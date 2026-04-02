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
  vulns?: { severity: string; title: string; detail: string; port?: number; verified?: boolean; evidence?: string[] }[]
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

// WiFi Recon types
interface WifiNetwork {
  ssid: string; bssid: string; rssi: number; channel: number
  band: number; channelWidth: number; noise: number; ibss: boolean
  countryCode: string; beaconInterval: number; security: string; securityLevel: number
  vendor: string; signalQuality: number; bandLabel: string
}

type Mode = 'network' | 'recon'
type NetTab = 'devices' | 'networks' | 'events'

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
  const [mode, setMode] = useState<Mode>('network')
  const [netTab, setNetTab] = useState<NetTab>('devices')

  // Probe state
  const [probing, setProbing] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({})
  const [deepScanAll, setDeepScanAll] = useState(false)
  const [deepScanProgress, setDeepScanProgress] = useState<{ current: number; total: number; ip: string } | null>(null)

  // Verification state
  const [verifying, setVerifying] = useState<string | null>(null) // "ip:port"
  const [verifyResults, setVerifyResults] = useState<Record<string, { verified: boolean; evidence: string[] }>>({})

  // Network Monitor state
  const [netmon, setNetmon] = useState<NetmonSnapshot>({ devices: [], events: [] })

  // WiFi Recon state
  const [reconNetworks, setReconNetworks] = useState<WifiNetwork[]>([])
  const [reconScanning, setReconScanning] = useState(false)
  const [reconFilter, setReconFilter] = useState<'all' | '2.4' | '5' | '6'>('all')
  const [reconSort, setReconSort] = useState<'signal' | 'channel' | 'security'>('signal')
  const [reconExpanded, setReconExpanded] = useState<string | null>(null)


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

  async function verifyVuln(ip: string, port: number, service: string) {
    const key = `${ip}:${port}`
    setVerifying(key)
    try {
      const result = await window.ipcRenderer.invoke('verify-vuln', ip, port, service)
      setVerifyResults(prev => ({ ...prev, [key]: { verified: result.verified, evidence: result.evidence } }))
    } catch { setVerifyResults(prev => ({ ...prev, [key]: { verified: false, evidence: ['Verification failed'] } })) }
    setVerifying(null)
  }

  async function runReconScan() {
    setReconScanning(true)
    const results: WifiNetwork[] = await window.ipcRenderer.invoke('wifi-recon-scan')
    setReconNetworks(results)
    setReconScanning(false)
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

        {probe.ports.length > 0 && (() => {
          const dangerMap: Record<number, { warn: string; service: string }> = {
            23: { warn: 'PLAINTEXT — passwords visible on network', service: 'Telnet' },
            21: { warn: 'PLAINTEXT — credentials sent unencrypted', service: 'FTP' },
            445: { warn: 'RANSOMWARE TARGET', service: 'SMB' },
            139: { warn: 'LEAKS SYSTEM INFO', service: 'NetBIOS' },
            3389: { warn: 'BRUTE-FORCE TARGET', service: 'RDP' },
            5900: { warn: 'OFTEN POORLY SECURED', service: 'VNC' },
            1883: { warn: 'OFTEN NO AUTH', service: 'MQTT' },
            161: { warn: 'DEFAULT COMMUNITY STRING', service: 'SNMP' },
            1900: { warn: 'CAN OPEN PORTS INTERNALLY', service: 'UPnP' },
            22: { warn: '', service: 'SSH' },
          }
          // Also verifiable: web ports
          const webPorts = new Set([80, 443, 8080, 8443, 8000, 8888, 3000, 5000, 9090])
          return (
            <div className="probe-section">
              <div className="probe-section-title">OPEN PORTS ({probe.ports.length})</div>
              <div className="probe-ports">
                {probe.ports.map(p => {
                  const danger = dangerMap[p.port]
                  const isVerifiable = !!danger || webPorts.has(p.port)
                  const vKey = `${probe.ip}:${p.port}`
                  const vResult = verifyResults[vKey]
                  const isVerifying = verifying === vKey
                  return (
                    <div key={p.port} className="probe-port-entry">
                      <div className={`probe-port-row${danger?.warn ? ' probe-port-row--danger' : ''}`}>
                        <span className="probe-port-num">{p.port}</span>
                        <span className="probe-port-name">{p.name}</span>
                        {p.banner && (
                          <span className="probe-port-banner" title={p.banner}>
                            {p.banner.slice(0, 50)}{p.banner.length > 50 ? '…' : ''}
                          </span>
                        )}
                        {danger?.warn && <span className="probe-port-warn">{danger.warn}</span>}
                        {isVerifiable && !vResult && (
                          <button className={`verify-btn${isVerifying ? ' verify-btn--active' : ''}`}
                            onClick={() => verifyVuln(probe.ip, p.port, danger?.service || 'HTTP')}
                            disabled={isVerifying}>
                            {isVerifying ? '...' : 'VERIFY'}
                          </button>
                        )}
                        {vResult && (
                          <span className={`verify-status${vResult.verified ? ' verify-status--confirmed' : ' verify-status--unconfirmed'}`}>
                            {vResult.verified ? 'CONFIRMED' : 'UNCONFIRMED'}
                          </span>
                        )}
                      </div>
                      {vResult && vResult.evidence.length > 0 && (
                        <div className="verify-evidence">
                          {vResult.evidence.map((e, i) => (
                            <div key={i} className={`verify-evidence-line${e === e.toUpperCase() && e.length > 10 ? ' verify-evidence-line--alert' : ''}`}>{e}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

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

        {/* Extra findings — only show things NOT already visible in port list */}
        {(() => {
          const portNums = new Set(probe.ports.map(p => p.port))
          const dangerPorts = new Set([23,21,445,139,3389,5900,1883,5353,161,1900,22])
          const extras = (probe.vulns || []).filter(v => !v.port || !dangerPorts.has(v.port) || !portNums.has(v.port))
          if (extras.length === 0 && probe.ports.length > 0) {
            const hasDanger = probe.ports.some(p => [23,21,445,139,3389,5900,1883,161,1900].includes(p.port))
            if (!hasDanger) return <div className="vuln-clean">NO VULNERABILITIES DETECTED</div>
            return null
          }
          if (extras.length === 0) return null
          return (
            <div className="vuln-results">
              <div className="vuln-header">
                SECURITY FINDINGS
                <span className="vuln-count">{extras.length}</span>
              </div>
              {extras.map((v, vi: number) => (
                <div key={vi} className={`vuln-finding vuln-finding--${v.severity}`}>
                  <span className="vuln-severity">{v.severity.toUpperCase()}</span>
                  <div className="vuln-body">
                    <div className="vuln-title">{v.title}</div>
                    <div className="vuln-detail">{v.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
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

  function getDeviceVulnCount(ip: string): { critical: number; high: number; medium: number; total: number } {
    const probe = probeResults[ip]
    if (!probe) return { critical: 0, high: 0, medium: 0, total: 0 }
    const dangerPorts = new Set([23,21,445,139,3389,5900,1883,161,1900])
    const portVulns = probe.ports.filter(p => dangerPorts.has(p.port)).length
    const extraVulns = (probe.vulns || []).length
    const critical = (probe.vulns || []).filter(v => v.severity === 'critical').length +
      probe.ports.filter(p => p.port === 23).length
    const high = (probe.vulns || []).filter(v => v.severity === 'high').length +
      probe.ports.filter(p => [21,445,3389,5900].includes(p.port)).length
    const medium = (probe.vulns || []).filter(v => v.severity === 'medium').length +
      probe.ports.filter(p => [139,1883,161,1900].includes(p.port)).length
    return { critical, high, medium, total: portVulns + extraVulns }
  }

  function renderDeviceRow(mac: string, ip: string, hostname: string | null, iface: string, isOffline = false) {
    const info = notes[mac]
    const isOpen = selected === mac
    const primary = info?.label || null
    const hasProbe = !!probeResults[ip]
    const isProbing = probing === ip
    const nd = netmonMap.get(mac)
    const vulns = getDeviceVulnCount(ip)

    return (
      <div key={mac} className={`device-row${isOpen ? ' device-row--open' : ''}${isOffline ? ' device-row--offline' : ''}${vulns.total > 0 ? ' device-row--vuln' : ''}`}>
        <div className="device-summary" onClick={() => selectDevice(mac)}>
          <div className="device-left">
            <div className="device-primary">
              {nd && <span className={`netmon-dot${nd.online ? ' online' : ''}`} />}
              {primary ?? ip}
              {nd && (nd.watchOnline || nd.watchOffline) && <span className="netmon-bell-sm">&#x1f514;</span>}
              {vulns.total > 0 && (
                <span className={`device-vuln-badge${vulns.critical > 0 ? ' vuln-crit' : vulns.high > 0 ? ' vuln-high' : ' vuln-med'}`}>
                  {vulns.critical > 0 ? `${vulns.critical} CRITICAL` : vulns.high > 0 ? `${vulns.high} HIGH` : `${vulns.medium} MEDIUM`}
                </span>
              )}
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

            {/* Scan buttons */}
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
                <span className="scan-pulse">SCANNING PORTS, SERVICES & VULNERABILITIES</span>
              </div>
            )}
            {hasProbe && renderProbeResult(ip)}

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

  // Recon analysis helpers
  const reconFiltered = reconFilter === 'all' ? reconNetworks
    : reconNetworks.filter(n => n.bandLabel.startsWith(reconFilter))
  const reconSorted = [...reconFiltered].sort((a, b) => {
    if (reconSort === 'signal') return b.rssi - a.rssi
    if (reconSort === 'channel') return a.channel - b.channel
    return a.securityLevel - b.securityLevel
  })

  // ── Your network security assessment ──
  const yourNets = reconNetworks.filter(n => n.ssid === ssid)
  const yourBestSec = yourNets.length ? Math.max(...yourNets.map(n => n.securityLevel)) : 0
  const yourSecGrade = yourBestSec >= 5 ? 'A' : yourBestSec === 4 ? 'B' : yourBestSec === 3 ? 'C' : yourBestSec === 2 ? 'F' : yourBestSec === 1 ? 'F' : '?'
  const yourBands = new Set(yourNets.map(n => n.band))
  const yourAPCount = yourNets.length

  // Channel recommendation for 2.4 GHz (only 1, 6, 11 don't overlap)
  const ch24Counts: Record<number, number> = {}
  for (const n of reconNetworks.filter(n => n.band === 1)) {
    ch24Counts[n.channel] = (ch24Counts[n.channel] || 0) + 1
  }
  const bestCh24 = [1, 6, 11].sort((a, b) => (ch24Counts[a] || 0) - (ch24Counts[b] || 0))[0]
  const yourCh24 = yourNets.find(n => n.band === 1)?.channel

  // ── Anomaly detection ──
  const reconAnomalies: { type: string; msg: string; level: 'warn' | 'danger' | 'info' }[] = []

  // Open networks
  const openNets = reconNetworks.filter(n => n.securityLevel === 1)
  if (openNets.length) reconAnomalies.push({ type: 'open', msg: `${openNets.length} open network${openNets.length > 1 ? 's' : ''} — all traffic visible in plaintext`, level: 'danger' })
  // WEP
  const wepNets = reconNetworks.filter(n => n.securityLevel === 2)
  if (wepNets.length) reconAnomalies.push({ type: 'wep', msg: `${wepNets.length} WEP network${wepNets.length > 1 ? 's' : ''} — crackable in minutes with aircrack-ng`, level: 'danger' })
  // WPA1
  const wpaNets = reconNetworks.filter(n => n.securityLevel === 3)
  if (wpaNets.length) reconAnomalies.push({ type: 'wpa', msg: `${wpaNets.length} WPA1 network${wpaNets.length > 1 ? 's' : ''} — TKIP encryption is deprecated and vulnerable`, level: 'warn' })
  // Evil twin: same SSID with open/WEP + WPA+
  const ssidSec = new Map<string, Set<number>>()
  for (const n of reconNetworks) {
    if (n.ssid === '(hidden)') continue
    if (!ssidSec.has(n.ssid)) ssidSec.set(n.ssid, new Set())
    ssidSec.get(n.ssid)!.add(n.securityLevel)
  }
  for (const [name, secs] of ssidSec) {
    const arr = [...secs]
    const hasWeak = arr.some(s => s <= 2)
    const hasStrong = arr.some(s => s >= 4)
    if (hasWeak && hasStrong) reconAnomalies.push({ type: 'twin', msg: `"${name}" has both secure and insecure versions — possible evil twin attack`, level: 'danger' })
  }
  // Channel congestion
  for (const [ch, count] of Object.entries(ch24Counts)) {
    if (count >= 5) reconAnomalies.push({ type: 'congestion', msg: `Channel ${ch} (2.4 GHz) congested — ${count} networks competing`, level: 'info' })
  }
  // Channel recommendation
  if (yourCh24 && yourCh24 !== bestCh24 && (ch24Counts[yourCh24] || 0) > (ch24Counts[bestCh24] || 0) + 1) {
    reconAnomalies.push({ type: 'channel', msg: `Your 2.4 GHz is on CH ${yourCh24} (${ch24Counts[yourCh24] || 0} networks) — CH ${bestCh24} has less interference (${ch24Counts[bestCh24] || 0})`, level: 'info' })
  }
  // Hidden networks
  const hiddenCount = reconNetworks.filter(n => n.ssid === '(hidden)').length
  if (hiddenCount) reconAnomalies.push({ type: 'hidden', msg: `${hiddenCount} hidden network${hiddenCount > 1 ? 's' : ''} — still detectable via probe requests`, level: 'info' })
  // Your security
  if (yourBestSec > 0 && yourBestSec <= 3) reconAnomalies.push({ type: 'yours', msg: `Your network uses ${yourNets[0]?.security} — upgrade to WPA3 if your router supports it`, level: 'warn' })

  // ── Attacker perspective for each security type ──
  function getAttackContext(secLevel: number, security: string): string {
    if (secLevel <= 1) return 'No password needed. Attacker joins instantly. All your traffic is readable.'
    if (secLevel === 2) return 'WEP cracked in 2-5 minutes with aircrack-ng. Practically no security.'
    if (secLevel === 3) return 'WPA1/TKIP vulnerable to BECK-TEWS attack. Handshake capturable, dictionary-attackable offline.'
    if (secLevel === 4) return 'WPA2 — capture the 4-way handshake when any device connects, then brute-force offline. Strong random password makes this very hard.'
    if (secLevel >= 5) {
      if (security.includes('Enterprise')) return 'Enterprise auth with RADIUS server. Very hard to attack without insider access.'
      return 'WPA3 uses SAE — resistant to offline dictionary attacks and handshake capture. Best consumer security available.'
    }
    return ''
  }

  // ── Unique SSIDs for AP count ──
  const ssidAPCounts = new Map<string, number>()
  for (const n of reconNetworks) {
    if (n.ssid === '(hidden)') continue
    ssidAPCounts.set(n.ssid, (ssidAPCounts.get(n.ssid) || 0) + 1)
  }

  return (
    <div className="scanner">
      {/* Top-level mode switcher */}
      <div className="scanner-mode-bar">
        <button className={`scanner-mode-btn${mode === 'network' ? ' active' : ''}`} onClick={() => setMode('network')}>
          NETWORK
        </button>
        <button className={`scanner-mode-btn${mode === 'recon' ? ' active' : ''}`} onClick={() => { setMode('recon'); if (reconNetworks.length === 0 && !reconScanning) runReconScan() }}>
          RECON
        </button>
      </div>

      {mode === 'network' && (
        <>
          <div className="scanner-toolbar">
            <div className="scanner-tabs">
              <button className={`tab-btn${netTab === 'devices' ? ' tab-btn--active' : ''}`} onClick={() => setNetTab('devices')}>
                DEVICES <span className="tab-count">{devices.length}</span>
              </button>
              <button className={`tab-btn${netTab === 'networks' ? ' tab-btn--active' : ''}`} onClick={() => { setNetTab('networks'); window.ipcRenderer.invoke('get-ssid').then(setSsid) }}>
                NETWORKS <span className="tab-count">{networks.length}</span>
              </button>
              <button className={`tab-btn${netTab === 'events' ? ' tab-btn--active' : ''}`} onClick={() => setNetTab('events')}>
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
                  <button className="scanner-action-btn" onClick={runDeepScanAll} disabled={deepScanAll}>
                    DEEP SCAN
                  </button>
                )
              )}
            </div>
          </div>

          <div className="device-list">
            {netTab === 'devices' && (
              <>
                {/* Vuln summary — online devices only */}
                {(() => {
                  const onlineIps = sortedDevices.map(d => d.ip)
                  const totals = onlineIps.reduce((acc, ip) => {
                    const v = getDeviceVulnCount(ip)
                    acc.critical += v.critical; acc.high += v.high; acc.medium += v.medium; acc.total += v.total
                    return acc
                  }, { critical: 0, high: 0, medium: 0, total: 0 })
                  const probed = onlineIps.filter(ip => !!probeResults[ip]).length
                  if (probed === 0) return null
                  return (
                    <div className={`vuln-summary-bar${totals.total > 0 ? ' vuln-summary-bar--issues' : ' vuln-summary-bar--clean'}`}>
                      {totals.total > 0 ? (
                        <>
                          <span className="vuln-summary-icon">⚠</span>
                          <span className="vuln-summary-text">
                            {totals.critical > 0 && <span className="vuln-sum-crit">{totals.critical} critical</span>}
                            {totals.high > 0 && <span className="vuln-sum-high">{totals.high} high</span>}
                            {totals.medium > 0 && <span className="vuln-sum-med">{totals.medium} medium</span>}
                            <span className="vuln-sum-total">across {probed} scanned device{probed !== 1 ? 's' : ''}</span>
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="vuln-summary-icon vuln-summary-icon--clean">✓</span>
                          <span className="vuln-summary-text">
                            <span className="vuln-sum-clean">No vulnerabilities</span>
                            <span className="vuln-sum-total">{probed} device{probed !== 1 ? 's' : ''} scanned</span>
                          </span>
                        </>
                      )}
                    </div>
                  )
                })()}
                {sortedDevices.map(d => renderDeviceRow(d.mac, d.ip, d.hostname, d.iface))}
                {offlineHistory.length > 0 && (
                  <>
                    <div className="device-list-divider">OFFLINE</div>
                    {offlineHistory.map(h => renderDeviceRow(h.mac, h.ip, h.hostname, '', true))}
                  </>
                )}
                {devices.length === 0 && offlineHistory.length === 0 && (
                  <div className="empty-state">No devices found yet.</div>
                )}
              </>
            )}

            {netTab === 'networks' && networks.map(([netName, netDevices]) => {
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
            {netTab === 'networks' && networks.length === 0 && (
              <div className="empty-state">No networks seen yet. Scan to discover devices.</div>
            )}

            {netTab === 'events' && (
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
        </>
      )}

      {mode === 'recon' && (
        <div className="recon-view">
          {/* Recon toolbar */}
          <div className="recon-toolbar">
            <div className="recon-filters">
              {(['all', '2.4', '5', '6'] as const).map(f => (
                <button key={f} className={`recon-filter-btn${reconFilter === f ? ' active' : ''}`}
                  onClick={() => setReconFilter(f)}>
                  {f === 'all' ? 'ALL' : `${f} GHz`}
                </button>
              ))}
            </div>
            <div className="recon-sorts">
              {(['signal', 'channel', 'security'] as const).map(s => (
                <button key={s} className={`recon-filter-btn${reconSort === s ? ' active' : ''}`}
                  onClick={() => setReconSort(s)}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            <span className="recon-count">{reconFiltered.length} network{reconFiltered.length !== 1 ? 's' : ''}</span>
            <button className="scanner-action-btn" onClick={runReconScan} disabled={reconScanning}>
              {reconScanning ? 'SCANNING...' : 'RESCAN'}
            </button>
          </div>

          {reconScanning && reconNetworks.length === 0 && (
            <div className="empty-state"><span className="scan-pulse">SCANNING NEARBY NETWORKS</span></div>
          )}

          {/* Compact intel strip — always visible, expands on click */}
          {reconNetworks.length > 0 && (
            <div className={`recon-intel-strip${reconExpanded === '__intel__' ? ' recon-intel-strip--open' : ''}`}>
              <div className="recon-intel-bar" onClick={() => setReconExpanded(reconExpanded === '__intel__' ? null : '__intel__')}>
                {yourNets.length > 0 && <span className={`recon-intel-grade recon-grade--${yourSecGrade}`}>{yourSecGrade}</span>}
                <div className="recon-security-summary">
                  {(() => {
                    const open = reconNetworks.filter(n => n.securityLevel === 1).length
                    const wep = reconNetworks.filter(n => n.securityLevel === 2).length
                    const wpa = reconNetworks.filter(n => n.securityLevel === 3).length
                    const wpa2 = reconNetworks.filter(n => n.securityLevel === 4).length
                    const wpa3 = reconNetworks.filter(n => n.securityLevel >= 5).length
                    return (
                      <>
                        {open > 0 && <span className="recon-sec-badge recon-sec--open">{open} OPEN</span>}
                        {wep > 0 && <span className="recon-sec-badge recon-sec--wep">{wep} WEP</span>}
                        {wpa > 0 && <span className="recon-sec-badge recon-sec--wpa">{wpa} WPA</span>}
                        {wpa2 > 0 && <span className="recon-sec-badge recon-sec--wpa2">{wpa2} WPA2</span>}
                        {wpa3 > 0 && <span className="recon-sec-badge recon-sec--wpa3">{wpa3} WPA3</span>}
                      </>
                    )
                  })()}
                </div>
                {reconAnomalies.filter(a => a.level === 'danger').length > 0 && (
                  <span className="recon-intel-warn">⚠ {reconAnomalies.filter(a => a.level === 'danger').length}</span>
                )}
                <span className="recon-intel-toggle">{reconExpanded === '__intel__' ? '▲' : '▼'}</span>
              </div>

              {reconExpanded === '__intel__' && (
                <div className="recon-intel-body">
                  {/* Your network assessment */}
                  {yourNets.length > 0 && (
                    <div className="recon-assessment">
                      <div className="recon-section-title">YOUR NETWORK — {ssid}</div>
                      <div className="recon-assess-grid">
                        <div className="recon-assess-cell">
                          <span className="recon-assess-label">SECURITY</span>
                          <span className={`recon-assess-grade recon-grade--${yourSecGrade}`}>{yourSecGrade}</span>
                          <span className="recon-assess-sub">{yourNets[0]?.security}</span>
                        </div>
                        <div className="recon-assess-cell">
                          <span className="recon-assess-label">ACCESS POINTS</span>
                          <span className="recon-assess-val">{yourAPCount}</span>
                          <span className="recon-assess-sub">{yourBands.has(1) ? '2.4' : ''}{yourBands.has(1) && yourBands.has(2) ? '+' : ''}{yourBands.has(2) ? '5' : ''}{(yourBands.has(1) || yourBands.has(2)) && yourBands.has(3) ? '+' : ''}{yourBands.has(3) ? '6' : ''} GHz</span>
                        </div>
                        <div className="recon-assess-cell">
                          <span className="recon-assess-label">BEST CH 2.4</span>
                          <span className="recon-assess-val">CH {bestCh24}</span>
                          <span className="recon-assess-sub">{ch24Counts[bestCh24] || 0} nets{yourCh24 ? ` (you: ${yourCh24})` : ''}</span>
                        </div>
                        <div className="recon-assess-cell">
                          <span className="recon-assess-label">ATTACK SURFACE</span>
                          <span className="recon-assess-val">{getAttackContext(yourBestSec, yourNets[0]?.security).length > 40 ? (yourBestSec >= 5 ? 'LOW' : yourBestSec >= 4 ? 'MED' : 'HIGH') : 'N/A'}</span>
                          <span className="recon-assess-sub">{yourBestSec >= 5 ? 'Resistant to offline attacks' : yourBestSec >= 4 ? 'Handshake capturable' : 'Easily compromised'}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Anomaly alerts */}
                  {reconAnomalies.length > 0 && (
                    <div className="recon-alerts">
                      {reconAnomalies.map((a, i) => (
                        <div key={i} className={`recon-alert recon-alert--${a.level}`}>
                          <span className="recon-alert-icon">{a.level === 'danger' ? '⚠' : a.level === 'warn' ? '⚡' : 'ℹ'}</span>
                          <span>{a.msg}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Channel map */}
                  <div className="recon-channel-map">
                    <div className="recon-section-title">CHANNEL MAP</div>
                    <div className="recon-channels">
                      {(() => {
                        const channelCounts: Record<string, { count: number; strongest: number }> = {}
                        for (const n of reconFiltered) {
                          const key = `${n.channel} ${n.bandLabel}`
                          if (!channelCounts[key]) channelCounts[key] = { count: 0, strongest: -100 }
                          channelCounts[key].count++
                          if (n.rssi > channelCounts[key].strongest) channelCounts[key].strongest = n.rssi
                        }
                        return Object.entries(channelCounts)
                          .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                          .map(([key, val]) => {
                            const congestion = val.count >= 5 ? 'high' : val.count >= 3 ? 'med' : 'low'
                            return (
                              <div key={key} className={`recon-ch recon-ch--${congestion}`}>
                                <div className="recon-ch-num">CH {key.split(' ')[0]}</div>
                                <div className="recon-ch-bar-wrap">
                                  <div className="recon-ch-bar" style={{ height: `${Math.min(100, val.count * 20)}%` }} />
                                </div>
                                <div className="recon-ch-count">{val.count}</div>
                              </div>
                            )
                          })
                      })()}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Network list */}
          <div className="device-list">
            {reconSorted.map((net, i) => {
              const signalBars = net.signalQuality >= 75 ? 4 : net.signalQuality >= 50 ? 3 : net.signalQuality >= 25 ? 2 : 1
              const isVulnerable = net.securityLevel <= 2
              const isYours = net.ssid === ssid
              const rowKey = `${net.ssid}-${net.channel}-${net.band}-${i}`
              const isOpen = reconExpanded === rowKey
              // Estimate distance from RSSI (free-space path loss, rough)
              const distMeters = net.rssi !== 0 ? Math.round(Math.pow(10, (27.55 - (20 * Math.log10(net.band === 1 ? 2437 : net.band === 2 ? 5200 : 6000)) + Math.abs(net.rssi)) / 20)) : null
              // Count how many APs share this channel
              const channelPeers = reconNetworks.filter(n => n.channel === net.channel && n.band === net.band).length - 1

              return (
                <div key={rowKey} className={`recon-row-wrap${isOpen ? ' recon-row-wrap--open' : ''}`}>
                  <div className={`recon-row${isVulnerable ? ' recon-row--vuln' : ''}${isYours ? ' recon-row--yours' : ''}`}
                    onClick={() => setReconExpanded(isOpen ? null : rowKey)}>
                    <div className="recon-signal">
                      <div className="recon-bars">
                        {[1, 2, 3, 4].map(b => (
                          <div key={b} className={`recon-bar${b <= signalBars ? ' active' : ''}`} />
                        ))}
                      </div>
                      <span className="recon-rssi">{net.rssi}</span>
                    </div>
                    <div className="recon-info">
                      <div className="recon-ssid">
                        {net.ssid === '(hidden)' ? <em className="recon-hidden">(hidden)</em> : net.ssid}
                        {isYours && <span className="recon-yours-badge">YOU</span>}
                      </div>
                      <div className="recon-meta">
                        <span className="recon-band-tag">{net.bandLabel}</span>
                        <span className="recon-ch-tag">CH {net.channel}</span>
                        {net.vendor && <span className="recon-vendor">{net.vendor}</span>}
                        {net.bssid && <span className="recon-bssid">{net.bssid}</span>}
                      </div>
                    </div>
                    <div className={`recon-security-tag recon-sec-lvl--${net.securityLevel <= 1 ? 'open' : net.securityLevel === 2 ? 'wep' : net.securityLevel <= 4 ? 'wpa' : 'wpa3'}`}>
                      {net.security}
                      {isVulnerable && <span className="recon-vuln-icon"> ⚠</span>}
                    </div>
                    <span className="device-toggle">{isOpen ? '▲' : '▼'}</span>
                  </div>

                  {isOpen && (
                    <div className="recon-detail">
                      <div className="recon-detail-grid">
                        <div className="recon-detail-cell">
                          <span className="recon-detail-label">SIGNAL</span>
                          <span className="recon-detail-val">{net.rssi} dBm</span>
                          <span className="recon-detail-sub">{net.signalQuality}% quality</span>
                        </div>
                        <div className="recon-detail-cell">
                          <span className="recon-detail-label">EST. DISTANCE</span>
                          <span className="recon-detail-val">{distMeters !== null ? (distMeters > 100 ? `~${Math.round(distMeters / 10) * 10}m` : `~${distMeters}m`) : '—'}</span>
                        </div>
                        <div className="recon-detail-cell">
                          <span className="recon-detail-label">CHANNEL</span>
                          <span className="recon-detail-val">CH {net.channel}</span>
                          <span className="recon-detail-sub">{channelPeers > 0 ? `${channelPeers} other${channelPeers > 1 ? 's' : ''} on same` : 'no interference'}</span>
                        </div>
                        <div className="recon-detail-cell">
                          <span className="recon-detail-label">BAND</span>
                          <span className="recon-detail-val">{net.bandLabel}</span>
                          <span className="recon-detail-sub">width {net.channelWidth === 1 ? '20' : net.channelWidth === 2 ? '40' : net.channelWidth === 3 ? '80' : net.channelWidth === 4 ? '160' : '?'} MHz</span>
                        </div>
                      </div>
                      <div className="recon-detail-grid">
                        <div className="recon-detail-cell">
                          <span className="recon-detail-label">SECURITY</span>
                          <span className={`recon-detail-val recon-sec-lvl--${net.securityLevel <= 1 ? 'open' : net.securityLevel === 2 ? 'wep' : net.securityLevel <= 4 ? 'wpa' : 'wpa3'}`}>{net.security}</span>
                          {isVulnerable && <span className="recon-detail-sub" style={{ color: '#e05555' }}>{net.securityLevel <= 1 ? 'No encryption — traffic visible to anyone' : 'WEP crackable in minutes'}</span>}
                        </div>
                        <div className="recon-detail-cell">
                          <span className="recon-detail-label">NOISE</span>
                          <span className="recon-detail-val">{net.noise} dBm</span>
                          <span className="recon-detail-sub">SNR {net.rssi - net.noise} dB</span>
                        </div>
                        {net.bssid && (
                          <div className="recon-detail-cell">
                            <span className="recon-detail-label">BSSID</span>
                            <span className="recon-detail-val recon-detail-val--mono">{net.bssid}</span>
                            {net.vendor && <span className="recon-detail-sub">{net.vendor}</span>}
                          </div>
                        )}
                        <div className="recon-detail-cell">
                          <span className="recon-detail-label">BEACON</span>
                          <span className="recon-detail-val">{net.beaconInterval}ms</span>
                          <span className="recon-detail-sub">{net.ibss ? 'Ad-hoc' : 'Infrastructure'}</span>
                        </div>
                      </div>
                      {/* Attacker perspective */}
                      <div className="recon-attack-context">
                        <span className="recon-detail-label">ATTACKER PERSPECTIVE</span>
                        <div className="recon-attack-text">{getAttackContext(net.securityLevel, net.security)}</div>
                        {(ssidAPCounts.get(net.ssid) || 0) > 1 && (
                          <div className="recon-attack-note">{ssidAPCounts.get(net.ssid)} access points — likely mesh or multi-band router</div>
                        )}
                        {net.ssid === '(hidden)' && (
                          <div className="recon-attack-note">Hidden SSID provides no real security — devices broadcast the name in probe requests when reconnecting</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
