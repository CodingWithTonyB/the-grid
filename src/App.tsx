import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'
import modules, { Module } from './modules'

type ModuleItem = { type: 'module'; id: string }
type FolderItem = { type: 'folder'; id: string; name: string; children: string[] }
type GridItem = ModuleItem | FolderItem

function defaultLayout(): GridItem[] {
  return modules.map(m => ({ type: 'module' as const, id: m.id }))
}

// const log = (window as any).__splashLog || (() => {})

// ── Split layout types ──────────────────────────────────────
type SplitDir = 'h' | 'v'
interface SplitState {
  dir: SplitDir
  sizes: [number, number]
  children: [LayoutState, LayoutState]
}
interface PaneState {
  type: 'single'
  openModuleId: string | null  // null = show grid
}
type LayoutState = PaneState | SplitState

function isSplit(s: LayoutState): s is SplitState { return 'dir' in s }

// ── Resize handle ───────────────────────────────────────────
function ResizeHandle({ dir, onResize }: { dir: SplitDir; onResize: (delta: number) => void }) {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    let last = dir === 'h' ? e.clientX : e.clientY
    const onMove = (ev: MouseEvent) => {
      const pos = dir === 'h' ? ev.clientX : ev.clientY
      onResize(pos - last)
      last = pos
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = dir === 'h' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [dir, onResize])

  return <div className={`split-handle split-handle--${dir}`} onMouseDown={onMouseDown} />
}

// ── Detached single-module window ───────────────────────────
function DetachedModuleView({ moduleId }: { moduleId: string }) {
  const mod = modules.find(m => m.id === moduleId)
  if (!mod) return <div className="council"><div className="empty-state">Module not found: {moduleId}</div></div>
  const Comp = mod.component
  return (
    <div className="council council--detached">
      <div className="header"><div className="page-title">{mod.name.toUpperCase()}</div></div>
      <div className="divider" />
      <Comp />
    </div>
  )
}

