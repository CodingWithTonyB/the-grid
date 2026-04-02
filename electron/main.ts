import { app, BrowserWindow, ipcMain, safeStorage, Notification, session } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { exec, spawn, ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
// dgram available if needed for UDP probes
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

ipcMain.handle('load-archived', () => {
  try {
    const p = path.join(app.getPath('userData'), 'archived-modules.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  return []
})

ipcMain.handle('save-archived', (_event, archived: string[]) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'archived-modules.json'), JSON.stringify(archived, null, 2))
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

// --- Probe persistence ---
function probesPath() {
  return path.join(app.getPath('userData'), 'device-probes.json')
}

let cachedProbes: Record<string, unknown> = {}
try {
  const p = probesPath()
  if (fs.existsSync(p)) cachedProbes = JSON.parse(fs.readFileSync(p, 'utf-8'))
} catch {}

function saveProbes() {
  try { fs.writeFileSync(probesPath(), JSON.stringify(cachedProbes, null, 2)) } catch {}
}

ipcMain.handle('load-probes', () => cachedProbes)

ipcMain.handle('save-probe', (_event, ip: string, result: unknown) => {
  cachedProbes[ip] = result
  saveProbes()
})

// Auto-probe: after a scan, probe any device that hasn't been probed yet (runs in background)
ipcMain.handle('auto-probe-new', async (_event, devices: { ip: string; mac: string }[]) => {
  const unprobed = devices.filter(d => !cachedProbes[d.ip])
  const results: Record<string, unknown> = {}
  for (const d of unprobed) {
    try {
      const ttl = await getTTL(d.ip)
      const portResults = await Promise.all(
        PROBE_PORTS.map(async p => {
          const r = await tcpProbe(d.ip, p.port, 1000)
          return r.open ? { port: p.port, name: p.name, open: true, banner: r.banner } : null
        })
      )
      const openPorts = portResults.filter(Boolean) as { port: number; name: string; open: boolean; banner: string }[]
      const httpResults: { port: number; server: string; title: string; redirectUrl: string; secure: boolean }[] = []
      for (const p of openPorts.filter(p => [80, 443, 8080, 8443, 8000, 5000, 32400].includes(p.port))) {
        const secure = [443, 8443].includes(p.port)
        const h = await httpProbe(d.ip, p.port, secure)
        if (h.server || h.title) httpResults.push({ port: p.port, secure, ...h })
      }
      const result = {
        ip: d.ip, mac: d.mac, vendor: lookupVendor(d.mac),
        ttl, osGuess: guessOS(ttl), ports: openPorts, http: httpResults,
        mdnsServices: [], netbiosName: '', ssdpInfo: '', arpType: '', reverseDns: '',
      }
      results[d.ip] = result
      cachedProbes[d.ip] = result
      // Send incremental update to renderer
      BrowserWindow.getAllWindows().forEach(w => {
        try { w.webContents.send('probe-result', d.ip, result) } catch {}
      })
    } catch {}
  }
  saveProbes()
  return results
})

// --- Network Probe / Deep Scan ---

// Common ports to scan, grouped by service type
const PROBE_PORTS: { port: number; name: string; proto: string }[] = [
  { port: 21, name: 'FTP', proto: 'tcp' },
  { port: 22, name: 'SSH', proto: 'tcp' },
  { port: 23, name: 'Telnet', proto: 'tcp' },
  { port: 25, name: 'SMTP', proto: 'tcp' },
  { port: 53, name: 'DNS', proto: 'tcp' },
  { port: 80, name: 'HTTP', proto: 'tcp' },
  { port: 443, name: 'HTTPS', proto: 'tcp' },
  { port: 445, name: 'SMB', proto: 'tcp' },
  { port: 548, name: 'AFP', proto: 'tcp' },
  { port: 554, name: 'RTSP', proto: 'tcp' },
  { port: 631, name: 'IPP/CUPS', proto: 'tcp' },
  { port: 1883, name: 'MQTT', proto: 'tcp' },
  { port: 3000, name: 'Dev Server', proto: 'tcp' },
  { port: 3306, name: 'MySQL', proto: 'tcp' },
  { port: 3389, name: 'RDP', proto: 'tcp' },
  { port: 5000, name: 'UPnP/Dev', proto: 'tcp' },
  { port: 5353, name: 'mDNS', proto: 'tcp' },
  { port: 5432, name: 'PostgreSQL', proto: 'tcp' },
  { port: 5900, name: 'VNC', proto: 'tcp' },
  { port: 8000, name: 'HTTP Alt', proto: 'tcp' },
  { port: 8080, name: 'HTTP Proxy', proto: 'tcp' },
  { port: 8443, name: 'HTTPS Alt', proto: 'tcp' },
  { port: 8883, name: 'MQTT TLS', proto: 'tcp' },
  { port: 9090, name: 'Prometheus', proto: 'tcp' },
  { port: 9100, name: 'Printer', proto: 'tcp' },
  { port: 32400, name: 'Plex', proto: 'tcp' },
  { port: 49152, name: 'UPnP', proto: 'tcp' },
  { port: 62078, name: 'iPhone', proto: 'tcp' },
]

// TCP connect scan a single port with timeout
function tcpProbe(ip: string, port: number, timeout = 1500): Promise<{ open: boolean; banner: string }> {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let banner = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ open: false, banner: '' })
    }, timeout)

    socket.connect(port, ip, () => {
      // Port is open — try to read a banner
      socket.setTimeout(800)
    })

    socket.on('data', (data) => {
      banner += data.toString('utf-8', 0, Math.min(data.length, 512))
      clearTimeout(timer)
      socket.destroy()
      resolve({ open: true, banner: banner.trim() })
    })

    socket.on('timeout', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ open: true, banner: '' })
    })

    socket.on('error', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ open: false, banner: '' })
    })
  })
}

