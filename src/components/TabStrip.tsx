import { useEffect, useRef, useState } from 'react'
import { BookOpen, FilePlus2, FileText, Loader2, Plus, X } from 'lucide-react'

export interface TabItem {
  path: string
  name: string
  kind?: 'pdf' | 'text' | 'epub'
  loading?: boolean
  failed?: boolean
}

export default function TabStrip({
  tabs,
  activePath,
  onActivate,
  onClose,
  onOpenPicker,
  onNewNote,
}: {
  tabs: TabItem[]
  activePath: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onOpenPicker: () => void
  /** Optional: adds "新建空白笔记" to the + menu (⌘N). */
  onNewNote?: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  // `position: fixed` on purpose: the menu lives inside the horizontally
  // scrolling tab strip, which would clip an absolutely positioned popover.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const openMenu = () => {
    const rect = wrapRef.current?.getBoundingClientRect()
    setMenuPos(rect ? { left: Math.round(rect.left), top: Math.round(rect.bottom + 4) } : null)
    setMenuOpen(true)
  }

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  return (
    <div className="tab-strip">
      <div className="tab-scroll">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`doc-tab${tab.path === activePath ? ' active' : ''}${tab.loading ? ' loading' : ''}${tab.failed ? ' failed' : ''}`}
            role="tab"
            aria-selected={tab.path === activePath}
            title={tab.path}
            onClick={() => onActivate(tab.path)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                onClose(tab.path)
              }
            }}
          >
            <span className="doc-tab-icon">
              {tab.loading
                ? <Loader2 size={13} className="spin" />
                : tab.kind === 'epub' ? <BookOpen size={13} /> : <FileText size={13} />}
            </span>
            <span className="doc-tab-name">{tab.name}</span>
            <button
              type="button"
              className="doc-tab-close"
              title="关闭标签页（⌘W）"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.path)
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="tab-add-wrap" ref={wrapRef}>
          <button
            type="button"
            className={`tab-add${menuOpen ? ' active' : ''}`}
            title="新建标签页"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          >
            <Plus size={14} />
          </button>
          {menuOpen && (
            <div className="tab-add-menu" role="menu" style={menuPos ? { left: menuPos.left, top: menuPos.top } : undefined}>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenPicker() }}>
                <FilePlus2 size={13} /> 打开文档…<span>⌘O</span>
              </button>
              {onNewNote && (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onNewNote() }}>
                  <FileText size={13} /> 新建空白笔记<span>⌘N</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
