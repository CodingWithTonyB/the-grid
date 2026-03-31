import { app, BrowserWindow, ipcMain, safeStorage, Notification } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { exec, spawn, ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { Client, type ConnectConfig } from 'ssh2'

const execAsync = promisify(exec)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

// Set app name (fixes menu bar and dock hover on macOS)
app.setName('The Grid')

function splashLog(msg: string) {
  win?.webContents.send('splash-log', msg)
}

function createWindow() {
  splashLog('main :: creating browser window')

  // Set dock icon on macOS (overrides Electron's default icon in dev mode)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(process.env.VITE_PUBLIC, 'grid-icon.svg')
    try { app.dock.setIcon(iconPath) } catch {}
  }

  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'grid-icon.svg'),
    backgroundColor: '#080808',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
    },
  })

  win.once('ready-to-show', () => {
    splashLog('main :: window ready to show')
    win?.show()
  })

  win.webContents.on('did-finish-load', () => {
    splashLog('main :: renderer loaded')
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    splashLog(`main :: connecting to dev server`)
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    splashLog('main :: loading production build')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  app.quit()
  win = null
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  createWindow()
  splashLog('main :: app ready — electron ' + process.versions.electron)
  splashLog('main :: node ' + process.versions.node + ' / chrome ' + process.versions.chrome)
  loadNetmonState()
  splashLog('main :: network monitor state loaded')
  // First scan after 8s (let window load), then every 60s
  setTimeout(() => {
    splashLog('main :: starting network scan')
    runNetmonScan()
    setInterval(runNetmonScan, 60_000)
    // Background scanner for NetworkScanner module
    runBackgroundScan()
    setInterval(runBackgroundScan, 30_000)
  }, 8000)
})

// --- Network Scanner IPC ---

let cachedScanResult: ArpDevice[] = []

interface ArpDevice {
  hostname: string | null
  ip: string
  mac: string
  iface: string
}

function parseArp(output: string): ArpDevice[] {
  const byMac = new Map<string, ArpDevice>()
  for (const line of output.split('\n')) {
    const match = line.match(/^(\S+)\s+\(([^)]+)\)\s+at\s+([a-f0-9:]+)\s+on\s+(\S+)/i)
    if (!match) continue
    const [, hostname, ip, mac, iface] = match
    if (mac === 'ff:ff:ff:ff:ff:ff') continue
    if (/^22[4-9]\.|^23[0-9]\./.test(ip)) continue
    const name = hostname === '?' ? null : hostname.replace(/\.lan$/, '')
    // Deduplicate by MAC — prefer entry with a hostname, otherwise keep last seen
    const existing = byMac.get(mac)
    if (!existing || (!existing.hostname && name)) {
      byMac.set(mac, { hostname: name, ip, mac, iface })
    }
  }
  return Array.from(byMac.values())
}

async function detectSubnet(): Promise<string | null> {
  for (const iface of ['en0', 'en1', 'en2', 'en3']) {
    try {
      const { stdout } = await execAsync(`ipconfig getifaddr ${iface} 2>/dev/null`)
      const ip = stdout.trim()
      if (ip && !ip.startsWith('169.254') && ip.includes('.')) {
        return ip.split('.').slice(0, 3).join('.')
      }
    } catch {}
  }
  return null
}

ipcMain.handle('get-ssid', async () => {
  // system_profiler works even when networksetup is blocked by macOS privacy
  try {
    const { stdout } = await execAsync('system_profiler SPAirPortDataType 2>/dev/null')
    const match = stdout.match(/Current Network Information:\s+([^\n:]+):/)
    if (match) return match[1].trim()
  } catch {}
  // Not on WiFi or couldn't read — show subnet instead
  const subnet = await detectSubnet()
  return subnet ? `${subnet}.x` : null
})

ipcMain.handle('ping-host', async (_event, host: string) => {
  try {
    const start = Date.now()
    await execAsync(`ping -c 1 -W 1000 ${host}`)
    const latency = Date.now() - start
    // Resolve hostname to IP
    let ip: string | null = null
    try {
      const { stdout } = await execAsync(`dig +short ${host} 2>/dev/null || true`)
      const resolved = stdout.trim().split('\n')[0]
      ip = resolved || null
    } catch {}
    return { online: true, latency, ip }
  } catch {
    return { online: false, latency: null, ip: null }
  }
})