// Grab HTTP headers and title from a web server
async function httpProbe(ip: string, port: number, secure: boolean): Promise<{
  server: string; title: string; headers: Record<string, string>; redirectUrl: string
}> {
  return new Promise(resolve => {
    const result = { server: '', title: '', headers: {} as Record<string, string>, redirectUrl: '' }
    const mod = secure ? https : http
    const req = mod.get({
      hostname: ip, port, path: '/', timeout: 3000,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'TheGrid/1.0' },
    }, (res) => {
      result.headers = res.headers as Record<string, string>
      result.server = (res.headers['server'] || '') as string
      if (res.headers['location']) result.redirectUrl = res.headers['location'] as string

      let body = ''
      res.setEncoding('utf-8')
      res.on('data', chunk => { body += chunk; if (body.length > 4096) res.destroy() })
      res.on('end', () => {
        const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i)
        if (titleMatch) result.title = titleMatch[1].trim()
        resolve(result)
      })
      res.on('error', () => resolve(result))
    })
    req.on('error', () => resolve(result))
    req.on('timeout', () => { req.destroy(); resolve(result) })
  })
}

// Get ping TTL to guess OS type
async function getTTL(ip: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`ping -c 1 -W 1000 ${ip}`)
    const match = stdout.match(/ttl[=:](\d+)/i)
    return match ? parseInt(match[1]) : null
  } catch { return null }
}

function guessOS(ttl: number | null): string {
  if (!ttl) return 'Unknown'
  if (ttl <= 64 && ttl > 32) return 'Linux/macOS/iOS'
  if (ttl <= 128 && ttl > 64) return 'Windows'
  if (ttl <= 255 && ttl > 128) return 'Network device'
  if (ttl <= 32) return 'Embedded/IoT'
  return 'Unknown'
}

// MAC vendor lookup (first 3 octets → OUI)
// Small built-in table of common vendors
const MAC_VENDORS: Record<string, string> = {
  '00:50:56': 'VMware', '00:0c:29': 'VMware', '00:1c:42': 'Parallels',
  'b8:27:eb': 'Raspberry Pi', 'dc:a6:32': 'Raspberry Pi', 'e4:5f:01': 'Raspberry Pi',
  'd8:3a:dd': 'Raspberry Pi',
  '00:17:88': 'Philips Hue', 'ec:b5:fa': 'Philips Hue',
  'f0:d5:bf': 'Google', '30:fd:38': 'Google', 'a4:77:33': 'Google',
  '44:07:0b': 'Google', '54:60:09': 'Google',
  '68:ff:7b': 'Amazon', '74:c2:46': 'Amazon', 'a4:08:01': 'Amazon',
  'fc:65:de': 'Amazon', '14:91:82': 'Amazon',
  '3c:22:fb': 'Apple', 'a8:60:b6': 'Apple', 'f0:18:98': 'Apple',
  'ac:de:48': 'Apple', '00:a0:40': 'Apple', '88:66:a5': 'Apple',
  'bc:d0:74': 'Apple', 'f8:ff:c2': 'Apple', '78:7b:8a': 'Apple',
  '28:6c:07': 'Apple', 'a4:83:e7': 'Apple', '6c:96:cf': 'Apple',
  'a0:99:9b': 'Apple',
  '50:02:91': 'Samsung', 'a8:7c:01': 'Samsung', 'c0:97:27': 'Samsung',
  'f4:42:8f': 'Samsung', '30:07:4d': 'Samsung',
  'b0:be:76': 'TP-Link', '60:32:b1': 'TP-Link', 'c0:06:c3': 'TP-Link',
  '98:da:c4': 'TP-Link', 'ac:15:a2': 'TP-Link',
  '44:d9:e7': 'Ubiquiti', '78:8a:20': 'Ubiquiti', 'fc:ec:da': 'Ubiquiti',
  '18:e8:29': 'Ubiquiti', '74:ac:b9': 'Ubiquiti', '24:5a:4c': 'Ubiquiti',
  '00:11:32': 'Synology', '00:1a:2b': 'QNAP',
  '70:b3:d5': 'Emporia', 'b4:e6:2d': 'Emporia',
  '00:40:ad': 'SMA Solar', 'c4:7c:8d': 'Enphase',
  'b8:d7:af': 'Murata (IoT)', '2c:f4:32': 'Espressif (ESP)',
  'a4:cf:12': 'Espressif (ESP)', '24:6f:28': 'Espressif (ESP)',
  '60:01:94': 'Espressif (ESP)', '30:ae:a4': 'Espressif (ESP)',
  '00:80:41': 'VoIP device', '00:04:f2': 'Polycom',
  '00:1b:21': 'Intel', '3c:97:0e': 'Intel', '8c:8c:aa': 'Intel',
  'b4:96:91': 'Intel',
  '30:9c:23': 'Belkin/Wemo',
  '34:ea:34': 'HiSilicon (camera)', '00:12:41': 'Amcrest',
  '9c:8e:cd': 'Amcrest', 'e0:63:da': 'Reolink', '54:c0:de': 'Reolink',
  '7c:dd:90': 'Shenzhen (generic IoT)', '78:11:dc': 'Xiaomi',
  'f8:a4:5f': 'Xiaomi', '64:ce:d1': 'Xiaomi',
  '00:1e:06': 'Wibrain (NUC)', 'b0:a7:37': 'Roku',
}

