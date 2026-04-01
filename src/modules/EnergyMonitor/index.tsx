import { useState, useEffect, useRef } from 'react'
import HouseView from './HouseView'

type ViewMode = 'data' | 'house'

interface ChannelUsage {
  name: string
  watts: number
  kwh: number
  percentage: number
  type: string
  deviceName: string
}

interface ChartData {
  usageList: number[]
  firstInstant: string
  scale: string
}

type Tab = 'LIVE' | 'HOUR' | 'DAY' | 'MONTH'

const TAB_SCALES: Record<Tab, string> = {
  LIVE: '1S',
  HOUR: '1H',
  DAY: '1D',
  MONTH: '1MON',
}

const COST_PER_KWH = 0.132

function parseUsageData(data: any, scale: string) {
  const channels: ChannelUsage[] = []
  let totalWatts = 0
  let totalKwh = 0

  if (!data?.deviceListUsages?.devices) return { channels, totalWatts, totalKwh }

  for (const device of data.deviceListUsages.devices) {
    const deviceName = device.deviceName || `Panel ${device.deviceGid}`
    for (const cu of device.channelUsages || []) {
      const rawUsage = Math.abs(cu.usage || 0)
      const name = cu.name || `Channel ${cu.channelNum}`
      const isMain = cu.channelNum === '1,2,3' || name === 'Main'
      const isBalance = name === 'Balance' || cu.channelNum === 'Balance'
      const type = isMain ? 'Main' : isBalance ? 'Balance' : 'Circuit'

      let watts: number
      let kwh: number
      if (scale === '1S') {
        watts = rawUsage * 3600 * 1000
        kwh = rawUsage
      } else if (scale === '1H') {
        kwh = rawUsage
        watts = rawUsage * 1000
      } else if (scale === '1D') {
        kwh = rawUsage
        watts = (rawUsage / 24) * 1000
      } else if (scale === '1MON') {
        kwh = rawUsage
        watts = (rawUsage / 720) * 1000
      } else {
        kwh = rawUsage
        watts = rawUsage * 1000
      }

      if (isMain) {
        totalWatts += watts
        totalKwh += kwh
      }

      channels.push({ name, watts, kwh, percentage: cu.percentage || 0, type, deviceName })
    }
  }

  channels.sort((a, b) => b.watts - a.watts)
  return { channels, totalWatts, totalKwh }
}

function formatLabel(instant: string, index: number, scale: string): string {
  const d = new Date(instant)
  d.setTime(d.getTime() + index * (
    scale === '1H' ? 3600000 : scale === '1D' ? 86400000 : 2592000000
  ))
  if (scale === '1H') {
    return d.toLocaleTimeString([], { hour: 'numeric', hour12: true })
  }
  if (scale === '1D') {
    return d.toLocaleDateString([], { weekday: 'short' })
  }
  return d.toLocaleDateString([], { month: 'short' })
}

