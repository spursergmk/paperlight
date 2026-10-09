import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, Copy, FilePlus2, FolderPlus, History, Link2, MessageSquarePlus, Pencil, RefreshCw,
  Send, ShieldCheck, ShieldOff, Sparkles, Trash2, X,
} from 'lucide-react'
import SpaceRail from './SpaceRail'
import Splitter from './Splitter'
import VaultTree from './VaultTree'
import type { VaultApi } from './useVault'
import type { AppSpace, ChatMessage, ChatThread } from '../types'
import { chatThreadTitle, filesUnderPath, filterVaultTree, newChatMessage, noteTitleFromPath, relativeTime } from '../lib/vault'
import { askVault } from '../lib/vaultai'

interface ChatSpaceProps {
  vault: VaultApi
  threads: ChatThread[]
  activeThreadId: string | null
  historyWidth: number
  pickerWidth: number
  historyOpen: boolean
  pickerOpen: boolean
  model: string
  onCreateThread: () => string
  onActivateThread: (id: string) => void
  onUpdateThread: (id: string, updater: (thread: ChatThread) => ChatThread) => void
  onDeleteThread: (id: string) => void
  onHistoryWidth: (delta: number) => void
  onHistoryReset: () => void
  onPickerWidth: (delta: number) => void
  onPickerReset: () => void
  onToggleColumn: (column: 'history' | 'picker') => void
  onSwitchSpace: (space: AppSpace) => void
  onOpenNote: (path: string) => void
}

const SUGGESTIONS = [
  '把我选中的笔记整理成一条主线',
  '这些笔记里有哪些互相矛盾或重复的说法？',
  '基于这些内容，列出还缺哪些资料',
]

