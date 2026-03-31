import { useState, useEffect, useRef } from 'react'
import Wheel from '@uiw/react-color-wheel'
import './clock.css'

interface ClockConfig {
  h1: number; h2: number; h3: number; h4: number; h5: number; h6: number
  s1: number; s2: number; s3: number; s4: number; s5: number; s6: number
  light: number
  mode: number
  outcarry: number
  is24h: number
  dst: number
  tz: number
  ah: number
  am: number
}

const DISPLAY_STYLES = [
  { val: 1, label: 'Normal' },
  { val: 2, label: 'Carry' },
  { val: 3, label: 'Jumping' },
]

const COLOR_MODES = [
  { val: 1, label: 'Custom' },
  { val: 2, label: 'Rainbow' },
  { val: 3, label: 'Breathing' },
  { val: 4, label: 'Flowing' },
  { val: 5, label: 'Test' },
]

const TIMEZONES = [
  { val: 1,  label: 'UTC-12  International Date Line West' },
  { val: 2,  label: 'UTC-11  Coordinated Universal Time-11' },
  { val: 3,  label: 'UTC-10  Aleutian Islands' },
  { val: 4,  label: 'UTC-9   Alaska' },
  { val: 5,  label: 'UTC-8   Pacific Time (Seattle, Vancouver)' },
  { val: 6,  label: 'UTC-7   Mountain Time (Denver, Calgary)' },
  { val: 7,  label: 'UTC-6   Central Time (Chicago, Mexico City)' },
  { val: 8,  label: 'UTC-5   Eastern Time (New York, Toronto)' },
  { val: 9,  label: 'UTC-4   Atlantic Time (Halifax)' },
  { val: 10, label: 'UTC-3   Buenos Aires, São Paulo' },
  { val: 11, label: 'UTC-2   Coordinated Universal Time-2' },
  { val: 12, label: 'UTC-1   Azores, Cape Verde' },
  { val: 13, label: 'UTC+0   London, Lisbon' },
  { val: 14, label: 'UTC+1   European Union (Paris, Berlin)' },
  { val: 15, label: 'UTC+2   Cairo, Athens' },
  { val: 16, label: 'UTC+3   Moscow, Istanbul' },
  { val: 17, label: 'UTC+4   Dubai, Abu Dhabi' },
  { val: 18, label: 'UTC+5:30 India (New Delhi, Mumbai)' },
  { val: 19, label: 'UTC+6   Astana, Dhaka' },
  { val: 20, label: 'UTC+7   Bangkok, Jakarta' },
  { val: 21, label: 'UTC+8   Beijing, Singapore' },
  { val: 22, label: 'UTC+9   Tokyo, Seoul' },
  { val: 23, label: 'UTC+10  Sydney, Melbourne' },
  { val: 24, label: 'UTC+11  Solomon Islands, Nouméa' },
  { val: 25, label: 'UTC+12  Auckland, Wellington' },
]

function tubeCSS(h: number, s: number) {
  return `hsl(${h}, ${Math.round(s / 255 * 100)}%, 55%)`
}

