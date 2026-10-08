import { BookOpen, MessagesSquare, NotebookPen, type LucideIcon } from 'lucide-react'
import type { AppSpace } from '../types'

const SPACES: Array<{ id: AppSpace; label: string; hint: string; icon: LucideIcon }> = [
  { id: 'reader', label: '阅读', hint: '阅读空间：文档、义项与记录本', icon: BookOpen },
  { id: 'notes', label: '笔记', hint: '笔记空间：vault、Markdown 笔记与每日汇总', icon: NotebookPen },
  { id: 'chat', label: '对话', hint: '对话空间：基于 vault 内容的知识挖掘', icon: MessagesSquare },
]

/**
 * The space switcher that lives in the sidebar of every desk, so the notes and
 * chat desks are always one click away from the reader (and back).
 */
export default function SpaceRail({
  active,
  onSelect,
  onChooseVault,
  vaultName,
}: {
  active: AppSpace
  onSelect: (space: AppSpace) => void
  onChooseVault?: () => void
  vaultName?: string
}) {
  return (
    <nav className="space-rail" aria-label="工作空间">
      {SPACES.map(({ id, label, hint, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={`space-rail-button${active === id ? ' active' : ''}`}
          title={`${hint}（⌘⌥${id === 'reader' ? 1 : id === 'notes' ? 2 : 3}）`}
          aria-current={active === id ? 'page' : undefined}
          onClick={() => onSelect(id)}
        >
          <Icon size={16} />
          <span>{label}</span>
        </button>
      ))}
      {onChooseVault && (
        <button
          type="button"
          className="space-rail-button vault"
          title={`笔记 vault：${vaultName || '未选择'}（点击更换）`}
          onClick={onChooseVault}
        >
          <NotebookPen size={16} />
          <span>Vault</span>
        </button>
      )}
    </nav>
  )
}
