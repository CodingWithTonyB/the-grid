import { useState, useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

interface Location {
  latitude: string
  longitude: string
  accuracy: string
  speed: number
  battery: string
  charge: string
  timestamp: string
  address1: string
  address2: string
  since: string
  isDriving: string
  wifi: string
}

interface Member {
  id: string
  firstName: string
  lastName: string
  avatar: string
  location: Location | null
  issues: { disconnected: string; type: string | null }
}

interface Circle {
  id: string
  name: string
  memberCount: string
  members: Member[]
}

function timeAgo(ts: string): string {
  const diff = Date.now() - parseInt(ts) * 1000
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function batteryIcon(pct: string, charging: string) {
  const n = parseInt(pct)
  const c = charging === '1'
  if (n > 60) return c ? '🔋⚡' : '🔋'
  if (n > 20) return c ? '🪫⚡' : '🪫'
  return c ? '🪫⚡' : '🪫'
}

export default function Life360() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [circles, setCircles] = useState<Circle[]>([])
  const [activeCircle, setActiveCircle] = useState<string | null>(null)
  const [selectedMember, setSelectedMember] = useState<string | null>(null)

  const [showWebLogin, setShowWebLogin] = useState(false)
  const webviewRef = useRef<HTMLWebViewElement>(null)

  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<L.Map | null>(null)
  const markersRef = useRef<Record<string, L.Marker>>({})

  // Check saved session on mount
  useEffect(() => {
    window.ipcRenderer.invoke('life360-check-session').then((ok: boolean) => {
      if (ok) {
        setLoggedIn(true)
        loadCircles()
      }
      setLoading(false)
    })
  }, [])

  // Listen for token intercepted from webview (main process interception)
  useEffect(() => {
    const onToken = (_e: unknown, _token: string) => {
      setShowWebLogin(false)
      setLoggedIn(true)
      setError(null)
      loadCircles()
    }
    window.ipcRenderer.on('life360-token-captured', onToken)
    return () => { window.ipcRenderer.off('life360-token-captured', onToken) }
  }, [])

  // Poll webview for token in localStorage/cookies after login
  useEffect(() => {
    if (!showWebLogin) return
    const interval = setInterval(async () => {
      const wv = webviewRef.current as any
      if (!wv || !wv.executeJavaScript) return
      try {
        // Try to find the token in localStorage, sessionStorage, or cookies
        const token = await wv.executeJavaScript(`
          (function() {
            // Check localStorage keys for anything token-like
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              const val = localStorage.getItem(key);
              try {
                const parsed = JSON.parse(val);
                if (parsed && parsed.access_token) return parsed.access_token;
                if (parsed && parsed.token) return parsed.token;
              } catch {}
              // Check if value itself looks like a JWT or token
              if (key.toLowerCase().includes('token') && val && val.length > 20) return val;
            }
            // Check sessionStorage
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              const val = sessionStorage.getItem(key);
              try {
                const parsed = JSON.parse(val);
                if (parsed && parsed.access_token) return parsed.access_token;
                if (parsed && parsed.token) return parsed.token;
              } catch {}
              if (key.toLowerCase().includes('token') && val && val.length > 20) return val;
            }
            return null;
          })()
        `)
        if (token) {
          clearInterval(interval)
          await window.ipcRenderer.invoke('life360-save-token', token)
          setShowWebLogin(false)
          setLoggedIn(true)
          loadCircles()
        }
      } catch {}
    }, 2000)
    return () => clearInterval(interval)
  }, [showWebLogin])

  async function logout() {
    await window.ipcRenderer.invoke('life360-logout')
    setLoggedIn(false)
    setCircles([])
    setActiveCircle(null)
    mapInstance.current?.remove()
    mapInstance.current = null
  }

  async function loadCircles() {
    setError(null)
    try {
      const data = await window.ipcRenderer.invoke('life360-circles')
      console.log('life360-circles response:', data)
      if (data?.error) {
        setError('API error: ' + data.error + (data.raw ? ' | ' + data.raw : ''))
      } else if (data && Array.isArray(data) && data.length > 0) {
        setCircles(data as Circle[])
        if (!activeCircle) setActiveCircle(data[0].id)
      } else {
        setError('No circles returned: ' + JSON.stringify(data).slice(0, 200))
      }
    } catch (e: any) {
      setError('Failed to load circles: ' + e.message)
    }
  }

  // Refresh location data
  useEffect(() => {
    if (!loggedIn || !activeCircle) return
    const interval = setInterval(loadCircles, 30000) // refresh every 30s
    return () => clearInterval(interval)
  }, [loggedIn, activeCircle])

  // Initialize / update map
  const circle = circles.find(c => c.id === activeCircle)
  const members = circle?.members ?? []

  useEffect(() => {
    if (!mapRef.current || members.length === 0) return

    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current, {
        zoomControl: false,
        attributionControl: false,
      }).setView([0, 0], 13)

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
      }).addTo(mapInstance.current)

      L.control.zoom({ position: 'bottomright' }).addTo(mapInstance.current)
    }

    const map = mapInstance.current
    const bounds: L.LatLngExpression[] = []

    // Update markers
    const currentIds = new Set<string>()
    for (const m of members) {
      if (!m.location) continue
      currentIds.add(m.id)
      const lat = parseFloat(m.location.latitude)
      const lng = parseFloat(m.location.longitude)
      bounds.push([lat, lng])

      const initials = (m.firstName[0] + (m.lastName?.[0] ?? '')).toUpperCase()
      const isDriving = m.location.isDriving === '1'
      const iconHtml = `<div class="l360-marker${isDriving ? ' l360-marker--driving' : ''}${selectedMember === m.id ? ' l360-marker--selected' : ''}">
        ${m.avatar ? `<img src="${m.avatar}" class="l360-marker-avatar"/>` : `<span class="l360-marker-initials">${initials}</span>`}
      </div>`

      const icon = L.divIcon({ html: iconHtml, className: 'l360-marker-wrapper', iconSize: [36, 36], iconAnchor: [18, 18] })

      if (markersRef.current[m.id]) {
        markersRef.current[m.id].setLatLng([lat, lng]).setIcon(icon)
      } else {
        markersRef.current[m.id] = L.marker([lat, lng], { icon })
          .addTo(map)
          .on('click', () => setSelectedMember(prev => prev === m.id ? null : m.id))
      }
    }

    // Remove stale markers
    for (const [id, marker] of Object.entries(markersRef.current)) {
      if (!currentIds.has(id)) { marker.remove(); delete markersRef.current[id] }
    }

    if (bounds.length > 0) {
      map.fitBounds(bounds as L.LatLngBoundsExpression, { padding: [60, 60], maxZoom: 15 })
    }

    return () => {}
  }, [members, selectedMember])

  // Resize map when container changes
  useEffect(() => {
    const timer = setTimeout(() => mapInstance.current?.invalidateSize(), 200)
    return () => clearTimeout(timer)
  })

  if (loading) return <div className="l360"><div className="l360-loading">CONNECTING...</div></div>

  if (!loggedIn) {
    if (showWebLogin) {
      return (
        <div className="l360">
          <div className="l360-webview-bar">
            <button className="back-btn" onClick={() => setShowWebLogin(false)}>← BACK</button>
            <span className="l360-webview-hint">Sign in normally, then tap DONE</span>
            <button className="scan-btn" style={{ marginLeft: 'auto' }} onClick={async () => {
              setError(null)
              const result = await window.ipcRenderer.invoke('life360-extract-token')
              if (result.ok) {
                setShowWebLogin(false)
                setLoggedIn(true)
                loadCircles()
              } else {
                setError(result.error + (result.cookieNames ? ' | Cookies: ' + result.cookieNames.join(', ') : ''))
              }
            }}>DONE</button>
          </div>
          {error && <div className="l360-error">{error}</div>}
          <webview
            ref={webviewRef as any}
            src="https://www.life360.com/login"
            className="l360-webview"
            partition="persist:life360"
            // @ts-ignore
            allowpopups="true"
          />
        </div>
      )
    }

    return (
      <div className="l360">
        <div className="l360-login">
          <div className="l360-login-title">LIFE360</div>
          <div className="l360-login-desc">Sign in through Life360's website. Your token will be captured automatically.</div>
          {error && <div className="l360-error">{error}</div>}
          <button className="scan-btn" onClick={() => setShowWebLogin(true)}>
            SIGN IN WITH LIFE360
          </button>
        </div>
      </div>
    )
  }

  const sel = selectedMember ? members.find(m => m.id === selectedMember) : null

  return (
    <div className="l360">
      {error && <div className="l360-error" style={{ flexShrink: 0 }}>{error}</div>}
      {/* Circle tabs */}
      {circles.length > 1 && (
        <div className="l360-circles">
          {circles.map(c => (
            <button
              key={c.id}
              className={`tab-btn${c.id === activeCircle ? ' tab-btn--active' : ''}`}
              onClick={() => { setActiveCircle(c.id); setSelectedMember(null) }}
            >
              {c.name} <span className="tab-count">{c.memberCount}</span>
            </button>
          ))}
        </div>
      )}

      <div className="l360-body">
        {/* Map */}
        <div className="l360-map" ref={mapRef} />

        {/* Member list */}
        <div className="l360-sidebar">
          <div className="l360-sidebar-header">
            <span>{circle?.name ?? 'CIRCLE'}</span>
            <button className="l360-logout" onClick={logout}>LOGOUT</button>
          </div>
          <div className="l360-members">
            {members.map(m => {
              const loc = m.location
              return (
                <div
                  key={m.id}
                  className={`l360-member${selectedMember === m.id ? ' l360-member--selected' : ''}`}
                  onClick={() => {
                    setSelectedMember(prev => prev === m.id ? null : m.id)
                    if (loc && mapInstance.current) {
                      mapInstance.current.setView([parseFloat(loc.latitude), parseFloat(loc.longitude)], 16, { animate: true })
                    }
                  }}
                >
                  <div className="l360-member-avatar">
                    {m.avatar ? <img src={m.avatar} /> : <span>{(m.firstName[0] + (m.lastName?.[0] ?? '')).toUpperCase()}</span>}
                  </div>
                  <div className="l360-member-info">
                    <div className="l360-member-name">{m.firstName} {m.lastName}</div>
                    {loc ? (
                      <>
                        <div className="l360-member-addr">{loc.address1}{loc.address2 ? `, ${loc.address2}` : ''}</div>
                        <div className="l360-member-meta">
                          <span>{timeAgo(loc.timestamp)}</span>
                          <span>{batteryIcon(loc.battery, loc.charge)} {loc.battery}%</span>
                          {loc.isDriving === '1' && <span className="l360-driving">DRIVING {Math.round(loc.speed)}mph</span>}
                          {loc.wifi === '1' && <span>WiFi</span>}
                        </div>
                      </>
                    ) : (
                      <div className="l360-member-addr l360-member-offline">Location unavailable</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Selected member detail */}
      {sel && sel.location && (
        <div className="l360-detail">
          <span className="l360-detail-name">{sel.firstName}</span>
          <span className="l360-detail-addr">{sel.location.address1}</span>
          <span className="l360-detail-time">Updated {timeAgo(sel.location.timestamp)}</span>
          {parseInt(sel.location.accuracy) > 0 && <span>~{sel.location.accuracy}m accuracy</span>}
        </div>
      )}
    </div>
  )
}
