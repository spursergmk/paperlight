import { BookOpen, ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import type { VaultTreeNode } from '../types'
import { collectFiles, countTree } from '../lib/vault'

interface VaultTreeProps {
  nodes: VaultTreeNode[]
  /** Open note (notes desk) or the note being previewed. */
  activePath?: string | null
  collapsed: string[]
  onToggleCollapse: (path: string) => void
  onOpenFile: (path: string) => void
  /** Original material under `materials/`: opening it goes to the reading desk. */
  onOpenSource?: (path: string) => void
  /** Chat desk: every note gets a checkbox and folders select their notes. */
  selectable?: boolean
  selected?: string[]
  onToggleSelect?: (path: string) => void
  /** Notes desk: shown on hover to add a note straight into that folder. */
  onNewNoteIn?: (folder: string) => void
  emptyHint?: string
}

export default function VaultTree({
  nodes, activePath, collapsed, onToggleCollapse, onOpenFile, onOpenSource,
  selectable = false, selected = [], onToggleSelect, onNewNoteIn, emptyHint,
}: VaultTreeProps) {
  if (nodes.length === 0) {
    return <p className="vault-tree-empty">{emptyHint || '这个 vault 里还没有 Markdown 笔记。'}</p>
  }

  return (
    <ul className="vault-tree">
      {nodes.map((node) => (
        <VaultNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
          onOpenFile={onOpenFile}
          onOpenSource={onOpenSource}
          selectable={selectable}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onNewNoteIn={onNewNoteIn}
        />
      ))}
    </ul>
  )
}

function VaultNode({
  node, depth, activePath, collapsed, onToggleCollapse, onOpenFile, onOpenSource,
  selectable, selected, onToggleSelect, onNewNoteIn,
}: {
  node: VaultTreeNode
  depth: number
  activePath?: string | null
  collapsed: string[]
  onToggleCollapse: (path: string) => void
  onOpenFile: (path: string) => void
  onOpenSource?: (path: string) => void
  selectable: boolean
  selected: string[]
  onToggleSelect?: (path: string) => void
  onNewNoteIn?: (folder: string) => void
}) {
  const indent = { paddingLeft: `${8 + depth * 13}px` }

  if (node.type === 'dir') {
    const folded = collapsed.includes(node.path)
    const files = collectFiles(node)
    const counts = countTree(node)
    const allSelected = selectable && files.length > 0 && files.every((path) => selected.includes(path))
    return (
      <li className="vault-branch">
        <div className="vault-node dir" style={indent}>
          {selectable && (
            <input
              type="checkbox"
              className="vault-check"
              checked={allSelected}
              title={allSelected ? '取消选择这个文件夹里的笔记' : '选择这个文件夹里的全部笔记'}
              onChange={() => onToggleSelect?.(node.path)}
            />
          )}
          <button type="button" className="vault-node-toggle" onClick={() => onToggleCollapse(node.path)}>
            {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {folded ? <Folder size={13} /> : <FolderOpen size={13} />}
            <span className="vault-node-name">{node.name}</span>
            <span
              className={`vault-node-count${counts.notes === 0 && counts.sources > 0 ? ' sources' : ''}`}
              title={`${counts.notes} 份笔记${counts.sources > 0 ? ` · ${counts.sources} 份资料` : ''}`}
            >
              {counts.notes + counts.sources}
            </span>
          </button>
          {onNewNoteIn && (
            <button type="button" className="vault-node-action" title={`在 ${node.path} 新建笔记`} onClick={() => onNewNoteIn(node.path)}>
              +
            </button>
          )}
        </div>
        {!folded && node.children.length > 0 && (
          <ul className="vault-children">
            {node.children.map((child) => (
              <VaultNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                onOpenFile={onOpenFile}
                onOpenSource={onOpenSource}
                selectable={selectable}
                selected={selected}
                onToggleSelect={onToggleSelect}
                onNewNoteIn={onNewNoteIn}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  if (node.kind === 'source') {
    return (
      <li className="vault-branch">
        <div className="vault-node file source" style={indent}>
          <button type="button" className="vault-node-toggle" title={`${node.path}（在阅读空间打开）`} onClick={() => onOpenSource?.(node.path)}>
            <BookOpen size={13} />
            <span className="vault-node-name">{node.name}</span>
          </button>
        </div>
      </li>
    )
  }

  const isSelected = selected.includes(node.path)
  const isActive = activePath === node.path
  return (
    <li className="vault-branch">
      <div className={`vault-node file${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}`} style={indent}>
        {selectable && (
          <input
            type="checkbox"
            className="vault-check"
            checked={isSelected}
            title={isSelected ? '不再把这个笔记作为对话依据' : '把这个笔记作为对话依据'}
            onChange={() => onToggleSelect?.(node.path)}
          />
        )}
        <button type="button" className="vault-node-toggle" title={node.path} onClick={() => (selectable ? onToggleSelect?.(node.path) : onOpenFile(node.path))}>
          <FileText size={13} />
          <span className="vault-node-name">{node.name.replace(/\.md$/i, '')}</span>
        </button>
      </div>
    </li>
  )
}
