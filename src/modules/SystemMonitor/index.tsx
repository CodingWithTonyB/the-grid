import { useState, useEffect, useRef } from 'react'

interface SSHTarget {
  id: string; name: string; host: string; port: number
  username: string; password: string; keyPath: string
}
interface Stats {
  hostname: string; os: string; uptime: string
  cpuTemp: number | null; cpuPct: number; loadAvg: string
  memTotal: number; memUsed: number
  swapTotal: number; swapUsed: number
  diskTotal: string; diskUsed: string; diskPercent: string
}
type StatsResult = Stats | { error: string }
const BLANK: Omit<SSHTarget, 'id'> = { name: '', host: '', port: 22, username: '', password: '', keyPath: '' }

export default function SystemMonitor() {
  const [targets, setTargets] = useState<SSHTarget[]>([])
  const [selected, setSelected] = useState<SSHTarget | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ ...BLANK })

  useEffect(() => {
    window.ipcRenderer.invoke('load-ssh-targets').then((saved: SSHTarget[]) => {
      if (saved?.length) { setTargets(saved); setSelected(saved[0]) }
    })
  }, [])

  function saveTargets(next: SSHTarget[]) {
    setTargets(next)
    window.ipcRenderer.invoke('save-ssh-targets', next)
  }

  function addTarget() {
    if (!form.host || !form.username) return
    const t: SSHTarget = { ...form, id: `ssh-${Date.now()}`, name: form.name || form.host }
    const next = [...targets, t]
    saveTargets(next)
    setSelected(t)
    setAdding(false)
    setForm({ ...BLANK })
  }

  function removeTarget(id: string) {
    const next = targets.filter(t => t.id !== id)
    saveTargets(next)
    if (selected?.id === id) setSelected(next[0] ?? null)
  }

  return (
    <div className="sysmon">
      <div className="sysmon-sidebar">
        <div className="sysmon-sidebar-label">DEVICES</div>
        {targets.map(t => (
          <div key={t.id}
            className={`sysmon-target${selected?.id === t.id ? ' sysmon-target--active' : ''}`}
            onClick={() => setSelected(t)}
          >
            <div className="sysmon-target-name">{t.name}</div>
            <div className="sysmon-target-host">{t.host}</div>
            <button className="sysmon-target-remove" onClick={e => { e.stopPropagation(); removeTarget(t.id) }}>×</button>
          </div>
        ))}
        {adding ? (
          <div className="sysmon-add-form">
            <input className="note-input" placeholder="NAME" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <input className="note-input" placeholder="HOST / IP" value={form.host} autoFocus onChange={e => setForm(f => ({ ...f, host: e.target.value }))} />
            <input className="note-input" placeholder="USERNAME" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
            <input className="note-input" placeholder="PASSWORD" type="password" value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') addTarget() }} />
            <input className="note-input" placeholder="PORT (default 22)" type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: parseInt(e.target.value) || 22 }))} />
            <input className="note-input" placeholder="KEY PATH (optional)" value={form.keyPath} onChange={e => setForm(f => ({ ...f, keyPath: e.target.value }))} />
            <div className="sysmon-add-actions">
              <button className="save-btn" onClick={addTarget}>ADD</button>
              <button className="save-btn" style={{ borderColor: '#1a1a1a', color: '#444' }} onClick={() => { setAdding(false); setForm({ ...BLANK }) }}>CANCEL</button>
            </div>
          </div>
        ) : (
          <button className="grid-add-btn" style={{ padding: '0.5rem 0' }} onClick={() => setAdding(true)}>+ DEVICE</button>
        )}
      </div>

      <div className="sysmon-right">
        {!selected
          ? <div className="sysmon-panel"><div className="empty-state">ADD A DEVICE TO MONITOR</div></div>
          : <StatsPanel key={selected.id} target={selected} />
        }
      </div>
    </div>
  )
}