ipcMain.handle('load-module-labels', () => {
  try {
    const p = path.join(app.getPath('userData'), 'module-labels.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  return {}
})

ipcMain.handle('save-module-labels', (_event, labels: unknown) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'module-labels.json'), JSON.stringify(labels, null, 2))
})

ipcMain.handle('load-layout', () => {
  try {
    const p = path.join(app.getPath('userData'), 'grid-layout.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  return null
})

ipcMain.handle('save-layout', (_event, layout: unknown) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'grid-layout.json'), JSON.stringify(layout, null, 2))
})

// ── Password encryption (OS keychain via safeStorage) ────────────────
function encryptPw(pw: string): string {
  if (!pw) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(pw).toString('base64')
  } catch {}
  return pw
}
function decryptPw(enc: string): string {
  if (!enc) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {}
  return enc // fallback: might be plain (pre-encryption)
}

ipcMain.handle('load-ssh-targets', () => {
  try {
    const p = path.join(app.getPath('userData'), 'ssh-targets.json')
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      return raw.map((t: { password?: string; keyPath?: string }) => ({ ...t, password: decryptPw(t.password ?? '') }))
    }
  } catch {}
  return []
})

ipcMain.handle('save-ssh-targets', (_event, targets: Array<{ password?: string }>) => {
  const toStore = targets.map(t => ({ ...t, password: encryptPw(t.password ?? '') }))
  fs.writeFileSync(path.join(app.getPath('userData'), 'ssh-targets.json'), JSON.stringify(toStore, null, 2))
})

// ── SSH Terminal sessions ─────────────────────────────────────────────
const sshSessions = new Map<string, { conn: Client; stream: NodeJS.ReadWriteStream }>()

ipcMain.on('ssh-term-start', (event, { sessionId, target }: { sessionId: string; target: { host: string; port: number; username: string; password?: string; keyPath?: string } }) => {
  if (sshSessions.has(sessionId)) return
  const conn = new Client()
  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
      if (err) { event.sender.send('ssh-term-error', { sessionId, message: err.message }); conn.end(); return }
      sshSessions.set(sessionId, { conn, stream })
      event.sender.send('ssh-term-ready', { sessionId })
      stream.on('data', (d: Buffer) => event.sender.send('ssh-term-data', { sessionId, data: d.toString('base64') }))
      stream.stderr?.on('data', (d: Buffer) => event.sender.send('ssh-term-data', { sessionId, data: d.toString('base64') }))
      stream.on('close', () => { event.sender.send('ssh-term-close', { sessionId }); sshSessions.delete(sessionId); conn.end() })
    })
  })
  conn.on('error', err => event.sender.send('ssh-term-error', { sessionId, message: err.message }))
  const cfg: ConnectConfig = { host: target.host, port: target.port || 22, username: target.username, readyTimeout: 8000 }
  if (target.password) cfg.password = target.password
  else if (target.keyPath) cfg.privateKey = fs.readFileSync(target.keyPath)
  conn.connect(cfg)
})

ipcMain.on('ssh-term-input', (_e, { sessionId, data }: { sessionId: string; data: string }) => {
  sshSessions.get(sessionId)?.stream.write(data)
})

ipcMain.on('ssh-term-resize', (_e, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
  const s = sshSessions.get(sessionId)
  if (s) (s.stream as NodeJS.ReadWriteStream & { setWindow: (r: number, c: number, h: number, w: number) => void }).setWindow(rows, cols, 0, 0)
})

ipcMain.on('ssh-term-kill', (_e, { sessionId }: { sessionId: string }) => {
  const s = sshSessions.get(sessionId)
  if (s) { s.stream.end(); s.conn.end(); sshSessions.delete(sessionId) }
})