function lookupVendor(mac: string): string {
  const prefix = mac.toLowerCase().slice(0, 8)
  return MAC_VENDORS[prefix] || ''
}

// mDNS query to discover services on a device
async function mdnsProbe(_ip: string): Promise<string[]> {
  return new Promise(resolve => {
    const services: string[] = []
    try {
      // Use dns-sd if available (macOS built-in)
      const proc = spawn('dns-sd', ['-B', '_services._dns-sd._udp', 'local.'], {
        timeout: 3000,
      })
      let output = ''
      proc.stdout.on('data', d => { output += d.toString() })
      setTimeout(() => {
        proc.kill()
        // Parse discovered service types
        for (const line of output.split('\n')) {
          const match = line.match(/(_\S+)\s+local\./)
          if (match && !services.includes(match[1])) services.push(match[1])
        }
        resolve(services)
      }, 2500)
      proc.on('error', () => resolve([]))
    } catch { resolve([]) }
  })
}

// Full probe of a single IP
ipcMain.handle('probe-device', async (_event, ip: string, mac?: string) => {
  const result: {
    ip: string
    mac: string
    vendor: string
    ttl: number | null
    osGuess: string
    ports: { port: number; name: string; open: boolean; banner: string }[]
    http: { port: number; server: string; title: string; redirectUrl: string; secure: boolean }[]
    mdnsServices: string[]
  } = {
    ip,
    mac: mac || '',
    vendor: mac ? lookupVendor(mac) : '',
    ttl: null,
    osGuess: 'Unknown',
    ports: [],
    http: [],
    mdnsServices: [],
  }

  // Step 1: TTL + OS guess
  result.ttl = await getTTL(ip)
  result.osGuess = guessOS(result.ttl)

  // Step 2: Port scan (parallel, all common ports)
  const portResults = await Promise.all(
    PROBE_PORTS.map(async p => {
      const r = await tcpProbe(ip, p.port)
      return { port: p.port, name: p.name, open: r.open, banner: r.banner }
    })
  )
  result.ports = portResults.filter(p => p.open)

  // Step 3: HTTP fingerprint on open web ports
  const webPorts = result.ports.filter(p =>
    [80, 443, 8080, 8443, 3000, 5000, 8000, 9090, 32400].includes(p.port)
  )
  for (const wp of webPorts) {
    const secure = [443, 8443].includes(wp.port)
    const httpInfo = await httpProbe(ip, wp.port, secure)
    if (httpInfo.server || httpInfo.title) {
      result.http.push({ port: wp.port, secure, ...httpInfo })
    }
  }

  // Step 4: mDNS (only if port 5353 is responsive or as general discovery)
  if (result.ports.some(p => p.port === 5353) || result.ports.length > 0) {
    result.mdnsServices = await mdnsProbe(ip)
  }

  // Auto-save probe result to disk
  cachedProbes[ip] = result
  saveProbes()

  return result
})

// Quick port scan — just check if ports are open, no fingerprinting
ipcMain.handle('quick-scan', async (_event, ip: string) => {
  const results = await Promise.all(
    PROBE_PORTS.map(async p => {
      const r = await tcpProbe(ip, p.port, 1000)
      return r.open ? { port: p.port, name: p.name, banner: r.banner } : null
    })
  )
  return results.filter(Boolean)
})

