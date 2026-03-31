import { useState, useEffect, useRef } from 'react'

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

function timeAgo(ts: number) {
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

// Tiny sparkline using SVG
function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const w = 60; const h = 20
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

export default function NetworkMonitor() {
  const [data, setData] = useState<NetmonSnapshot>({ devices: [], events: [] })
  const [selected, setSelected] = useState<NetDevice | null>(null)
  const [scanning, setScanning] = useState(false)
  const [editingAlias, setEditingAlias] = useState(false)
  const [aliasVal, setAliasVal] = useState('')
  const [view, setView] = useState<'devices' | 'events'>('devices')
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    window.ipcRenderer.invoke('netmon-get-state').then((s: NetmonSnapshot) => {
      setData(s)
      if (s.devices.length) setSelected(s.devices[0])
    })
    const onUpdate = (_: unknown, s: NetmonSnapshot) => {
      setData(s)
      // Keep selected in sync
      setSelected(prev => prev ? (s.devices.find(d => d.mac === prev.mac) ?? prev) : s.devices[0] ?? null)
    }
    window.ipcRenderer.on('netmon-update', onUpdate)
    // Re-render timeAgo every 30s
    tickRef.current = setInterval(() => setData(d => ({ ...d })), 30_000)
    return () => {
      window.ipcRenderer.off('netmon-update', onUpdate)
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [])

  async function scanNow() {
    setScanning(true)
    const s: NetmonSnapshot = await window.ipcRenderer.invoke('netmon-scan-now')
    setData(s)
    setScanning(false)
  }

  function selectDevice(dev: NetDevice) {
    setSelected(dev)
    setEditingAlias(false)
  }

  async function setWatch(watchOnline: boolean, watchOffline: boolean) {
    if (!selected) return
    await window.ipcRenderer.invoke('netmon-set-watch', selected.mac, watchOnline, watchOffline)
  }

  async function saveAlias() {
    if (!selected || !aliasVal.trim()) return
    await window.ipcRenderer.invoke('netmon-set-alias', selected.mac, aliasVal.trim())
    setEditingAlias(false)
  }

  async function forget() {
    if (!selected) return
    await window.ipcRenderer.invoke('netmon-forget', selected.mac)
    setSelected(null)
  }

  const online = data.devices.filter(d => d.online)
  const offline = data.devices.filter(d => !d.online)

  return (
    <div className="netmon">
      {/* Left sidebar — device list */}
      <div className="netmon-sidebar">
        <div className="netmon-sidebar-head">
          <div className="netmon-count-row">
            <span className="netmon-count-on">{online.length} online</span>
            <span className="netmon-count-off">{offline.length} offline</span>
          </div>
          <button className={`netmon-scan-btn${scanning ? ' netmon-scan-btn--spinning' : ''}`} onClick={scanNow} title="Scan now">
            ↻
          </button>
        </div>

        {online.length > 0 && (
          <>
            <div className="netmon-group-label">ONLINE</div>
            {online.sort((a, b) => a.name.localeCompare(b.name)).map(dev => (
              <DeviceRow key={dev.mac} dev={dev} active={selected?.mac === dev.mac} onClick={() => selectDevice(dev)} />
            ))}
          </>
        )}
        {offline.length > 0 && (
          <>
            <div className="netmon-group-label">OFFLINE</div>
            {offline.sort((a, b) => b.lastSeen - a.lastSeen).map(dev => (
              <DeviceRow key={dev.mac} dev={dev} active={selected?.mac === dev.mac} onClick={() => selectDevice(dev)} />
            ))}
          </>
        )}
        {data.devices.length === 0 && (
          <div className="netmon-empty">Scanning...</div>
        )}
      </div>

      {/* Right panel */}
      <div className="netmon-right">
        {/* Top nav */}
        <div className="netmon-topnav">
          <div className="netmon-viewnav">
            <button className={`netmon-viewnav-btn${view === 'devices' ? ' active' : ''}`} onClick={() => setView('devices')}>DEVICES</button>
            <button className={`netmon-viewnav-btn${view === 'events' ? ' active' : ''}`} onClick={() => setView('events')}>
              EVENTS
              {data.events.length > 0 && <span className="netmon-event-badge">{Math.min(data.events.length, 99)}</span>}
            </button>
          </div>
        </div>

        {view === 'events' ? (
          <EventFeed events={data.events} devices={data.devices} />
        ) : selected ? (
          <DeviceDetail
            dev={selected}
            editingAlias={editingAlias}
            aliasVal={aliasVal}
            onStartAlias={() => { setAliasVal(selected.name); setEditingAlias(true) }}
            onAliasChange={setAliasVal}
            onSaveAlias={saveAlias}
            onCancelAlias={() => setEditingAlias(false)}
            onSetWatch={setWatch}
            onForget={forget}
          />
        ) : (
          <div className="netmon-placeholder">Select a device</div>
        )}
      </div>
    </div>
  )
}

// ── Device row in sidebar ───────────────────────────────────────────────
function DeviceRow({ dev, active, onClick }: { dev: NetDevice; active: boolean; onClick: () => void }) {
  return (
    <div className={`netmon-device-row${active ? ' active' : ''}`} onClick={onClick}>
      <div className={`netmon-dot${dev.online ? ' online' : ''}`} />
      <div className="netmon-device-info">
        <div className="netmon-device-name">
          {dev.name}
          {(dev.watchOnline || dev.watchOffline) && <span className="netmon-bell">🔔</span>}
        </div>
        <div className="netmon-device-sub">{dev.ip}</div>
      </div>
      <div className="netmon-device-meta">
        {dev.online && dev.latencyMs !== null && (
          <span style={{ color: latencyColor(dev.latencyMs), fontSize: 10 }}>{dev.latencyMs.toFixed(0)}ms</span>
        )}
        {!dev.online && <span className="netmon-device-ago">{timeAgo(dev.lastSeen)}</span>}
      </div>
    </div>
  )
}

// ── Device detail panel ─────────────────────────────────────────────────
function DeviceDetail({ dev, editingAlias, aliasVal, onStartAlias, onAliasChange, onSaveAlias, onCancelAlias, onSetWatch, onForget }: {
  dev: NetDevice
  editingAlias: boolean; aliasVal: string
  onStartAlias: () => void; onAliasChange: (v: string) => void
  onSaveAlias: () => void; onCancelAlias: () => void
  onSetWatch: (on: boolean, off: boolean) => void
  onForget: () => void
}) {
  const uptime = uptimePct(dev)
  const avgLatency = dev.latencyHistory.length
    ? (dev.latencyHistory.reduce((a, b) => a + b, 0) / dev.latencyHistory.length).toFixed(1)
    : null

  return (
    <div className="netmon-detail">
      {/* Header */}
      <div className="netmon-detail-header">
        <div className={`netmon-dot-lg${dev.online ? ' online' : ''}`} />
        <div style={{ flex: 1 }}>
          {editingAlias ? (
            <div className="netmon-alias-edit">
              <input
                className="note-input" autoFocus value={aliasVal}
                onChange={e => onAliasChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') onSaveAlias(); if (e.key === 'Escape') onCancelAlias() }}
              />
              <button className="save-btn" onClick={onSaveAlias}>SAVE</button>
              <button className="save-btn" style={{ borderColor: '#1a1a1a', color: '#444' }} onClick={onCancelAlias}>CANCEL</button>
            </div>
          ) : (
            <div className="netmon-detail-name" onClick={onStartAlias} title="Click to rename">
              {dev.name} <span className="netmon-edit-hint">✎</span>
            </div>
          )}
          <div className="netmon-detail-mac">{dev.mac} · {dev.ip}</div>
        </div>
        <div className={`netmon-status-badge${dev.online ? ' online' : ''}`}>
          {dev.online ? 'ONLINE' : 'OFFLINE'}
        </div>
      </div>

      {/* Stats grid */}
      <div className="netmon-stat-grid">
        <div className="netmon-stat">
          <div className="netmon-stat-label">UPTIME</div>
          <div className="netmon-stat-val" style={{ color: uptime > 80 ? '#4caf88' : uptime > 50 ? '#e0c060' : '#e07b3a' }}>
            {uptime}%
          </div>
          <div className="netmon-stat-sub">{dev.scansOnline}/{dev.scansTotal} scans</div>
        </div>

        <div className="netmon-stat">
          <div className="netmon-stat-label">LATENCY</div>
          <div className="netmon-stat-val" style={{ color: latencyColor(dev.latencyMs) }}>
            {dev.latencyMs !== null ? `${dev.latencyMs.toFixed(0)}ms` : '—'}
          </div>
          {avgLatency && <div className="netmon-stat-sub">avg {avgLatency}ms</div>}
        </div>

        <div className="netmon-stat">
          <div className="netmon-stat-label">FIRST SEEN</div>
          <div className="netmon-stat-val netmon-stat-val--sm">{timeAgo(dev.firstSeen)}</div>
        </div>

        <div className="netmon-stat">
          <div className="netmon-stat-label">LAST SEEN</div>
          <div className="netmon-stat-val netmon-stat-val--sm">{timeAgo(dev.lastSeen)}</div>
        </div>
      </div>

      {/* Latency sparkline */}
      {dev.latencyHistory.length >= 2 && (
        <div className="netmon-sparkline-wrap">
          <div className="netmon-stat-label" style={{ marginBottom: 6 }}>LATENCY HISTORY</div>
          <Sparkline data={dev.latencyHistory} />
        </div>
      )}

      {/* Uptime bar */}
      <div className="netmon-uptime-bar-wrap">
        <div className="netmon-stat-label" style={{ marginBottom: 6 }}>UPTIME</div>
        <div className="netmon-uptime-bar">
          <div className="netmon-uptime-fill" style={{ width: `${uptime}%`, background: uptime > 80 ? '#4caf88' : uptime > 50 ? '#e0c060' : '#e07b3a' }} />
        </div>
      </div>

      {/* Watch toggles */}
      <div className="netmon-watch-row">
        <div className="netmon-stat-label" style={{ marginBottom: 6 }}>NOTIFICATIONS</div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <label className="netmon-toggle">
            <input type="checkbox" checked={dev.watchOnline} onChange={e => onSetWatch(e.target.checked, dev.watchOffline)} />
            <span>Notify when online</span>
          </label>
          <label className="netmon-toggle">
            <input type="checkbox" checked={dev.watchOffline} onChange={e => onSetWatch(dev.watchOnline, e.target.checked)} />
            <span>Notify when offline</span>
          </label>
        </div>
      </div>

      {/* Forget */}
      <div style={{ marginTop: 'auto', paddingTop: '1.5rem' }}>
        <button className="netmon-forget-btn" onClick={onForget}>FORGET DEVICE</button>
      </div>
    </div>
  )
}

// ── Event feed ──────────────────────────────────────────────────────────
function EventFeed({ events, devices }: { events: NetEvent[]; devices: NetDevice[] }) {
  const devMap = new Map(devices.map(d => [d.mac, d]))

  if (!events.length) return (
    <div className="netmon-placeholder">No events yet — events appear as devices join and leave.</div>
  )

  return (
    <div className="netmon-events">
      {events.map(ev => {
        const dev = devMap.get(ev.mac)
        const isJoin = ev.type === 'joined'
        const isNew = ev.type === 'new'
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
                {dev && <span> · {uptimePct(dev)}% uptime</span>}
              </div>
            </div>
            <div className="netmon-event-time">{timeAgo(ev.ts)}</div>
          </div>
        )
      })}
    </div>
  )
}