ipcMain.handle('ssh-get-stats', (_event, target: { host: string; port: number; username: string; password?: string; keyPath?: string }) => {
  return new Promise((resolve) => {
    const conn = new Client()
    const timer = setTimeout(() => { conn.end(); resolve({ error: 'Timed out' }) }, 15000)

    // Base64-encoded script avoids all shell quoting issues
    const script = [
      'S1=$(awk \'NR==1{$1="";print}\' /proc/stat)',
      'N1=$(awk \'NR>2{gsub(/:/,"",$1); if($1!="lo") r+=$2; if($1!="lo") t+=$10}END{printf "%d %d",r+0,t+0}\' /proc/net/dev)',
      'sleep 1',
      'S2=$(awk \'NR==1{$1="";print}\' /proc/stat)',
      'N2=$(awk \'NR>2{gsub(/:/,"",$1); if($1!="lo") r+=$2; if($1!="lo") t+=$10}END{printf "%d %d",r+0,t+0}\' /proc/net/dev)',
      'echo "HOSTNAME=$(hostname)"',
      'echo "CPU_TEMP=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo -1)"',
      'echo "UPTIME=$(uptime | sed \'s/.*up //;s/,.*//\' | awk \'{$1=$1;print}\')"',
      'echo "LOAD=$(awk \'{print $1}\' /proc/loadavg)"',
      'echo "MEM=$(free -m | awk \'NR==2{printf "%s %s",$2,$3}\')"',
      'echo "SWAP=$(free -m | awk \'NR==3{printf "%s %s",$2,$3}\')"',
      'echo "DISK=$(df -h / | awk \'NR==2{printf "%s %s %s",$2,$3,$5}\')"',
      'echo "OS=$(. /etc/os-release 2>/dev/null && printf "%s" "$PRETTY_NAME" || uname -s)"',
      'echo "CPU_PCT=$(printf "%s %s\\n" "$S1" "$S2" | awk \'{n=NF/2;i1=$(4);t1=0;for(j=1;j<=n;j++)t1+=$j;i2=$(n+4);t2=0;for(j=n+1;j<=NF;j++)t2+=$j;if(t2-t1>0)printf "%.1f",(1-(i2-i1)/(t2-t1))*100;else print "0\'}\")"',
      'echo "NET_RX=$(printf "%s %s\\n" "$N1" "$N2" | awk \'{print $3-$1}\')"',
      'echo "NET_TX=$(printf "%s %s\\n" "$N1" "$N2" | awk \'{print $4-$2}\')"',
      'echo "PROCS=$(ps aux --sort=-%cpu 2>/dev/null | awk \'NR>1&&NR<=6{cmd=$11;for(i=12;i<=NF;i++)cmd=cmd" "$i;printf "%s|%.1f|%.1f|%s;",$1,$3,$4,cmd}\')"',
    ].join('\n')
    const cmd = `echo '${Buffer.from(script).toString('base64')}' | base64 -d | bash`

    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); resolve({ error: err.message }); return }
        let out = ''
        stream.on('data', (d: Buffer) => { out += d.toString() })
        stream.on('close', () => {
          clearTimeout(timer)
          conn.end()
          const get = (k: string) => (out.match(new RegExp(`${k}=(.+)`)) ?? [])[1]?.trim() ?? ''
          const temp = parseInt(get('CPU_TEMP'))
          const mem = get('MEM').split(' ')
          const swap = get('SWAP').split(' ')
          const disk = get('DISK').split(' ')
          const procs = get('PROCS').split(';').filter(Boolean).map(p => {
            const [user, cpu, memP, ...cmdParts] = p.split('|')
            return { user, cpu: parseFloat(cpu) || 0, mem: parseFloat(memP) || 0, cmd: cmdParts.join('|') }
          })
          resolve({
            hostname: get('HOSTNAME'),
            os: get('OS'),
            uptime: get('UPTIME'),
            cpuTemp: temp > 0 ? +(temp / 1000).toFixed(1) : null,
            cpuPct: parseFloat(get('CPU_PCT')) || 0,
            loadAvg: get('LOAD'),
            memTotal: parseInt(mem[0]) || 0,
            memUsed: parseInt(mem[1]) || 0,
            swapTotal: parseInt(swap[0]) || 0,
            swapUsed: parseInt(swap[1]) || 0,
            diskTotal: disk[0] || '?',
            diskUsed: disk[1] || '?',
            diskPercent: disk[2] || '?',
            netRx: parseInt(get('NET_RX')) || 0,
            netTx: parseInt(get('NET_TX')) || 0,
            procs,
          })
        })
      })
    })

    conn.on('error', (err) => { clearTimeout(timer); resolve({ error: err.message }) })

    const cfg: ConnectConfig = { host: target.host, port: target.port || 22, username: target.username, readyTimeout: 8000 }
    if (target.password) cfg.password = target.password
    else if (target.keyPath) cfg.privateKey = fs.readFileSync(target.keyPath)
    conn.connect(cfg)
  })
})

