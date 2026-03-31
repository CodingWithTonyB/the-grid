import { useState, useEffect, useRef } from 'react'
import './App.css'
import modules, { Module } from './modules'

type ModuleItem = { type: 'module'; id: string }
type FolderItem = { type: 'folder'; id: string; name: string; children: string[] }
type GridItem = ModuleItem | FolderItem

function defaultLayout(): GridItem[] {
  return modules.map(m => ({ type: 'module' as const, id: m.id }))
}

const log = (window as any).__splashLog || (() => {})

function App({ onReady }: { onReady?: () => void }) {
  const [active, setActive] = useState<Module | null>(null)
  const [layout, setLayout] = useState<GridItem[]>(defaultLayout)
  const [openFolder, setOpenFolder] = useState<FolderItem | null>(null)

  // View transition state
  const [viewPhase, setViewPhase] = useState<'idle' | 'exit' | 'enter'>('idle')
  const pendingAction = useRef<() => void>(() => {})

  function transitionTo(action: () => void) {
    setViewPhase('exit')
    pendingAction.current = action
    setTimeout(() => {
      action()
      setViewPhase('enter')
      setTimeout(() => setViewPhase('idle'), 300)
    }, 200)
  }

  function openModule(mod: Module) {
    transitionTo(() => setActive(mod))
  }

  function closeToGrid() {
    transitionTo(() => { setActive(null); setOpenFolder(null) })
  }

  function openFolderView(folder: FolderItem) {
    transitionTo(() => setOpenFolder(folder))
  }

  function closeFolderView() {
    transitionTo(() => setOpenFolder(null))
  }

  // Main grid drag state
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  // Folder interior drag state
  const [folderDragIdx, setFolderDragIdx] = useState<number | null>(null)
  const [folderHoverIdx, setFolderHoverIdx] = useState<number | null>(null)

  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const didDrag = useRef(false)

  // Rename
  type Labels = Record<string, { name: string; desc: string }>
  const [labels, setLabels] = useState<Labels>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')

  useEffect(() => {
    log('app :: loading module labels')
    window.ipcRenderer.invoke('load-module-labels').then((saved: Labels) => {
      if (saved) {
        setLabels(saved)
        log(`app :: loaded ${Object.keys(saved).length} custom labels`)
      }
    })
  }, [])

  function getLabel(id: string, defaultName: string, defaultDesc: string) {
    return {
      name: labels[id]?.name ?? defaultName,
      desc: labels[id]?.desc ?? defaultDesc,
    }
  }

  function startEdit(e: React.MouseEvent, id: string, name: string, desc: string) {
    e.stopPropagation()
    setEditingId(id)
    setEditName(name)
    setEditDesc(desc)
  }

  function saveEdit() {
    if (!editingId) return
    const next = { ...labels, [editingId]: { name: editName.trim() || editName, desc: editDesc } }
    setLabels(next)
    window.ipcRenderer.invoke('save-module-labels', next)
    setEditingId(null)
  }

  function cancelEdit() { setEditingId(null) }

  useEffect(() => {
    log('app :: loading grid layout')
    log(`app :: ${modules.length} modules registered`)
    window.ipcRenderer.invoke('load-layout').then((saved: GridItem[] | null) => {
      if (!saved || !Array.isArray(saved)) {
        log('app :: using default layout')
      } else {
        const allIds = new Set<string>()
        saved.forEach(item => {
          allIds.add(item.id)
          if (item.type === 'folder') item.children.forEach(id => allIds.add(id))
        })
        const newMods = modules
          .filter(m => !allIds.has(m.id))
          .map(m => ({ type: 'module' as const, id: m.id }))
        setLayout([...saved, ...newMods])
        const folders = saved.filter(i => i.type === 'folder').length
        log(`app :: layout restored — ${saved.length} items, ${folders} folders`)
      }
      onReady?.()
    })
  }, [])

  function saveLayout(next: GridItem[]) {
    setLayout(next)
    window.ipcRenderer.invoke('save-layout', next)
    if (openFolder) {
      const updated = next.find(i => i.id === openFolder.id) as FolderItem | undefined
      if (updated) setOpenFolder(updated)
    }
  }

  // ── Main grid drag ──────────────────────────────────────────
  function onDragStart(e: React.DragEvent, idx: number) {
    didDrag.current = false
    setDragIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    setHoverIdx(idx)
  }

  function onDrop(e: React.DragEvent, dropIdx: number) {
    e.preventDefault()
    if (dragIdx === null) { resetDrag(); return }

    const dragItem = layout[dragIdx]
    const dropItem = layout[dropIdx]

    // Drop a module onto a folder → move it inside
    if (dragItem.type === 'module' && dropItem.type === 'folder' && dragIdx !== dropIdx) {
      const next = layout.filter((_, i) => i !== dragIdx) as GridItem[]
      const folder = next.find(i => i.id === dropItem.id) as FolderItem
      if (!folder.children.includes(dragItem.id)) {
        folder.children = [...folder.children, dragItem.id]
      }
      didDrag.current = true
      saveLayout(next)
      resetDrag()
      return
    }

    if (dragIdx === dropIdx) { resetDrag(); return }

    // Reorder
    const next = [...layout]
    const [item] = next.splice(dragIdx, 1)
    const at = Math.max(0, Math.min(dropIdx > dragIdx ? dropIdx - 1 : dropIdx, next.length))
    next.splice(at, 0, item)
    didDrag.current = true
    saveLayout(next)
    resetDrag()
  }

  function resetDrag() {
    setDragIdx(null)
    setHoverIdx(null)
    requestAnimationFrame(() => { didDrag.current = false })
  }

  // ── Folder interior drag ────────────────────────────────────
  function onFolderDragStart(e: React.DragEvent, idx: number) {
    setFolderDragIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
  }

  function onFolderDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    setFolderHoverIdx(idx)
  }

  function onFolderDrop(e: React.DragEvent, dropIdx: number) {
    e.preventDefault()
    if (!openFolder || folderDragIdx === null || folderDragIdx === dropIdx) {
      resetFolderDrag(); return
    }
    const children = [...openFolder.children]
    const [item] = children.splice(folderDragIdx, 1)
    const at = Math.max(0, Math.min(dropIdx > folderDragIdx ? dropIdx - 1 : dropIdx, children.length))
    children.splice(at, 0, item)
    const next = layout.map(i => i.id === openFolder.id ? { ...i, children } : i) as GridItem[]
    saveLayout(next)
    resetFolderDrag()
  }

  function resetFolderDrag() { setFolderDragIdx(null); setFolderHoverIdx(null) }

  // ── Folder actions ──────────────────────────────────────────
  function ejectFromFolder(moduleId: string) {
    if (!openFolder) return
    const children = openFolder.children.filter(id => id !== moduleId)
    const next = layout.map(i =>
      i.id === openFolder.id ? { ...i, children } : i
    ) as GridItem[]
    next.push({ type: 'module', id: moduleId })
    saveLayout(next)
  }

  function deleteFolder(folderId: string) {
    const folder = layout.find(i => i.id === folderId) as FolderItem
    const next = layout.filter(i => i.id !== folderId) as GridItem[]
    folder.children.forEach(id => next.push({ type: 'module', id }))
    saveLayout(next)
    transitionTo(() => setOpenFolder(null))
  }

  function createFolder() {
    const name = folderName.trim().toUpperCase() || 'FOLDER'
    const item: FolderItem = { type: 'folder', id: `folder-${Date.now()}`, name, children: [] }
    saveLayout([...layout, item])
    setFolderName('')
    setCreatingFolder(false)
  }

  // ── Render ──────────────────────────────────────────────────
  const ActiveComponent = active?.component ?? null

  const dragItemType = dragIdx !== null ? layout[dragIdx]?.type : null

  return (
    <div className="council">
      <div className="tron-corner tron-corner--tl" />
      <div className="tron-corner tron-corner--tr" />
      <div className="tron-corner tron-corner--bl" />
      <div className="tron-corner tron-corner--br" />
      <div className="version-tag">v5.0</div>
      <div className={`view-transition${viewPhase === 'exit' ? ' view-exit' : viewPhase === 'enter' ? ' view-enter' : ''}`}>
      <div className="header">
        {active ? (
          <div className="header-nav">
            <button className="back-btn" onClick={closeToGrid}>← THE GRID</button>
            <div className="page-title">{getLabel(active.id, active.name, active.description).name.toUpperCase()}</div>
          </div>
        ) : openFolder ? (
          <div className="header-nav">
            <button className="back-btn" onClick={closeFolderView}>← THE GRID</button>
            <div className="page-title">{openFolder.name}</div>
          </div>
        ) : (
          <div className="title">THE GRID</div>
        )}
      </div>
      <div className="divider" />
      {ActiveComponent ? (
        <ActiveComponent />
      ) : openFolder ? (
        // ── Inside a folder ──
        <div className="content">
          <div className="app-list">
            {openFolder.children.length === 0 && (
              <div className="empty-state">EMPTY — DRAG MODULES HERE FROM THE GRID</div>
            )}
            {openFolder.children.map((modId, idx) => {
              const mod = modules.find(m => m.id === modId)
              if (!mod) return null
              const isDragging = folderDragIdx === idx
              const isHover = folderHoverIdx === idx && folderDragIdx !== idx
              const lbl = getLabel(modId, mod.name, mod.description)

              if (editingId === modId) {
                return (
                  <div key={modId} className="app-row app-row--editing">
                    <div className="grid-drag-handle" style={{ opacity: 0.3 }}>⠿</div>
                    <div className="app-edit-fields">
                      <input className="app-edit-name" value={editName} autoFocus
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit() }} />
                      <input className="app-edit-desc" value={editDesc} placeholder="caption..."
                        onChange={e => setEditDesc(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit() }} />
                    </div>
                    <div className="app-edit-actions">
                      <button className="save-btn" onClick={saveEdit}>SAVE</button>
                      <button className="save-btn" style={{ borderColor: '#1a1a1a', color: '#444' }} onClick={cancelEdit}>✕</button>
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={modId}
                  className={`app-row${isDragging ? ' grid-item--dragging' : ''}${isHover ? ' grid-item--hover' : ''}`}
                  draggable
                  onDragStart={e => onFolderDragStart(e, idx)}
                  onDragOver={e => onFolderDragOver(e, idx)}
                  onDrop={e => onFolderDrop(e, idx)}
                  onDragEnd={resetFolderDrag}
                  onClick={() => openModule(mod)}
                >
                  <div className="grid-drag-handle">⠿</div>
                  <div className="app-info">
                    <div className="app-name">{lbl.name}</div>
                    <div className="app-desc">{lbl.desc}</div>
                  </div>
                  <button className="grid-edit-btn" onClick={e => startEdit(e, modId, lbl.name, lbl.desc)}>✎</button>
                  <button
                    className="folder-eject-btn"
                    onClick={e => { e.stopPropagation(); ejectFromFolder(modId) }}
                  >↑</button>
                </div>
              )
            })}
          </div>
          <div className="grid-controls">
            <button
              className="grid-add-btn"
              style={{ color: '#663333' }}
              onClick={() => deleteFolder(openFolder.id)}
            >
              DELETE FOLDER
            </button>
          </div>
        </div>
      ) : (
        // ── Main grid ──
        <div className="content">
          <div className="app-list">
            {layout.map((item, idx) => {
              const isDragging = dragIdx === idx
              const isHover = hoverIdx === idx && dragIdx !== idx
              const isDropTarget = isHover && item.type === 'folder' && dragItemType === 'module'

              if (item.type === 'folder') {
                const folderLbl = getLabel(item.id, item.name, '')

                if (editingId === item.id) {
                  return (
                    <div key={item.id} className="folder-tile app-row--editing">
                      <div className="grid-drag-handle" style={{ opacity: 0.3 }}>⠿</div>
                      <div className="folder-icon">▤</div>
                      <div className="app-edit-fields">
                        <input className="app-edit-name" value={editName} autoFocus
                          onChange={e => setEditName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit() }} />
                      </div>
                      <div className="app-edit-actions">
                        <button className="save-btn" onClick={saveEdit}>SAVE</button>
                        <button className="save-btn" style={{ borderColor: '#1a1a1a', color: '#444' }} onClick={cancelEdit}>✕</button>
                      </div>
                    </div>
                  )
                }

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
                    <button className="grid-edit-btn" onClick={e => startEdit(e, item.id, folderLbl.name, '')}>✎</button>
                    <div className="app-arrow">›</div>
                  </div>
                )
              }

              const mod = modules.find(m => m.id === item.id)
              if (!mod) return null
              const lbl = getLabel(item.id, mod.name, mod.description)

              if (editingId === item.id) {
                return (
                  <div key={item.id} className="app-row app-row--editing">
                    <div className="grid-drag-handle" style={{ opacity: 0.3 }}>⠿</div>
                    <div className="app-edit-fields">
                      <input className="app-edit-name" value={editName} autoFocus
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit() }} />
                      <input className="app-edit-desc" value={editDesc} placeholder="caption..."
                        onChange={e => setEditDesc(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit() }} />
                    </div>
                    <div className="app-edit-actions">
                      <button className="save-btn" onClick={saveEdit}>SAVE</button>
                      <button className="save-btn" style={{ borderColor: '#1a1a1a', color: '#444' }} onClick={cancelEdit}>✕</button>
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={item.id}
                  className={`app-row${isDragging ? ' grid-item--dragging' : ''}${isHover ? ' grid-item--hover' : ''}`}
                  draggable
                  onDragStart={e => onDragStart(e, idx)}
                  onDragOver={e => onDragOver(e, idx)}
                  onDrop={e => onDrop(e, idx)}
                  onDragEnd={resetDrag}
                  onClick={() => { if (!didDrag.current) openModule(mod) }}
                >
                  <div className="grid-drag-handle">⠿</div>
                  <div className="app-info">
                    <div className="app-name">{lbl.name}</div>
                    <div className="app-desc">{lbl.desc}</div>
                  </div>
                  <button className="grid-edit-btn" onClick={e => startEdit(e, item.id, lbl.name, lbl.desc)}>✎</button>
                  <div className="app-arrow">›</div>
                </div>
              )
            })}
          </div>
          <div className="grid-controls">
            {creatingFolder ? (
              <div className="grid-add-section">
                <input
                  className="note-input grid-section-input"
                  autoFocus
                  placeholder="FOLDER NAME"
                  value={folderName}
                  onChange={e => setFolderName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') createFolder()
                    if (e.key === 'Escape') setCreatingFolder(false)
                  }}
                />
                <button className="save-btn" onClick={createFolder}>CREATE</button>
                <button
                  className="save-btn"
                  style={{ borderColor: '#1a1a1a', color: '#444' }}
                  onClick={() => setCreatingFolder(false)}
                >CANCEL</button>
              </div>
            ) : (
              <button className="grid-add-btn" onClick={() => setCreatingFolder(true)}>+ FOLDER</button>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

export default App
