import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarDays, Check, ExternalLink, Eye, FileText, FolderPlus, Hash, History, Lightbulb,
  Link2, Pencil, Plus, RefreshCw, ScanText, Sparkles, Trash2, WandSparkles, X,
} from 'lucide-react'
import MarkdownPreview from './MarkdownPreview'
import SpaceRail from './SpaceRail'
import Splitter from './Splitter'
import VaultTree from './VaultTree'
import type { VaultApi } from './useVault'
import type { AppSpace, NoteViewMode, NotebookNote, SenseAtom, VaultEntry, VaultNoteKind } from '../types'
import {
  countWords, dailyNotePath, filterVaultTree, frontmatterList, frontmatterString, isVaultNoteKind,
  localDateKey, noteFolderPath, notesFolderFromPath, noteTitleFromPath, parseNote, relativeTime,
  vaultBasename, vaultDirname, wikiLinks,
} from '../lib/vault'

const KIND_LABELS: Record<VaultNoteKind, string> = {
  daily: '日记',
  report: '日报',
  sense: '语义',
  semantic: '语义',
  expression: '表达',
  note: '笔记',
  chat: 'vault 对话',
  inbox: '记录本',
  finding: '专项发现',
}

type CreateKind = 'note' | 'folder' | 'material' | 'finding'

interface NotesSpaceProps {
  vault: VaultApi
  atoms: SenseAtom[]
  notes: NotebookNote[]
  recentRoots: string[]
  openPaths: string[]
  activePath: string | null
  view: NoteViewMode
  treeWidth: number
  sideOpen: boolean
  sideWidth: number
  collapsed: string[]
  /** The material currently open in the reading desk, when it lives in materials/. */
  readingContext: { document: string; notesFolder: string } | null
  reportTime: string
  onOpen: (path: string, options?: { background?: boolean }) => void
  onClose: (path: string) => void
  onActivate: (path: string) => void
  onView: (view: NoteViewMode) => void
  onTreeWidth: (delta: number) => void
  onTreeReset: () => void
  onSideWidth: (delta: number) => void
  onSideReset: () => void
  onToggleCollapsed: (path: string) => void
  onToggleSide: () => void
  onSwitchSpace: (space: AppSpace) => void
  onOpenSense: (atomId: string) => void
  /** Opens an original material (vault-relative path) in the reading desk. */
  onOpenSource: (path: string) => void
  /** Notebook senses that do not have a vault file yet. */
  pendingSenseCount: number
  onSavePendingSenses: () => void
  /** The `+` on the note tabs: a new blank note, ready to type in. */
  onCreateBlankNote: () => void
}

