import { useState } from 'react'
import { Send, Sparkles, StickyNote } from 'lucide-react'
import SenseCard from './SenseCard'
import type { ChatMessage, SensePayload } from '../types'

interface ChatPanelProps {
  sense: SensePayload | null
  model: string
  messages: ChatMessage[]
  sending: boolean
  error: string
  onSend: (question: string) => void
  onSaveExcerpt: (message: ChatMessage) => void
}

const SUGGESTIONS = [
  '在写作里怎么自然地用它？',
  '和近义词比，什么时候用它更好？',
  '给我两个更口语的替代表达',
]

export default function ChatPanel({
  sense, model, messages, sending, error, onSend, onSaveExcerpt,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('')

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
          <div className="chat-fixed-label"><Sparkles size={11} /> 本次义项 · 对话的固定首条输出</div>
          <SenseCard sense={sense} model={model} compact />
        </>
      ) : (
        <p className="sense-plain">先在正文里选中一个词，得到上下文义项后即可开始对话。</p>
      )}

      {messages.length > 0 && (
        <ul className="chat-messages">
          {messages.map((message) => (
            <li key={message.id} className={message.role}>
              <p>{message.content}</p>
              <button type="button" title="把这条内容存成笔记" onClick={() => onSaveExcerpt(message)}>
                <StickyNote size={11} /> 存为笔记
              </button>
            </li>
          ))}
        </ul>
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
          placeholder={sense ? '围绕这条义项继续提问…' : '先选中一个词'}
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
