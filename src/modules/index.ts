import { ComponentType } from 'react'
import NetworkScannerMeta from './NetworkScanner/meta'
import NetworkScanner from './NetworkScanner'
import NetworkMonitorMeta from './NetworkMonitor/meta'
import NetworkMonitor from './NetworkMonitor'
import FinderMeta from './Finder/meta'
import Finder from './Finder'
import CameraViewerMeta from './CameraViewer/meta'
import CameraViewer from './CameraViewer'
import SpeedTestMeta from './SpeedTest/meta'
import SpeedTest from './SpeedTest'
import SystemMonitorMeta from './SystemMonitor/meta'
import SystemMonitor from './SystemMonitor'
import ClockMeta from './Clock/meta'
import Clock from './Clock'

export interface Module {
  id: string
  name: string
  description: string
  component: ComponentType
}

const modules: Module[] = [
  { ...NetworkScannerMeta, component: NetworkScanner },
  { ...NetworkMonitorMeta, component: NetworkMonitor },
  { ...FinderMeta, component: Finder },
  { ...CameraViewerMeta, component: CameraViewer },
  { ...SpeedTestMeta, component: SpeedTest },
  { ...SystemMonitorMeta, component: SystemMonitor },
  { ...ClockMeta, component: Clock },
]

export default modules