// Extended port list for deep scanning mystery devices
const DEEP_PORTS: { port: number; name: string }[] = [
  // All standard ports plus IoT, smart home, cameras, etc.
  { port: 7, name: 'Echo' }, { port: 9, name: 'WOL' },
  { port: 13, name: 'Daytime' }, { port: 17, name: 'QOTD' },
  { port: 37, name: 'Time' }, { port: 42, name: 'WINS' },
  { port: 49, name: 'TACACS' }, { port: 67, name: 'DHCP' },
  { port: 68, name: 'DHCP Client' }, { port: 69, name: 'TFTP' },
  { port: 79, name: 'Finger' }, { port: 81, name: 'HTTP Alt' },
  { port: 88, name: 'Kerberos' }, { port: 110, name: 'POP3' },
  { port: 111, name: 'RPC' }, { port: 119, name: 'NNTP' },
  { port: 123, name: 'NTP' }, { port: 135, name: 'MSRPC' },
  { port: 137, name: 'NetBIOS-NS' }, { port: 138, name: 'NetBIOS-DGM' },
  { port: 139, name: 'NetBIOS-SSN' }, { port: 143, name: 'IMAP' },
  { port: 161, name: 'SNMP' }, { port: 162, name: 'SNMP Trap' },
  { port: 179, name: 'BGP' }, { port: 389, name: 'LDAP' },
  { port: 427, name: 'SLP' }, { port: 443, name: 'HTTPS' },
  { port: 500, name: 'IKE/VPN' }, { port: 515, name: 'LPD Print' },
  { port: 520, name: 'RIP' }, { port: 546, name: 'DHCPv6' },
  { port: 547, name: 'DHCPv6 Server' }, { port: 587, name: 'SMTP Sub' },
  { port: 593, name: 'HTTP RPC' }, { port: 636, name: 'LDAPS' },
  { port: 873, name: 'rsync' }, { port: 993, name: 'IMAPS' },
  { port: 995, name: 'POP3S' }, { port: 1080, name: 'SOCKS' },
  { port: 1194, name: 'OpenVPN' }, { port: 1433, name: 'MSSQL' },
  { port: 1434, name: 'MSSQL Browser' }, { port: 1521, name: 'Oracle' },
  { port: 1701, name: 'L2TP' }, { port: 1723, name: 'PPTP' },
  { port: 1812, name: 'RADIUS' }, { port: 1900, name: 'SSDP/UPnP' },
  { port: 2049, name: 'NFS' }, { port: 2082, name: 'cPanel' },
  { port: 2083, name: 'cPanel SSL' }, { port: 2181, name: 'Zookeeper' },
  { port: 2222, name: 'SSH Alt' }, { port: 2375, name: 'Docker' },
  { port: 2376, name: 'Docker TLS' }, { port: 3128, name: 'Squid' },
  { port: 3283, name: 'Apple Remote' }, { port: 3478, name: 'STUN' },
  { port: 3689, name: 'iTunes/DAAP' }, { port: 4000, name: 'Thin' },
  { port: 4040, name: 'Avahi' }, { port: 4443, name: 'HTTPS Alt' },
  { port: 4500, name: 'IPSec NAT' }, { port: 4567, name: 'Sinatra' },
  { port: 4713, name: 'PulseAudio' }, { port: 4786, name: 'Cisco Smart' },
  { port: 5001, name: 'Synology' }, { port: 5004, name: 'RTP' },
  { port: 5060, name: 'SIP' }, { port: 5222, name: 'XMPP' },
  { port: 5269, name: 'XMPP S2S' }, { port: 5357, name: 'WSDAPI' },
  { port: 5500, name: 'VNC Alt' }, { port: 5601, name: 'Kibana' },
  { port: 5800, name: 'VNC HTTP' }, { port: 5901, name: 'VNC :1' },
  { port: 6000, name: 'X11' }, { port: 6379, name: 'Redis' },
  { port: 6443, name: 'K8s API' }, { port: 6667, name: 'IRC' },
  { port: 6881, name: 'BitTorrent' }, { port: 7070, name: 'RealServer' },
  { port: 7443, name: 'HTTPS Alt' }, { port: 7547, name: 'TR-069' },
  { port: 8008, name: 'HTTP Alt' }, { port: 8009, name: 'AJP' },
  { port: 8081, name: 'HTTP Alt' }, { port: 8088, name: 'HTTP Alt' },
  { port: 8123, name: 'Home Asst' }, { port: 8181, name: 'HTTP Alt' },
  { port: 8200, name: 'GoToMyPC' }, { port: 8291, name: 'MikroTik' },
  { port: 8443, name: 'HTTPS Alt' }, { port: 8444, name: 'HTTPS Alt' },
  { port: 8500, name: 'Consul' }, { port: 8545, name: 'Ethereum' },
  { port: 8728, name: 'MikroTik API' }, { port: 8834, name: 'Nessus' },
  { port: 8888, name: 'HTTP Alt' }, { port: 9000, name: 'Portainer' },
  { port: 9001, name: 'ETH/Tor' }, { port: 9043, name: 'WebSphere' },
  { port: 9080, name: 'HTTP Alt' }, { port: 9091, name: 'Transmission' },
  { port: 9200, name: 'Elasticsearch' }, { port: 9300, name: 'ES Transport' },
  { port: 9443, name: 'HTTPS Alt' }, { port: 9876, name: 'Mondorescue' },
  { port: 9999, name: 'Urchin' }, { port: 10000, name: 'Webmin' },
  { port: 10001, name: 'Ubiquiti Disc' }, { port: 10243, name: 'MS WSUS' },
  { port: 11211, name: 'Memcached' }, { port: 12345, name: 'NetBus' },
  { port: 15672, name: 'RabbitMQ' }, { port: 16992, name: 'Intel AMT' },
  { port: 16993, name: 'Intel AMT TLS' }, { port: 17000, name: 'Cassia Hub' },
  { port: 18080, name: 'HTTP Alt' }, { port: 19132, name: 'Minecraft BE' },
  { port: 20000, name: 'DNP3' }, { port: 25565, name: 'Minecraft' },
  { port: 27017, name: 'MongoDB' }, { port: 28017, name: 'MongoDB Web' },
  { port: 30303, name: 'Ethereum P2P' }, { port: 32469, name: 'Plex DLNA' },
  { port: 37215, name: 'Huawei HG' }, { port: 37777, name: 'Dahua Cam' },
  { port: 44818, name: 'EtherNet/IP' }, { port: 47808, name: 'BACnet' },
  { port: 49153, name: 'UPnP' }, { port: 49154, name: 'UPnP' },
  { port: 50000, name: 'SAP' }, { port: 51820, name: 'WireGuard' },
  { port: 55442, name: 'Reolink' }, { port: 55443, name: 'Reolink HTTPS' },
  { port: 56790, name: 'IoT Misc' },
]

