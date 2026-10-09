import { useState } from 'react'
import { Check, FilePlus2, Send, Sparkles, StickyNote } from 'lucide-react'
import MarkdownPreview from './MarkdownPreview'
import SenseCard from './SenseCard'
import type { ChatMessage, SensePayload } from '../types'

interface ChatPanelProps {
  sense: SensePayload | null
  model: string
  messages: ChatMessage[]
  sending: boolean
  error: string
  savedMessageIds: ReadonlySet<string>
  onSend: (question: string) => void
  onSaveExcerpt: (message: ChatMessage) => void
  onSaveReaderMessage: (message: ChatMessage) => void
  onOpenSavedAnswer: (path: string) => void
  vaultReady: boolean
  vaultBusy: boolean
  onOpenNotebook: () => void
}

const SUGGESTIONS = [
  '在写作里怎么自然地用它？',
  '和近义词比，什么时候用它更好？',
  '给我两个更口语的替代表达',
]

export default function ChatPanel({
  sense, model, messages, sending, error, savedMessageIds, onSend, onSaveExcerpt,
  onSaveReaderMessage, onOpenSavedAnswer, vaultReady, vaultBusy, onOpenNotebook,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const savedCount = messages.filter((message) => savedMessageIds.has(message.id)).length

  function submit(question: string) {
    const value = question.trim()
    if (!value || sending || !sense) return
    onSend(value)
    setDraft('')
  }

  return (
    <div className="chat-panel">
      {sense ? (
        <>
          <div className="chat-fixed-label">
            <span><Sparkles size={11} /> 本次语义 · 对话的固定首条输出</span>
          </div>
          <SenseCard sense={sense} model={model} compact />
        </>
      ) : (
        <p className="sense-plain">先在正文里选中一个词，得到上下文语义后即可开始对话。</p>
      )}

      {messages.length > 0 && (
        <ul className="chat-messages">
          {messages.map((message) => {
            const saved = savedMessageIds.has(message.id)
            return (
              <li key={message.id} className={message.role}>
                <MarkdownPreview markdown={message.content} className="message-body" />
                <button
                  type="button"
                  className={saved ? 'saved' : ''}
                  title={saved ? '这条消息已存入记录本' : '把这条内容存成笔记'}
                  disabled={saved}
                  onClick={() => onSaveExcerpt(message)}
                >
                  {saved ? <><Check size={11} /> 已存笔记</> : <><StickyNote size={11} /> 存为笔记</>}
                </button>
                {message.role === 'assistant' && (message.savedPath ? (
                  <button type="button" className="saved" onClick={() => onOpenSavedAnswer(message.savedPath!)}>
                    <Check size={11} /> 已存入 inbox · 打开
                  </button>
                ) : (
                  <button type="button" disabled={!vaultReady || vaultBusy} onClick={() => onSaveReaderMessage(message)}>
                    <FilePlus2 size={11} /> 存入 inbox
                  </button>
                ))}
              </li>
            )
          })}
        </ul>
      )}

      {savedCount > 0 && (
        <div className="chat-save-feedback" role="status">
          <Check size={12} />
          <span>{savedCount} 条对话内容已保存到记录本</span>
          <button type="button" onClick={onOpenNotebook}>查看记录本</button>
        </div>
      )}

      {sending && <p className="chat-typing">正在思考…</p>}
      {error && <p className="api-config-message error" role="status">{error}</p>}

      {sense && messages.length === 0 && !sending && (
        <div className="chat-suggestions">
          {SUGGESTIONS.map((item) => (
            <button key={item} type="button" onClick={() => submit(item)}>{item}</button>
          ))}
        </div>
      )}

      <div className="chat-input">
        <textarea
          value={draft}
          placeholder={sense ? '围绕这条语义继续提问…' : '先选中一个词'}
          disabled={!sense || sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit(draft)
            }
          }}
        />
        <button type="button" disabled={!sense || sending || !draft.trim()} onClick={() => submit(draft)}>
          <Send size={14} />
        </button>
      </div>
      <p className="chat-hint">Enter 发送 · Shift+Enter 换行 · 对话内容可存成带日期编号的笔记</p>
    </div>
  )
}
