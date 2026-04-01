import { useState, useRef, useCallback, useEffect } from 'react'
import modules from './modules'

// ── Panel tree types ──────────────────────────────────────────
export type LeafPanel = {
  type: 'leaf'
  id: string
  tabs: string[]   // module IDs
  active: number   // index into tabs
}

export type SplitPanel = {
  type: 'split'
  id: string
  direction: 'h' | 'v'
  children: PanelNode[]
  sizes: number[]  // fractional sizes (sum to 1)
}

export type PanelNode = LeafPanel | SplitPanel

let _panelId = 0
export function newId() { return `p${Date.now()}-${_panelId++}` }

export function makeLeaf(moduleId: string): LeafPanel {
  return { type: 'leaf', id: newId(), tabs: [moduleId], active: 0 }
}

// ── Tree operations ───────────────────────────────────────────
function removeNode(root: PanelNode, id: string): PanelNode | null {
  if (root.id === id) return null
  if (root.type === 'split') {
    const idx = root.children.findIndex(c => c.id === id)
    if (idx !== -1) {
      const newChildren = root.children.filter((_, i) => i !== idx)
      const newSizes = root.sizes.filter((_, i) => i !== idx)
      if (newChildren.length === 1) return newChildren[0]
      const total = newSizes.reduce((a, b) => a + b, 0)
      return { ...root, children: newChildren, sizes: newSizes.map(s => s / total) }
    }
    return { ...root, children: root.children.map(c => removeNode(c, id) ?? c) }
  }
  return root
}

// ── Resize handle ─────────────────────────────────────────────
function ResizeHandle({ direction, onResize }: { direction: 'h' | 'v'; onResize: (delta: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const startPos = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    startPos.current = direction === 'h' ? e.clientX : e.clientY
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'h' ? ev.clientX : ev.clientY
      const delta = pos - startPos.current
      startPos.current = pos
      onResize(delta)
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = direction === 'h' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, onResize])

  return (
    <div
      ref={ref}
      className={`panel-resize-handle panel-resize-handle--${direction}`}
      onMouseDown={onMouseDown}
    />
  )
}

// ── Tab bar context menu ──────────────────────────────────────
function TabContextMenu({ x, y, onAction, onClose }: {
  x: number; y: number
  onAction: (action: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} className="panel-context-menu" style={{ left: x, top: y }}>
      <div className="panel-context-item" onClick={() => onAction('split-right')}>Split Right</div>
      <div className="panel-context-item" onClick={() => onAction('split-down')}>Split Down</div>
      <div className="panel-context-item" onClick={() => onAction('split-left')}>Split Left</div>
      <div className="panel-context-item" onClick={() => onAction('split-up')}>Split Up</div>
      <div className="panel-context-sep" />
      <div className="panel-context-item" onClick={() => onAction('new-window')}>Open in New Window</div>
      <div className="panel-context-sep" />
      <div className="panel-context-item panel-context-item--danger" onClick={() => onAction('close')}>Close Tab</div>
    </div>
  )
}

// ── Module picker for empty panels / add tab ──────────────────
function ModulePicker({ onPick, onCancel, existing }: {
  onPick: (id: string) => void
  onCancel: () => void
  existing: string[]
}) {
  return (
    <div className="panel-module-picker">
      <div className="panel-picker-title">ADD MODULE</div>
      {modules.map(m => (
        <div
          key={m.id}
          className={`panel-picker-item${existing.includes(m.id) ? ' panel-picker-item--active' : ''}`}
          onClick={() => onPick(m.id)}
        >
          {m.name}
        </div>
      ))}
      <div className="panel-picker-item panel-picker-item--cancel" onClick={onCancel}>CANCEL</div>
    </div>
  )
}