ipcMain.handle('load-watchlist', () => {
  try {
    const p = path.join(app.getPath('userData'), 'watchlist.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  return []
})

ipcMain.handle('save-watchlist', (_event, list: unknown) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'watchlist.json'), JSON.stringify(list, null, 2))
})

async function runBackgroundScan() {
  try {
    const subnet = await detectSubnet()
    if (subnet) {
      const pings: Promise<unknown>[] = []
      for (let i = 1; i <= 254; i++) {
        pings.push(execAsync(`ping -c 1 -W 500 ${subnet}.${i}`).catch(() => {}))
      }
      await Promise.all(pings)
    }
    const { stdout } = await execAsync('arp -a')
    cachedScanResult = parseArp(stdout)
    win?.webContents.send('scanner-update', cachedScanResult)
  } catch {}
}

ipcMain.handle('scan-network', async () => {
  await runBackgroundScan()
  return cachedScanResult
})

ipcMain.handle('scan-network-cached', () => {
  return cachedScanResult
})

function notesPath() {
  return path.join(app.getPath('userData'), 'device-notes.json')
}

ipcMain.handle('load-notes', () => {
  try {
    const p = notesPath()
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  return {}
})

ipcMain.handle('save-notes', (_event, notes: unknown) => {
  fs.writeFileSync(notesPath(), JSON.stringify(notes, null, 2))
})

function historyPath() {
  return path.join(app.getPath('userData'), 'device-history.json')
}

ipcMain.handle('load-history', () => {
  try {
    const p = historyPath()
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  return {}
})

ipcMain.handle('save-history', (_event, history: unknown) => {
  fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2))
})

ipcMain.handle('load-target-history', () => {
  try {
    const p = path.join(app.getPath('userData'), 'target-history.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  return []
})

ipcMain.handle('save-target-history', (_event, history: unknown) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'target-history.json'), JSON.stringify(history, null, 2))
})

// --- Camera Viewer IPC ---

interface NVRConfig {
  rtspHost: string
  rtspPort: number
  username: string
  password: string
  channels: number
  mac?: string
}

interface CameraStream {
  process: ChildProcess
  server: http.Server
  clients: Set<http.ServerResponse>
}

const cameraStreams = new Map<number, CameraStream>()
const cameraStatus = new Map<number, string>() // channel → status message

const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const STREAM_BASE_PORT = 19848

function sendCameraStatus(channel: number, status: string) {
  cameraStatus.set(channel, status)
  BrowserWindow.getAllWindows().forEach(w => {
    try { w.webContents.send('camera-status', { channel, status }) } catch {}
  })
}

function resolveNvrIp(mac: string): string | null {
  if (!mac) return null
  const device = cachedScanResult.find(d => d.mac === mac)
  if (device) return device.ip
  // Fall back to device history
  try {
    const histPath = path.join(app.getPath('userData'), 'device-history.json')
    if (fs.existsSync(histPath)) {
      const history = JSON.parse(fs.readFileSync(histPath, 'utf-8'))
      if (history[mac]?.ip) return history[mac].ip
    }
  } catch {}
  return null
}

ipcMain.handle('load-nvr-config', () => {
  try {
    const p = path.join(app.getPath('userData'), 'nvr-config.json')
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (data.rtspHost) {
        const config = { ...data, password: decryptPw(data.password ?? '') } as unknown as NVRConfig
        // Auto-resolve IP from MAC if stored
        if (config.mac) {
          const resolved = resolveNvrIp(config.mac)
          if (resolved && resolved !== config.rtspHost) {
            config.rtspHost = resolved
            // Persist the updated IP
            const toStore = { ...data, rtspHost: resolved }
            fs.writeFileSync(p, JSON.stringify(toStore, null, 2))
          }
        }
        // Kick off motion detection in background
        setTimeout(() => startMotionStream(config), 2000)
        return config
      }
    }
  } catch {}
  return null
})