export default function NotesSpace({
  vault, atoms, notes, recentRoots, openPaths, activePath, view, treeWidth, sideOpen, sideWidth, collapsed,
  readingContext, reportTime,
  onOpen, onClose, onActivate, onView, onTreeWidth, onTreeReset, onSideWidth, onSideReset,
  onToggleCollapsed, onToggleSide, onSwitchSpace, onOpenSense, onOpenSource,
  pendingSenseCount, onSavePendingSenses, onCreateBlankNote,
}: NotesSpaceProps) {
  const [draft, setDraft] = useState('')
  const [loadedPath, setLoadedPath] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [noteError, setNoteError] = useState('')
  const [query, setQuery] = useState('')
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  const [createName, setCreateName] = useState('')
  const [createTarget, setCreateTarget] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [aiTopic, setAiTopic] = useState('')
  const [aiOpen, setAiOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)

  // The vault API object is rebuilt on every render, so callbacks read it
  // through a ref: an effect that depended on it would reload the note and
  // throw away the draft on every keystroke.
  const vaultRef = useRef(vault)
  vaultRef.current = vault
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const draftRef = useRef(draft)
  draftRef.current = draft
  const loadedRef = useRef(loadedPath)
  loadedRef.current = loadedPath
  const savingRef = useRef(saving)
  savingRef.current = saving
  const vaultReady = vault.ready
  const vaultFiles = vault.files

  const tree = useMemo(() => filterVaultTree(vault.tree, query), [query, vault.tree])
  const activeEntry = vaultFiles.find((entry) => entry.path === activePath) || null

  // Load the active note into the editor buffer.
  useEffect(() => {
    if (!vaultReady || !activePath) {
      setDraft('')
      setLoadedPath(null)
      setDirty(false)
      return
    }
    let cancelled = false
    setNoteError('')
    setStatus('')
    void vaultRef.current.readNote(activePath).then((content) => {
      if (cancelled) return
      setDraft(content)
      setLoadedPath(activePath)
      setDirty(false)
    }).catch((caught) => {
      if (cancelled) return
      setDraft('')
      setLoadedPath(activePath)
      setDirty(false)
      setNoteError(caught instanceof Error ? caught.message : '无法读取这份笔记。')
    })
    return () => { cancelled = true }
  }, [activePath, vaultReady])

  const save = useCallback(async () => {
    const path = loadedRef.current
    if (!path || !dirtyRef.current || savingRef.current) return
    setSaving(true)
    try {
      await vaultRef.current.writeNote(path, draftRef.current)
      setDirty(false)
      setStatus(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)
      setNoteError('')
    } catch (caught) {
      setNoteError(caught instanceof Error ? caught.message : '保存失败。')
    } finally {
      setSaving(false)
    }
  }, [])

  // Autosave like Obsidian: typing settles, then the file is written.
  useEffect(() => {
    if (!dirty || !loadedPath) return
    const timer = window.setTimeout(() => { void save() }, 1200)
    return () => window.clearTimeout(timer)
  }, [dirty, draft, loadedPath, save])

  // Never lose a draft: flush on unmount and when the window goes away.
  useEffect(() => {
    const flush = () => {
      const path = loadedRef.current
      if (dirtyRef.current && path) void vaultRef.current.writeNote(path, draftRef.current).catch(() => undefined)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void save()
      } else if (key === 'e') {
        event.preventDefault()
        onView(view === 'edit' ? 'preview' : 'edit')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onView, save, view])

  // Entering the notes desk opens the day's note (and its record list).
  const enteredRef = useRef(false)
  useEffect(() => {
    if (!vaultReady || enteredRef.current) return
    enteredRef.current = true
    const today = localDateKey()
    void (async () => {
      await vaultRef.current.refreshDaily(today, { silent: true })
      if (openPaths.length === 0) onOpen(dailyNotePath(today))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultReady])

  // Keep the open day's list current while the desk is visible.
  useEffect(() => {
    if (!vaultReady) return
    const timer = window.setTimeout(() => { void vaultRef.current.refreshDaily(localDateKey(), { silent: true }) }, 1500)
    return () => window.clearTimeout(timer)
  }, [atoms, notes, vaultReady])

  const parsed = useMemo(() => parseNote(draft), [draft])
  const kind: VaultNoteKind = useMemo(() => {
    const declared = frontmatterString(parsed.data, 'kind')
    if (declared === 'sense') return 'semantic'
    return isVaultNoteKind(declared) ? declared : 'note'
  }, [parsed.data])

  // Linked senses come from the frontmatter, which every Paperlight template
  // fills in (including the day's note). Body wikilinks additionally resolve to
  // real notes, so the panel never claims "no links" for a note full of them.
  const linkedAtoms = useMemo(() => {
    const ids = frontmatterList(parsed.data, 'senses')
    return ids.map((id) => atoms.find((atom) => atom.id === id)).filter((atom): atom is SenseAtom => Boolean(atom))
  }, [atoms, parsed.data])

  const linkedNotes = useMemo(() => {
    const seen = new Set<string>()
    const resolved: Array<{ path: string; title: string }> = []
    for (const target of wikiLinks(draft)) {
      const lower = target.toLowerCase()
      const match = vaultFiles.find((entry) => entry.path === target)
        || vaultFiles.find((entry) => entry.path === `${target}.md`)
        || vaultFiles.find((entry) => entry.path.toLowerCase().endsWith(`/${lower}.md`))
        || vaultFiles.find((entry) => noteTitleFromPath(entry.path).toLowerCase() === lower)
        || vaultFiles.find((entry) => vaultBasename(entry.path).toLowerCase() === lower)
      if (!match || match.path === activePath || seen.has(match.path)) continue
      seen.add(match.path)
      resolved.push({ path: match.path, title: noteTitleFromPath(match.path) })
      if (resolved.length >= 12) break
    }
    return resolved
  }, [activePath, draft, vaultFiles])

  const unresolvedLinks = useMemo(() => {
    const known = new Set(vaultFiles.map((entry) => entry.path))
    return wikiLinks(draft).filter((target) => !known.has(target) && !known.has(`${target}.md`)).slice(0, 6)
  }, [draft, vaultFiles])

  const dayEntries = useMemo(
    () => vault.entries.filter((entry) => !entry.directory && entry.path.startsWith('Daily/')),
    [vault.entries],
  )

  /** New notes land next to the open note when it lives in `notes/`. */
  const defaultNoteFolder = useMemo(() => {
    const folder = activePath && activePath.startsWith('notes/') ? vaultDirname(activePath) : ''
    return folder || noteFolderPath(null)
  }, [activePath])

  const activeNotesFolder = useMemo(() => notesFolderFromPath(activePath || '') || '', [activePath])

  const startCreate = useCallback((kindToCreate: CreateKind, folder?: string) => {
    setCreateKind(kindToCreate)
    setCreateName('')
    setCreateTarget(folder ?? null)
  }, [])

  const submitCreate = useCallback(async () => {
    const name = createName.trim()
    if (!name || !createKind) return
    const folder = createTarget || defaultNoteFolder
    try {
      await save()
      if (createKind === 'note') {
        const path = await vaultRef.current.createNote(folder, name)
        onOpen(path)
        setStatus(`已新建 ${path}`)
      } else if (createKind === 'folder') {
        const path = await vaultRef.current.createFolder(folder, name)
        setStatus(`已新建文件夹 ${path}`)
      } else if (createKind === 'material') {
        const path = await vaultRef.current.createMaterial(name)
        setStatus(`已新建 ${path}，笔记会自动镜像到 notes/${vaultBasename(path)}/`)
      } else {
        const path = await vaultRef.current.createFinding(name)
        onOpen(path)
        setStatus(`已新建专项发现 ${path}`)
      }
      setCreateKind(null)
      setCreateName('')
      setCreateTarget(null)
      setNoteError('')
    } catch (caught) {
      setNoteError(caught instanceof Error ? caught.message : '新建失败。')
    }
  }, [createKind, createName, createTarget, defaultNoteFolder, onOpen, save])

  const refreshDay = useCallback(async (force = false) => {
    const today = localDateKey()
    const info = await vaultRef.current.refreshDaily(today, { force, silent: !force })
    if (force) setStatus(info ? `${today} 的记录清单已更新（${info.entryCount} 条）。` : '更新失败。')
    onOpen(dailyNotePath(today))
  }, [onOpen])

  const runReport = useCallback(async (force = false) => {
    setStatus('正在生成日报…')
    const info = await vaultRef.current.generateReport(localDateKey(), { force, silent: false })
    if (info) {
      setStatus(`日报已生成：${info.path}`)
      onOpen(info.path)
    }
  }, [onOpen])

  const openWikiLink = useCallback((target: string) => {
    const normalized = target.trim()
    const lower = normalized.toLowerCase()
    const direct = vaultFiles.find((entry) => entry.path === normalized)
      || vaultFiles.find((entry) => entry.path === `${normalized}.md`)
      || vaultFiles.find((entry) => entry.path.toLowerCase().endsWith(`/${lower}.md`))
      || vaultFiles.find((entry) => noteTitleFromPath(entry.path).toLowerCase() === lower)
      || vaultFiles.find((entry) => vaultBasename(entry.path).toLowerCase() === lower)
    if (direct) {
      void save().then(() => onOpen(direct.path))
      return
    }
    setStatus(`vault 里没有找到「${normalized}」这份笔记。`)
  }, [onOpen, save, vaultFiles])

  const removeActive = useCallback(async () => {
    const path = activePath
    if (!path) return
    if (!window.confirm(`确定要把「${noteTitleFromPath(path)}」从 vault 删除吗？文件会从磁盘移除，无法撤销。`)) return
    try {
      await vaultRef.current.removeEntry(path)
      onClose(path)
      setStatus('已删除。')
    } catch (caught) {
      setNoteError(caught instanceof Error ? caught.message : '删除失败。')
    }
  }, [activePath, onClose])

  const submitRename = useCallback(async () => {
    const path = activePath
    if (!path || !renameValue.trim()) {
      setRenaming(false)
      return
    }
    try {
      await save()
      const next = await vaultRef.current.renameNote(path, renameValue.trim())
      setRenaming(false)
      if (next !== path) {
        onClose(path)
        onOpen(next)
      }
    } catch (caught) {
      setNoteError(caught instanceof Error ? caught.message : '重命名失败。')
    }
  }, [activePath, onClose, onOpen, renameValue, save])

  const generateFromTopic = useCallback(async () => {
    const topic = aiTopic.trim()
    if (!topic) return
    setAiBusy(true)
    setNoteError('')
    try {
      await save()
      const path = await vaultRef.current.generateTopicNote(topic, activeNotesFolder || undefined)
      onOpen(path)
      setAiTopic('')
      setAiOpen(false)
    } catch (caught) {
      setNoteError(caught instanceof Error ? caught.message : 'AI 笔记生成失败。')
    } finally {
      setAiBusy(false)
    }
  }, [activeNotesFolder, aiTopic, onOpen, save])

  const words = useMemo(() => countWords(draft), [draft])
  const report = vault.report
  const staleReport = Boolean(report && report.date === localDateKey() && report.stale)

  return (
    <div
      className="notes-space"
      data-expression-source={activePath?.startsWith('enlightenment/') ? 'enlightenment' : 'note'}
      data-expression-path={activePath || ''}
      data-expression-name={activePath ? noteTitleFromPath(activePath) : 'Vault 笔记'}
    >
      <SpaceRail active="notes" onSelect={onSwitchSpace} onChooseVault={() => void vault.chooseVault()} />

      <aside className="notes-tree-pane" style={{ width: `${treeWidth}px` }}>
        <header className="notes-tree-head">
          <div>
            <span className="right-kicker">VAULT</span>
            <h2 title={vault.root || ''}>{vault.rootName}</h2>
          </div>
          <div className="notes-tree-actions">
            <button type="button" className="tiny-icon" title="重新读取 vault" onClick={() => void vault.refresh()}><RefreshCw size={13} /></button>
            <button type="button" className="tiny-icon" title="更换 vault 文件夹（⌘⇧V）" onClick={() => void vault.chooseVault()}><FolderPlus size={13} /></button>
          </div>
        </header>

        {!vaultReady ? (
          <div className="vault-choose">
            <FolderPlus size={22} />
            <strong>选择一个 vault</strong>
            <span>vault 是一个文件夹：「materials/」放原始资料，「notes/」自动镜像归档笔记，「enlightenment/」写你自己的专项发现，「Daily/」每天一份记录清单与日报。</span>
            <button className="primary-button" type="button" onClick={() => void vault.chooseVault()}><FolderPlus size={14} /> 选择文件夹</button>
            {recentRoots.length > 0 && (
              <div className="vault-recents">
                <span className="places-title"><History size={11} /> 最近使用</span>
                {recentRoots.map((path) => (
                  <button key={path} type="button" className="places-item" title={path} onClick={() => void vault.useVaultPath(path)}>
                    <FolderPlus size={12} /><span>{path}</span>
                  </button>
                ))}
              </div>
            )}
            {vault.error && <p className="panel-error-text">{vault.error}</p>}
          </div>
        ) : (
          <>
            <div className="notes-tree-filter">
              <input className="text-field" placeholder="筛选 vault 内容…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>

            <div className="notes-tree-toolbar">
              <button type="button" onClick={() => startCreate('note')}><FileText size={12} /> 新建笔记</button>
              <button type="button" onClick={() => startCreate('material')} title="在 materials/ 下新建资料夹，notes/ 会自动镜像"><FolderPlus size={12} /> 新建资料夹</button>
              <button type="button" onClick={() => startCreate('finding')} title="在 enlightenment/ 下写下你的专项发现，日报会读它"><Lightbulb size={12} /> 新建发现</button>
              <button type="button" className="daily" title="打开并更新今天的记录清单" onClick={() => void refreshDay(false)}><CalendarDays size={12} /> 今日记录</button>
            </div>

            {createKind && (
              <div className="notes-create-row">
                <input
                  className="text-field"
                  autoFocus
                  placeholder={createKind === 'note' ? '笔记标题'
                    : createKind === 'folder' ? '文件夹名称'
                      : createKind === 'material' ? '资料夹名称（如 books、book1）'
                        : '发现的标题'}
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitCreate()
                    if (event.key === 'Escape') setCreateKind(null)
                  }}
                />
                <span className="notes-create-folder" title={createKind === 'note' || createKind === 'folder' ? (createTarget || defaultNoteFolder) : ''}>
                  {createKind === 'note' || createKind === 'folder'
                    ? `存到 ${createTarget || defaultNoteFolder}`
                    : createKind === 'material' ? 'materials/ → notes/ 自动镜像' : 'enlightenment/'}
                </span>
                <button type="button" className="notes-create-ok" disabled={!createName.trim()} onClick={() => void submitCreate()}><Check size={11} /> 创建</button>
                <button type="button" className="tiny-icon" onClick={() => setCreateKind(null)}><X size={12} /></button>
              </div>
            )}

            <div className="notes-tree-scroll">
              <VaultTree
                nodes={tree}
                activePath={activePath}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapsed}
                onOpenFile={onOpen}
                onOpenSource={onOpenSource}
                onNewNoteIn={(folder) => startCreate('note', folder)}
              />
            </div>

            <footer className="notes-tree-foot">
              <span>{vaultFiles.filter((entry) => entry.path.endsWith('.md')).length} 份 Markdown · {vault.materialFolders.length} 个资料夹</span>
              {vault.loading && <span className="mini-spinner" />}
            </footer>
          </>
        )}
      </aside>

      <Splitter
        label="调整 vault 面板宽度"
        value={treeWidth}
        min={168}
        max={560}
        onDelta={onTreeWidth}
        onReset={onTreeReset}
      />

      <section className="notes-editor-pane">
        <div className="note-tabs">
          {openPaths.map((path) => (
            <div
              key={path}
              className={`note-tab${path === activePath ? ' active' : ''}`}
              role="tab"
              aria-selected={path === activePath}
              title={path}
              onClick={() => void save().then(() => onActivate(path))}
            >
              <span className="note-tab-name">{noteTitleFromPath(path)}</span>
              <button
                type="button"
                className="note-tab-close"
                title="关闭这个笔记标签"
                onClick={(event) => { event.stopPropagation(); void save().then(() => onClose(path)) }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          {openPaths.length === 0 && <span className="note-tabs-empty">从左侧选一份笔记，或新建笔记</span>}
          <button type="button" className="note-tab-add" title="新建空白笔记（⌘N）" onClick={onCreateBlankNote}>
            <Plus size={13} />
          </button>
        </div>

        {activePath && vaultReady ? (
          <>
            <div className="note-toolbar">
              <div className="note-toolbar-path" title={activePath}>
                <span className={`note-kind kind-${kind}`}>{KIND_LABELS[kind] || '笔记'}</span>
                <span className="note-toolbar-path-text">{activePath}</span>
              </div>
              <div className="note-toolbar-actions">
                <span className="note-view-switch" role="group" aria-label="笔记显示模式">
                  <button
                    type="button"
                    className={view === 'edit' ? 'selected' : ''}
                    title="编辑模式（⌘E 切换）"
                    onClick={() => onView('edit')}
                  >
                    <Pencil size={12} /> 编辑
                  </button>
                  <button
                    type="button"
                    className={view === 'preview' ? 'selected' : ''}
                    title="浏览模式（⌘E 切换）"
                    onClick={() => onView('preview')}
                  >
                    <Eye size={12} /> 浏览
                  </button>
                </span>
                {renaming ? (
                  <span className="note-rename-row">
                    <input
                      className="text-field"
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitRename()
                        if (event.key === 'Escape') setRenaming(false)
                      }}
                    />
                    <button type="button" className="tiny-icon" onClick={() => void submitRename()}><Check size={13} /></button>
                  </span>
                ) : (
                  <button type="button" className="tiny-icon" title="重命名这份笔记" onClick={() => { setRenameValue(noteTitleFromPath(activePath)); setRenaming(true) }}><Pencil size={13} /></button>
                )}
                <button type="button" className="tiny-icon" title="在文件管理器中显示" onClick={() => void vault.revealEntry(activePath)}><ExternalLink size={13} /></button>
                <button type="button" className="tiny-icon danger" title="从 vault 删除这份笔记" onClick={() => void removeActive()}><Trash2 size={13} /></button>
              </div>
            </div>

            <div className={`note-body view-${view}`}>
              {view === 'edit' ? (
                <textarea
                  className="note-textarea"
                  value={draft}
                  spellCheck={false}
                  placeholder="用 Markdown 写笔记：[[另一份笔记]] 可以互相链接。"
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setDirty(true)
                  }}
                  onBlur={() => void save()}
                />
              ) : (
                <div className="note-preview-area">
                  <MarkdownPreview markdown={draft} onOpenWikiLink={openWikiLink} />
                </div>
              )}
            </div>

            <div className="note-status-bar">
              <span className="note-save-state">
                {noteError ? <span className="note-status-error">{noteError}</span>
                  : saving ? <><span className="mini-spinner" /> 正在保存…</>
                    : dirty ? '未保存的改动（1.2 秒后自动保存）'
                      : <><Check size={11} /> {status || '已保存'}</>}
              </span>
              <span className="note-meta-inline">
                {words} 字 · {view === 'edit' ? '编辑模式' : '浏览模式'} · {activeEntry ? relativeTime(new Date(activeEntry.mtimeMs).toISOString()) : '未落盘'}
              </span>
            </div>
          </>
        ) : (
          <div className="notes-empty-state">
            <ScanText size={26} />
            <strong>{vaultReady ? '打开或新建一份笔记' : '先选择一个 vault 文件夹'}</strong>
            <span>所有笔记都是 vault 里的 Markdown 文件；在阅读助手里收录的语义会按资料夹自动归档到 notes/。</span>
            <div className="notes-empty-actions">
              {vaultReady && <button className="primary-button" type="button" onClick={() => void refreshDay(false)}><CalendarDays size={14} /> 打开今日记录</button>}
              {vaultReady && <button className="secondary-button" type="button" onClick={() => startCreate('note')}><FileText size={14} /> 新建笔记</button>}
              {!vaultReady && <button className="primary-button" type="button" onClick={() => void vault.chooseVault()}><FolderPlus size={14} /> 选择 vault 文件夹</button>}
              <button className="secondary-button" type="button" onClick={() => onSwitchSpace('chat')}><Sparkles size={14} /> 去对话空间挖掘 vault</button>
            </div>
          </div>
        )}
      </section>

      {sideOpen && (
        <Splitter
          label="调整笔记信息面板宽度"
          value={sideWidth}
          min={208}
          max={560}
          onDelta={onSideWidth}
          onReset={onSideReset}
        />
      )}

      {sideOpen && (
        <aside className="notes-side-pane" style={{ width: `${sideWidth}px` }}>
          <header className="notes-side-head">
            <h3><Hash size={13} /> 笔记信息</h3>
            <button type="button" className="tiny-icon" title="收起信息面板" onClick={onToggleSide}><X size={13} /></button>
          </header>

          <section className="notes-side-block">
            <h4>今日记录 · {localDateKey()}</h4>
            <p className="sense-plain">
              {vault.daily
                ? `${vault.daily.entryCount} 条记录 · ${relativeTime(vault.daily.updatedAt)} 更新`
                : `打开笔记空间时会自动生成 ${localDateKey()} 的记录清单。`}
            </p>
            <div className="notes-side-actions">
              <button type="button" className="subtle-button" disabled={vault.organizingDaily} onClick={() => void refreshDay(true)}>
                {vault.organizingDaily ? <><span className="mini-spinner" /> 正在更新…</> : <><WandSparkles size={12} /> 更新今日记录清单</>}
              </button>
            </div>
          </section>

          <section className="notes-side-block">
            <h4>日报 · 每天 {reportTime} 生成</h4>
            {report && report.date === localDateKey() ? (
              <div className="report-card">
                <p className="sense-plain">
                  {report.source === 'ai' ? 'AI 整理' : '本地整理'} · {report.records} 条记录 · {relativeTime(report.generatedAt)}生成
                </p>
                {staleReport && <p className="report-stale">记录在这之后有更新，可以重新生成日报。</p>}
                <div className="notes-side-actions">
                  <button type="button" className="subtle-button" onClick={() => onOpen(report.path)}><FileText size={12} /> 打开日报</button>
                  <button type="button" className="subtle-button" disabled={vault.generatingReport} onClick={() => void runReport(true)}>
                    {vault.generatingReport ? <><span className="mini-spinner" /> 生成中…</> : <><RefreshCw size={12} /> 重新生成</>}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="sense-plain">今天还没有日报。日报在到点后自动生成，也可以现在就手动生成（会覆盖上一版）。</p>
                <div className="notes-side-actions">
                  <button type="button" className="subtle-button" disabled={vault.generatingReport} onClick={() => void runReport(false)}>
                    {vault.generatingReport ? <><span className="mini-spinner" /> 生成中…</> : <><Sparkles size={12} /> 立即生成日报</>}
                  </button>
                </div>
              </>
            )}
          </section>

          {readingContext && (
            <section className="notes-side-block">
              <h4><Link2 size={12} /> 阅读上下文</h4>
              <p className="sense-plain">
                正在读 <strong>{readingContext.document}</strong><br />
                语义与笔记会存到 <code>{readingContext.notesFolder}/</code>
              </p>
            </section>
          )}

          {vaultReady && pendingSenseCount > 0 && (
            <section className="notes-side-block">
              <h4>待归档语义（{pendingSenseCount}）</h4>
              <p className="sense-plain">
                记录本里还有 {pendingSenseCount} 条语义没有对应的 vault 笔记，所以当天记录清单里的链接暂时点不开。
              </p>
              <div className="notes-side-actions">
                <button type="button" className="subtle-button" disabled={vault.busy} onClick={onSavePendingSenses}>
                  {vault.busy ? <><span className="mini-spinner" /> 正在写入…</> : <><FileText size={12} /> 全部写入 vault</>}
                </button>
              </div>
            </section>
          )}

          <section className="notes-side-block">
            <h4>AI 完整笔记</h4>
            <p className="sense-plain">
              让模型把主题写成一份结构完整的 Markdown 笔记，存进 {activeNotesFolder ? `${noteFolderPath(activeNotesFolder)}/` : `${noteFolderPath(null)}/`}。
            </p>
            {aiOpen ? (
              <div className="ai-note-row">
                <input
                  className="text-field"
                  autoFocus
                  placeholder="如：numerous 的学术用法"
                  value={aiTopic}
                  onChange={(event) => setAiTopic(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void generateFromTopic() }}
                />
                <button type="button" className="notes-create-ok" disabled={!aiTopic.trim() || aiBusy} onClick={() => void generateFromTopic()}>
                  {aiBusy ? '生成中…' : '生成'}
                </button>
              </div>
            ) : (
              <button type="button" className="subtle-button" disabled={!vault.apiConfigured} onClick={() => setAiOpen(true)}>
                <Sparkles size={12} /> {vault.apiConfigured ? '写一份 AI 完整笔记' : '需先在设置里配置 API'}
              </button>
            )}
          </section>

          {activePath && vaultReady && (
            <section className="notes-side-block">
              <h4>这份笔记</h4>
              <dl className="note-facts">
                <div><dt>类型</dt><dd>{KIND_LABELS[kind] || '笔记'}</dd></div>
                <div><dt>路径</dt><dd title={activePath}>{activePath}</dd></div>
                <div><dt>字数</dt><dd>{words}</dd></div>
                <div><dt>大小</dt><dd>{activeEntry ? `${Math.max(1, Math.round(activeEntry.size / 1024))} KB` : '—'}</dd></div>
                <div><dt>更新</dt><dd>{activeEntry ? relativeTime(new Date(activeEntry.mtimeMs).toISOString()) : '未落盘'}</dd></div>
              </dl>
              {frontmatterList(parsed.data, 'tags').length > 0 && (
                <div className="note-tag-row">
                  {frontmatterList(parsed.data, 'tags').map((tag) => <span key={tag} className="note-tag">{tag}</span>)}
                </div>
              )}
              <h4>关联语义（{linkedAtoms.length}）</h4>
              {linkedAtoms.length === 0 && <p className="sense-plain">这份笔记没有记录本里的语义（语义卡里点「语义存入 vault」会自动带上）。</p>}
              <ul className="note-sense-list">
                {linkedAtoms.map((atom) => (
                  <li key={atom.id}>
                    <button type="button" onClick={() => onOpenSense(atom.id)}>
                      <strong>{atom.term}</strong> · {atom.contextualMeaning}
                    </button>
                  </li>
                ))}
              </ul>
              <h4>链接到的笔记（{linkedNotes.length}）</h4>
              {linkedNotes.length === 0 && <p className="sense-plain">正文里还没有 [[链接]]。</p>}
              <ul className="note-sense-list">
                {linkedNotes.map((note) => (
                  <li key={note.path}>
                    <button type="button" title={note.path} onClick={() => onOpen(note.path)}>→ {note.title}</button>
                  </li>
                ))}
              </ul>
              {unresolvedLinks.length > 0 && (
                <p className="sense-plain">还没创建的链接：{unresolvedLinks.join('、')}</p>
              )}
            </section>
          )}

          <section className="notes-side-block">
            <h4><History size={12} /> 最近改动</h4>
            <ul className="recent-note-list">
              {[...vaultFiles].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 8).map((entry: VaultEntry) => (
                <li key={entry.path}>
                  <button type="button" title={entry.path} onClick={() => (entry.path.endsWith('.md') ? onOpen(entry.path) : onOpenSource(entry.path))}>
                    {noteTitleFromPath(entry.path)}
                    <span>{relativeTime(new Date(entry.mtimeMs).toISOString())}</span>
                  </button>
                </li>
              ))}
              {vaultFiles.length === 0 && <li className="sense-plain">还没有笔记。</li>}
            </ul>
            {dayEntries.length > 0 && <p className="sense-plain">Daily/ 里已有 {dayEntries.length} 份记录文件。</p>}
          </section>

          {vault.error && <p className="panel-error-text">{vault.error}</p>}
        </aside>
      )}

      {!sideOpen && (
        <button type="button" className="notes-side-handle" title="展开笔记信息面板" onClick={onToggleSide}>
          <Hash size={13} />
        </button>
      )}

      {vault.notice && <div className="vault-notice" role="status">{vault.notice}</div>}
    </div>
  )
}
