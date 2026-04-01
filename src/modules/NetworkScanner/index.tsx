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

type Tab = 'online' | 'history'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
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
  const [probing, setProbing] = useState<string | null>(null) // IP being probed
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({})
  const [deepScanAll, setDeepScanAll] = useState(false)
  const [deepScanProgress, setDeepScanProgress] = useState<{ current: number; total: number; ip: string } | null>(null)

  useEffect(() => {
    Promise.all([
      window.ipcRenderer.invoke('load-notes').then(setNotes),
      window.ipcRenderer.invoke('load-history').then(setHistory),
      window.ipcRenderer.invoke('scan-network-cached').then((cached: Device[]) => {
        if (cached && cached.length > 0) {
          setDevices(cached)
          setLastScanned(new Date())
        }
      }),
      window.ipcRenderer.invoke('get-ssid').then(setSsid),
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

    const tickInterval = setInterval(() => setTick(t => t + 1), 10_000)

    return () => {
      window.ipcRenderer.off('scanner-update', onUpdate)
      window.ipcRenderer.off('deep-scan-progress', onDeepProgress)
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

  function renderProbeResult(ip: string) {
    const probe = probeResults[ip]
    if (!probe) return null

    return (
      <div className="probe-results">
        {/* Device identity */}
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

        {/* Open ports */}
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

        {/* Web services */}
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

        {/* mDNS services */}
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

        {/* Nothing found */}
        {probe.ports.length === 0 && (
          <div className="probe-empty">No open ports found — device may have a firewall</div>
        )}
      </div>
    )
  }

  function renderDeviceRow(mac: string, ip: string, hostname: string | null, iface: string, isOffline = false) {
    const info = notes[mac]
    const isOpen = selected === mac
    const primary = info?.label || null
    const hasProbe = !!probeResults[ip]
    const isProbing = probing === ip

    return (
      <div key={mac} className={`device-row${isOpen ? ' device-row--open' : ''}${isOffline ? ' device-row--offline' : ''}`}>
        <div className="device-summary" onClick={() => selectDevice(mac)}>
          <div className="device-left">
            <div className="device-primary">{primary ?? ip}</div>
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

            {/* Probe results */}
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
        </div>

        {ssid && <div className="ssid-badge">{ssid}</div>}

        <div className="scanner-actions">
          {!deepScanAll && devices.length > 0 && (
            <button className="scan-btn probe-btn" onClick={runDeepScanAll} disabled={deepScanAll}>
              SCAN ALL
            </button>
          )}
          {deepScanAll && deepScanProgress && (
            <span className="scan-pulse deep-scan-status">
              {deepScanProgress.current}/{deepScanProgress.total} — {deepScanProgress.ip}
            </span>
          )}
        </div>

        <div className="scanner-status">
          {scanning
            ? <span className="scan-pulse">SCANNING</span>
            : lastScanned
              ? <span className="scan-last">updated {timeAgo(lastScanned.toISOString())}</span>
              : null
          }
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
      </div>
    </div>
  )
}