ipcMain.handle('save-nvr-config', (_event, config: { password?: string } & Record<string, unknown>) => {
  const toStore = { ...config, password: encryptPw(config.password ?? '') }
  fs.writeFileSync(path.join(app.getPath('userData'), 'nvr-config.json'), JSON.stringify(toStore, null, 2))
  // Restart motion stream with new config
  const plain = config as unknown as NVRConfig
  startMotionStream(plain)
})

// ── NVR Motion Detection ───────────────────────────────────────────────────
const motionActive: Record<number, boolean> = {}          // channel → active
const motionNotifyAt: Record<number, number> = {}         // channel → last notify ms
const MOTION_NOTIFY_COOLDOWN = 30_000                     // 30 s between notifs per cam
let motionReq: ReturnType<typeof http.get> | null = null
let motionRetryTimer: ReturnType<typeof setTimeout> | null = null

function mutePath() { return path.join(app.getPath('userData'), 'motion-mute.json') }
function loadMute(): Record<number, boolean> {
  try { return JSON.parse(fs.readFileSync(mutePath(), 'utf-8')) } catch { return {} }
}

function startMotionStream(config: NVRConfig) {
  if (motionRetryTimer) { clearTimeout(motionRetryTimer); motionRetryTimer = null }
  if (motionReq) { try { motionReq.destroy() } catch {}; motionReq = null }

  const url = `http://${config.rtspHost}/cgi-bin/eventManager.cgi?action=attach&codes=[VideoMotion]`
  const opts = {
    auth: `${config.username}:${config.password}`,
    timeout: 60_000,
  }

  const retry = () => {
    motionRetryTimer = setTimeout(() => startMotionStream(config), 15_000)
  }

  try {
    motionReq = http.get(url, opts, res => {
      if (res.statusCode !== 200) { res.destroy(); retry(); return }

      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const m = line.match(/Code=VideoMotion;action=(Start|Stop);index=(\d+)/)
          if (!m) continue
          const active = m[1] === 'Start'
          const ch = parseInt(m[2]) + 1        // Dahua is 0-indexed
          if (motionActive[ch] === active) continue
          motionActive[ch] = active

          BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('nvr-motion', { channel: ch, active }) } catch {}
          })

          // macOS notification on start, respecting per-channel mute + cooldown
          if (active) {
            const muted = loadMute()
            const now = Date.now()
            if (!muted[ch] && (!motionNotifyAt[ch] || now - motionNotifyAt[ch] > MOTION_NOTIFY_COOLDOWN)) {
              motionNotifyAt[ch] = now
              new Notification({
                title: 'Motion Detected',
                body: `Camera ${ch}`,
                silent: false,
              }).show()
            }
          }
        }
      })
      res.on('close', retry)
      res.on('error', retry)
    })
    motionReq.on('error', retry)
  } catch { retry() }
}

ipcMain.handle('nvr-motion-state', () => ({ ...motionActive }))

ipcMain.handle('camera-status-all', () => Object.fromEntries(cameraStatus))

ipcMain.handle('nvr-get-mute', () => loadMute())

ipcMain.handle('nvr-set-mute', (_e, channel: number, muted: boolean) => {
  const current = loadMute()
  if (muted) current[channel] = true
  else delete current[channel]
  fs.writeFileSync(mutePath(), JSON.stringify(current, null, 2))
})

