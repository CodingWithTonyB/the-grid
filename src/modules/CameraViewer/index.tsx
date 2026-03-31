import { useState, useEffect, useRef } from 'react'

interface NVRConfig {
  rtspHost: string
  rtspPort: number
  username: string
  password: string
  channels: number
  mac?: string
}

const DEFAULT_FORM = {
  rtspHost: '192.168.12.100',
  rtspPort: '554',
  username: 'admin',
  password: '',
  channels: '4',
  mac: '',
}

export default function CameraViewer() {
  const [config, setConfig] = useState<NVRConfig | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [ports, setPorts] = useState<Record<number, number>>({})
  const [loaded, setLoaded] = useState<Record<number, boolean>>({})
  const [expanded, setExpanded] = useState<number | null>(null)
  const [camStatus, setCamStatus] = useState<Record<number, string>>({})

  // Motion
  const [motion, setMotion] = useState<Record<number, boolean>>({})

  const imgRefs = useRef<Record<number, HTMLImageElement | null>>({})

  useEffect(() => {
    window.ipcRenderer.invoke('load-nvr-config').then((c: NVRConfig | null) => {
      if (c) {
        setConfig(c)
        setForm({ rtspHost: c.rtspHost, rtspPort: String(c.rtspPort), username: c.username, password: c.password, channels: String(c.channels), mac: c.mac || '' })
        startStreams(c)
      } else {
        setConfiguring(true)
      }
    })

    // Load initial motion state + camera status
    window.ipcRenderer.invoke('nvr-motion-state').then((s: Record<number, boolean>) => setMotion(s))
    window.ipcRenderer.invoke('camera-status-all').then((s: Record<number, string>) => { if (s) setCamStatus(s) })

    // Listen for live motion events
    const motionHandler = (_: unknown, { channel, active }: { channel: number; active: boolean }) => {
      setMotion(prev => ({ ...prev, [channel]: active }))
    }
    window.ipcRenderer.on('nvr-motion', motionHandler)

    // Listen for camera status events
    const statusHandler = (_: unknown, { channel, status }: { channel: number; status: string }) => {
      setCamStatus(prev => ({ ...prev, [channel]: status }))
    }
    window.ipcRenderer.on('camera-status', statusHandler)

    return () => {
      window.ipcRenderer.invoke('stop-camera-streams')
      window.ipcRenderer.off('nvr-motion', motionHandler)
      window.ipcRenderer.off('camera-status', statusHandler)
    }
  }, [])

  async function startStreams(c: NVRConfig) {
    setCamStatus({})
    const p = await window.ipcRenderer.invoke('start-camera-streams', c)
    setPorts(p)
    setLoaded({})
    setTimeout(() => {
      setLoaded(prev => {
        const next: Record<number, boolean> = { ...prev }
        for (let ch = 1; ch <= c.channels; ch++) next[ch] = true
        return next
      })
    }, 6000)
  }

  async function saveConfig() {
    const host = form.rtspHost.trim()
    // Auto-detect MAC from network scan if not set
    let mac = form.mac.trim()
    if (!mac) {
      const devices: { ip: string; mac: string }[] = await window.ipcRenderer.invoke('scan-network-cached')
      const match = devices.find(d => d.ip === host)
      if (match) mac = match.mac
    }
    const c: NVRConfig = {
      rtspHost: host,
      rtspPort: parseInt(form.rtspPort) || 554,
      username: form.username.trim(),
      password: form.password,
      channels: Math.min(8, Math.max(1, parseInt(form.channels) || 4)),
      mac,
    }
    await window.ipcRenderer.invoke('save-nvr-config', c)
    await window.ipcRenderer.invoke('stop-camera-streams')
    setPorts({}); setLoaded({}); setConfig(c); setConfiguring(false)
    startStreams(c)
  }

  function field(label: string, key: keyof typeof form, opts?: { type?: string; placeholder?: string }) {
    return (
      <>
        <label className="camera-setup-label">{label}</label>
        <input
          className="note-input"
          type={opts?.type ?? 'text'}
          placeholder={opts?.placeholder ?? ''}
          value={form[key]}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && saveConfig()}
          style={{ width: '100%' }}
          autoFocus={key === 'rtspHost'}
        />
      </>
    )
  }

  if (configuring) {
    return (
      <div className="camera-viewer">
        <div className="camera-setup">
          <div className="camera-setup-title">NVR CONNECTION</div>
          <div className="camera-setup-grid">
            {field('HOST', 'rtspHost', { placeholder: '192.168.12.100' })}
            {field('RTSP PORT', 'rtspPort', { placeholder: '554' })}
            {field('USERNAME', 'username', { placeholder: 'admin' })}
            {field('PASSWORD', 'password', { type: 'password' })}
            {field('CHANNELS', 'channels', { placeholder: '4' })}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '1.25rem' }}>
            <button className="save-btn" onClick={saveConfig}>CONNECT</button>
            {config && (
              <button className="save-btn" style={{ borderColor: '#222', color: '#444' }} onClick={() => setConfiguring(false)}>CANCEL</button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!config) return null

  const channelCount = config.channels
  const gridClass = channelCount <= 4 ? 'camera-grid--2x2' : 'camera-grid--4x2'

  // Expanded single camera
  if (expanded !== null) {
    const p = ports[expanded]
    const isMotion = motion[expanded]
    return (
      <div className="camera-viewer camera-expanded">
        <div className="camera-expanded-bar">
          <button className="scan-btn" style={{ fontSize: '10px' }} onClick={() => setExpanded(null)}>← GRID</button>
          <div className="camera-expanded-title">
            CAM {expanded}
            {isMotion && <span className="camera-motion-badge">● MOTION</span>}
          </div>
          <button className="scan-btn" style={{ fontSize: '10px', marginLeft: 'auto' }} onClick={() => setConfiguring(true)}>SETTINGS</button>
        </div>
        <div className="camera-expanded-frame">
          {p ? (
            <img className="camera-img-expanded" src={`http://localhost:${p}`} alt={`cam${expanded}`} />
          ) : (
            <span className="camera-no-signal">NO SIGNAL</span>
          )}
        </div>
      </div>
    )
  }

  // Grid view
  return (
    <div className="camera-viewer">
      <div className="camera-topbar">
        <span className="camera-nvr-label">{config.rtspHost} · {channelCount} CAM{channelCount !== 1 ? 'S' : ''}</span>
        <button className="scan-btn" style={{ fontSize: '10px' }} onClick={() => setConfiguring(true)}>SETTINGS</button>
      </div>

      <div className={`camera-grid ${gridClass}`}>
        {Array.from({ length: channelCount }, (_, i) => i + 1).map(ch => {
          const p = ports[ch]
          const isLoaded = loaded[ch]
          const isMotion = motion[ch]
          const status = camStatus[ch] || ''
          const isError = ['AUTH FAILED', 'REFUSED', 'TIMEOUT', 'UNREACHABLE', 'STREAM ERROR', 'DISCONNECTED'].includes(status)
          return (
            <div key={ch} className={`camera-cell${isMotion ? ' camera-cell--motion' : ''}`} onClick={() => setExpanded(ch)}>
              {p ? (
                <>
                  <img
                    ref={el => { imgRefs.current[ch] = el }}
                    className="camera-img"
                    src={`http://localhost:${p}`}
                    alt={`cam${ch}`}
                    style={{ opacity: isLoaded ? 1 : 0 }}
                    onLoad={() => setLoaded(prev => ({ ...prev, [ch]: true }))}
                    onError={() => {
                      setLoaded(prev => ({ ...prev, [ch]: false }))
                      setTimeout(() => {
                        const el = imgRefs.current[ch]
                        if (el) el.src = `http://localhost:${p}?t=${Date.now()}`
                      }, 3000)
                    }}
                  />
                  {!isLoaded && (
                    <span className={`camera-no-signal${isError ? ' camera-no-signal--error' : ''}`} style={isError ? {} : { animation: 'pulse 1.5s infinite' }}>
                      {isError ? status : (status || 'CONNECTING')}
                    </span>
                  )}
                </>
              ) : (
                <span className="camera-no-signal" style={{ animation: 'pulse 1.5s infinite' }}>STARTING</span>
              )}
              <div className="camera-label">CAM {ch}</div>
              {isMotion && <div className="camera-motion-dot" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