// Combine both port lists, deduplicate
function getAllPorts() {
  const seen = new Set<number>()
  const all: { port: number; name: string }[] = []
  for (const p of PROBE_PORTS) {
    if (!seen.has(p.port)) { seen.add(p.port); all.push({ port: p.port, name: p.name }) }
  }
  for (const p of DEEP_PORTS) {
    if (!seen.has(p.port)) { seen.add(p.port); all.push({ port: p.port, name: p.name }) }
  }
  return all.sort((a, b) => a.port - b.port)
}

// Try to get more info about a device via ARP, nbtscan, SSDP
async function deepIdentify(ip: string, _mac: string): Promise<{
  netbiosName: string
  ssdpInfo: string
  arpType: string
  reverseDns: string
}> {
  const result = { netbiosName: '', ssdpInfo: '', arpType: '', reverseDns: '' }

  // Reverse DNS
  try {
    const { stdout } = await execAsync(`host ${ip} 2>/dev/null`, { timeout: 3000 })
    const match = stdout.match(/pointer\s+(.+)\.?$/)
    if (match) result.reverseDns = match[1].replace(/\.$/, '')
  } catch {}

  // ARP entry type (check if it's static, dynamic, etc.)
  try {
    const { stdout } = await execAsync(`arp -n ${ip} 2>/dev/null`, { timeout: 2000 })
    if (stdout.includes('permanent')) result.arpType = 'permanent'
    else if (stdout.includes('(incomplete)')) result.arpType = 'incomplete'
    else result.arpType = 'dynamic'
  } catch {}

  // SSDP M-SEARCH for UPnP device description
  try {
    const ssdp = await new Promise<string>((resolve) => {
      const dgram = require('node:dgram') as typeof import('node:dgram')
      const socket = dgram.createSocket('udp4')
      const msg = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${ip}:1900\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: ssdp:all\r\n\r\n'
      )
      let response = ''
      const timer = setTimeout(() => { socket.close(); resolve(response) }, 3000)
      socket.on('message', (data) => {
        response += data.toString()
      })
      socket.on('error', () => { clearTimeout(timer); socket.close(); resolve('') })
      socket.send(msg, 0, msg.length, 1900, ip)
    })
    if (ssdp) {
      const serverMatch = ssdp.match(/SERVER:\s*(.+)/i)
      const locMatch = ssdp.match(/LOCATION:\s*(.+)/i)
      const parts: string[] = []
      if (serverMatch) parts.push(serverMatch[1].trim())
      if (locMatch) parts.push(locMatch[1].trim())
      result.ssdpInfo = parts.join(' | ')
    }
  } catch {}

  return result
}

// Deep probe — extended port range + extra identification
ipcMain.handle('deep-probe-device', async (_event, ip: string, mac?: string) => {
  const allPorts = getAllPorts()

  const result: {
    ip: string
    mac: string
    vendor: string
    ttl: number | null
    osGuess: string
    ports: { port: number; name: string; open: boolean; banner: string }[]
    http: { port: number; server: string; title: string; redirectUrl: string; secure: boolean }[]
    mdnsServices: string[]
    netbiosName: string
    ssdpInfo: string
    arpType: string
    reverseDns: string
  } = {
    ip,
    mac: mac || '',
    vendor: mac ? lookupVendor(mac) : '',
    ttl: null,
    osGuess: 'Unknown',
    ports: [],
    http: [],
    mdnsServices: [],
    netbiosName: '',
    ssdpInfo: '',
    arpType: '',
    reverseDns: '',
  }

  // TTL + OS
  result.ttl = await getTTL(ip)
  result.osGuess = guessOS(result.ttl)

  // Deep identification (reverse DNS, SSDP, ARP type) in parallel with port scan
  const [deepId, portResults] = await Promise.all([
    deepIdentify(ip, mac || ''),
    // Scan all ports in batches of 50 to avoid overwhelming
    (async () => {
      const results: { port: number; name: string; open: boolean; banner: string }[] = []
      for (let i = 0; i < allPorts.length; i += 50) {
        const batch = allPorts.slice(i, i + 50)
        const batchResults = await Promise.all(
          batch.map(async p => {
            const r = await tcpProbe(ip, p.port, 1200)
            return { port: p.port, name: p.name, open: r.open, banner: r.banner }
          })
        )
        results.push(...batchResults.filter(p => p.open))
      }
      return results
    })(),
  ])

  Object.assign(result, deepId)
  result.ports = portResults

  // HTTP fingerprint open web ports
  const webPorts = result.ports.filter(p =>
    [80, 81, 443, 3000, 4443, 5000, 5001, 7443, 8000, 8008, 8080, 8081, 8088, 8123,
     8181, 8200, 8443, 8444, 8888, 9000, 9080, 9090, 9443, 10000, 18080, 32400].includes(p.port)
  )
  for (const wp of webPorts) {
    const secure = [443, 4443, 5001, 7443, 8443, 8444, 9443].includes(wp.port)
    const httpInfo = await httpProbe(ip, wp.port, secure)
    if (httpInfo.server || httpInfo.title) {
      result.http.push({ port: wp.port, secure, ...httpInfo })
    }
  }

  // mDNS
  result.mdnsServices = await mdnsProbe(ip)

  // Auto-save probe result to disk
  cachedProbes[ip] = result
  saveProbes()

  return result
})

