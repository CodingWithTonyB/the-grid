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

  useEffect(() => {
    // Load cached results immediately, then subscribe to background updates
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
      // Only do a fresh scan if no cached data was available
      if (devices.length === 0) runScan()
    })

    // Listen for background scan updates
    const onUpdate = (_e: unknown, result: Device[]) => {
      setDevices(result)
      setLastScanned(new Date())
    }
    window.ipcRenderer.on('scanner-update', onUpdate)

    const tickInterval = setInterval(() => setTick(t => t + 1), 10_000)

    return () => {
      window.ipcRenderer.off('scanner-update', onUpdate)
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

  function renderDeviceRow(mac: string, ip: string, hostname: string | null, iface: string, isOffline = false) {
    const info = notes[mac]
    const isOpen = selected === mac
    const primary = info?.label || null

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