function stopCameraStream(channel: number) {
  const stream = cameraStreams.get(channel)
  if (!stream) return
  cameraStreams.delete(channel)
  try { stream.process.kill('SIGKILL') } catch {}
  stream.clients.forEach(c => { try { c.socket?.destroy() } catch {} })
  stream.clients.clear()
  try { (stream.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.() } catch {}
  try { stream.server.close() } catch {}
}

function spawnFfmpeg(channel: number, config: NVRConfig, clients: Set<http.ServerResponse>) {
  const rtspUrl = `rtsp://${config.username}:${config.password}@${config.rtspHost}:${config.rtspPort}/cam/realmonitor?channel=${channel}&subtype=1`
  sendCameraStatus(channel, 'CONNECTING')
  const ffmpeg = spawn(FFMPEG, [
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-timeout', '10000000',
    '-i', rtspUrl,
    '-f', 'mjpeg',
    '-q:v', '5',
    '-r', '8',
    '-vf', 'scale=640:-1',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let gotFirstFrame = false
  let stderrBuf = ''

  ffmpeg.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
    // Parse common errors
    if (stderrBuf.includes('401 Unauthorized') || stderrBuf.includes('Unauthorized')) {
      sendCameraStatus(channel, 'AUTH FAILED')
    } else if (stderrBuf.includes('Connection refused')) {
      sendCameraStatus(channel, 'REFUSED')
    } else if (stderrBuf.includes('Connection timed out') || stderrBuf.includes('timed out')) {
      sendCameraStatus(channel, 'TIMEOUT')
    } else if (stderrBuf.includes('No route to host')) {
      sendCameraStatus(channel, 'UNREACHABLE')
    }
    // Cap buffer
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048)
  })

  ffmpeg.on('exit', (code) => {
    if (!gotFirstFrame) {
      const status = cameraStatus.get(channel)
      if (!status || status === 'CONNECTING') {
        sendCameraStatus(channel, code ? 'STREAM ERROR' : 'DISCONNECTED')
      }
    } else {
      sendCameraStatus(channel, 'DISCONNECTED')
    }
  })

  let buf = Buffer.alloc(0)
  ffmpeg.stdout?.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (true) {
      const start = buf.indexOf(Buffer.from([0xFF, 0xD8]))
      if (start === -1) { buf = Buffer.alloc(0); break }
      const end = buf.indexOf(Buffer.from([0xFF, 0xD9]), start + 2)
      if (end === -1) { if (start > 0) buf = buf.subarray(start); break }
      if (!gotFirstFrame) { gotFirstFrame = true; sendCameraStatus(channel, 'LIVE') }
      const frame = buf.subarray(start, end + 2)
      const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
      const out = Buffer.concat([Buffer.from(header), frame, Buffer.from('\r\n')])
      clients.forEach(c => { try { c.write(out) } catch { clients.delete(c) } })
      buf = buf.subarray(end + 2)
    }
    if (buf.length > 2 * 1024 * 1024) buf = Buffer.alloc(0)
  })
  return ffmpeg
}

function startCameraStream(channel: number, config: NVRConfig): number {
  const port = STREAM_BASE_PORT + channel - 1
  const existing = cameraStreams.get(channel)

  if (existing) {
    // Server already running — just restart ffmpeg, reuse the port
    try { existing.process.kill('SIGKILL') } catch {}
    existing.process = spawnFfmpeg(channel, config, existing.clients)
    return port
  }

  // First time — create the HTTP server
  const clients = new Set<http.ServerResponse>()
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    clients.add(res)
    res.socket?.on('close', () => clients.delete(res))
  })
  server.listen(port)

  const ffmpeg = spawnFfmpeg(channel, config, clients)
  cameraStreams.set(channel, { process: ffmpeg, server, clients })
  return port
}

ipcMain.handle('start-camera-streams', (_event, config: NVRConfig) => {
  const ports: Record<number, number> = {}
  for (let ch = 1; ch <= config.channels; ch++) {
    ports[ch] = startCameraStream(ch, config)
  }
  return ports
})

ipcMain.handle('stop-camera-streams', () => {
  for (const ch of [...cameraStreams.keys()]) stopCameraStream(ch)
})

app.on('before-quit', () => {
  for (const ch of [...cameraStreams.keys()]) stopCameraStream(ch)
})

// --- Speed Test IPC ---

function measurePing(): Promise<number> {
  return execAsync('ping -c 4 1.1.1.1').then(({ stdout }) => {
    const m = stdout.match(/min\/avg\/max\/stddev = [\d.]+\/([\d.]+)/)
    return m ? parseFloat(m[1]) : -1
  }).catch(() => -1)
}

