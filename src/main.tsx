import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

const log = (window as any).__splashLog || (() => {})

// Listen for main process logs
window.ipcRenderer.on('splash-log', (_e: any, msg: string) => log(msg))

log('renderer :: scripts loaded')
log('renderer :: mounting react')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App onReady={() => {
      log('renderer :: app mounted — ready')
      log('READY :: all systems online');
      (window as any).__splashReady?.()
    }} />
  </React.StrictMode>,
)

// Use contextBridge
window.ipcRenderer.on('main-process-message', (_event, message) => {
  console.log(message)
})