// Deep scan ALL online devices — probes each one sequentially, sends progress updates
ipcMain.handle('deep-scan-all', async (_event, devices: { ip: string; mac: string }[]) => {
  const results: Record<string, any> = {}
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i]
    win?.webContents.send('deep-scan-progress', { current: i + 1, total: devices.length, ip: d.ip })
    try {
      // Use the standard probe (not the extended deep one) for speed when scanning all
      const ttl = await getTTL(d.ip)
      const portResults = await Promise.all(
        PROBE_PORTS.map(async p => {
          const r = await tcpProbe(d.ip, p.port, 1000)
          return r.open ? { port: p.port, name: p.name, open: true, banner: r.banner } : null
        })
      )
      const openPorts = portResults.filter(Boolean) as { port: number; name: string; open: boolean; banner: string }[]

      // Quick HTTP fingerprint on web ports
      const httpResults: { port: number; server: string; title: string; redirectUrl: string; secure: boolean }[] = []
      for (const p of openPorts.filter(p => [80, 443, 8080, 8443, 8000, 5000, 32400].includes(p.port))) {
        const secure = [443, 8443].includes(p.port)
        const h = await httpProbe(d.ip, p.port, secure)
        if (h.server || h.title) httpResults.push({ port: p.port, secure, ...h })
      }

      results[d.ip] = {
        ip: d.ip,
        mac: d.mac,
        vendor: lookupVendor(d.mac),
        ttl,
        osGuess: guessOS(ttl),
        ports: openPorts,
        http: httpResults,
        mdnsServices: [],
        netbiosName: '',
        ssdpInfo: '',
        arpType: '',
        reverseDns: '',
      }
    } catch {}
  }
  // Save all probe results to disk
  Object.assign(cachedProbes, results)
  saveProbes()
  return results
})

// --- Life360 API ---
const LIFE360_BASE = 'https://www.life360.com'
let life360Token: string | null = null

async function life360Fetch(endpoint: string): Promise<any> {
  if (!life360Token) throw new Error('Not authenticated')

  const headers: Record<string, string> = { 'Accept': 'application/json' }

  if (life360Token === '__cookie_auth__') {
    // Use cookies from the webview session
    const life360Session = session.fromPartition('persist:life360')
    const cookies = await life360Session.cookies.get({ domain: '.life360.com' })
    headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  } else {
    headers['Authorization'] = `Bearer ${life360Token}`
  }

  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, LIFE360_BASE)
    const req = https.request(url, { headers }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(data) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

ipcMain.handle('life360-check-session', () => {
  try {
    const p = path.join(app.getPath('userData'), 'life360-token.json')
    if (fs.existsSync(p)) {
      const saved = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (saved.token) {
        life360Token = saved.token
        return true
      }
    }
  } catch {}
  return false
})

// Intercept Life360 webview token responses
app.whenReady().then(() => {
  const life360Session = session.fromPartition('persist:life360')
  life360Session.webRequest.onCompleted({
    urls: ['https://www.life360.com/v3/oauth2/token*', 'https://api.life360.com/v3/oauth2/token*']
  }, (details) => {
    if (details.statusCode === 200 && details.method === 'POST') {
      // Token endpoint was hit successfully — now fetch it via the webview's cookies/response
      // We need to read the response body. Since onCompleted doesn't give us the body,
      // we use a different approach: intercept via debugger or just watch for Bearer headers
    }
  })

  // Watch for any authenticated API requests to grab the Bearer token
  life360Session.webRequest.onBeforeSendHeaders({
    urls: ['https://www.life360.com/v3/*', 'https://api.life360.com/v3/*']
  }, (details, callback) => {
    const authHeader = details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
    if (authHeader && authHeader.startsWith('Bearer ') && !life360Token) {
      const token = authHeader.replace('Bearer ', '')
      life360Token = token
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'life360-token.json'),
        JSON.stringify({ token })
      )
      win?.webContents.send('life360-token-captured', token)
    }
    callback({ requestHeaders: details.requestHeaders })
  })
})