function measureDownload(onProgress: (mbps: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let bytes = 0
    https.get('https://speed.cloudflare.com/__down?bytes=25000000', res => {
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        const secs = (Date.now() - start) / 1000
        if (secs > 0) onProgress((bytes * 8) / (secs * 1_000_000))
      })
      res.on('end', () => {
        const secs = (Date.now() - start) / 1000
        resolve(secs > 0 ? (bytes * 8) / (secs * 1_000_000) : 0)
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

function measureUpload(onProgress: (mbps: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.alloc(10 * 1024 * 1024)
    const start = Date.now()
    let sent = 0
    const req = https.request({
      hostname: 'speed.cloudflare.com',
      path: '/__up',
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length },
    }, res => {
      res.resume()
      res.on('end', () => {
        const secs = (Date.now() - start) / 1000
        resolve(secs > 0 ? (sent * 8) / (secs * 1_000_000) : 0)
      })
    })
    req.on('error', reject)
    const chunk = 64 * 1024
    let offset = 0
    function write() {
      while (offset < payload.length) {
        const end = Math.min(offset + chunk, payload.length)
        sent = end
        const secs = (Date.now() - start) / 1000
        if (secs > 0) onProgress((sent * 8) / (secs * 1_000_000))
        const ok = req.write(payload.subarray(offset, end))
        offset = end
        if (!ok) { req.once('drain', write); return }
      }
      req.end()
    }
    write()
  })
}

ipcMain.handle('run-speed-test', async event => {
  const push = (data: object) => { try { event.sender.send('speed-test-update', data) } catch {} }
  push({ stage: 'ping' })
  const ping = await measurePing()
  push({ stage: 'ping', value: ping, done: true })
  push({ stage: 'download' })
  const download = await measureDownload(v => push({ stage: 'download', value: v }))
  push({ stage: 'download', value: download, done: true })
  push({ stage: 'upload' })
  const upload = await measureUpload(v => push({ stage: 'upload', value: v }))
  push({ stage: 'upload', value: upload, done: true })
  push({ stage: 'done', ping, download, upload })
  return { ping, download, upload }
})

// ── Network Monitor ────────────────────────────────────────────────────
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
interface NetmonState { devices: Record<string, NetDevice>; events: NetEvent[] }

let netmonState: NetmonState = { devices: {}, events: [] }
const netmonPath = () => path.join(app.getPath('userData'), 'netmon-state.json')

function loadNetmonState() {
  try {
    if (fs.existsSync(netmonPath())) {
      const raw = JSON.parse(fs.readFileSync(netmonPath(), 'utf-8')) as NetmonState
      // Mark all devices offline at startup — will be corrected by first scan
      Object.values(raw.devices).forEach(d => { d.online = false })
      netmonState = raw
    }
  } catch {}
}

function saveNetmonState() {
  try { fs.writeFileSync(netmonPath(), JSON.stringify(netmonState)) } catch {}
}

function pushNetmon() {
  const snapshot = netmonWithLabels()
  BrowserWindow.getAllWindows().forEach(w => {
    try { w.webContents.send('netmon-update', snapshot) } catch {}
  })
}

function addNetEvent(type: NetEvent['type'], dev: NetDevice) {
  netmonState.events = [
    { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: Date.now(), type, mac: dev.mac, name: dev.name, ip: dev.ip },
    ...netmonState.events,
  ].slice(0, 300)
}

async function pingMs(ip: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`ping -c 1 -W 1 ${ip}`)
    const m = stdout.match(/time=([\d.]+)/)
    return m ? parseFloat(m[1]) : null
  } catch { return null }
}

