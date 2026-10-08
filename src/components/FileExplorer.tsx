import { useMemo, useState } from 'react'
import {
  ArrowUp, BookOpen, Check, Clock, FileText, Folder, FolderOpen, FolderPlus, History, RefreshCw, Star,
} from 'lucide-react'
import type { DirEntry, DirListing, QuickRoot } from '../lib/bridge'
import { crumbsForPath, entryIsOpenable } from '../lib/fsaccess'
import { KIND_LABELS } from '../lib/documentKind'
import type { RecentFile } from '../lib/persist'

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(mtimeMs: number): string {
  if (!mtimeMs) return ''
  const date = new Date(mtimeMs)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export default function FileExplorer({
  root,
  currentDir,
  listing,
  loading,
  error,
  roots,
  recents,
  recentFolders,
  favorites,
  openPaths,
  browseMode,
  onPickFolder,
  onOpenDir,
  onGoUp,
  onRefresh,
  onOpenFile,
  onReveal,
  onToggleFavorite,
  onOpenRecent,
  onOpenRecentFolder,
}: {
  root: string | null
  currentDir: string
  listing: DirListing | null
  loading: boolean
  error: string
  roots: QuickRoot[]
  recents: RecentFile[]
  recentFolders: string[]
  favorites: string[]
  openPaths: string[]
  browseMode: 'app' | 'browser' | 'none'
  onPickFolder: () => void
  onOpenDir: (path: string) => void
  onGoUp: () => void
  onRefresh: () => void
  onOpenFile: (path: string, options?: { background?: boolean }) => void
  onReveal: (path: string) => void
  onToggleFavorite: (path: string) => void
  onOpenRecent: (path: string) => void
  onOpenRecentFolder: (path: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [showPlaces, setShowPlaces] = useState(!root)

  const entries = useMemo(() => {
    const list = listing?.entries || []
    const needle = filter.trim().toLowerCase()
    const filtered = needle ? list.filter((entry) => entry.name.toLowerCase().includes(needle)) : list
    return filtered
  }, [filter, listing])

  const crumbs = crumbsForPath(currentDir)
  const isFavorite = Boolean(currentDir && favorites.includes(currentDir))

  function activate(entry: DirEntry) {
    if (entry.directory) onOpenDir(entry.path)
    else if (entryIsOpenable(entry)) onOpenFile(entry.path)
  }

  return (
    <div className="explorer">
      <div className="explorer-toolbar">
        <button type="button" className="icon-button small" title="打开文件夹（⌘⇧O）" onClick={onPickFolder}>
          <FolderPlus size={15} />
        </button>
        <button type="button" className="icon-button small" title="上级文件夹" disabled={!currentDir} onClick={onGoUp}>
          <ArrowUp size={15} />
        </button>
        <button type="button" className="icon-button small" title="刷新" disabled={!currentDir || loading} onClick={onRefresh}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
        </button>
        <button
          type="button"
          className={`icon-button small${isFavorite ? ' active' : ''}`}
          title={isFavorite ? '取消收藏此文件夹' : '收藏此文件夹'}
          disabled={!currentDir}
          onClick={() => currentDir && onToggleFavorite(currentDir)}
        >
          <Star size={14} />
        </button>
        <button
          type="button"
          className={`icon-button small${showPlaces ? ' active' : ''}`}
          title="位置与最近"
          onClick={() => setShowPlaces((value) => !value)}
        >
          <History size={14} />
        </button>
      </div>

      {showPlaces && (
        <div className="explorer-places">
          {favorites.length > 0 && <div className="places-group">
            <span className="places-title"><Star size={11} /> 收藏</span>
            {favorites.map((path) => (
              <button key={path} type="button" className="places-item" title={path} onClick={() => onOpenRecentFolder(path)}>
                <Folder size={13} /><span>{path.split(/[\\/]/).filter(Boolean).pop() || path}</span>
              </button>
            ))}
          </div>}
          {roots.length > 0 && <div className="places-group">
            <span className="places-title"><FolderOpen size={11} /> 位置</span>
            {roots.map((item) => (
              <button key={item.path} type="button" className="places-item" title={item.path} onClick={() => onOpenRecentFolder(item.path)}>
                <Folder size={13} /><span>{item.label}</span>
              </button>
            ))}
          </div>}
          {recentFolders.length > 0 && <div className="places-group">
            <span className="places-title"><Clock size={11} /> 最近文件夹</span>
            {recentFolders.slice(0, 6).map((path) => (
              <button key={path} type="button" className="places-item" title={path} onClick={() => onOpenRecentFolder(path)}>
                <Clock size={13} /><span>{path.split(/[\\/]/).filter(Boolean).pop() || path}</span>
              </button>
            ))}
          </div>}
          {browseMode === 'browser' && <p className="explorer-hint">浏览器开发模式下，文件夹授权只在本次会话有效。打包后的 app 可直接读取文件夹。</p>}
          {browseMode === 'none' && <p className="explorer-hint">当前环境不支持读取本地文件夹，请使用“打开 PDF”。</p>}
        </div>
      )}

      <div className="explorer-breadcrumb" title={currentDir}>
        {crumbs.length === 0 && <span className="crumb muted">未选择文件夹</span>}
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="crumb-wrap">
            {index > 0 && <span className="crumb-sep">/</span>}
            <button
              type="button"
              className="crumb"
              onClick={() => onOpenDir(crumb.path)}
            >
              {index === 0 ? (crumb.label || '/') : crumb.label}
            </button>
          </span>
        ))}
      </div>

      <div className="explorer-filter">
        <input
          className="text-field"
          placeholder="筛选此文件夹"
          value={filter}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      {error && <p className="explorer-error">{error}</p>}

      <div className="explorer-list" role="listbox" aria-label="文件夹内容">
        {entries.map((entry) => {
          const isOpen = openPaths.includes(entry.path)
          return (
            <div
              key={entry.path}
              role="option"
              aria-selected={selected === entry.path}
              tabIndex={0}
              className={`explorer-entry${selected === entry.path ? ' selected' : ''}${entry.directory ? ' is-dir' : ''}${isOpen ? ' is-open' : ''}`}
              title={entry.path}
              onClick={() => setSelected(entry.path)}
              onDoubleClick={() => activate(entry)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') activate(entry)
              }}
            >
              <span className={`entry-icon${entry.kind ? ` kind-${entry.kind}` : ''}`}>
                {entry.directory ? <Folder size={14} /> : entry.kind === 'epub' ? <BookOpen size={14} /> : <FileText size={14} />}
              </span>
              <span className="entry-name">{entry.name}</span>
              {isOpen && <span className="entry-open-flag" title="已在标签页中打开"><Check size={12} /></span>}
              <span className="entry-meta">
                {entry.directory ? '' : `${entry.kind ? `${KIND_LABELS[entry.kind]} · ` : ''}${formatSize(entry.size)}${entry.mtimeMs ? ` · ${formatDate(entry.mtimeMs)}` : ''}`}
              </span>
              {entryIsOpenable(entry) && (
                <span className="entry-actions">
                  <button
                    type="button"
                    title="打开"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenFile(entry.path)
                    }}
                  >
                    <FolderOpen size={12} />
                  </button>
                  <button
                    type="button"
                    title="在后台标签页打开"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenFile(entry.path, { background: true })
                    }}
                  >
                    <FileText size={12} />
                  </button>
                  <button
                    type="button"
                    title="在访达中显示"
                    onClick={(event) => {
                      event.stopPropagation()
                      onReveal(entry.path)
                    }}
                  >
                    <ArrowUp size={12} />
                  </button>
                </span>
              )}
            </div>
          )
        })}
        {!loading && entries.length === 0 && (
          <div className="explorer-empty">
            {currentDir ? '此文件夹中没有可阅读的文档或子文件夹' : '点击左上角打开一个文件夹'}
          </div>
        )}
      </div>

      {recents.length > 0 && showPlaces && (
        <div className="explorer-recents">
          <span className="places-title"><Clock size={11} /> 最近打开的文件</span>
          {recents.slice(0, 6).map((file) => (
            <button key={file.path} type="button" className="places-item" title={file.path} onClick={() => onOpenRecent(file.path)}>
              <FileText size={13} /><span>{file.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="explorer-footer">
        {listing ? `${entries.length} 项` : '文件'}
        {root && <span className="explorer-root-name" title={root}>{root.split(/[\\/]/).filter(Boolean).pop()}</span>}
      </div>
    </div>
  )
}
