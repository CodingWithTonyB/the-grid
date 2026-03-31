import { useState, useEffect, useRef } from 'react'

interface WatchTarget {
  id: string
  host: string
  label: string
}

interface TargetStatus {
  online: boolean | null
  latency: number | null
  ip: string | null
  lastSeen: string | null
  wentOnline: boolean
}

function beep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.4)
  } catch {}
}

export default function Finder() {
  const [targets, setTargets] = useState<WatchTarget[]>([])
  const [targetHistory, setTargetHistory] = useState<WatchTarget[]>([])
  const [statuses, setStatuses] = useState<Record<string, TargetStatus>>({})
  const [input, setInput] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [adding, setAdding] = useState(false)
  const prevOnline = useRef<Record<string, boolean>>({})
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    Promise.all([
      window.ipcRenderer.invoke('load-watchlist'),
      window.ipcRenderer.invoke('load-target-history'),
    ]).then(([saved, hist]) => {
      setTargets(saved)
      setTargetHistory(hist)
    })
  }, [])

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (targets.length === 0) return
    pingAll(targets)
    intervalRef.current = setInterval(() => pingAll(targets), 3000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [targets])

  async function pingAll(list: WatchTarget[]) {
    await Promise.all(list.map(async t => {
      const result: { online: boolean; latency: number | null; ip: string | null } =
        await window.ipcRenderer.invoke('ping-host', t.host)
      const wasOnline = prevOnline.current[t.id] ?? false
      const justCameOnline = result.online && !wasOnline
      prevOnline.current[t.id] = result.online
      if (justCameOnline) beep()
      setStatuses(prev => ({
        ...prev,
        [t.id]: {
          online: result.online,
          latency: result.latency,
          ip: result.ip ?? prev[t.id]?.ip ?? null,
          lastSeen: result.online ? new Date().toISOString() : prev[t.id]?.lastSeen ?? null,
          wentOnline: justCameOnline,
        }
      }))
    }))
  }

  async function addTarget(host?: string, label?: string) {
    const h = (host ?? input).trim()
    if (!h) return
    const newTarget: WatchTarget = {
      id: crypto.randomUUID(),
      host: h,
      label: (label ?? labelInput).trim() || h,
    }
    const updatedTargets = [...targets, newTarget]
    setTargets(updatedTargets)
    await window.ipcRenderer.invoke('save-watchlist', updatedTargets)

    // Save to history (deduplicated by host)
    const updatedHistory = [
      newTarget,
      ...targetHistory.filter(h => h.host !== newTarget.host)
    ].slice(0, 20)
    setTargetHistory(updatedHistory)
    await window.ipcRenderer.invoke('save-target-history', updatedHistory)

    setInput('')
    setLabelInput('')
    setAdding(false)
  }

  async function removeTarget(id: string) {
    const updated = targets.filter(t => t.id !== id)
    setTargets(updated)
    setStatuses(prev => { const n = { ...prev }; delete n[id]; return n })
    await window.ipcRenderer.invoke('save-watchlist', updated)
  }

  const activeHosts = new Set(targets.map(t => t.host))
  const historyItems = targetHistory.filter(h => !activeHosts.has(h.host))

  return (
    <div className="finder">
      <div className="finder-toolbar">
        {!adding ? (
          <button className="scan-btn" onClick={() => setAdding(true)}>+ ADD TARGET</button>
        ) : (
          <div className="finder-add-wrap">
            <div className="finder-add-row">
              <input
                className="note-input finder-input"
                placeholder="hostname or IP  (e.g. kernel.local)"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTarget()}
                autoFocus
              />
              <input
                className="note-input finder-input-label"
                placeholder="Label  (optional)"
                value={labelInput}
                onChange={e => setLabelInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTarget()}
              />
              <button className="save-btn" onClick={() => addTarget()}>ADD</button>
              <button className="finder-cancel" onClick={() => { setAdding(false); setInput(''); setLabelInput('') }}>✕</button>
            </div>
            {historyItems.length > 0 && (
              <div className="finder-history">
                <div className="finder-history-label">RECENT</div>
                {historyItems.map(h => (
                  <div key={h.host} className="finder-history-item" onClick={() => addTarget(h.host, h.label)}>
                    <span className="finder-history-label-text">{h.label !== h.host ? h.label : null}</span>
                    <span className="finder-history-host">{h.host}</span>
                    <span className="finder-history-add">+ add</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="device-list">
        {targets.length === 0 && (
          <div className="empty-state">No targets. Add a hostname or IP to watch.</div>
        )}
        {targets.map(t => {
          const s = statuses[t.id]
          const isOnline = s?.online === true
          const isPending = s?.online === null || s === undefined
          return (
            <div key={t.id} className={`finder-row${isOnline ? ' finder-row--online' : ''}`}>
              <div className="finder-dot-col">
                <div className={`finder-dot ${isPending ? 'finder-dot--pending' : isOnline ? 'finder-dot--online' : 'finder-dot--offline'}`} />
              </div>
              <div className="device-left" style={{ flex: 1 }}>
                <div className="device-primary">{t.label}</div>
                <div className="device-secondary">
                  <span className="device-hostname">{t.host}</span>
                  {s?.ip && s.ip !== t.host && <span className="device-ip-small">{s.ip}</span>}
                </div>
              </div>
              <div className="finder-right">
                {isPending && <span className="finder-status-text">checking...</span>}
                {!isPending && isOnline && <span className="finder-latency">{s.latency}ms</span>}
                {!isPending && !isOnline && s?.lastSeen && <span className="finder-offline-text">offline</span>}
                {!isPending && !isOnline && !s?.lastSeen && <span className="finder-offline-text">not found</span>}
                <button className="finder-remove" onClick={() => removeTarget(t.id)}>✕</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