async function runNetmonScan() {
  try {
    // Load user-defined labels from Network Scanner — shared source of truth
    let notes: Record<string, { label?: string }> = {}
    try {
      const p = notesPath()
      if (fs.existsSync(p)) notes = JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch {}

    const { stdout } = await execAsync('arp -a')
    const found = parseArp(stdout)
    const now = Date.now()
    const onlineMacs = new Set(found.map(d => d.mac))

    for (const d of found) {
      const existing = netmonState.devices[d.mac]
      // Priority: user label from Network Scanner > ARP hostname > existing name > short MAC
      const name = notes[d.mac]?.label || d.hostname || existing?.name || d.mac.slice(-8)
      if (!existing) {
        const dev: NetDevice = {
          mac: d.mac, ip: d.ip, name, firstSeen: now, lastSeen: now,
          online: true, watchOnline: false, watchOffline: false,
          scansTotal: 1, scansOnline: 1, latencyMs: null, latencyHistory: [],
        }
        netmonState.devices[d.mac] = dev
        addNetEvent('new', dev)
      } else {
        existing.ip = d.ip
        // Always re-apply priority: label > hostname > keep existing
        existing.name = notes[d.mac]?.label || d.hostname || existing.name
        existing.lastSeen = now
        existing.scansTotal++
        existing.scansOnline++
        if (!existing.online) {
          existing.online = true
          addNetEvent('joined', existing)
          if (existing.watchOnline) new Notification({ title: 'Network Monitor', body: `${existing.name} came online` }).show()
        }
      }
    }

    for (const dev of Object.values(netmonState.devices)) {
      if (!onlineMacs.has(dev.mac)) {
        dev.scansTotal++
        if (dev.online) {
          dev.online = false
          addNetEvent('left', dev)
          if (dev.watchOffline) new Notification({ title: 'Network Monitor', body: `${dev.name} went offline` }).show()
        }
      }
    }

    // Ping online devices (up to 20 in parallel)
    const online = Object.values(netmonState.devices).filter(d => d.online)
    await Promise.all(online.slice(0, 20).map(async dev => {
      const ms = await pingMs(dev.ip)
      dev.latencyMs = ms
      if (ms !== null) dev.latencyHistory = [...dev.latencyHistory, ms].slice(-20)
    }))

    saveNetmonState()
    pushNetmon()
  } catch {}
}

function netmonWithLabels() {
  let notes: Record<string, { label?: string }> = {}
  try {
    const p = notesPath()
    if (fs.existsSync(p)) notes = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  const devices = Object.values(netmonState.devices).map(d => ({
    ...d,
    name: notes[d.mac]?.label || d.name,
  }))
  return { devices, events: netmonState.events }
}

ipcMain.handle('netmon-get-state', () => netmonWithLabels())

ipcMain.handle('netmon-scan-now', async () => {
  await runNetmonScan()
  return netmonWithLabels()
})

ipcMain.handle('netmon-set-watch', (_e, mac: string, watchOnline: boolean, watchOffline: boolean) => {
  const dev = netmonState.devices[mac]
  if (dev) { dev.watchOnline = watchOnline; dev.watchOffline = watchOffline; saveNetmonState() }
})

ipcMain.handle('netmon-set-alias', (_e, mac: string, alias: string) => {
  const dev = netmonState.devices[mac]
  if (!dev) return
  dev.name = alias
  saveNetmonState()
  // Write back to shared notes file so Network Scanner sees the same label
  try {
    const p = notesPath()
    const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {}
    existing[mac] = { ...(existing[mac] ?? {}), label: alias }
    fs.writeFileSync(p, JSON.stringify(existing, null, 2))
  } catch {}
})

ipcMain.handle('netmon-forget', (_e, mac: string) => {
  delete netmonState.devices[mac]
  netmonState.events = netmonState.events.filter(e => e.mac !== mac)
  saveNetmonState()
})

// ── ClocTeck Clock ────────────────────────────────────────────────────────────
const clockIpPath = () => path.join(app.getPath('userData'), 'clock-ip.json')

ipcMain.handle('clock-load-ip', () => {
  try {
    const p = clockIpPath()
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')).ip ?? ''
  } catch {}
  return ''
})

ipcMain.handle('clock-save-ip', (_e, ip: string) => {
  fs.writeFileSync(clockIpPath(), JSON.stringify({ ip }))
})

ipcMain.handle('clock-get-config', (_e, ip: string) => {
  return new Promise(resolve => {
    http.get(`http://${ip}/config`, { timeout: 5000 }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    }).on('error', () => resolve(null)).on('timeout', () => resolve(null))
  })
})

ipcMain.handle('clock-send', (_e, ip: string, endpoint: string) => {
  return new Promise(resolve => {
    http.get(`http://${ip}${endpoint}`, { timeout: 4000 }, res => {
      res.resume()
      res.on('end', () => resolve(true))
    }).on('error', () => resolve(false)).on('timeout', () => resolve(false))
  })
})

