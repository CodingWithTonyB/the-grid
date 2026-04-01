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
import EnergyMonitorMeta from './EnergyMonitor/meta'
import EnergyMonitor from './EnergyMonitor'
import Life360Meta from './Life360/meta'
import Life360 from './Life360'

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
  { ...EnergyMonitorMeta, component: EnergyMonitor },
  { ...Life360Meta, component: Life360 },
]

export default modules