export default function Clock() {
  const [ip, setIp] = useState('')
  const [ipInput, setIpInput] = useState('192.168.12.125')
  const [config, setConfig] = useState<ClockConfig | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const [allSame, setAllSame] = useState(true)
  const [brightness, setBrightnessState] = useState(100) // 0-100, local only
  const [sending, setSending] = useState(false)
  const [timerMin, setTimerMin] = useState(5)
  const [timerRunning, setTimerRunning] = useState(false)
  const [alarmH, setAlarmH] = useState(0)
  const [alarmM, setAlarmM] = useState(0)
  const [alarmOn, setAlarmOn] = useState(false)
  // Wheel colors are local state — decoupled from config to avoid onChange feedback loop
  const [wheelHsv, setWheelHsv] = useState<{h: number, s: number}>({ h: 0, s: 100 })
  const [perTubeHsv, setPerTubeHsv] = useState<Array<{h: number, s: number}>>(
    Array.from({length: 6}, () => ({ h: 0, s: 100 }))
  )
  const wheelInitRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastActionRef = useRef<number>(0)
  const ipRef = useRef('')
  const brightnessRef = useRef(100)

  useEffect(() => {
    window.ipcRenderer.invoke('clock-load-ip').then((saved: string) => {
      if (saved) { setIp(saved); setIpInput(saved); ipRef.current = saved; connect(saved) }
    })
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  async function connect(addr?: string) {
    const target = addr ?? ipInput
    setConnecting(true); setError('')
    try {
      const cfg = await window.ipcRenderer.invoke('clock-get-config', target)
      if (!cfg) throw new Error('no response')
      setConfig(cfg); setIp(target); ipRef.current = target
      if (!wheelInitRef.current) {
        wheelInitRef.current = true
        setWheelHsv({ h: cfg.h1, s: Math.round(cfg.s1 / 255 * 100) })
        setPerTubeHsv([cfg.h1,cfg.h2,cfg.h3,cfg.h4,cfg.h5,cfg.h6].map((h, i) => ({
          h, s: Math.round([cfg.s1,cfg.s2,cfg.s3,cfg.s4,cfg.s5,cfg.s6][i] / 255 * 100)
        })))
      }
      if (cfg.ah || cfg.am) {
        setAlarmH(cfg.ah || 0)
        setAlarmM(cfg.am || 0)
        setAlarmOn(true)
      }
      await window.ipcRenderer.invoke('clock-save-ip', target)
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        if (Date.now() - lastActionRef.current < 6000) return
        const c = await window.ipcRenderer.invoke('clock-get-config', ipRef.current)
        if (!c || Date.now() - lastActionRef.current < 6000) return
        setConfig(c)
      }, 12000)
    } catch { setError('Could not connect — check the IP and that the clock is on') }
    setConnecting(false)
  }

  function send(endpoint: string) {
    lastActionRef.current = Date.now()
    window.ipcRenderer.invoke('clock-send', ipRef.current, endpoint)
  }

  function sendMode(colorMode: number, displayStyle: number) {
    lastActionRef.current = Date.now()
    send(`/mode?m=${colorMode}&s=${displayStyle}`)
  }

  function setColorMode(m: number) {
    if (!config) return
    setConfig(c => c ? { ...c, mode: m } : c)
    sendMode(m, config.outcarry || 1)
  }

  function setDisplayStyle(s: number) {
    if (!config) return
    setConfig(c => c ? { ...c, outcarry: s } : c)
    sendMode(config.mode || 1, s)
  }

  function setBrightness(v: number) {
    setBrightnessState(v)
    brightnessRef.current = v
    lastActionRef.current = Date.now()
    // Re-send current tube colors with new brightness
    if (!config) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const h = config.h1, s = Math.round(config.s1 / 255 * 100)
      setSending(true)
      Promise.all([1,2,3,4,5,6].map(i => {
        const hi = (config as unknown as Record<string, number>)[`h${i}`]
        const si = Math.round((config as unknown as Record<string, number>)[`s${i}`] / 255 * 100)
        return window.ipcRenderer.invoke('clock-send', ipRef.current, `/tubecolor?t=${i}&h=${hi}&s=${si}&v=${v}`)
      })).finally(() => setSending(false))
      void h; void s
    }, 80)
  }

  function setTubeColor(tube: number, h: number, s: number) {
    if (!config) return
    const v = brightnessRef.current
    const sApi = Math.round(s / 255 * 100)
    const update: Record<string, number> = {}
    const tubes = allSame ? [1,2,3,4,5,6] : [tube]
    tubes.forEach(i => { update[`h${i}`] = h; update[`s${i}`] = s })
    setConfig(c => c ? { ...c, ...update } : c)
    // Live — send immediately, no debounce
    lastActionRef.current = Date.now()
    setSending(true)
    Promise.all(tubes.map(i =>
      window.ipcRenderer.invoke('clock-send', ipRef.current, `/tubecolor?t=${i}&h=${h}&s=${sApi}&v=${v}`)
    )).finally(() => setSending(false))
  }

  function toggle24h() {
    if (!config) return
    const next = config.is24h ? 0 : 1
    setConfig(c => c ? { ...c, is24h: next } : c)
    send(`/tm?s=${next ? 24 : 12}`)
  }

  function toggleDST() {
    if (!config) return
    const next = config.dst ? 0 : 1
    setConfig(c => c ? { ...c, dst: next } : c)
    send(`/enDST?d=${next}`)
  }

  function startTimer() {
    setTimerRunning(true)
    send(`/timer?min=${timerMin}`)
  }

  function stopTimer() {
    setTimerRunning(false)
    send('/timer?min=0')
  }

  function toggleAlarm() {
    if (alarmOn) {
      setAlarmOn(false)
      send('/alarm?h=0&m=0')
    } else {
      setAlarmOn(true)
      send(`/alarm?h=${alarmH}&m=${alarmM}`)
    }
  }

  function updateAlarm(h: number, m: number) {
    setAlarmH(h); setAlarmM(m)
    if (alarmOn) send(`/alarm?h=${h}&m=${m}`)
  }

  function setTimezone(tz: number) {
    if (!config) return
    setConfig(c => c ? { ...c, tz } : c)
    send(`/time?t=${tz}`)
  }

  function syncTime() {
    const d = new Date()
    send(`/uptm?t=0&h=${d.getHours()}&m=${d.getMinutes()}&s=${d.getSeconds()}&y=${d.getFullYear()}&mo=${d.getMonth()}&d=${d.getDate()}`)
  }

  if (!ip) {
    return (
      <div className="clock-setup">
        <div className="clock-setup-icon">⏱</div>
        <div className="clock-setup-title">CLOCTECK CLOCK</div>
        <div className="clock-setup-sub">Enter the clock's IP address</div>
        <input className="clock-ip-input" value={ipInput}
          onChange={e => setIpInput(e.target.value)}
          placeholder="192.168.x.x"
          onKeyDown={e => e.key === 'Enter' && connect()} />
        {error && <div className="clock-error">{error}</div>}
        <button className="clock-connect-btn" onClick={() => connect()} disabled={connecting}>
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="clock-setup">
        <div className="clock-spin">◌</div>
        <div className="clock-setup-sub">Connecting to {ip}...</div>
      </div>
    )
  }

  const isCustom = config.mode === 1

  return (
    <div className="clock-wrap">
      <button className="clock-ip-pill"
        onClick={() => { setIp(''); setConfig(null); ipRef.current = '' }}>
        ⚙ {ip}
      </button>

      {/* Tube preview */}
      <div className="clock-tubes">
        {[1,2,3,4,5,6].map(i => {
          const h = (config as unknown as Record<string, number>)[`h${i}`]
          const s = (config as unknown as Record<string, number>)[`s${i}`]
          return (
            <div key={i} className="clock-tube" style={{
              background: tubeCSS(h, s),
              boxShadow: `0 0 14px 3px ${tubeCSS(h, s)}44`,
              opacity: 0.2 + brightness / 100 * 0.8,
            }}>
              <span className="clock-tube-num">{i}</span>
            </div>
          )
        })}
      </div>

      {/* Brightness spans full width */}
      <div className="clock-brightness-row">
        <span className="clock-label">BRIGHTNESS</span>
        <div className="clock-slider-wrap">
          <input type="range" min={0} max={100} value={brightness}
            className="clock-slider clock-slider--bright"
            onChange={e => setBrightness(Number(e.target.value))} />
          <span className="clock-val">{brightness}%</span>
        </div>
      </div>

      <div className="clock-body">
        {/* Left: controls */}
        <div className="clock-controls">

          {/* — Visual — */}
          <div className="clock-section-label">VISUAL</div>

          <div className="clock-row">
            <span className="clock-label">DISPLAY</span>
            <div className="clock-pill-row">
              {DISPLAY_STYLES.map(d => (
                <button key={d.val}
                  className={`clock-mode-btn${config.outcarry === d.val ? ' clock-mode-btn--active' : ''}`}
                  onClick={() => setDisplayStyle(d.val)}>{d.label}</button>
              ))}
            </div>
          </div>

          <div className="clock-row">
            <span className="clock-label">COLOR MODE</span>
            <div className="clock-pill-row">
              {COLOR_MODES.map(m => (
                <button key={m.val}
                  className={`clock-mode-btn${config.mode === m.val ? ' clock-mode-btn--active' : ''}`}
                  onClick={() => setColorMode(m.val)}>{m.label}</button>
              ))}
            </div>
          </div>

          {isCustom && (
            <div className="clock-row">
              <span className="clock-label">TUBES</span>
              <div className="clock-pill-row">
                <button className={`clock-mode-btn${allSame ? ' clock-mode-btn--active' : ''}`}
                  onClick={() => setAllSame(true)}>All same</button>
                <button className={`clock-mode-btn${!allSame ? ' clock-mode-btn--active' : ''}`}
                  onClick={() => setAllSame(false)}>Per tube</button>
              </div>
            </div>
          )}

          {/* — Features — */}
          <div className="clock-divider" />
          <div className="clock-section-label">FEATURES</div>

          <div className="clock-feature-row">
            <span className="clock-label">TIMER</span>
            <div className="clock-feature-controls">
              <div className="clock-time-display">
                <input type="number" min={0} max={99} value={timerMin}
                  className="clock-digit-input"
                  onChange={e => setTimerMin(Math.max(0, Math.min(99, Number(e.target.value))))} />
                <span className="clock-time-sep">min</span>
              </div>
              <button
                className={`clock-action-btn${timerRunning ? ' clock-action-btn--stop' : ''}`}
                onClick={timerRunning ? stopTimer : startTimer}>
                {timerRunning ? '◼ Stop' : '▶ Start'}
              </button>
            </div>
          </div>

          <div className="clock-feature-row">
            <span className="clock-label">ALARM</span>
            <div className="clock-feature-controls">
              <div className="clock-time-display">
                <input type="number" min={0} max={23} value={alarmH}
                  className="clock-digit-input"
                  onChange={e => updateAlarm(Math.max(0, Math.min(23, Number(e.target.value))), alarmM)} />
                <span className="clock-time-sep">:</span>
                <input type="number" min={0} max={59} value={alarmM}
                  className="clock-digit-input"
                  onChange={e => updateAlarm(alarmH, Math.max(0, Math.min(59, Number(e.target.value))))} />
              </div>
              <button className={`clock-action-btn${alarmOn ? ' clock-action-btn--on' : ''}`} onClick={toggleAlarm}>
                {alarmOn ? '◉ On' : '○ Off'}
              </button>
            </div>
          </div>

          {/* — Clock settings — */}
          <div className="clock-divider" />
          <div className="clock-bottom-row">
            <button className={`clock-pill${config.is24h ? ' clock-pill--on' : ''}`} onClick={toggle24h}>
              24H
            </button>
            <button className={`clock-pill${config.dst ? ' clock-pill--on' : ''}`} onClick={toggleDST}>
              DST
            </button>
            <button className="clock-pill" onClick={syncTime}>
              SYNC
            </button>
            <select className="clock-tz-select" value={config.tz}
              onChange={e => setTimezone(Number(e.target.value))}>
              {TIMEZONES.map(z => (
                <option key={z.val} value={z.val}>{z.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Right: color wheel centered in the full height of the left column */}
        {isCustom && allSame && (
          <div className="clock-wheel-panel"
            onMouseUp={() => setTubeColor(1, wheelHsv.h, Math.round(wheelHsv.s / 100 * 255))}
            onTouchEnd={() => setTubeColor(1, wheelHsv.h, Math.round(wheelHsv.s / 100 * 255))}
          >
            <Wheel
              color={{ h: wheelHsv.h, s: wheelHsv.s, v: 100, a: 1 }}
              onChange={c => setWheelHsv({ h: Math.round(c.hsva.h), s: Math.round(c.hsva.s) })}
              width={160}
              height={160}
            />
          </div>
        )}
      </div>

      {/* Per-tube wheels side by side */}
      {isCustom && !allSame && (
        <div className="clock-pertube">
          {[1,2,3,4,5,6].map(i => {
            const { h, s } = perTubeHsv[i - 1]
            return (
              <div key={i} className="clock-tube-col"
                onMouseUp={() => setTubeColor(i, h, Math.round(s / 100 * 255))}
                onTouchEnd={() => setTubeColor(i, h, Math.round(s / 100 * 255))}
              >
                <div className="clock-tube-dot" style={{ background: `hsl(${h}, ${s}%, 55%)` }} />
                <span className="clock-tube-label">T{i}</span>
                <Wheel
                  color={{ h, s, v: 100, a: 1 }}
                  onChange={c => setPerTubeHsv(prev => {
                    const next = [...prev]
                    next[i - 1] = { h: Math.round(c.hsva.h), s: Math.round(c.hsva.s) }
                    return next
                  })}
                  width={90}
                  height={90}
                />
              </div>
            )
          })}
        </div>
      )}

      {sending && <div className="clock-sending" />}
    </div>
  )
}
