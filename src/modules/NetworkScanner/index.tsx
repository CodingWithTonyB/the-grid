import { useState, useEffect } from 'react'

interface Device {
  hostname: string | null
  ip: string
  mac: string
  iface: string
}

interface DeviceNote {
  label: string
  note: string
}

interface Notes {
  [mac: string]: DeviceNote
}

interface HistoryEntry {
  mac: string
  ip: string
  hostname: string | null
  lastSeen: string
  ssid: string | null
}

interface History {
  [mac: string]: HistoryEntry
}

interface PortInfo {
  port: number
  name: string
  banner: string
}

interface HttpInfo {
  port: number
  server: string
  title: string
  redirectUrl: string
  secure: boolean
}

interface ProbeResult {
  ip: string
  mac: string
  vendor: string
  ttl: number | null
  osGuess: string
  ports: PortInfo[]
  http: HttpInfo[]
  mdnsServices: string[]
  netbiosName?: string
  ssdpInfo?: string
  arpType?: string
  reverseDns?: string
}

// Network Monitor types
interface NetDevice {
  mac: string; ip: string; name: string
  firstSeen: number; lastSeen: number
  online: boolean; watchOnline: boolean; watchOffline: boolean
  scansTotal: number; scansOnline: number
  latencyMs: number | null; latencyHistory: number[]
}
interface NetEvent {
  id: string; ts: number; type: 'joined' | 'left' | 'new'
  mac: string; name: string; ip: string
}
interface NetmonSnapshot { devices: NetDevice[]; events: NetEvent[] }

type Tab = 'online' | 'history' | 'networks' | 'events'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function timeAgoTs(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function uptimePct(dev: NetDevice) {
  if (!dev.scansTotal) return 0
  return Math.round((dev.scansOnline / dev.scansTotal) * 100)
}

function latencyColor(ms: number | null) {
  if (ms === null) return '#333'
  if (ms < 10) return '#4caf88'
  if (ms < 50) return '#5b8dee'
  if (ms < 150) return '#e0c060'
  return '#e07b3a'
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const w = 80; const h = 24
  const max = Math.max(...data, 1)
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (v / max) * h
    return `${x},${y}`
  }).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke="#5b8dee" strokeWidth="1.5" opacity="0.7" />
    </svg>
  )
}