export default function ChatSpace({
  vault, threads, activeThreadId, historyWidth, pickerWidth, historyOpen, pickerOpen, model,
  onCreateThread, onActivateThread, onUpdateThread, onDeleteThread,
  onHistoryWidth, onHistoryReset, onPickerWidth, onPickerReset, onToggleColumn, onSwitchSpace, onOpenNote,
}: ChatSpaceProps) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [flash, setFlash] = useState('')
  const [copiedId, setCopiedId] = useState('')

  const vaultRef = useRef(vault)
  vaultRef.current = vault
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const activeRef = useRef(activeThreadId)
  activeRef.current = activeThreadId
  const sendingRef = useRef(sending)
  sendingRef.current = sending
  const draftRef = useRef(draft)
  draftRef.current = draft
  const flashTimer = useRef<number | null>(null)

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) || null,
    [activeThreadId, threads],
  )
  const tree = useMemo(() => filterVaultTree(vault.noteTree, query), [query, vault.noteTree])
  const selectedPaths = activeThread?.contextPaths || []

  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current) }, [])

  const notify = useCallback((text: string) => {
    setFlash(text)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(''), 5000)
  }, [])

  const patchThread = useCallback((id: string, updater: (thread: ChatThread) => ChatThread) => {
    onUpdateThread(id, updater)
  }, [onUpdateThread])

  const send = useCallback(async (questionOverride?: string) => {
    const thread = threadsRef.current.find((item) => item.id === activeRef.current)
    const question = (questionOverride ?? draftRef.current).trim()
    if (!thread || !question || sendingRef.current) return
    setDraft('')
    setSending(true)
    setError('')
    const history = thread.messages.slice(-8).map((message) => ({ role: message.role, content: message.content }))
    patchThread(thread.id, (current) => ({
      ...current,
      title: current.messages.length === 0 ? chatThreadTitle(question) : current.title,
      updatedAt: new Date().toISOString(),
      messages: [...current.messages, newChatMessage('user', question)],
    }))
    try {
      const { context, skipped } = await vaultRef.current.groundingContext(thread.contextPaths)
      const reply = await askVault({ question, history, context, model })
      const sources = reply.sources.length ? reply.sources : context.map((item) => item.path)
      patchThread(thread.id, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [...current.messages, newChatMessage('assistant', reply.answer, {
          grounded: context.length > 0,
          sources,
        })],
      }))
      if (skipped.length > 0) {
        setError(`有 ${skipped.length} 份所选内容无法读取，已跳过：${skipped.slice(0, 3).join('、')}`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'vault 对话失败。')
    } finally {
      setSending(false)
    }
  }, [model, patchThread])

  const saveAnswer = useCallback(async (message: ChatMessage) => {
    const thread = threadsRef.current.find((item) => item.id === activeRef.current)
    if (!thread) return
    const question = [...thread.messages]
      .reverse()
      .find((item) => item.role === 'user' && item.createdAt <= message.createdAt)?.content || thread.title
    try {
      const path = await vaultRef.current.saveChatAnswer(thread, question, message.content, message.sources || [])
      patchThread(thread.id, (current) => ({
        ...current,
        messages: current.messages.map((item) => (item.id === message.id ? { ...item, savedPath: path } : item)),
      }))
      notify(`已把这条回答存成 vault 笔记：${path}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '存入 vault 失败。')
    }
  }, [notify, patchThread])

  const copyAnswer = useCallback((message: ChatMessage) => {
    void navigator.clipboard?.writeText(message.content).then(() => {
      setCopiedId(message.id)
      window.setTimeout(() => setCopiedId(''), 1500)
    }).catch(() => undefined)
  }, [])

  const toggleContext = useCallback((path: string) => {
    const thread = activeRef.current ? threadsRef.current.find((item) => item.id === activeRef.current) : null
    if (!thread) return
    const target = vault.noteTree
    const isFolder = target.length > 0 && filesUnderPath(target, path).length > 0 && !path.endsWith('.md')
    const next = isFolder ? filesUnderPath(target, path) : [path]
    patchThread(thread.id, (current) => {
      const has = next.every((item) => current.contextPaths.includes(item))
      return {
        ...current,
        contextPaths: has
          ? current.contextPaths.filter((item) => !next.includes(item))
          : [...current.contextPaths, ...next.filter((item) => !current.contextPaths.includes(item))],
      }
    })
  }, [patchThread, vault.noteTree])

  const clearContext = useCallback(() => {
    const id = activeRef.current
    if (!id) return
    patchThread(id, (current) => ({ ...current, contextPaths: [] }))
  }, [patchThread])

  const clearMessages = useCallback(() => {
    const id = activeRef.current
    if (!id) return
    if (!window.confirm('清空这段对话的记录吗？（已存入 vault 的笔记不受影响）')) return
    patchThread(id, (current) => ({ ...current, messages: [], updatedAt: new Date().toISOString() }))
  }, [patchThread])

  const submitRename = useCallback(() => {
    const id = activeRef.current
    const title = renameValue.trim()
    if (id && title) patchThread(id, (current) => ({ ...current, title }))
    setRenaming(false)
  }, [patchThread, renameValue])

  const groundedCount = selectedPaths.length

  return (
    <div
      className="chat-space"
      data-expression-source="chat"
      data-expression-path={activeThread?.id ? `chat:${activeThread.id}` : undefined}
      data-expression-name={activeThread?.title || '自由对话'}
    >
      <SpaceRail active="chat" onSelect={onSwitchSpace} onChooseVault={() => void vault.chooseVault()} />

      {historyOpen && (
        <aside className="thread-column" style={{ width: `${historyWidth}px` }}>
          <header className="thread-column-head">
            <div>
              <span className="right-kicker">CHATS</span>
              <h2>对话记录</h2>
            </div>
            <button type="button" className="tiny-icon" title="新建对话" onClick={() => onCreateThread()}><MessageSquarePlus size={14} /></button>
          </header>
          <ul className="thread-list">
            {threads.map((thread) => (
              <li key={thread.id} className={thread.id === activeThreadId ? 'active' : ''}>
                <button type="button" className="thread-open" title={thread.title} onClick={() => onActivateThread(thread.id)}>
                  <strong>{thread.title}</strong>
                  <span>
                    {thread.messages.length} 条 · {relativeTime(thread.updatedAt)}
                    {thread.contextPaths.length > 0 ? ` · 依据 ${thread.contextPaths.length}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="thread-delete"
                  title="删除这段对话"
                  onClick={() => {
                    if (window.confirm(`删除对话「${thread.title}」？`)) onDeleteThread(thread.id)
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
            {threads.length === 0 && <li className="thread-empty">还没有对话，点右上角新建。</li>}
          </ul>
          <footer className="thread-column-foot">
            <span>{threads.length} 段对话</span>
          </footer>
        </aside>
      )}

      {historyOpen && (
        <Splitter label="调整对话记录宽度" value={historyWidth} min={152} max={420} onDelta={onHistoryWidth} onReset={onHistoryReset} />
      )}

      {pickerOpen && (
        <aside className="picker-column" style={{ width: `${pickerWidth}px` }}>
          <header className="picker-column-head">
            <div>
              <span className="right-kicker">VAULT CONTEXT</span>
              <h2>vault 内容</h2>
            </div>
            <div className="notes-tree-actions">
              <button type="button" className="tiny-icon" title="重新读取 vault" onClick={() => void vault.refresh()}><RefreshCw size={13} /></button>
              <button type="button" className="tiny-icon" title="更换 vault 文件夹" onClick={() => void vault.chooseVault()}><FolderPlus size={13} /></button>
            </div>
          </header>

          {vault.ready ? (
            <>
              <div className="notes-tree-filter">
                <input className="text-field" placeholder="筛选 vault 内容…" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <div className="picker-hint">
                <ShieldCheck size={12} />
                <span>勾选后的内容会作为对话的唯一依据（最多 8 份，每份截取前 6000 字）。</span>
              </div>
              <div className="picker-tree">
                <VaultTree
                  nodes={tree}
                  collapsed={collapsed}
                  onToggleCollapse={(path) => setCollapsed((current) => (
                    current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
                  ))}
                  onOpenFile={(path) => onOpenNote(path)}
                  selectable
                  selected={selectedPaths}
                  onToggleSelect={toggleContext}
                  emptyHint="vault 里还没有 Markdown 笔记。"
                />
              </div>
              <footer className="picker-foot">
                <span>已选 {groundedCount} 份</span>
                {groundedCount > 0 && <button type="button" onClick={clearContext}>清空</button>}
              </footer>
            </>
          ) : (
            <div className="vault-choose compact">
              <FolderPlus size={20} />
              <strong>选择一个 vault</strong>
              <span>选择后即可把笔记勾选为对话依据。</span>
              <button className="primary-button" type="button" onClick={() => void vault.chooseVault()}><FolderPlus size={14} /> 选择文件夹</button>
            </div>
          )}
        </aside>
      )}

      {pickerOpen && (
        <Splitter label="调整 vault 内容选择宽度" value={pickerWidth} min={176} max={520} onDelta={onPickerWidth} onReset={onPickerReset} />
      )}

      <section className="chat-main">
        <header className="chat-main-head">
          <div className="chat-main-title">
            {renaming ? (
              <span className="note-rename-row">
                <input
                  className="text-field"
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitRename()
                    if (event.key === 'Escape') setRenaming(false)
                  }}
                />
                <button type="button" className="tiny-icon" onClick={submitRename}><Check size={13} /></button>
              </span>
            ) : (
              <>
                <h2>{activeThread?.title || '新的对话'}</h2>
                <button
                  type="button"
                  className="tiny-icon"
                  title="重命名这段对话"
                  onClick={() => { setRenameValue(activeThread?.title || ''); setRenaming(true) }}
                >
                  <Pencil size={12} />
                </button>
              </>
            )}
          </div>
          <div className="chat-main-actions">
            <span className={`grounded-badge${groundedCount > 0 ? ' on' : ''}`}>
              {groundedCount > 0 ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
              {groundedCount > 0 ? `严格 grounded · ${groundedCount} 份` : '未限定 vault 内容'}
            </span>
            <button type="button" className="tiny-icon" title="收起对话记录" onClick={() => onToggleColumn('history')}><History size={13} /></button>
            <button type="button" className="tiny-icon" title="收起 vault 内容栏" onClick={() => onToggleColumn('picker')}><Link2 size={13} /></button>
            <button type="button" className="tiny-icon" title="清空当前对话" onClick={clearMessages}><Trash2 size={13} /></button>
            <button type="button" className="tiny-icon" title="新建对话" onClick={() => onCreateThread()}><MessageSquarePlus size={13} /></button>
          </div>
        </header>

        {groundedCount > 0 ? (
          <div className="grounding-bar">
            <span className="grounding-label"><ShieldCheck size={12} /> 本次对话严格依据：</span>
            {selectedPaths.map((path) => (
              <span key={path} className="grounding-chip">
                <button type="button" title={`打开 ${path}`} onClick={() => onOpenNote(path)}>{noteTitleFromPath(path)}</button>
                <button type="button" aria-label={`移除 ${path}`} onClick={() => toggleContext(path)}><X size={10} /></button>
              </span>
            ))}
          </div>
        ) : (
          <div className="grounding-bar off">
            <ShieldOff size={12} />
            <span>未选择 vault 内容：回答来自模型的一般知识，不会被 vault 限定。在左栏勾选笔记即可严格 grounded。</span>
          </div>
        )}

        <div className="vault-chat-scroll">
          {!activeThread && (
            <div className="chat-empty">
              <Sparkles size={22} />
              <strong>开始一段 vault 对话</strong>
              <span>先在左栏勾选笔记，再提问：模型的每一条结论都会标注来源笔记，并拒绝回答笔记里没有的内容。</span>
              <button className="primary-button" type="button" onClick={() => onCreateThread()}><MessageSquarePlus size={14} /> 新建对话</button>
            </div>
          )}

          {activeThread && activeThread.messages.length === 0 && (
            <div className="chat-suggestions">
              {SUGGESTIONS.map((item) => (
                <button key={item} type="button" disabled={sending} onClick={() => void send(item)}>{item}</button>
              ))}
            </div>
          )}

          {activeThread && activeThread.messages.length > 0 && (
            <ul className="vault-chat-messages">
              {activeThread.messages.map((message) => (
                <li key={message.id} className={message.role}>
                  <div className="message-meta">
                    <span>{message.role === 'user' ? '我' : model}</span>
                    {message.role === 'assistant' && (
                      message.grounded === true
                        ? <span className="message-grounded on"><ShieldCheck size={10} /> grounded</span>
                        : <span className="message-grounded"><ShieldOff size={10} /> 未限定</span>
                    )}
                    <span className="message-time">{relativeTime(message.createdAt)}</span>
                  </div>
                  <p className="message-body">{message.content}</p>
                  {message.role === 'assistant' && (message.sources?.length || 0) > 0 && (
                    <div className="message-sources">
                      <span>依据：</span>
                      {message.sources?.map((path) => (
                        <button key={path} type="button" title={`打开 ${path}`} onClick={() => onOpenNote(path)}>{noteTitleFromPath(path)}</button>
                      ))}
                    </div>
                  )}
                  {message.role === 'assistant' && (
                    <div className="message-actions">
                      {message.savedPath ? (
                        <button type="button" className="saved" onClick={() => onOpenNote(message.savedPath!)}>
                          <Check size={11} /> 已存入 {noteTitleFromPath(message.savedPath)}
                        </button>
                      ) : (
                        <button type="button" onClick={() => void saveAnswer(message)}><FilePlus2 size={11} /> 存为 vault 笔记</button>
                      )}
                      <button type="button" onClick={() => copyAnswer(message)}>
                        {copiedId === message.id ? <><Check size={11} /> 已复制</> : <><Copy size={11} /> 复制</>}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {sending && <p className="chat-typing">正在读取所选 vault 内容并作答…</p>}
          {error && <p className="api-config-message error" role="status">{error}</p>}
          {flash && <p className="api-config-message success" role="status">{flash}</p>}
        </div>

        <div className="vault-chat-input">
          <textarea
            value={draft}
            placeholder={groundedCount > 0 ? `基于所选的 ${groundedCount} 份笔记提问…` : '提问（或先在左栏勾选 vault 内容）'}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button type="button" disabled={sending || !draft.trim() || !activeThread} onClick={() => void send()}>
            <Send size={15} />
          </button>
        </div>
        <p className="chat-hint">Enter 发送 · Shift+Enter 换行 · 回答可一键存成 vault 笔记（{vault.rootName}）</p>
      </section>

      {(!historyOpen || !pickerOpen) && (
        <div className="chat-column-handles">
          {!historyOpen && <button type="button" onClick={() => onToggleColumn('history')} title="展开对话记录栏"><History size={13} /> 对话记录</button>}
          {!pickerOpen && <button type="button" onClick={() => onToggleColumn('picker')} title="展开 vault 内容栏"><Link2 size={13} /> vault 内容</button>}
        </div>
      )}
    </div>
  )
}