// Extract token from Life360 webview session cookies or by making an API call
ipcMain.handle('life360-extract-token', async () => {
  try {
    const life360Session = session.fromPartition('persist:life360')
    const cookies = await life360Session.cookies.get({ domain: '.life360.com' })

    // Look for auth-related cookies
    const tokenCookie = cookies.find(c =>
      c.name.toLowerCase().includes('token') ||
      c.name.toLowerCase().includes('auth') ||
      c.name.toLowerCase().includes('session') ||
      c.name === 'access_token'
    )

    if (tokenCookie) {
      life360Token = tokenCookie.value
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'life360-token.json'),
        JSON.stringify({ token: tokenCookie.value })
      )
      return { ok: true, token: tokenCookie.value }
    }

    // If no obvious token cookie, try making an API call using the session cookies
    // The webview is authenticated, so we can fetch via the session
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

    // Try to get circles using cookie auth
    const result: any = await new Promise((resolve, reject) => {
      const url = new URL('/v3/circles', LIFE360_BASE)
      const req = https.request(url, {
        headers: {
          'Cookie': cookieHeader,
          'Accept': 'application/json',
        },
      }, res => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ raw: data }) }
        })
      })
      req.on('error', reject)
      req.end()
    })

    // If cookie auth works, we can use cookies directly
    if (result.circles) {
      life360Token = '__cookie_auth__'
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'life360-token.json'),
        JSON.stringify({ token: '__cookie_auth__', cookies: cookieHeader })
      )
      return { ok: true, mode: 'cookie' }
    }

    // Return cookie names for debugging
    return { error: 'No token found', cookieNames: cookies.map(c => c.name) }
  } catch (e: any) {
    return { error: e.message }
  }
})

ipcMain.handle('life360-save-token', (_event, token: string) => {
  life360Token = token
  fs.writeFileSync(
    path.join(app.getPath('userData'), 'life360-token.json'),
    JSON.stringify({ token })
  )
})

ipcMain.handle('life360-logout', () => {
  life360Token = null
  const p = path.join(app.getPath('userData'), 'life360-token.json')
  if (fs.existsSync(p)) fs.unlinkSync(p)
})

ipcMain.handle('life360-circles', async () => {
  try {
    const data = await life360Fetch('/v3/circles')
    console.log('life360 /v3/circles raw:', JSON.stringify(data).slice(0, 500))

    if (!data.circles) return { error: 'No circles key in response', raw: JSON.stringify(data).slice(0, 300) }

    // For each circle, fetch members
    const results = []
    for (const c of data.circles) {
      const detail = await life360Fetch(`/v3/circles/${c.id}`)
      results.push({
        id: c.id,
        name: c.name,
        memberCount: c.memberCount,
        members: detail.members || [],
      })
    }
    return results
  } catch (e: any) {
    return { error: e.message }
  }
})

// --- Detach module into its own window ---
ipcMain.handle('detach-module', (_event, moduleId: string) => {
  const child = new BrowserWindow({
    width: 800,
    height: 600,
    backgroundColor: '#080808',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
    },
  })
  const url = VITE_DEV_SERVER_URL
    ? `${VITE_DEV_SERVER_URL}#/module/${moduleId}`
    : `file://${path.join(RENDERER_DIST, 'index.html')}#/module/${moduleId}`
  child.loadURL(url)
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

// ── Emporia Energy Monitor ──────────────────────────────────────────────────

// Cognito pool: us-east-2_ghlOXVLi1
const EMPORIA_COGNITO_CLIENT = '4qte47jbstod8apnfic0bunmrq'
const EMPORIA_API = 'https://api.emporiaenergy.com'

let emporiaTokens: { idToken: string; accessToken: string; refreshToken: string; expiresAt: number } | null = null
let emporiaDevices: { deviceGid: number; name: string; channels: { channelNum: string; name: string; channelMultiplier: number; type: string }[] }[] = []

function emporiaConfigPath() { return path.join(app.getPath('userData'), 'emporia-config.json') }

ipcMain.handle('emporia-load-config', () => {
  try {
    const p = emporiaConfigPath()
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      return { email: data.email, hasPassword: !!data.password }
    }
  } catch {}
  return null
})

ipcMain.handle('emporia-login', async (_e, email: string, password: string) => {
  try {
    // Authenticate via AWS Cognito USER_PASSWORD_AUTH
    const authPayload = JSON.stringify({
      AuthParameters: { USERNAME: email, PASSWORD: password },
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: EMPORIA_COGNITO_CLIENT,
    })

    const authResult: any = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'cognito-idp.us-east-2.amazonaws.com',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
      }, res => {
        let data = ''
        res.on('data', (c: Buffer) => { data += c.toString() })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (res.statusCode === 200) resolve(parsed)
            else reject(new Error(parsed.message || parsed.__type || 'Auth failed'))
          } catch { reject(new Error('Invalid response')) }
        })
      })
      req.on('error', reject)
      req.write(authPayload)
      req.end()
    })

    const result = authResult.AuthenticationResult
    if (!result) throw new Error('No auth result')

    emporiaTokens = {
      idToken: result.IdToken,
      accessToken: result.AccessToken,
      refreshToken: result.RefreshToken,
      expiresAt: Date.now() + (result.ExpiresIn * 1000),
    }

    // Save credentials (encrypted)
    const config = { email, password: encryptPw(password) }
    fs.writeFileSync(emporiaConfigPath(), JSON.stringify(config, null, 2))

    // Fetch devices
    await emporiaFetchDevices()
    return { success: true, devices: emporiaDevices }
  } catch (err: any) {
    return { success: false, error: err.message || 'Login failed' }
  }
})

