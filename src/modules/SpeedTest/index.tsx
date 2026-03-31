import { useState, useEffect, useRef } from 'react'

type Stage = 'idle' | 'ping' | 'download' | 'upload' | 'done'

interface Results {
  ping: number
  download: number
  upload: number
}

interface Update {
  stage: Stage
  value?: number
  done?: boolean
  ping?: number
  download?: number
  upload?: number
}

function fmt(mbps: number) {
  return mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)
}

export default function SpeedTest() {
  const [stage, setStage] = useState<Stage>('idle')
  const [live, setLive] = useState<number | null>(null)
  const [results, setResults] = useState<Results | null>(null)
  const [history, setHistory] = useState<(Results & { ts: number })[]>([])
  const running = useRef(false)

  useEffect(() => {
    const handler = (_: unknown, update: Update) => {
      if (update.stage === 'done' && update.ping !== undefined) {
        const r = { ping: update.ping, download: update.download!, upload: update.upload! }
        setResults(r)
        setHistory(prev => [{ ...r, ts: Date.now() }, ...prev].slice(0, 5))
        setStage('done')
        setLive(null)
        running.current = false
      } else if (!update.done) {
        setStage(update.stage)
        if (update.value !== undefined) setLive(update.value)
      } else {
        setLive(null)
      }
    }
    window.ipcRenderer.on('speed-test-update', handler)
    return () => { window.ipcRenderer.off('speed-test-update', handler) }
  }, [])

  async function run() {
    if (running.current) return
    running.current = true
    setStage('ping')
    setLive(null)
    setResults(null)
    window.ipcRenderer.invoke('run-speed-test')
  }

  const stageLabel: Record<Stage, string> = {
    idle: '',
    ping: 'MEASURING LATENCY',
    download: 'DOWNLOAD',
    upload: 'UPLOAD',
    done: 'COMPLETE',
  }

  return (
    <div className="speedtest">
      {/* Main readout */}
      <div className="speedtest-readout">
        {stage === 'idle' && (
          <div className="speedtest-idle">
            {results ? (
              <div className="speedtest-results">
                <div className="speedtest-result-row">
                  <span className="speedtest-result-label">PING</span>
                  <span className="speedtest-result-val">{results.ping < 0 ? '—' : `${results.ping.toFixed(0)} ms`}</span>
                </div>
                <div className="speedtest-result-row">
                  <span className="speedtest-result-label">DOWN</span>
                  <span className="speedtest-result-val speedtest-result-val--blue">{fmt(results.download)} Mbps</span>
                </div>
                <div className="speedtest-result-row">
                  <span className="speedtest-result-label">UP</span>
                  <span className="speedtest-result-val">{fmt(results.upload)} Mbps</span>
                </div>
              </div>
            ) : (
              <div className="speedtest-hint">READY</div>
            )}
          </div>
        )}

        {stage !== 'idle' && stage !== 'done' && (
          <div className="speedtest-running">
            <div className="speedtest-stage-label" style={{ animation: 'pulse 1.2s infinite' }}>
              {stageLabel[stage]}
            </div>
            {stage !== 'ping' && live !== null ? (
              <div className="speedtest-live">
                <span className="speedtest-live-num">{fmt(live)}</span>
                <span className="speedtest-live-unit">Mbps</span>
              </div>
            ) : (
              <div className="speedtest-dots">
                <span style={{ animation: 'pulse 1s infinite 0s' }}>·</span>
                <span style={{ animation: 'pulse 1s infinite 0.3s' }}>·</span>
                <span style={{ animation: 'pulse 1s infinite 0.6s' }}>·</span>
              </div>
            )}
          </div>
        )}

        {stage === 'done' && results && (
          <div className="speedtest-results">
            <div className="speedtest-result-row">
              <span className="speedtest-result-label">PING</span>
              <span className="speedtest-result-val">{results.ping < 0 ? '—' : `${results.ping.toFixed(0)} ms`}</span>
            </div>
            <div className="speedtest-result-row">
              <span className="speedtest-result-label">DOWN</span>
              <span className="speedtest-result-val speedtest-result-val--blue">{fmt(results.download)} Mbps</span>
            </div>
            <div className="speedtest-result-row">
              <span className="speedtest-result-label">UP</span>
              <span className="speedtest-result-val">{fmt(results.upload)} Mbps</span>
            </div>
          </div>
        )}
      </div>

      {/* Run button */}
      <button
        className="speedtest-btn"
        onClick={run}
        disabled={stage !== 'idle' && stage !== 'done'}
      >
        {stage === 'idle' || stage === 'done' ? 'RUN TEST' : 'TESTING...'}
      </button>

      {/* History */}
      {history.length > 1 && (
        <div className="speedtest-history">
          <div className="speedtest-history-label">HISTORY</div>
          {history.slice(1).map((r, i) => (
            <div key={i} className="speedtest-history-row">
              <span className="speedtest-history-time">
                {new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="speedtest-history-val">↓ {fmt(r.download)}</span>
              <span className="speedtest-history-val">↑ {fmt(r.upload)}</span>
              <span className="speedtest-history-ping">{r.ping < 0 ? '—' : `${r.ping.toFixed(0)}ms`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