export default function NetworkScanner() {
  const [devices, setDevices] = useState<Device[]>([])
  const [notes, setNotes] = useState<Notes>({})
  const [history, setHistory] = useState<History>({})
  const [ssid, setSsid] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [lastScanned, setLastScanned] = useState<Date | null>(null)
  const [, setTick] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<DeviceNote>({ label: '', note: '' })
  const [tab, setTab] = useState<Tab>('online')

  // Probe state
  const [probing, setProbing] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({})
  const [deepScanAll, setDeepScanAll] = useState(false)
  const [deepScanProgress, setDeepScanProgress] = useState<{ current: number; total: number; ip: string } | null>(null)

  // Network Monitor state
  const [netmon, setNetmon] = useState<NetmonSnapshot>({ devices: [], events: [] })

  useEffect(() => {
    Promise.all([
      window.ipcRenderer.invoke('load-notes').then(setNotes),
      window.ipcRenderer.invoke('load-history').then(setHistory),
      window.ipcRenderer.invoke('load-probes').then((p: Record<string, ProbeResult>) => {
        if (p) setProbeResults(p)
      }),
      window.ipcRenderer.invoke('scan-network-cached').then((cached: Device[]) => {
        if (cached && cached.length > 0) {
          setDevices(cached)
          setLastScanned(new Date())
        }
      }),
      window.ipcRenderer.invoke('get-ssid').then(setSsid),
      window.ipcRenderer.invoke('netmon-get-state').then((s: NetmonSnapshot) => {
        if (s) setNetmon(s)
      }),
    ]).then(() => {
      if (devices.length === 0) runScan()
    })

    const onUpdate = (_e: unknown, result: Device[]) => {
      setDevices(result)
      setLastScanned(new Date())
    }
    window.ipcRenderer.on('scanner-update', onUpdate)

    const onDeepProgress = (_e: unknown, progress: { current: number; total: number; ip: string }) => {
      setDeepScanProgress(progress)
    }
    window.ipcRenderer.on('deep-scan-progress', onDeepProgress)

    // Incremental probe results from auto-probe
    const onProbeResult = (_e: unknown, ip: string, result: ProbeResult) => {
      setProbeResults(prev => ({ ...prev, [ip]: result }))
    }
    window.ipcRenderer.on('probe-result', onProbeResult)

    // Network monitor updates
    const onNetmonUpdate = (_: unknown, s: NetmonSnapshot) => {
      setNetmon(s)
    }
    window.ipcRenderer.on('netmon-update', onNetmonUpdate)

    const tickInterval = setInterval(() => setTick(t => t + 1), 10_000)

    return () => {
      window.ipcRenderer.off('scanner-update', onUpdate)
      window.ipcRenderer.off('deep-scan-progress', onDeepProgress)
      window.ipcRenderer.off('probe-result', onProbeResult)
      window.ipcRenderer.off('netmon-update', onNetmonUpdate)
      clearInterval(tickInterval)
    }
  }, [])

  async function runScan() {
    setScanning(true)
    const [result, currentSsid]: [Device[], string | null] = await Promise.all([
      window.ipcRenderer.invoke('scan-network'),
      window.ipcRenderer.invoke('get-ssid'),
    ])
    const now = new Date().toISOString()
    setSsid(currentSsid)

    const currentHistory: History = await window.ipcRenderer.invoke('load-history')
    for (const d of result) {
      currentHistory[d.mac] = { mac: d.mac, ip: d.ip, hostname: d.hostname, lastSeen: now, ssid: currentSsid }
    }
    await window.ipcRenderer.invoke('save-history', currentHistory)

    setDevices(result)
    setHistory(currentHistory)
    setLastScanned(new Date())
    setScanning(false)

    // Auto-probe new devices in background
    window.ipcRenderer.invoke('auto-probe-new', result.map(d => ({ ip: d.ip, mac: d.mac })))
  }

  function selectDevice(mac: string) {
    if (selected === mac) { setSelected(null); return }
    setSelected(mac)
    setDraft(notes[mac] ?? { label: '', note: '' })
  }

  async function saveNote() {
    if (!selected) return
    const updated = { ...notes, [selected]: draft }
    setNotes(updated)
    await window.ipcRenderer.invoke('save-notes', updated)
    setSelected(null)
  }

  async function probeDevice(ip: string, mac: string) {
    setProbing(ip)
    const result: ProbeResult = await window.ipcRenderer.invoke('probe-device', ip, mac)
    setProbeResults(prev => ({ ...prev, [ip]: result }))
    setProbing(null)
  }

  async function deepProbeDevice(ip: string, mac: string) {
    setProbing(ip)
    const result: ProbeResult = await window.ipcRenderer.invoke('deep-probe-device', ip, mac)
    setProbeResults(prev => ({ ...prev, [ip]: result }))
    setProbing(null)
  }

  async function runDeepScanAll() {
    setDeepScanAll(true)
    setDeepScanProgress({ current: 0, total: devices.length, ip: '' })
    const deviceList = devices.map(d => ({ ip: d.ip, mac: d.mac }))
    const results: Record<string, ProbeResult> = await window.ipcRenderer.invoke('deep-scan-all', deviceList)
    setProbeResults(prev => ({ ...prev, ...results }))
    setDeepScanAll(false)
    setDeepScanProgress(null)
  }

  async function setWatch(mac: string, watchOnline: boolean, watchOffline: boolean) {
    await window.ipcRenderer.invoke('netmon-set-watch', mac, watchOnline, watchOffline)
  }

  async function forgetDevice(mac: string) {
    await window.ipcRenderer.invoke('netmon-forget', mac)
    setSelected(null)
  }

  // Build netmon device lookup
  const netmonMap = new Map(netmon.devices.map(d => [d.mac, d]))

  const sortedDevices = [...devices].sort((a, b) => {
    const aHasLabel = !!(notes[a.mac]?.label)
    const bHasLabel = !!(notes[b.mac]?.label)
    if (aHasLabel && !bHasLabel) return -1
    if (!aHasLabel && bHasLabel) return 1
    return 0
  })

  const onlineMacs = new Set(devices.map(d => d.mac))
  const offlineHistory = Object.values(history)
    .filter(h => !onlineMacs.has(h.mac) && h.ssid === ssid)
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())

  // Group all history by network SSID
  const networkMap: Record<string, HistoryEntry[]> = {}
  for (const h of Object.values(history)) {
    const net = h.ssid || 'Unknown'
    if (!networkMap[net]) networkMap[net] = []
    networkMap[net].push(h)
  }
  for (const net of Object.keys(networkMap)) {
    networkMap[net].sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
  }
  const networks = Object.entries(networkMap).sort((a, b) => {
    if (a[0] === ssid) return -1
    if (b[0] === ssid) return 1
    return new Date(b[1][0].lastSeen).getTime() - new Date(a[1][0].lastSeen).getTime()
  })

  const [expandedNet, setExpandedNet] = useState<string | null>(null)

  function renderProbeResult(ip: string) {
    const probe = probeResults[ip]
    if (!probe) return null

    return (
      <div className="probe-results">
        <div className="probe-section">
          <div className="probe-identity">
            {probe.vendor && <span className="probe-vendor">{probe.vendor}</span>}
            <span className="probe-os">{probe.osGuess}</span>
            {probe.ttl != null && <span className="probe-ttl">TTL {probe.ttl}</span>}
            {probe.arpType && <span className="probe-ttl">ARP: {probe.arpType}</span>}
          </div>
          {probe.reverseDns && (
            <div className="probe-extra-row">
              <span className="meta-key">DNS</span>
              <span className="probe-extra-val">{probe.reverseDns}</span>
            </div>
          )}
          {probe.ssdpInfo && (
            <div className="probe-extra-row">
              <span className="meta-key">SSDP</span>
              <span className="probe-extra-val">{probe.ssdpInfo}</span>
            </div>
          )}
          {probe.netbiosName && (
            <div className="probe-extra-row">
              <span className="meta-key">NETBIOS</span>
              <span className="probe-extra-val">{probe.netbiosName}</span>
            </div>
          )}
        </div>

        {probe.ports.length > 0 && (
          <div className="probe-section">
            <div className="probe-section-title">OPEN PORTS ({probe.ports.length})</div>
            <div className="probe-ports">
              {probe.ports.map(p => (
                <div key={p.port} className="probe-port-row">
                  <span className="probe-port-num">{p.port}</span>
                  <span className="probe-port-name">{p.name}</span>
                  {p.banner && (
                    <span className="probe-port-banner" title={p.banner}>
                      {p.banner.slice(0, 60)}{p.banner.length > 60 ? '...' : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {probe.http.length > 0 && (
          <div className="probe-section">
            <div className="probe-section-title">WEB SERVICES</div>
            {probe.http.map(h => (
              <div key={h.port} className="probe-http-row">
                <span className="probe-http-badge">{h.secure ? 'HTTPS' : 'HTTP'}:{h.port}</span>
                {h.title && <span className="probe-http-title">{h.title}</span>}
                {h.server && <span className="probe-http-server">{h.server}</span>}
                {h.redirectUrl && <span className="probe-http-redirect">→ {h.redirectUrl}</span>}
              </div>
            ))}
          </div>
        )}

        {probe.mdnsServices.length > 0 && (
          <div className="probe-section">
            <div className="probe-section-title">mDNS SERVICES</div>
            <div className="probe-mdns">
              {probe.mdnsServices.map(s => (
                <span key={s} className="probe-mdns-tag">{s}</span>
              ))}
            </div>
          </div>
        )}

        {probe.ports.length === 0 && (
          <div className="probe-empty">No open ports found — device may have a firewall</div>
        )}
      </div>
    )
  }

  function renderNetmonStats(mac: string) {
    const nd = netmonMap.get(mac)
    if (!nd) return null
    const uptime = uptimePct(nd)

    return (
      <div className="netmon-inline">
        {/* Stats row */}
        <div className="netmon-stat-row">
          <div className="netmon-stat-cell">
            <span className="netmon-stat-label">UPTIME</span>
            <span className="netmon-stat-val" style={{ color: uptime > 80 ? '#4caf88' : uptime > 50 ? '#e0c060' : '#e07b3a' }}>
              {uptime}%
            </span>
            <span className="netmon-stat-sub">{nd.scansOnline}/{nd.scansTotal}</span>
          </div>
          <div className="netmon-stat-cell">
            <span className="netmon-stat-label">LATENCY</span>
            <span className="netmon-stat-val" style={{ color: latencyColor(nd.latencyMs) }}>
              {nd.latencyMs !== null ? `${nd.latencyMs.toFixed(0)}ms` : '—'}
            </span>
            {nd.latencyHistory.length > 0 && (
              <span className="netmon-stat-sub">
                avg {(nd.latencyHistory.reduce((a, b) => a + b, 0) / nd.latencyHistory.length).toFixed(0)}ms
              </span>
            )}
          </div>
          <div className="netmon-stat-cell">
            <span className="netmon-stat-label">FIRST SEEN</span>
            <span className="netmon-stat-val netmon-stat-val--sm">{timeAgoTs(nd.firstSeen)}</span>
          </div>
          <div className="netmon-stat-cell">
            <span className="netmon-stat-label">LAST SEEN</span>
            <span className="netmon-stat-val netmon-stat-val--sm">{timeAgoTs(nd.lastSeen)}</span>
          </div>
        </div>

        {/* Latency sparkline */}
        {nd.latencyHistory.length >= 2 && (
          <div className="netmon-sparkline-section">
            <span className="netmon-stat-label">LATENCY HISTORY</span>
            <Sparkline data={nd.latencyHistory} />
          </div>
        )}

        {/* Uptime bar */}
        <div className="netmon-uptime-bar-section">
          <span className="netmon-stat-label">UPTIME</span>
          <div className="netmon-uptime-bar">
            <div className="netmon-uptime-fill" style={{ width: `${uptime}%`, background: uptime > 80 ? '#4caf88' : uptime > 50 ? '#e0c060' : '#e07b3a' }} />
          </div>
        </div>

        {/* Watch toggles */}
        <div className="netmon-watch-section">
          <span className="netmon-stat-label">NOTIFICATIONS</span>
          <div className="netmon-watch-toggles">
            <label className="netmon-toggle">
              <input type="checkbox" checked={nd.watchOnline} onChange={e => setWatch(mac, e.target.checked, nd.watchOffline)} />
              <span>Online</span>
            </label>
            <label className="netmon-toggle">
              <input type="checkbox" checked={nd.watchOffline} onChange={e => setWatch(mac, nd.watchOnline, e.target.checked)} />
              <span>Offline</span>
            </label>
          </div>
        </div>

        {/* Forget */}
        <button className="netmon-forget-btn" onClick={() => forgetDevice(mac)}>FORGET DEVICE</button>
      </div>
    )
  }

  function renderDeviceRow(mac: string, ip: string, hostname: string | null, iface: string, isOffline = false) {
    const info = notes[mac]
    const isOpen = selected === mac
    const primary = info?.label || null
    const hasProbe = !!probeResults[ip]
    const isProbing = probing === ip
    const nd = netmonMap.get(mac)

    return (
      <div key={mac} className={`device-row${isOpen ? ' device-row--open' : ''}${isOffline ? ' device-row--offline' : ''}`}>
        <div className="device-summary" onClick={() => selectDevice(mac)}>
          <div className="device-left">
            <div className="device-primary">
              {nd && <span className={`netmon-dot${nd.online ? ' online' : ''}`} />}
              {primary ?? ip}
              {nd && (nd.watchOnline || nd.watchOffline) && <span className="netmon-bell-sm">&#x1f514;</span>}
            </div>
            <div className="device-secondary">
              {primary && <span className="device-ip-small">{ip}</span>}
              {!primary && hostname && <span className="device-hostname">{hostname}</span>}
              {isOffline && (
                <span className="device-offline-time">last seen {timeAgo(history[mac]?.lastSeen ?? '')}</span>
              )}
              {hasProbe && !isOpen && (
                <span className="device-probe-badge">
                  {probeResults[ip].ports.length} ports · {probeResults[ip].osGuess}
                  {probeResults[ip].vendor ? ` · ${probeResults[ip].vendor}` : ''}
                </span>
              )}
              {nd && nd.latencyMs !== null && !isOpen && (
                <span className="device-latency-badge" style={{ color: latencyColor(nd.latencyMs) }}>
                  {nd.latencyMs.toFixed(0)}ms
                </span>
              )}
              {nd && !isOpen && (
                <span className="device-uptime-badge">{uptimePct(nd)}% up</span>
              )}
            </div>
          </div>
          <div className="device-right">
            {info?.note && !isOpen && (
              <div className="device-note-preview">{info.note}</div>
            )}
            <span className="device-toggle">{isOpen ? '▲' : '▼'}</span>
          </div>
        </div>

        {isOpen && (
          <div className="device-editor" onClick={e => e.stopPropagation()}>
            <div className="device-meta-row">
              <span className="meta-key">IP</span>
              <span className="meta-val">{ip}</span>
              <span className="meta-key">MAC</span>
              <span className="meta-val">{mac}</span>
              <span className="meta-key">HOST</span>
              <span className="meta-val">{hostname ?? '—'}</span>
              {!isOffline && <><span className="meta-key">IF</span><span className="meta-val">{iface}</span></>}
            </div>

            {/* Network Monitor stats */}
            {renderNetmonStats(mac)}

            {/* Probe buttons */}
            {!isOffline && (
              <div className="probe-btn-row">
                <button
                  className={`scan-btn probe-btn${isProbing ? ' probe-btn--scanning' : ''}`}
                  onClick={() => probeDevice(ip, mac)}
                  disabled={isProbing}
                >
                  {isProbing ? 'PROBING...' : hasProbe ? 'PROBE AGAIN' : 'PROBE'}
                </button>
                <button
                  className={`scan-btn probe-btn probe-btn--deep${isProbing ? ' probe-btn--scanning' : ''}`}
                  onClick={() => deepProbeDevice(ip, mac)}
                  disabled={isProbing}
                >
                  {isProbing ? 'SCANNING...' : 'DEEP PROBE'}
                </button>
              </div>
            )}

            {isProbing && (
              <div className="probe-loading">
                <span className="scan-pulse">SCANNING PORTS & SERVICES</span>
              </div>
            )}
            {hasProbe && !isProbing && renderProbeResult(ip)}

            {/* Notes */}
            <input
              className="note-input"
              placeholder="Label  (e.g. Tony's iPhone)"
              value={draft.label}
              onChange={e => setDraft(prev => ({ ...prev, label: e.target.value }))}
            />
            <textarea
              className="note-textarea"
              placeholder="Notes..."
              value={draft.note}
              onChange={e => setDraft(prev => ({ ...prev, note: e.target.value }))}
            />
            <button className="save-btn" onClick={saveNote}>SAVE</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="scanner">
      <div className="scanner-toolbar">
        <div className="scanner-tabs">
          <button className={`tab-btn${tab === 'online' ? ' tab-btn--active' : ''}`} onClick={() => setTab('online')}>
            ONLINE <span className="tab-count">{devices.length}</span>
          </button>
          <button className={`tab-btn${tab === 'history' ? ' tab-btn--active' : ''}`} onClick={() => setTab('history')}>
            HISTORY <span className="tab-count">{offlineHistory.length}</span>
          </button>
          <button className={`tab-btn${tab === 'networks' ? ' tab-btn--active' : ''}`} onClick={() => setTab('networks')}>
            NETWORKS <span className="tab-count">{networks.length}</span>
          </button>
          <button className={`tab-btn${tab === 'events' ? ' tab-btn--active' : ''}`} onClick={() => setTab('events')}>
            EVENTS {netmon.events.length > 0 && <span className="tab-count">{netmon.events.length > 99 ? '99+' : netmon.events.length}</span>}
          </button>
        </div>

        <div className="scanner-right-bar">
          {ssid && <span className="ssid-badge-sm">{ssid}</span>}
          <span className="scanner-status-text">
            {scanning
              ? <span className="scan-pulse">SCANNING</span>
              : lastScanned
                ? <span className="scan-last">updated {timeAgo(lastScanned.toISOString())}</span>
                : null
            }
          </span>
          {deepScanAll && deepScanProgress ? (
            <span className="scan-pulse deep-scan-status">
              {deepScanProgress.current}/{deepScanProgress.total} — {deepScanProgress.ip}
            </span>
          ) : (
            devices.length > 0 && (
              <button className="scanner-action-btn" onClick={runDeepScanAll} disabled={deepScanAll} title="Deep probe all devices">
                DEEP SCAN
              </button>
            )
          )}
        </div>
      </div>

      <div className="device-list">
        {tab === 'online' && sortedDevices.map(d =>
          renderDeviceRow(d.mac, d.ip, d.hostname, d.iface)
        )}
        {tab === 'history' && offlineHistory.map(h =>
          renderDeviceRow(h.mac, h.ip, h.hostname, '', true)
        )}
        {tab === 'history' && offlineHistory.length === 0 && (
          <div className="empty-state">No offline devices on {ssid ?? 'this network'} yet.</div>
        )}

        {tab === 'networks' && networks.map(([netName, netDevices]) => {
          const isCurrent = netName === ssid
          const isExpanded = expandedNet === netName
          const onlineCount = isCurrent ? netDevices.filter(d => onlineMacs.has(d.mac)).length : 0

          return (
            <div key={netName} className="net-group">
              <div className="net-header" onClick={() => setExpandedNet(isExpanded ? null : netName)}>
                <div className="net-header-left">
                  <span className={`net-name${isCurrent ? ' net-name--current' : ''}`}>{netName}</span>
                  {isCurrent && <span className="net-current-badge">CONNECTED</span>}
                </div>
                <div className="net-header-right">
                  <span className="net-device-count">{netDevices.length} device{netDevices.length !== 1 ? 's' : ''}</span>
                  {isCurrent && onlineCount > 0 && <span className="net-online-count">{onlineCount} online</span>}
                  <span className="net-last-seen">last seen {timeAgo(netDevices[0].lastSeen)}</span>
                  <span className="device-toggle">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>
              {isExpanded && (
                <div className="net-devices">
                  {netDevices.map(h => {
                    const isOnline = onlineMacs.has(h.mac)
                    const dev = isOnline ? devices.find(d => d.mac === h.mac) : null
                    return renderDeviceRow(h.mac, dev?.ip ?? h.ip, dev?.hostname ?? h.hostname, dev?.iface ?? '', !isOnline)
                  })}
                </div>
              )}
            </div>
          )
        })}
        {tab === 'networks' && networks.length === 0 && (
          <div className="empty-state">No networks seen yet. Scan to discover devices.</div>
        )}

        {tab === 'events' && (
          <div className="netmon-events">
            {netmon.events.length === 0 && (
              <div className="empty-state">No events yet — events appear as devices join and leave.</div>
            )}
            {netmon.events.map(ev => {
              const isJoin = ev.type === 'joined'
              const isNew = ev.type === 'new'
              const nd = netmonMap.get(ev.mac)
              return (
                <div key={ev.id} className={`netmon-event netmon-event--${ev.type}`}>
                  <div className="netmon-event-icon">
                    {isNew ? '◆' : isJoin ? '●' : '○'}
                  </div>
                  <div className="netmon-event-body">
                    <div className="netmon-event-title">
                      <span className="netmon-event-type">{isNew ? 'NEW DEVICE' : isJoin ? 'JOINED' : 'LEFT'}</span>
                      <span className="netmon-event-name">{ev.name}</span>
                    </div>
                    <div className="netmon-event-sub">
                      {ev.ip}
                      {nd && <span> · {uptimePct(nd)}% uptime</span>}
                    </div>
                  </div>
                  <div className="netmon-event-time">{timeAgoTs(ev.ts)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