// ── Leaf panel renderer ───────────────────────────────────────
function LeafPanelView({ panel, onUpdate, onRemove, onSplit, onDetach }: {
  panel: LeafPanel
  onUpdate: (p: LeafPanel) => void
  onRemove: () => void
  onSplit: (dir: 'h' | 'v', pos: 'before' | 'after', moduleId: string) => void
  onDetach: (moduleId: string) => void
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabIdx: number } | null>(null)
  const [picking, setPicking] = useState(false)

  const activeModId = panel.tabs[panel.active]
  const mod = modules.find(m => m.id === activeModId)
  const ActiveComponent = mod?.component

  function closeTab(idx: number) {
    if (panel.tabs.length === 1) { onRemove(); return }
    const newTabs = panel.tabs.filter((_, i) => i !== idx)
    const newActive = Math.min(panel.active, newTabs.length - 1)
    onUpdate({ ...panel, tabs: newTabs, active: newActive })
  }

  function handleCtxAction(action: string) {
    const tabModId = panel.tabs[ctxMenu!.tabIdx]
    setCtxMenu(null)
    switch (action) {
      case 'split-right': onSplit('h', 'after', tabModId); break
      case 'split-left': onSplit('h', 'before', tabModId); break
      case 'split-down': onSplit('v', 'after', tabModId); break
      case 'split-up': onSplit('v', 'before', tabModId); break
      case 'new-window': onDetach(tabModId); break
      case 'close': closeTab(ctxMenu!.tabIdx); break
    }
  }

  // Drop handler for tab reordering between panels
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const data = e.dataTransfer.getData('text/panel-tab')
    if (!data) return
    const { moduleId, sourcePanelId } = JSON.parse(data)
    if (sourcePanelId === panel.id && panel.tabs.includes(moduleId)) return
    // Add to this panel's tabs
    if (!panel.tabs.includes(moduleId)) {
      const newTabs = [...panel.tabs, moduleId]
      onUpdate({ ...panel, tabs: newTabs, active: newTabs.length - 1 })
    }
  }

  function onDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('text/panel-tab')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    }
  }

  return (
    <div className="panel-leaf" onDrop={onDrop} onDragOver={onDragOver}>
      <div className="panel-tab-bar">
        {panel.tabs.map((tabId, idx) => {
          const tabMod = modules.find(m => m.id === tabId)
          return (
            <div
              key={tabId}
              className={`panel-tab${idx === panel.active ? ' panel-tab--active' : ''}`}
              draggable
              onClick={() => onUpdate({ ...panel, active: idx })}
              onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, tabIdx: idx }) }}
              onDragStart={e => {
                e.dataTransfer.setData('text/panel-tab', JSON.stringify({ moduleId: tabId, sourcePanelId: panel.id }))
                e.dataTransfer.effectAllowed = 'move'
              }}
            >
              <span className="panel-tab-name">{tabMod?.name ?? tabId}</span>
              <span className="panel-tab-close" onClick={e => { e.stopPropagation(); closeTab(idx) }}>×</span>
            </div>
          )
        })}
        <div className="panel-tab panel-tab--add" onClick={() => setPicking(true)}>+</div>
      </div>

      <div className="panel-content">
        {picking && (
          <div className="panel-picker-overlay">
            <ModulePicker
              existing={panel.tabs}
              onPick={id => {
                setPicking(false)
                if (!panel.tabs.includes(id)) {
                  const newTabs = [...panel.tabs, id]
                  onUpdate({ ...panel, tabs: newTabs, active: newTabs.length - 1 })
                } else {
                  onUpdate({ ...panel, active: panel.tabs.indexOf(id) })
                }
              }}
              onCancel={() => setPicking(false)}
            />
          </div>
        )}
        {ActiveComponent && <ActiveComponent />}
      </div>

      {ctxMenu && (
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onAction={handleCtxAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

// ── Recursive panel renderer ──────────────────────────────────
function PanelView({ node, onUpdate, onRemove, onDetach }: {
  node: PanelNode
  onUpdate: (n: PanelNode) => void
  onRemove: () => void
  onDetach: (moduleId: string) => void
}) {
  const handleResize = useCallback((index: number, delta: number) => {
    if (node.type !== 'split') return
    const container = document.querySelector(`[data-panel-id="${node.id}"]`)
    if (!container) return
    const rect = container.getBoundingClientRect()
    const totalSize = node.direction === 'h' ? rect.width : rect.height
    const fraction = delta / totalSize
    const newSizes = [...node.sizes]
    newSizes[index] = Math.max(0.05, newSizes[index] + fraction)
    newSizes[index + 1] = Math.max(0.05, newSizes[index + 1] - fraction)
    onUpdate({ ...node, sizes: newSizes })
  }, [node, onUpdate])

  if (node.type === 'leaf') {
    return (
      <LeafPanelView
        panel={node}
        onUpdate={p => onUpdate(p)}
        onRemove={onRemove}
        onSplit={(dir, pos, moduleId) => {
          // Remove the module from this panel's tabs if it has multiple
          let thisPanel: LeafPanel = node
          if (node.tabs.length > 1) {
            const newTabs = node.tabs.filter(t => t !== moduleId)
            thisPanel = { ...node, tabs: newTabs, active: Math.min(node.active, newTabs.length - 1) }
          }
          const newLeaf = makeLeaf(moduleId)
          const children = pos === 'after' ? [thisPanel, newLeaf] : [newLeaf, thisPanel]
          const split: SplitPanel = {
            type: 'split', id: newId(), direction: dir,
            children, sizes: [0.5, 0.5]
          }
          onUpdate(node.tabs.length > 1 ? split : split)
        }}
        onDetach={onDetach}
      />
    )
  }

  return (
    <div
      className={`panel-split panel-split--${node.direction}`}
      data-panel-id={node.id}
    >
      {node.children.map((child, i) => (
        <div key={child.id} className="panel-split-child" style={{
          flex: `0 0 ${node.sizes[i] * 100}%`,
        }}>
          <PanelView
            node={child}
            onUpdate={updated => {
              const newChildren = [...node.children]
              newChildren[i] = updated
              onUpdate({ ...node, children: newChildren })
            }}
            onRemove={() => {
              const result = removeNode(node, child.id)
              if (result && result.id !== node.id) onUpdate(result)
              else if (result) onUpdate(result)
              else onRemove()
            }}
            onDetach={onDetach}
          />
          {i < node.children.length - 1 && (
            <ResizeHandle direction={node.direction} onResize={d => handleResize(i, d)} />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main PanelLayout component ────────────────────────────────
export default function PanelLayout({ root, onChange, onBack, onDetach }: {
  root: PanelNode
  onChange: (root: PanelNode) => void
  onBack: () => void
  onDetach: (moduleId: string) => void
}) {
  return (
    <div className="panel-layout">
      <div className="panel-toolbar">
        <button className="back-btn" onClick={onBack}>← THE GRID</button>
      </div>
      <div className="panel-root">
        <PanelView
          node={root}
          onUpdate={onChange}
          onRemove={onBack}
          onDetach={onDetach}
        />
      </div>
    </div>
  )
}
