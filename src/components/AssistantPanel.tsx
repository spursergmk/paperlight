import {
  Bookmark, BookOpen, ChevronDown, Languages, Library, Maximize2, Minimize2, Sparkles,
  StickyNote, X,
} from 'lucide-react'
import SenseCard from './SenseCard'
import NotebookPanel from './NotebookPanel'
import ChatPanel from './ChatPanel'
import type {
  ChatMessage, NotebookNote, SenseAtom, SensePayload, SenseSummary, TextSelection,
} from '../types'
import type { SenseRelation } from '../types'

export type AssistantTab = 'sense' | 'notebook' | 'chat'

export default function AssistantPanel({
  tab,
  onTab,
  wide,
  onToggleWide,
  onCollapse,
  queryTerm,
  onQueryTerm,
  onQuery,
  sense,
  senseLoading,
  senseError,
  allSenses,
  expanding,
  onExpand,
  translation,
  translationLoading,
  translationError,
  onTranslate,
  selection,
  senseInNotebook,
  relations,
  onAddSense,
  model,
  onJumpToAtom,
  atoms,
  notes,
  activeAtomId,
  onSelectAtom,
  onDeleteAtom,
  onAddNote,
  onDeleteNote,
  chatMessages,
  savedMessageIds,
  chatSending,
  chatError,
  onSend,
  onSaveExcerpt,
  onSaveSense,
  onRetrySense,
  vaultReady,
  vaultRootName,
  vaultBusy,
  vaultMessage,
  onOpenNotesSpace,
  onSaveSenseToVault,
  onGenerateCompleteNote,
  onSaveNoteToVault,
  vaultTarget,
}: {
  tab: AssistantTab
  onTab: (tab: AssistantTab) => void
  wide: boolean
  onToggleWide: () => void
  onCollapse: () => void
  queryTerm: string
  onQueryTerm: (value: string) => void
  onQuery: () => void
  sense: SensePayload | null
  senseLoading: boolean
  senseError: string
  allSenses: SenseSummary[] | null
  expanding: boolean
  onExpand: () => void
  translation: string
  translationLoading: boolean
  translationError: string
  onTranslate: () => void
  selection: TextSelection | null
  senseInNotebook: boolean
  relations: SenseRelation[]
  onAddSense: () => void
  model: string
  onJumpToAtom: (id: string) => void
  atoms: SenseAtom[]
  notes: NotebookNote[]
  activeAtomId: string | null
  onSelectAtom: (id: string | null) => void
  onDeleteAtom: (id: string) => void
  onAddNote: (body: string) => void
  onDeleteNote: (id: string) => void
  chatMessages: ChatMessage[]
  savedMessageIds: Set<string>
  chatSending: boolean
  chatError: string
  onSend: (question: string) => void
  onSaveExcerpt: (message: ChatMessage) => void
  onSaveSense: () => void
  onRetrySense: () => void
  vaultReady: boolean
  vaultRootName: string
  vaultBusy: boolean
  vaultMessage: { kind: 'success' | 'error'; text: string } | null
  onOpenNotesSpace: () => void
  onSaveSenseToVault: () => void
  onGenerateCompleteNote: () => void
  onSaveNoteToVault: (note: NotebookNote) => void
  /** Vault folder the reading session writes to, e.g. `notes/books/book1`. */
  vaultTarget: string
}) {
  return (
    <aside className="right-sidebar">
      <div className="right-heading">
        <div>
          <span className="right-kicker">READING DESK</span>
          <h2>阅读助手</h2>
        </div>
        <div className="right-heading-actions">
          <button type="button" className="tiny-icon" title={`打开笔记空间（${vaultRootName}）`} onClick={onOpenNotesSpace}>
            <Library size={14} />
          </button>
          <button
            type="button"
            className="tiny-icon"
            title={wide ? '恢复助手宽度' : '加宽助手（给查询、追问、笔记更多空间）'}
            onClick={onToggleWide}
          >
            {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" className="tiny-icon" title="收起侧栏" onClick={onCollapse}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="right-tabs">
        <button type="button" className={tab === 'sense' ? 'selected' : ''} onClick={() => onTab('sense')}><Languages size={14} /> 义项</button>
        <button type="button" className={tab === 'notebook' ? 'selected' : ''} onClick={() => onTab('notebook')}>
          <StickyNote size={14} /> 记录本{atoms.length > 0 && <span className="notes-count">{atoms.length}</span>}
        </button>
        <button type="button" className={tab === 'chat' ? 'selected' : ''} onClick={() => onTab('chat')}>
          <BookOpen size={14} /> 对话{chatMessages.length > 0 && <span className="notes-count">{chatMessages.length}</span>}
        </button>
      </div>

      {tab === 'sense' && (
        <div className="translation-panel">
          <div className="query-row">
            <label className="field-label" htmlFor="query-term">查询词（可键盘修改）</label>
            <div className="query-input-wrap">
              <input
                id="query-term"
                className="text-field"
                value={queryTerm}
                spellCheck={false}
                placeholder="如 within"
                onChange={(event) => onQueryTerm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onQuery()
                }}
              />
              <button
                type="button"
                className="query-go"
                disabled={senseLoading || !queryTerm.trim()}
                onClick={onQuery}
              >
                查询
              </button>
            </div>
            {selection && <span className="query-meta">来自「{selection.documentName || '当前文档'}」第 {selection.pageNumber} 页的选区 · Enter 重新查询</span>}
          </div>

          {senseLoading && <div className="loading-copy"><span className="mini-spinner" /> 正在结合上下文判断义项…</div>}

          {senseError && !senseLoading && (
            <div className="panel-error">
              <p>{senseError}</p>
              <button className="text-action" type="button" onClick={onRetrySense}>重试</button>
            </div>
          )}

          {sense && !senseLoading && (
            <>
              <SenseCard
                sense={sense}
                model={model}
                added={senseInNotebook}
                relations={relations}
                onAdd={onAddSense}
                onJumpToAtom={onJumpToAtom}
              />

              <div className="sense-actions">
                <button className="text-action" type="button" disabled={expanding} onClick={onExpand}>
                  {expanding ? '正在获取…' : allSenses ? '重新获取完整义项' : '查看完整词典义项'}
                </button>
                <button className="text-action" type="button" onClick={() => onTab('chat')}>继续和 Agent 对话</button>
              </div>

              {allSenses && allSenses.length > 0 && (
                <section className="sense-block all-senses">
                  <h4>{sense.lemma} 的全部义项（{allSenses.length}）</h4>
                  <ul className="all-sense-list">
                    {allSenses.map((item) => (
                      <li key={item.senseId} className={item.isContextual ? 'current' : ''}>
                        <strong>{item.partOfSpeech} · {item.senseId}{item.isContextual ? '（当前上下文）' : ''}</strong>
                        <p>{item.meaning}</p>
                        <span>{item.definition}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="sense-plain">以上义项同样由 AI 生成，不是授权词典内容，请自行核对。</p>
                </section>
              )}

              <details className="context-details">
                <summary>整句翻译参考 <ChevronDown size={13} /></summary>
                {translationLoading ? <div className="loading-copy"><span className="mini-spinner" /> 正在翻译…</div>
                  : translationError ? <p className="panel-error-text">{translationError}</p>
                    : translation ? <p>{translation}</p>
                      : selection ? <button className="text-action" type="button" onClick={onTranslate}>翻译选中内容</button>
                        : <p className="sense-plain">先在正文中选中文字。</p>}
              </details>

              <button className="save-note-button" type="button" onClick={onSaveSense}>
                <Bookmark size={15} /> 把这条义项存成笔记
              </button>

              <div className="vault-action-row">
                <button
                  className="vault-button"
                  type="button"
                  disabled={vaultBusy}
                  title={vaultReady ? `把这条义项写成 Markdown 存进 ${vaultRootName}` : '先在笔记空间里选择 vault 文件夹'}
                  onClick={onSaveSenseToVault}
                >
                  <Library size={13} /> 义项存入 vault
                </button>
                <button
                  className="vault-button"
                  type="button"
                  disabled={vaultBusy || !vaultReady}
                  title="让 AI 把这条义项写成一份结构完整的学习笔记，存进 vault"
                  onClick={onGenerateCompleteNote}
                >
                  <Sparkles size={13} /> 生成 AI 完整笔记
                </button>
              </div>
              {vaultBusy && <p className="loading-copy"><span className="mini-spinner" /> 正在写入 vault…</p>}
              {vaultMessage && <p className={`api-config-message ${vaultMessage.kind}`} role="status">{vaultMessage.text}</p>}
              {!vaultReady && <p className="vault-hint">还没有选择笔记 vault：点右上角 <Library size={11} /> 进入笔记空间选择文件夹。</p>}
              {vaultReady && <p className="vault-hint"><Library size={11} /> 这条阅读会话的义项与笔记会存到 <code>{vaultTarget}/</code></p>}
            </>
          )}

          {!sense && !senseLoading && !senseError && (
            <div className="translation-empty">
              <div><Languages size={20} /></div>
              <strong>选中一个词</strong>
              <span>会结合上下文给出准确的义项、例句、<br />使用建议与词根词缀分析。</span>
            </div>
          )}
        </div>
      )}

      {tab === 'notebook' && <NotebookPanel
        atoms={atoms}
        notes={notes}
        activeAtomId={activeAtomId}
        model={model}
        vaultReady={vaultReady}
        vaultRootName={vaultRootName}
        onSelectAtom={onSelectAtom}
        onDeleteAtom={onDeleteAtom}
        onAddNote={onAddNote}
        onDeleteNote={onDeleteNote}
        onSaveToVault={onSaveNoteToVault}
        onOpenNotesSpace={onOpenNotesSpace}
      />}

      {tab === 'chat' && <ChatPanel
        sense={sense}
        model={model}
        messages={chatMessages}
        sending={chatSending}
        error={chatError}
        savedMessageIds={savedMessageIds}
        onSend={onSend}
        onSaveExcerpt={onSaveExcerpt}
        onOpenNotebook={() => onTab('notebook')}
      />}
    </aside>
  )
}