// ── Single pane — a full independent app instance ───────────
function AppPane({ initialModuleId, layout, archived, showArchive, onSplit, onClose, isInSplit, getLabel, archiveModule, unarchiveModule, setShowArchive }: {
  initialModuleId: string | null
  layout: GridItem[]
  archived: string[]
  showArchive: boolean
  onSplit: (dir: SplitDir, moduleId: string) => void
  onClose: (() => void) | null
  isInSplit: boolean
  getLabel: (id: string, defaultName: string, defaultDesc: string) => { name: string; desc: string }
  archiveModule: (id: string) => void
  unarchiveModule: (id: string) => void
  setShowArchive: (v: boolean) => void
}) {
  const [active, setActive] = useState<Module | null>(
    initialModuleId ? modules.find(m => m.id === initialModuleId) ?? null : null
  )
  const [openFolder, setOpenFolder] = useState<FolderItem | null>(null)
  const [viewPhase, setViewPhase] = useState<'idle' | 'exit' | 'enter'>('idle')

  // Drag state
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [folderDragIdx, setFolderDragIdx] = useState<number | null>(null)
  const [folderHoverIdx, setFolderHoverIdx] = useState<number | null>(null)
  const [edgeHover, setEdgeHover] = useState<'left' | 'right' | 'top' | 'bottom' | null>(null)
  const didDrag = useRef(false)

  function transitionTo(action: () => void) {
    setViewPhase('exit')
    setTimeout(() => {
      action()
      setViewPhase('enter')
      setTimeout(() => setViewPhase('idle'), 300)
    }, 200)
  }

  function openModule(mod: Module) { transitionTo(() => setActive(mod)) }
  function closeToGrid() { transitionTo(() => { setActive(null); setOpenFolder(null) }) }
  function openFolderView(folder: FolderItem) { transitionTo(() => setOpenFolder(folder)) }
  function closeFolderView() { transitionTo(() => setOpenFolder(null)) }

  // Grid drag
  function onDragStart(e: React.DragEvent, idx: number) {
    didDrag.current = false; setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'
  }
  function onDragOver(e: React.DragEvent, idx: number) { e.preventDefault(); setHoverIdx(idx) }
  function resetDrag() { setDragIdx(null); setHoverIdx(null); requestAnimationFrame(() => { didDrag.current = false }) }

  function onDrop(e: React.DragEvent, dropIdx: number) {
    e.preventDefault()
    if (dragIdx === null) { resetDrag(); return }
    if (dragIdx === dropIdx) { resetDrag(); return }
    didDrag.current = true
    resetDrag()
  }

  function onEdgeDrop(edge: 'left' | 'right' | 'top' | 'bottom') {
    if (dragIdx === null) return
    const item = layout[dragIdx]
    if (item?.type !== 'module') return
    const dir: SplitDir = (edge === 'left' || edge === 'right') ? 'h' : 'v'
    onSplit(dir, item.id)
    setEdgeHover(null)
    resetDrag()
  }

  function onDragEnd(e: React.DragEvent, idx: number) {
    if (edgeHover) { setEdgeHover(null); resetDrag(); return }
    const x = e.clientX; const y = e.clientY
    const w = window.innerWidth; const h = window.innerHeight
    if ((x <= 0 || x >= w || y <= 0 || y >= h) && dragIdx !== null) {
      const item = layout[idx]
      if (item?.type === 'module') window.ipcRenderer.invoke('detach-module', item.id)
    }
    resetDrag(); setEdgeHover(null)
  }

  // Folder drag
  function onFolderDragStart(e: React.DragEvent, idx: number) { setFolderDragIdx(idx); e.dataTransfer.effectAllowed = 'move' }
  function onFolderDragOver(e: React.DragEvent, idx: number) { e.preventDefault(); setFolderHoverIdx(idx) }
  function resetFolderDrag() { setFolderDragIdx(null); setFolderHoverIdx(null) }

  const ActiveComponent = active?.component ?? null
  const dragItemType = dragIdx !== null ? layout[dragIdx]?.type : null

  const edgeZone = (edge: 'left' | 'right' | 'top' | 'bottom') => (
    <div
      className={`edge-drop edge-drop--${edge}${edgeHover === edge ? ' edge-drop--active' : ''}`}
      onDragOver={e => { e.preventDefault(); setEdgeHover(edge) }}
      onDragLeave={() => { if (edgeHover === edge) setEdgeHover(null) }}
      onDrop={e => { e.preventDefault(); onEdgeDrop(edge) }}
    />
  )

  return (
    <div className={`pane${isInSplit ? ' pane--split' : ''}`}>
      {dragIdx !== null && <>
        {edgeZone('left')}
        {edgeZone('right')}
        {edgeZone('top')}
        {edgeZone('bottom')}
      </>}
      {!isInSplit && <>
        <div className="tron-corner tron-corner--tl" />
        <div className="tron-corner tron-corner--tr" />
        <div className="tron-corner tron-corner--bl" />
        <div className="tron-corner tron-corner--br" />
        <div className="version-tag">v5.0</div>
      </>}
      <div className={`view-transition${viewPhase === 'exit' ? ' view-exit' : viewPhase === 'enter' ? ' view-enter' : ''}`}>
      <div className={`header${isInSplit ? ' header--compact' : ''}`}>
        {active ? (
          <div className="header-nav">
            <button className="back-btn" onClick={closeToGrid}>← THE GRID</button>
            <div className="page-title">{getLabel(active.id, active.name, active.description).name.toUpperCase()}</div>
            <div className="header-actions">
              <button className="header-action-btn" title="Open in new window" onClick={() => window.ipcRenderer.invoke('detach-module', active.id)}>⧉</button>
              {onClose && <button className="header-action-btn header-action-btn--close" title="Close split" onClick={onClose}>✕</button>}
            </div>
          </div>
        ) : openFolder ? (
          <div className="header-nav">
            <button className="back-btn" onClick={closeFolderView}>← THE GRID</button>
            <div className="page-title">{openFolder.name}</div>
            {onClose && <div className="header-actions"><button className="header-action-btn header-action-btn--close" title="Close split" onClick={onClose}>✕</button></div>}
          </div>
        ) : (
          <div className="header-nav header-nav--home">
            <div className="title">THE GRID</div>
            {onClose && <div className="header-actions"><button className="header-action-btn header-action-btn--close" title="Close split" onClick={onClose}>✕</button></div>}
          </div>
        )}
      </div>
      <div className="divider" />
      {ActiveComponent ? (
        <ActiveComponent />
      ) : openFolder ? (
        <div className="content">
          <div className="app-list">
            {openFolder.children.length === 0 && (
              <div className="empty-state">EMPTY — DRAG MODULES HERE FROM THE GRID</div>
            )}
            {openFolder.children.map((modId, idx) => {
              const mod = modules.find(m => m.id === modId)
              if (!mod) return null
              const lbl = getLabel(modId, mod.name, mod.description)
              return (
                <div
                  key={modId}
                  className={`app-row${folderDragIdx === idx ? ' grid-item--dragging' : ''}${folderHoverIdx === idx && folderDragIdx !== idx ? ' grid-item--hover' : ''}`}
                  draggable
                  onDragStart={e => onFolderDragStart(e, idx)}
                  onDragOver={e => onFolderDragOver(e, idx)}
                  onDragEnd={resetFolderDrag}
                  onClick={() => openModule(mod)}
                >
                  <div className="grid-drag-handle">⠿</div>
                  <div className="app-info">
                    <div className="app-name">{lbl.name}</div>
                    <div className="app-desc">{lbl.desc}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="content">
          <div className="app-list">
            {layout.map((item, idx) => {
              const isDragging = dragIdx === idx
              const isHover = hoverIdx === idx && dragIdx !== idx
              const isDropTarget = isHover && item.type === 'folder' && dragItemType === 'module'

              if (item.type === 'folder') {
                const folderLbl = getLabel(item.id, item.name, '')
                return (
                  <div
                    key={item.id}
                    className={`folder-tile${isDragging ? ' grid-item--dragging' : ''}${isDropTarget ? ' folder-tile--drop' : isHover ? ' grid-item--hover' : ''}`}
                    draggable
                    onDragStart={e => onDragStart(e, idx)}
                    onDragOver={e => onDragOver(e, idx)}
                    onDrop={e => onDrop(e, idx)}
                    onDragEnd={resetDrag}
                    onClick={() => { if (!didDrag.current) openFolderView(item) }}
                  >
                    <div className="grid-drag-handle">⠿</div>
                    <div className="folder-icon">▤</div>
                    <div className="app-info">
                      <div className="app-name">{folderLbl.name}</div>
                      <div className="app-desc">{item.children.length} item{item.children.length !== 1 ? 's' : ''}</div>
                    </div>
                    <div className="app-arrow">›</div>
                  </div>
                )
              }

              const mod = modules.find(m => m.id === item.id)
              if (!mod) return null
              if (archived.includes(item.id)) return null
              const lbl = getLabel(item.id, mod.name, mod.description)

              return (
                <div
                  key={item.id}
                  className={`app-row${isDragging ? ' grid-item--dragging' : ''}${isHover ? ' grid-item--hover' : ''}`}
                  draggable
                  onDragStart={e => onDragStart(e, idx)}
                  onDragOver={e => onDragOver(e, idx)}
                  onDrop={e => onDrop(e, idx)}
                  onDragEnd={e => onDragEnd(e, idx)}
                  onClick={() => { if (!didDrag.current) openModule(mod) }}
                >
                  <div className="grid-drag-handle">⠿</div>
                  <div className="app-info">
                    <div className="app-name">{lbl.name}</div>
                    <div className="app-desc">{lbl.desc}</div>
                  </div>
                  <button className="grid-archive-btn" title="Archive" onClick={e => { e.stopPropagation(); archiveModule(item.id) }}>⌂</button>
                  <div className="app-arrow">›</div>
                </div>
              )
            })}
          </div>
          <div className="grid-controls">
            <div className="grid-controls-row">
              {archived.length > 0 && (
                <button className="grid-add-btn grid-archive-toggle" onClick={() => setShowArchive(!showArchive)}>
                  ARCHIVE <span className="tab-count">{archived.length}</span> {showArchive ? '▲' : '▼'}
                </button>
              )}
            </div>
          </div>
          {showArchive && archived.length > 0 && (
            <div className="archive-section">
              <div className="archive-header">ARCHIVED</div>
              <div className="app-list">
                {archived.map(modId => {
                  const mod = modules.find(m => m.id === modId)
                  if (!mod) return null
                  const lbl = getLabel(modId, mod.name, mod.description)
                  return (
                    <div key={modId} className="app-row app-row--archived">
                      <div className="app-info">
                        <div className="app-name">{lbl.name}</div>
                        <div className="app-desc">{lbl.desc}</div>
                      </div>
                      <button className="grid-restore-btn" onClick={() => unarchiveModule(modId)}>RESTORE</button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

// ── Split layout renderer ───────────────────────────────────
function SplitLayout({ state, onChange, layout, archived, showArchive, getLabel, archiveModule, unarchiveModule, setShowArchive }: {
  state: LayoutState
  onChange: (s: LayoutState) => void
  layout: GridItem[]
  archived: string[]
  showArchive: boolean
  getLabel: (id: string, defaultName: string, defaultDesc: string) => { name: string; desc: string }
  archiveModule: (id: string) => void
  unarchiveModule: (id: string) => void
  setShowArchive: (v: boolean) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  const handleResize = useCallback((delta: number) => {
    if (!isSplit(state) || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const total = state.dir === 'h' ? rect.width : rect.height
    const frac = delta / total
    const s0 = Math.max(0.15, Math.min(0.85, state.sizes[0] + frac))
    onChange({ ...state, sizes: [s0, 1 - s0] })
  }, [state, onChange])

  if (!isSplit(state)) {
    return (
      <AppPane
        initialModuleId={state.openModuleId}
        layout={layout}
        
        archived={archived}
        showArchive={showArchive}
        onSplit={(dir, moduleId) => {
          onChange({
            dir,
            sizes: [0.5, 0.5],
            children: [
              { type: 'single', openModuleId: null },
              { type: 'single', openModuleId: moduleId },
            ]
          })
        }}
        onClose={null}
        isInSplit={false}
        getLabel={getLabel}
        archiveModule={archiveModule}
        unarchiveModule={unarchiveModule}
        setShowArchive={setShowArchive}
      />
    )
  }

  return (
    <div ref={containerRef} className={`split-container split-container--${state.dir}`}>
      <div className="split-pane" style={{ flex: `0 0 ${state.sizes[0] * 100}%` }}>
        {isSplit(state.children[0]) ? (
          <SplitLayout
            state={state.children[0]}
            onChange={s => onChange({ ...state, children: [s as PaneState | SplitState, state.children[1]] })}
            layout={layout} archived={archived} showArchive={showArchive}
            getLabel={getLabel} archiveModule={archiveModule} unarchiveModule={unarchiveModule} setShowArchive={setShowArchive}
          />
        ) : (
          <AppPane
            initialModuleId={state.children[0].openModuleId}
            layout={layout} archived={archived} showArchive={showArchive}
            onSplit={(dir, moduleId) => {
              const newChild: SplitState = {
                dir, sizes: [0.5, 0.5],
                children: [state.children[0], { type: 'single', openModuleId: moduleId }]
              }
              onChange({ ...state, children: [newChild as any, state.children[1]] })
            }}
            onClose={() => onChange(state.children[1])}
            isInSplit={true}
            getLabel={getLabel} archiveModule={archiveModule} unarchiveModule={unarchiveModule} setShowArchive={setShowArchive}
          />
        )}
      </div>
      <ResizeHandle dir={state.dir} onResize={handleResize} />
      <div className="split-pane" style={{ flex: `0 0 ${state.sizes[1] * 100}%` }}>
        {isSplit(state.children[1]) ? (
          <SplitLayout
            state={state.children[1]}
            onChange={s => onChange({ ...state, children: [state.children[0], s as PaneState | SplitState] })}
            layout={layout} archived={archived} showArchive={showArchive}
            getLabel={getLabel} archiveModule={archiveModule} unarchiveModule={unarchiveModule} setShowArchive={setShowArchive}
          />
        ) : (
          <AppPane
            initialModuleId={state.children[1].openModuleId}
            layout={layout} archived={archived} showArchive={showArchive}
            onSplit={(dir, moduleId) => {
              const newChild: SplitState = {
                dir, sizes: [0.5, 0.5],
                children: [state.children[1], { type: 'single', openModuleId: moduleId }]
              }
              onChange({ ...state, children: [state.children[0], newChild as any] })
            }}
            onClose={() => onChange(state.children[0])}
            isInSplit={true}
            getLabel={getLabel} archiveModule={archiveModule} unarchiveModule={unarchiveModule} setShowArchive={setShowArchive}
          />
        )}
      </div>
    </div>
  )
}

// ── Root App ────────────────────────────────────────────────
function App({ onReady }: { onReady?: () => void }) {
  const hashModule = window.location.hash.match(/^#\/module\/(.+)$/)
  if (hashModule) {
    useEffect(() => { onReady?.() }, [])
    return <DetachedModuleView moduleId={hashModule[1]} />
  }

  const [layoutState, setLayoutState] = useState<LayoutState>({ type: 'single', openModuleId: null })
  const [layout, setLayout] = useState<GridItem[]>(defaultLayout)
  const [labels, setLabels] = useState<Record<string, { name: string; desc: string }>>({})
  const [archived, setArchived] = useState<string[]>([])
  const [showArchive, setShowArchive] = useState(false)

  useEffect(() => {
    Promise.all([
      window.ipcRenderer.invoke('load-module-labels').then((saved: any) => { if (saved) setLabels(saved) }),
      window.ipcRenderer.invoke('load-layout').then((saved: GridItem[] | null) => {
        if (saved && Array.isArray(saved)) {
          const validIds = new Set(modules.map(m => m.id))
          // Filter out modules/folder children that no longer exist
          const cleaned = saved
            .map(item => {
              if (item.type === 'folder') return { ...item, children: item.children.filter(id => validIds.has(id)) }
              return item
            })
            .filter(item => item.type === 'folder' ? item.children.length > 0 : validIds.has(item.id))
          const allIds = new Set<string>()
          cleaned.forEach(item => { allIds.add(item.id); if (item.type === 'folder') item.children.forEach(id => allIds.add(id)) })
          const newMods = modules.filter(m => !allIds.has(m.id)).map(m => ({ type: 'module' as const, id: m.id }))
          setLayout([...cleaned, ...newMods])
        }
      }),
      window.ipcRenderer.invoke('load-archived').then((saved: string[] | null) => { if (saved) setArchived(saved) }),
    ]).then(() => onReady?.())
  }, [])

  function getLabel(id: string, defaultName: string, defaultDesc: string) {
    return { name: labels[id]?.name ?? defaultName, desc: labels[id]?.desc ?? defaultDesc }
  }

  function archiveModule(moduleId: string) {
    const next = [...archived, moduleId]; setArchived(next)
    window.ipcRenderer.invoke('save-archived', next)
  }
  function unarchiveModule(moduleId: string) {
    const next = archived.filter(id => id !== moduleId); setArchived(next)
    window.ipcRenderer.invoke('save-archived', next)
  }

  return (
    <div className="council">
      <SplitLayout
        state={layoutState}
        onChange={setLayoutState}
        layout={layout}
        
        archived={archived}
        showArchive={showArchive}
        getLabel={getLabel}
        archiveModule={archiveModule}
        unarchiveModule={unarchiveModule}
        setShowArchive={setShowArchive}
      />
    </div>
  )
}

export default App