ipcMain.handle('emporia-auto-login', async () => {
  try {
    const p = emporiaConfigPath()
    if (!fs.existsSync(p)) return { success: false, error: 'No saved credentials' }
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!data.email || !data.password) return { success: false, error: 'Missing credentials' }
    const password = decryptPw(data.password)

    // Reuse existing tokens if still valid
    if (emporiaTokens && Date.now() < emporiaTokens.expiresAt - 60000) {
      if (emporiaDevices.length === 0) await emporiaFetchDevices()
      return { success: true, devices: emporiaDevices }
    }

    // Re-authenticate
    const authPayload = JSON.stringify({
      AuthParameters: { USERNAME: data.email, PASSWORD: password },
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: EMPORIA_COGNITO_CLIENT,
    })

    const authResult: any = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'cognito-idp.us-east-2.amazonaws.com',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
      }, res => {
        let d = ''
        res.on('data', (c: Buffer) => { d += c.toString() })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d)
            if (res.statusCode === 200) resolve(parsed)
            else reject(new Error(parsed.message || 'Auth failed'))
          } catch { reject(new Error('Invalid response')) }
        })
      })
      req.on('error', reject)
      req.write(authPayload)
      req.end()
    })

    const auth = authResult.AuthenticationResult
    if (!auth) throw new Error('No auth result')

    emporiaTokens = {
      idToken: auth.IdToken,
      accessToken: auth.AccessToken,
      refreshToken: auth.RefreshToken || emporiaTokens?.refreshToken || '',
      expiresAt: Date.now() + (auth.ExpiresIn * 1000),
    }

    await emporiaFetchDevices()
    return { success: true, devices: emporiaDevices }
  } catch (err: any) {
    return { success: false, error: err.message || 'Auto-login failed' }
  }
})

function emporiaApiGet(endpoint: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!emporiaTokens) return reject(new Error('Not authenticated'))
    const url = new URL(endpoint, EMPORIA_API)
    https.get(url, {
      headers: { 'authtoken': emporiaTokens.idToken },
    }, res => {
      let data = ''
      res.on('data', (c: Buffer) => { data += c.toString() })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Invalid JSON')) }
      })
    }).on('error', reject)
  })
}

async function emporiaFetchDevices() {
  const data = await emporiaApiGet('/customers/devices')
  if (data?.devices) {
    emporiaDevices = data.devices.map((d: any) => ({
      deviceGid: d.deviceGid,
      name: d.locationProperties?.deviceName || d.model || `Device ${d.deviceGid}`,
      channels: (d.devices || []).concat([d]).flatMap((sub: any) =>
        (sub.channels || []).map((ch: any) => ({
          channelNum: ch.channelNum,
          name: ch.name || ch.channelNum,
          channelMultiplier: ch.channelMultiplier || 1,
          type: ch.type || '',
        }))
      ),
    }))
  }
}

ipcMain.handle('emporia-get-usage', async (_e, scale?: string) => {
  try {
    if (!emporiaTokens || !emporiaDevices.length) return null

    // Ensure tokens are fresh
    if (Date.now() >= emporiaTokens.expiresAt - 60000) {
      }

    const gids = emporiaDevices.map(d => d.deviceGid).join('+')
    const now = new Date()
    const instant = now.toISOString()
    const s = scale || '1S'

    const data = await emporiaApiGet(
      `/AppAPI?apiMethod=getDeviceListUsages&deviceGids=${gids}&instant=${instant}&scale=${s}&energyUnit=KilowattHours`
    )
    return data
  } catch (err: any) {
    return { error: err.message }
  }
})

ipcMain.handle('emporia-get-chart', async (_e, scale: string, days: number) => {
  try {
    if (!emporiaTokens || !emporiaDevices.length) return null
    const now = new Date()
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    // Get chart data for each device and combine
    const results: { gid: number; name: string; usageList: number[]; firstInstant: string }[] = []
    for (const dev of emporiaDevices) {
      const data = await emporiaApiGet(
        `/AppAPI?apiMethod=getChartUsage&deviceGid=${dev.deviceGid}&channel=1,2,3&start=${start.toISOString()}&end=${now.toISOString()}&scale=${scale}&energyUnit=KilowattHours`
      )
      if (data?.usageList) {
        results.push({
          gid: dev.deviceGid,
          name: dev.name,
          usageList: data.usageList,
          firstInstant: data.firstUsageInstant,
        })
      }
    }
    // Combine both panels into one total array
    if (results.length === 0) return null
    const maxLen = Math.max(...results.map(r => r.usageList.length))
    const combined: number[] = []
    for (let i = 0; i < maxLen; i++) {
      let sum = 0
      for (const r of results) {
        const v = r.usageList[i]
        if (v != null) sum += v
      }
      combined.push(sum)
    }
    return { usageList: combined, firstInstant: results[0].firstInstant, scale }
  } catch (err: any) {
    return { error: err.message }
  }
})

ipcMain.handle('emporia-get-devices', () => emporiaDevices)

ipcMain.handle('emporia-logout', () => {
  emporiaTokens = null
  emporiaDevices = []
  try { fs.unlinkSync(emporiaConfigPath()) } catch {}
  return true
})