function StatsPanel({ target }: { target: SSHTarget }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    doFetch()
    timerRef.current = setInterval(doFetch, 12000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [target.id])

  async function doFetch() {
    setLoading(true)
    const r: StatsResult = await window.ipcRenderer.invoke('ssh-get-stats', target)
    setLoading(false)
    if ('error' in r) { setError(r.error); setStats(null) }
    else { setStats(r); setError(null) }
  }

  if (error) return (
    <div className="sysmon-panel">
      <div className="sysmon-error">
        <div className="sysmon-error-title">CONNECTION FAILED</div>
        <div className="sysmon-error-msg">{error}</div>
        <button className="save-btn" style={{ marginTop: '1rem' }} onClick={doFetch}>RETRY</button>
      </div>
    </div>
  )

  const memPct  = stats?.memTotal  ? Math.round((stats.memUsed  / stats.memTotal)  * 100) : 0
  const swapPct = stats?.swapTotal ? Math.round((stats.swapUsed / stats.swapTotal) * 100) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Header: name left, uptime right */}
      <div className="sysmon-topnav" style={{ justifyContent: 'space-between' }}>
        <div className="sysmon-topnav-device">{target.name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {stats && <span className="sysmon-uptime-sm">UP {stats.uptime.toUpperCase()}</span>}
          {loading && <span className="sysmon-refreshing">↻</span>}
        </div>
      </div>

      {!stats ? (
        <div className="sysmon-panel"><div className="sysmon-connecting"><span className="scan-pulse">FETCHING STATS...</span></div></div>
      ) : (
        <div className="sysmon-panel">
          <div className="sysmon-stat-grid">

            <div className="sysmon-stat-block">
              <div className="sysmon-stat-label">CPU TEMP</div>
              <div className={`sysmon-stat-val${stats.cpuTemp && stats.cpuTemp > 70 ? ' sysmon-stat-val--warn' : ''}`}>
                {stats.cpuTemp !== null ? `${stats.cpuTemp}°C` : 'N/A'}
              </div>
            </div>

            <div className="sysmon-stat-block">
              <div className="sysmon-stat-label">LOAD AVG</div>
              <div className="sysmon-stat-val">{stats.loadAvg}</div>
            </div>

            <div className="sysmon-stat-block">
              <div className="sysmon-stat-label">DISK</div>
              <div className="sysmon-stat-val">{stats.diskUsed} / {stats.diskTotal}</div>
              <div className="sysmon-stat-sub">{stats.diskPercent} used</div>
            </div>

            <div className="sysmon-stat-block">
              <div className="sysmon-stat-label">OS</div>
              <div className="sysmon-stat-val sysmon-stat-val--sm">{stats.os}</div>
            </div>

            <div className="sysmon-stat-block sysmon-stat-block--wide">
              <div className="sysmon-stat-label">CPU USAGE</div>
              <div className="sysmon-ram-row">
                <div className="sysmon-ram-bar">
                  <div className="sysmon-ram-fill" style={{ width: `${stats.cpuPct}%`, background: stats.cpuPct > 80 ? '#e07b3a' : '#5b8dee' }} />
                </div>
                <div className="sysmon-stat-val sysmon-stat-val--sm">{stats.cpuPct}%</div>
              </div>
            </div>

            <div className="sysmon-stat-block sysmon-stat-block--wide">
              <div className="sysmon-stat-label">RAM</div>
              <div className="sysmon-ram-row">
                <div className="sysmon-ram-bar">
                  <div className="sysmon-ram-fill" style={{ width: `${memPct}%` }} />
                </div>
                <div className="sysmon-stat-val sysmon-stat-val--sm">
                  {stats.memUsed} / {stats.memTotal} MB <span className="sysmon-stat-sub">({memPct}%)</span>
                </div>
              </div>
            </div>

            {stats.swapTotal > 0 && (
              <div className="sysmon-stat-block sysmon-stat-block--wide">
                <div className="sysmon-stat-label">SWAP</div>
                <div className="sysmon-ram-row">
                  <div className="sysmon-ram-bar">
                    <div className="sysmon-ram-fill" style={{ width: `${swapPct}%`, background: '#7a5dee' }} />
                  </div>
                  <div className="sysmon-stat-val sysmon-stat-val--sm">
                    {stats.swapUsed} / {stats.swapTotal} MB <span className="sysmon-stat-sub">({swapPct}%)</span>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  )
}