export default function EnergyMonitor() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loggingIn, setLoggingIn] = useState(false)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [, setDevices] = useState<any[]>([])
  const [tab, setTab] = useState<Tab>('LIVE')
  const [usages, setUsages] = useState<ChannelUsage[]>([])
  const [totalWatts, setTotalWatts] = useState(0)
  const [totalKwh, setTotalKwh] = useState(0)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [chart, setChart] = useState<ChartData | null>(null)
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('data')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tabRef = useRef<Tab>('LIVE')

  useEffect(() => {
    window.ipcRenderer.invoke('emporia-auto-login').then((res: any) => {
      if (res.success) {
        setLoggedIn(true)
        setDevices(res.devices)
        startPolling('LIVE')
      }
      setLoading(false)
    })
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  function startPolling(t: Tab) {
    if (pollRef.current) clearInterval(pollRef.current)
    tabRef.current = t
    fetchData(t)
    if (t === 'LIVE') {
      pollRef.current = setInterval(() => fetchData('LIVE'), 5000)
    }
    // Fetch chart data for non-live tabs
    if (t !== 'LIVE') {
      fetchChart(t)
    }
  }

  function switchTab(t: Tab) {
    setTab(t)
    setHistory([])
    setChart(null)
    setHoveredBar(null)
    startPolling(t)
  }

  async function fetchChart(t: Tab) {
    const scaleMap: Record<string, { scale: string; days: number }> = {
      HOUR: { scale: '1H', days: 7 },
      DAY: { scale: '1D', days: 30 },
      MONTH: { scale: '1MON', days: 365 },
    }
    const cfg = scaleMap[t]
    if (!cfg) return
    const data = await window.ipcRenderer.invoke('emporia-get-chart', cfg.scale, cfg.days)
    if (data && !data.error && tabRef.current === t) {
      setChart(data)
    }
  }

  async function fetchData(t: Tab) {
    const scale = TAB_SCALES[t]
    const data = await window.ipcRenderer.invoke('emporia-get-usage', scale)
    if (!data || data.error) return
    if (tabRef.current !== t) return

    const { channels, totalWatts: tw, totalKwh: tk } = parseUsageData(data, scale)
    setUsages(channels)
    setTotalWatts(tw)
    setTotalKwh(tk)
    if (t === 'LIVE') setHistory(prev => [...prev.slice(-59), tw])
    setLastUpdate(new Date())
  }

  async function handleLogin() {
    setLoggingIn(true)
    setError('')
    const res = await window.ipcRenderer.invoke('emporia-login', email, password)
    if (res.success) {
      setLoggedIn(true)
      setDevices(res.devices)
      startPolling('LIVE')
    } else {
      setError(res.error || 'Login failed')
    }
    setLoggingIn(false)
  }

  async function handleLogout() {
    if (pollRef.current) clearInterval(pollRef.current)
    await window.ipcRenderer.invoke('emporia-logout')
    setLoggedIn(false)
    setDevices([])
    setUsages([])
    setTotalWatts(0)
    setTotalKwh(0)
    setChart(null)
  }

  if (loading) {
    return (
      <div className="energy-monitor">
        <div className="energy-loading">CONNECTING TO EMPORIA...</div>
      </div>
    )
  }

  if (!loggedIn) {
    return (
      <div className="energy-monitor">
        <div className="camera-setup">
          <div className="camera-setup-title">EMPORIA ENERGY LOGIN</div>
          <div className="camera-setup-grid">
            <label className="camera-setup-label">EMAIL</label>
            <input className="note-input" type="email" placeholder="your@email.com" value={email}
              onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLogin()}
              style={{ width: '100%' }} autoFocus />
            <label className="camera-setup-label">PASSWORD</label>
            <input className="note-input" type="password" value={password}
              onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLogin()}
              style={{ width: '100%' }} />
          </div>
          {error && <div className="energy-error">{error}</div>}
          <div style={{ display: 'flex', gap: '8px', marginTop: '1.25rem' }}>
            <button className="save-btn" onClick={handleLogin} disabled={loggingIn}>
              {loggingIn ? 'CONNECTING...' : 'CONNECT'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const mains = usages.filter(u => u.type === 'Main' || u.type === 'Balance')
  const circuits = usages.filter(u => u.type === 'Circuit')
  const totalCost = totalKwh * COST_PER_KWH
  const isLive = tab === 'LIVE'

  // Chart bar data
  const chartBars = chart?.usageList?.filter(v => v != null) || []
  const chartMax = chartBars.length > 0 ? Math.max(...chartBars, 0.1) : 1
  const chartTotalKwh = chartBars.reduce((a, b) => a + (b || 0), 0)
  const chartTotalCost = chartTotalKwh * COST_PER_KWH

  return (
    <div className="energy-monitor">
      {/* View toggle + Tabs */}
      <div className="energy-tabs">
        <div className="energy-view-toggle">
          <button className={`energy-view-btn${viewMode === 'data' ? ' energy-view-btn--active' : ''}`}
            onClick={() => setViewMode('data')}>DATA</button>
          <button className={`energy-view-btn${viewMode === 'house' ? ' energy-view-btn--active' : ''}`}
            onClick={() => { setViewMode('house'); if (tab !== 'LIVE') switchTab('LIVE') }}>HOUSE</button>
        </div>
        {viewMode === 'data' && (
          <>
            {(['LIVE', 'HOUR', 'DAY', 'MONTH'] as Tab[]).map(t => (
              <button key={t} className={`energy-tab${tab === t ? ' energy-tab--active' : ''}`}
                onClick={() => switchTab(t)}>
                {t}
              </button>
            ))}
          </>
        )}
        <button className="scan-btn" style={{ fontSize: '10px', marginLeft: 'auto' }} onClick={handleLogout}>LOGOUT</button>
      </div>

      {/* House View */}
      {viewMode === 'house' && (
        <HouseView circuits={circuits} totalWatts={totalWatts} />
      )}

      {/* Data View */}
      {viewMode === 'data' && <>
      {/* Top bar */}
      <div className="energy-topbar">
        <span className="energy-total">
          {isLive
            ? totalWatts >= 1000 ? `${(totalWatts / 1000).toFixed(2)} kW` : `${Math.round(totalWatts)} W`
            : totalKwh >= 1 ? `${totalKwh.toFixed(1)} kWh` : `${(totalKwh * 1000).toFixed(0)} Wh`
          }
        </span>
        {isLive && <span className="energy-live-dot" />}
        {!isLive && <span className="energy-cost">${totalCost.toFixed(2)}</span>}
        <span className="energy-time">
          {isLive
            ? lastUpdate ? lastUpdate.toLocaleTimeString() : '—'
            : tab === 'HOUR' ? 'LAST HOUR'
            : tab === 'DAY' ? 'TODAY'
            : 'THIS MONTH'
          }
        </span>
      </div>

      {/* Total power arc */}
      <div className="energy-hero">
        <svg viewBox="0 0 200 120" className="energy-arc">
          <defs>
            <linearGradient id="arc-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#0f6" />
              <stop offset="50%" stopColor="#ff0" />
              <stop offset="100%" stopColor="#f33" />
            </linearGradient>
          </defs>
          <path d="M 20 110 A 80 80 0 0 1 180 110" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" strokeLinecap="round" />
          <path d="M 20 110 A 80 80 0 0 1 180 110" fill="none" stroke="url(#arc-grad)" strokeWidth="8" strokeLinecap="round"
            strokeDasharray={`${Math.min(1, totalWatts / 10000) * 251.3} 251.3`}
            style={{ transition: 'stroke-dasharray 0.5s ease' }} />
        </svg>
        <div className="energy-hero-value">
          {isLive
            ? totalWatts >= 1000 ? `${(totalWatts / 1000).toFixed(1)}` : `${Math.round(totalWatts)}`
            : totalKwh >= 1 ? `${totalKwh.toFixed(1)}` : `${(totalKwh * 1000).toFixed(0)}`
          }
        </div>
        <div className="energy-hero-unit">
          {isLive ? (totalWatts >= 1000 ? 'kW' : 'W') : (totalKwh >= 1 ? 'kWh' : 'Wh')}
        </div>
        {!isLive && <div className="energy-hero-cost">${totalCost.toFixed(2)}</div>}
      </div>

      {/* Mains summary */}
      {mains.length > 0 && (
        <div className="energy-mains">
          {mains.map((m, i) => (
            <div key={i} className="energy-mains-card">
              <div className="energy-mains-label">{m.deviceName} · {m.name}</div>
              <div className="energy-mains-value">
                {isLive
                  ? m.watts >= 1000 ? `${(m.watts / 1000).toFixed(1)} kW` : `${Math.round(m.watts)} W`
                  : m.kwh >= 1 ? `${m.kwh.toFixed(2)} kWh` : `${(m.kwh * 1000).toFixed(0)} Wh`
                }
              </div>
              {!isLive && <div className="energy-mains-cost">${(m.kwh * COST_PER_KWH).toFixed(2)}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Live sparkline */}
      {isLive && history.length > 1 && (
        <div className="energy-graph">
          <svg viewBox={`0 0 ${history.length - 1} 100`} preserveAspectRatio="none" className="energy-graph-svg">
            <defs>
              <linearGradient id="graph-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(0,255,255,0.2)" />
                <stop offset="100%" stopColor="rgba(0,255,255,0)" />
              </linearGradient>
            </defs>
            {(() => {
              const max = Math.max(...history, 100)
              const points = history.map((v, i) => `${i},${100 - (v / max) * 90}`)
              const line = points.join(' ')
              const area = `0,100 ${line} ${history.length - 1},100`
              return (
                <>
                  <polygon points={area} fill="url(#graph-fill)" />
                  <polyline points={line} fill="none" stroke="#0ff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </>
              )
            })()}
          </svg>
        </div>
      )}

      {/* Historical bar chart */}
      {!isLive && chartBars.length > 0 && (
        <div className="energy-chart">
          <div className="energy-chart-header">
            <span className="energy-chart-title">
              {tab === 'HOUR' ? 'LAST 7 DAYS (HOURLY)' : tab === 'DAY' ? 'LAST 30 DAYS' : 'LAST 12 MONTHS'}
            </span>
            <span className="energy-chart-total">
              {chartTotalKwh.toFixed(1)} kWh · ${chartTotalCost.toFixed(2)}
            </span>
          </div>
          <div className="energy-chart-bars">
            {chartBars.map((val, i) => {
              const pct = (val / chartMax) * 100
              const isHovered = hoveredBar === i
              const label = chart ? formatLabel(chart.firstInstant, i, chart.scale) : ''
              return (
                <div key={i} className="energy-chart-col"
                  onMouseEnter={() => setHoveredBar(i)}
                  onMouseLeave={() => setHoveredBar(null)}>
                  {isHovered && (
                    <div className="energy-chart-tooltip">
                      {val.toFixed(2)} kWh<br />${(val * COST_PER_KWH).toFixed(2)}
                    </div>
                  )}
                  <div className="energy-chart-bar-wrap">
                    <div className={`energy-chart-bar${isHovered ? ' energy-chart-bar--hover' : ''}`}
                      style={{ height: `${Math.max(2, pct)}%` }} />
                  </div>
                  {/* Show label every N bars depending on count */}
                  {(chartBars.length <= 14 || i % Math.ceil(chartBars.length / 12) === 0) && (
                    <div className="energy-chart-label">{label}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Circuit breakdown */}
      <div className="energy-circuits">
        {circuits.map((ch, i) => {
          const active = ch.watts >= 1
          return (
            <div key={i} className={`energy-circuit-row${active ? '' : ' energy-circuit-row--off'}`}>
              <div className="energy-circuit-name">{ch.name}</div>
              <div className="energy-circuit-bar-bg">
                <div className="energy-circuit-bar"
                  style={{ width: `${Math.min(100, ch.percentage)}%`, transition: 'width 0.5s ease' }} />
              </div>
              <div className="energy-circuit-watts">
                {active
                  ? isLive
                    ? ch.watts >= 1000 ? `${(ch.watts / 1000).toFixed(1)}kW` : `${Math.round(ch.watts)}W`
                    : ch.kwh >= 1 ? `${ch.kwh.toFixed(2)}kWh` : `${(ch.kwh * 1000).toFixed(0)}Wh`
                  : 'OFF'
                }
              </div>
              {!isLive && active && (
                <div className="energy-circuit-cost">${(ch.kwh * COST_PER_KWH).toFixed(2)}</div>
              )}
            </div>
          )
        })}
        {circuits.length === 0 && (
          <div className="energy-loading">WAITING FOR DATA...</div>
        )}
      </div>
      </>}
    </div>
  )
}
