import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, Bookmark, ChevronDown, ChevronLeft, ChevronRight, FilePlus2, FileText,
  FolderOpen, KeyRound, Languages, Minus, PanelLeftClose, PanelRightClose, Plus, RotateCcw,
  Settings2, StickyNote, Trash2, X,
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PDFPage from './components/PDFPage'
import PDFThumbnail from './components/PDFThumbnail'
import SenseCard from './components/SenseCard'
import NotebookPanel from './components/NotebookPanel'
import ChatPanel from './components/ChatPanel'
import { openPdf } from './lib/pdf'
import {
  getApiConfigStatus, protocolForBaseUrl, removeApiKey, saveApiKey, translateSelection,
} from './lib/translation'
import type { ApiConfigStatus } from './lib/translation'
import { askSense, expandSenses, lookupSense, sentenceAround, termFromSelection } from './lib/sense'
import {
  createNote, loadAtoms, loadChat, loadNotes, relateSense, saveAtoms, saveChat, saveNotes,
  senseKeyOf, toAtom,
} from './lib/notebook'
import type {
  ChatMessage, NotebookNote, SenseAtom, SensePayload, SenseSummary, TextSelection, TranslateMode,
} from './types'

interface OutlineItem {
  title: string
  dest: unknown
  items?: OutlineItem[]
}

interface AnchorPoint { x: number; y: number }

type RightTab = 'sense' | 'notebook' | 'chat'

// Bumped so a previously stored model name cannot keep overriding the default.
const MODEL_KEY = 'paperlight-model-v2'
const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_API_BASE_URL = 'https://api.deepseek.com'
const API_PRESETS: Array<{ label: string; baseUrl: string; model?: string }> = [
  { label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  { label: 'ZJUAI 网关', baseUrl: 'https://api.zjuailab.club' },
]

function tidyText(value: string) {
  return value.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

function newMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, content, createdAt: new Date().toISOString() }
}

function App() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [fileName, setFileName] = useState('')
  const [pageCount, setPageCount] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const [basePageWidth, setBasePageWidth] = useState(612)
  const [viewportWidth, setViewportWidth] = useState(900)
  const [zoom, setZoom] = useState(1)
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [leftTab, setLeftTab] = useState<'pages' | 'outline'>('pages')
  const [rightTab, setRightTab] = useState<RightTab>('sense')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [anchor, setAnchor] = useState<AnchorPoint | null>(null)
  const [mode, setMode] = useState<TranslateMode>(() => localStorage.getItem('paperlight-mode') === 'openai' ? 'openai' : 'mock')
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [apiConfig, setApiConfig] = useState<ApiConfigStatus | null>(null)
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiConfigLoading, setApiConfigLoading] = useState(false)
  const [apiConfigMessage, setApiConfigMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [pageInput, setPageInput] = useState('1')

  // Sense lookup
  const [queryTerm, setQueryTerm] = useState('')
  const [sense, setSense] = useState<SensePayload | null>(null)
  const [senseLoading, setSenseLoading] = useState(false)
  const [senseError, setSenseError] = useState('')
  const [allSenses, setAllSenses] = useState<SenseSummary[] | null>(null)
  const [expanding, setExpanding] = useState(false)

  // Notebook + agent conversation
  const [atoms, setAtoms] = useState<SenseAtom[]>(loadAtoms)
  const [notebookNotes, setNotebookNotes] = useState<NotebookNote[]>(loadNotes)
  const [activeAtomId, setActiveAtomId] = useState<string | null>(null)
  const [chat, setChat] = useState<Record<string, ChatMessage[]>>(loadChat)
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState('')

  // Sentence translation kept from the original reader
  const [translation, setTranslation] = useState('')
  const [translationLoading, setTranslationLoading] = useState(false)
  const [translationError, setTranslationError] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const translationRequestRef = useRef(0)
  const senseRequestRef = useRef(0)
  const lastContextRef = useRef('')
  const scale = useMemo(() => Math.max(0.25, ((viewportWidth - 92) / basePageWidth) * zoom), [basePageWidth, viewportWidth, zoom])

  const senseId = sense ? senseKeyOf(sense) : null
  const senseInNotebook = Boolean(senseId && atoms.some((atom) => atom.id === senseId))
  const relations = useMemo(() => (sense ? relateSense(sense, atoms) : []), [sense, atoms])
  const chatMessages = senseId ? chat[senseId] || [] : []
  const savedMessageIds = useMemo(() => new Set(
    notebookNotes.map((note) => note.sourceMessageId).filter((id): id is string => Boolean(id)),
  ), [notebookNotes])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth))
    observer.observe(element)
    setViewportWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { localStorage.setItem('paperlight-mode', mode) }, [mode])
  useEffect(() => { localStorage.setItem(MODEL_KEY, model) }, [model])
  useEffect(() => { saveAtoms(atoms) }, [atoms])
  useEffect(() => { saveNotes(notebookNotes) }, [notebookNotes])
  useEffect(() => { saveChat(chat) }, [chat])

  useEffect(() => {
    if (!settingsOpen || mode !== 'openai') return
    let cancelled = false
    setApiConfigLoading(true)
    setApiConfigMessage(null)
    void getApiConfigStatus()
      .then((status) => {
        if (!cancelled) {
          setApiConfig(status)
          if (status.source) setApiBaseUrl(status.baseUrl)
        }
      })
      .catch((error) => {
        if (!cancelled) setApiConfigMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : '无法读取 API 配置状态。',
        })
      })
      .finally(() => { if (!cancelled) setApiConfigLoading(false) })
    return () => { cancelled = true }
  }, [mode, settingsOpen])

  async function configureApiKey() {
    if (!apiConfig || !apiBaseUrl.trim() || !apiKeyInput.trim()) return
    setApiConfigLoading(true)
    setApiConfigMessage(null)
    try {
      const status = await saveApiKey(apiKeyInput.trim(), apiBaseUrl.trim(), apiConfig.csrfNonce)
      setApiConfig(status)
      setApiBaseUrl(status.baseUrl)
      setApiKeyInput('')
      setApiConfigMessage({ kind: 'success', text: 'API 地址和密钥已安全保存，可以直接使用。' })
    } catch (error) {
      setApiConfigMessage({ kind: 'error', text: error instanceof Error ? error.message : '无法保存 API 密钥。' })
    } finally {
      setApiConfigLoading(false)
    }
  }

  async function deleteApiKey() {
    if (!apiConfig || apiConfig.source !== 'local-file') return
    if (!window.confirm('确定要移除本机保存的 API 密钥吗？')) return
    setApiConfigLoading(true)
    setApiConfigMessage(null)
    try {
      const status = await removeApiKey(apiConfig.csrfNonce)
      setApiConfig(status)
      setApiKeyInput('')
      setApiConfigMessage({ kind: 'success', text: '本机保存的 API 密钥已移除。' })
    } catch (error) {
      setApiConfigMessage({ kind: 'error', text: error instanceof Error ? error.message : '无法移除 API 密钥。' })
    } finally {
      setApiConfigLoading(false)
    }
  }

  const openFile = useCallback(async (file?: File) => {
    if (!file) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      window.alert('请选择 PDF 文件。')
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const document = await openPdf(bytes)
      const firstPage = await document.getPage(1)
      const [items] = await Promise.all([document.getOutline()])
      setPdf(document)
      setFileName(file.name)
      setPageCount(document.numPages)
      setPageNumber(1)
      setPageInput('1')
      setBasePageWidth(firstPage.getViewport({ scale: 1 }).width)
      setOutline((items || []) as OutlineItem[])
      setSelection(null)
      setSense(null)
      setSenseError('')
      setAllSenses(null)
      setQueryTerm('')
      setAnchor(null)
      setZoom(1)
      scrollRef.current?.scrollTo({ top: 0 })
    } catch (error) {
      console.error('PDF could not be opened', error)
      window.alert('无法读取这个 PDF。文件可能已损坏或受到密码保护。')
    }
  }, [])

  const chooseFile = () => fileInputRef.current?.click()

  const scrollToPage = useCallback((number: number) => {
    const target = Math.min(pageCount, Math.max(1, number))
    document.querySelector(`[data-page-number="${target}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setPageNumber(target)
    setPageInput(String(target))
  }, [pageCount])

  const onPageVisible = useCallback((number: number) => {
    setPageNumber(number)
    setPageInput(String(number))
  }, [])

  const runTranslation = useCallback(async (next: TextSelection, requestedMode = mode, requestedModel = model) => {
    const requestId = ++translationRequestRef.current
    setTranslationLoading(true)
    setTranslationError('')
    try {
      const result = await translateSelection(next, requestedMode, requestedModel)
      if (requestId === translationRequestRef.current) setTranslation(result)
    } catch (error) {
      if (requestId === translationRequestRef.current) {
        setTranslationError(error instanceof Error ? error.message : '翻译失败，请稍后重试。')
      }
    } finally {
      if (requestId === translationRequestRef.current) setTranslationLoading(false)
    }
  }, [mode, model])

  const runSenseLookup = useCallback(async (term: string, context: string) => {
    const cleaned = term.trim()
    if (!cleaned) return
    const requestId = ++senseRequestRef.current
    lastContextRef.current = context
    setSenseLoading(true)
    setSenseError('')
    setAllSenses(null)
    setChatError('')
    try {
      const result = await lookupSense(cleaned, context, model)
      if (requestId !== senseRequestRef.current) return
      setSense({
        ...result,
        term: result.term || cleaned,
        lemma: result.lemma || cleaned,
        examples: Array.isArray(result.examples) ? result.examples : [],
      })
      setRightTab('sense')
    } catch (error) {
      if (requestId === senseRequestRef.current) {
        setSenseError(error instanceof Error ? error.message : '义项查询失败。')
      }
    } finally {
      if (requestId === senseRequestRef.current) setSenseLoading(false)
    }
  }, [model])

  const selectText = useCallback(() => {
    const browserSelection = window.getSelection()
    const rawText = browserSelection?.toString() || ''
    const text = tidyText(rawText)
    if (text.length < 2 || !browserSelection || browserSelection.rangeCount === 0) return
    const range = browserSelection.getRangeAt(0)
    const startNode = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    const pageElement = startNode?.closest<HTMLElement>('.pdf-page-shell')
    if (!pageElement) return
    const pageLayer = pageElement.querySelector('.textLayer')
    const pageText = tidyText(pageLayer?.textContent || '')
    const index = pageText.indexOf(text)
    const rect = range.getBoundingClientRect()
    const next: TextSelection = {
      text,
      before: index >= 0 ? pageText.slice(Math.max(0, index - 500), index) : '',
      after: index >= 0 ? pageText.slice(index + text.length, index + text.length + 500) : '',
      pageNumber: Number(pageElement.dataset.pageNumber || 1),
    }
    setSelection(next)
    setTranslation('')
    setTranslationError('')
    setRightOpen(true)
    setRightTab('sense')
    setAnchor({
      x: Math.max(174, Math.min(window.innerWidth - 174, rect.left + rect.width / 2)),
      y: Math.max(82, rect.top - 12),
    })
    const term = termFromSelection(text)
    setQueryTerm(term)
    void runSenseLookup(term, sentenceAround(pageText, index, text.length))
  }, [runSenseLookup])

  function addCurrentSense() {
    if (!sense) return
    const atom = toAtom(sense, model)
    setAtoms((current) => (current.some((item) => item.id === atom.id) ? current : [atom, ...current]))
    setActiveAtomId(atom.id)
  }

  async function expandCurrent() {
    const term = (sense?.lemma || queryTerm).trim()
    if (!term || expanding) return
    setExpanding(true)
    setSenseError('')
    try {
      setAllSenses(await expandSenses(term, model))
    } catch (error) {
      setSenseError(error instanceof Error ? error.message : '无法获取完整义项。')
    } finally {
      setExpanding(false)
    }
  }

  function pushChat(message: ChatMessage) {
    if (!senseId) return
    setChat((current) => ({ ...current, [senseId]: [...(current[senseId] || []), message] }))
  }

  async function sendChat(question: string) {
    if (!sense || !senseId) return
    const history = (chat[senseId] || []).slice(-8).map((message) => ({ role: message.role, content: message.content }))
    pushChat(newMessage('user', question))
    setChatSending(true)
    setChatError('')
    try {
      const answer = await askSense({
        term: sense.term || sense.lemma,
        sense: { contextualMeaning: sense.contextualMeaning, definition: sense.definition },
        question,
        history,
        model,
      })
      pushChat(newMessage('assistant', answer))
    } catch (error) {
      setChatError(error instanceof Error ? error.message : '对话失败，请重试。')
    } finally {
      setChatSending(false)
    }
  }

  // Saving any excerpt also stores the term ↔ sense atom so the link resolves.
  function saveExcerpt(body: string, sourceMessageId?: string) {
    if (!sense || (sourceMessageId && savedMessageIds.has(sourceMessageId))) return
    const atom = toAtom(sense, model)
    const note = createNote(body, [atom.id], new Date(), sourceMessageId)
    setAtoms((current) => (current.some((item) => item.id === atom.id) ? current : [atom, ...current]))
    setNotebookNotes((current) => [note, ...current])
  }

  function addNoteToActiveAtom(body: string) {
    if (!activeAtomId) return
    const note = createNote(body, [activeAtomId])
    setNotebookNotes((current) => [note, ...current])
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        chooseFile()
      } else if ((event.metaKey || event.ctrlKey) && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        setZoom((value) => Math.min(2, value + 0.1))
      } else if ((event.metaKey || event.ctrlKey) && event.key === '-') {
        event.preventDefault()
        setZoom((value) => Math.max(0.5, value - 0.1))
      } else if (event.key === 'Escape') {
        setAnchor(null)
        setSettingsOpen(false)
      } else if (!editing && event.key === 'ArrowRight' && pdf) {
        scrollToPage(pageNumber + 1)
      } else if (!editing && event.key === 'ArrowLeft' && pdf) {
        scrollToPage(pageNumber - 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pageNumber, pdf, scrollToPage])

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    setDragActive(false)
    void openFile(event.dataTransfer.files[0])
  }

  const flattenOutline = (items: OutlineItem[], depth = 0): Array<{ item: OutlineItem; depth: number }> =>
    items.flatMap((item) => [{ item, depth }, ...flattenOutline(item.items || [], depth + 1)])

  return (
    <main className="app-shell" onDragOver={(event) => { event.preventDefault(); setDragActive(true) }} onDragLeave={(event) => {
      if (event.target === event.currentTarget) setDragActive(false)
    }} onDrop={handleDrop}>
      <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={(event) => void openFile(event.target.files?.[0])} />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><BookOpen size={17} strokeWidth={1.8} /></div>
          <div className="brand-name">paperlight<span>PDF</span></div>
          <span className="topbar-divider" />
          {fileName ? <div className="document-title"><FileText size={15} /> <span>{fileName}</span></div> : <div className="document-title muted-title">轻盈阅读，随选随译</div>}
        </div>
        <div className="topbar-actions">
          <button className="icon-button" title={leftOpen ? '收起缩略图' : '展开缩略图'} onClick={() => setLeftOpen((value) => !value)}><PanelLeftClose size={17} /></button>
          <button className="icon-button" title="打开 PDF（⌘/Ctrl + O）" onClick={chooseFile}><FolderOpen size={17} /></button>
          <button className={`provider-pill ${mode === 'openai' ? 'provider-openai' : ''}`} onClick={() => setSettingsOpen((value) => !value)} title="翻译设置">
            <span className={`provider-dot ${mode}`} />{mode === 'mock' ? '模拟翻译' : '兼容 API'}<ChevronDown size={13} />
          </button>
          <button className="icon-button" title={rightOpen ? '收起侧栏' : '展开侧栏'} onClick={() => setRightOpen((value) => !value)}><PanelRightClose size={17} /></button>
          <button className="icon-button" title="设置" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={17} /></button>
        </div>
      </header>

      {settingsOpen && <div className="settings-popover">
        <div className="settings-heading"><div><strong>翻译设置</strong><p>选择翻译服务</p></div><button className="tiny-icon" onClick={() => setSettingsOpen(false)}><X size={15} /></button></div>
        <label className="field-label" htmlFor="provider-mode">翻译方式</label>
        <select id="provider-mode" className="select-field" value={mode} onChange={(event) => {
          const nextMode = event.target.value as TranslateMode
          setMode(nextMode)
          if (selection) void runTranslation(selection, nextMode)
        }}>
          <option value="mock">模拟模式 · 无需密钥</option>
          <option value="openai">OpenAI 兼容 API</option>
        </select>
        {mode === 'openai' ? <>
          <div className={`api-config-status${apiConfig?.configured ? ' configured' : ''}`}>
            <span className="api-status-dot" />
            <div>
              <strong>{apiConfigLoading && !apiConfig ? '正在检查配置…' : apiConfig?.configured ? 'API 已配置' : '尚未配置 API'}</strong>
              <span>{apiConfig?.source === 'environment' ? '由启动环境提供' : apiConfig?.source === 'local-file' ? '安全保存在本机 .env.local' : '输入密钥后即可使用真实翻译'}{` · ${protocolForBaseUrl(apiBaseUrl) === 'chat-completions' ? 'Chat Completions' : 'Responses'}`}</span>
            </div>
          </div>
          {apiConfig?.source !== 'environment' && <>
            <div className="api-preset-row">
              {API_PRESETS.map((preset) => (
                <button
                  key={preset.baseUrl}
                  type="button"
                  className={`api-preset-button${apiBaseUrl === preset.baseUrl ? ' selected' : ''}`}
                  onClick={() => {
                    setApiBaseUrl(preset.baseUrl)
                    if (preset.model) setModel(preset.model)
                    setApiConfigMessage(null)
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="field-label model-label" htmlFor="api-base-url">API Base URL</label>
            <input
              id="api-base-url"
              className="text-field"
              type="url"
              spellCheck={false}
              value={apiBaseUrl}
              placeholder="https://api.example.com"
              onChange={(event) => setApiBaseUrl(event.target.value)}
            />
            <label className="field-label model-label" htmlFor="openai-api-key">API 密钥</label>
            <div className="api-key-input-wrap">
              <KeyRound size={13} />
              <input
                id="openai-api-key"
                className="text-field api-key-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKeyInput}
                placeholder={apiConfig?.configured ? '输入新密钥以替换' : 'sk-…'}
                onChange={(event) => setApiKeyInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void configureApiKey() }}
              />
            </div>
            <div className="api-config-actions">
              {apiConfig?.source === 'local-file' && <button className="api-remove-button" type="button" disabled={apiConfigLoading} onClick={() => void deleteApiKey()} title="移除已保存的 API 密钥"><Trash2 size={13} /> 移除</button>}
              <button className="api-save-button" type="button" disabled={apiConfigLoading || !apiConfig || !apiBaseUrl.trim() || !apiKeyInput.trim()} onClick={() => void configureApiKey()}><KeyRound size={13} /> {apiConfig?.configured ? '更新配置' : '保存配置'}</button>
            </div>
          </>}
          {apiConfigMessage && <p className={`api-config-message ${apiConfigMessage.kind}`} role="status">{apiConfigMessage.text}</p>}
          <p className="settings-hint">{apiConfig?.source === 'environment' ? <>密钥由启动环境管理，页面不会读取、显示或覆盖它。</> : <>密钥仅写入本机 <code>.env.local</code>，不会保存在浏览器、显示在页面或打包进应用。</>}</p>
          <label className="field-label model-label" htmlFor="model-name">模型名称</label>
          <input id="model-name" className="text-field" value={model} onChange={(event) => setModel(event.target.value)} />
        </> : <p className="settings-hint">模拟模式只影响整句翻译；义项查询、例句与对话始终使用已配置的 API。</p>}
      </div>}

      <div className={`workspace${dragActive ? ' drag-active' : ''}`}>
        {leftOpen && <aside className="left-sidebar">
          <div className="sidebar-tabs">
            <button className={leftTab === 'pages' ? 'selected' : ''} onClick={() => setLeftTab('pages')}>页面</button>
            <button className={leftTab === 'outline' ? 'selected' : ''} onClick={() => setLeftTab('outline')}>目录</button>
          </div>
          {!pdf ? <div className="sidebar-empty"><span className="sidebar-empty-icon"><FileText size={19} /></span><span>打开 PDF 后<br />在这里浏览页面</span></div> : leftTab === 'pages' ?
            <div className="thumbnail-list">{Array.from({ length: pageCount }, (_, index) => <PDFThumbnail key={index + 1} pdf={pdf} pageNumber={index + 1} active={pageNumber === index + 1} onClick={() => scrollToPage(index + 1)} />)}</div> :
            <div className="outline-list">
              {flattenOutline(outline).map(({ item, depth }, index) => <button key={`${item.title}-${index}`} className="outline-entry" style={{ paddingLeft: `${15 + depth * 13}px` }} onClick={async () => {
                if (!pdf || !item.dest) return
                try {
                  const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest
                  const reference = Array.isArray(destination) ? destination[0] : null
                  if (!reference) return
                  const pageIndex = await pdf.getPageIndex(reference as never)
                  scrollToPage(pageIndex + 1)
                } catch { /* Some PDFs contain incomplete outline destinations. */ }
              }}><ChevronRight size={12} /><span>{item.title}</span></button>)}
              {outline.length === 0 && <div className="outline-empty">此 PDF 没有目录</div>}
            </div>}
          <div className="sidebar-footer">{pdf ? `${pageCount} 页` : 'PDF 阅读器'}</div>
        </aside>}

        <section className="reader-column">
          {pdf && <div className="reader-toolbar">
            <div className="page-navigation">
              <button className="toolbar-button" title="上一页（←）" disabled={pageNumber <= 1} onClick={() => scrollToPage(pageNumber - 1)}><ChevronLeft size={17} /></button>
              <input className="page-number-input" aria-label="页码" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') scrollToPage(Number(pageInput) || 1)
              }} onBlur={() => setPageInput(String(pageNumber))} />
              <span className="page-total">/ {pageCount}</span>
              <button className="toolbar-button" title="下一页（→）" disabled={pageNumber >= pageCount} onClick={() => scrollToPage(pageNumber + 1)}><ChevronRight size={17} /></button>
            </div>
            <div className="zoom-controls">
              <button className="toolbar-button" title="缩小（⌘/Ctrl + -）" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))}><Minus size={15} /></button>
              <span className="zoom-label">{Math.round(zoom * 100)}%</span>
              <button className="toolbar-button" title="放大（⌘/Ctrl + +）" onClick={() => setZoom((value) => Math.min(2, Number((value + 0.1).toFixed(2))))}><Plus size={15} /></button>
              <span className="toolbar-separator" />
              <button className="toolbar-button fit-button" title="适合页面宽度" onClick={() => setZoom(1)}><RotateCcw size={14} /><span>适宽</span></button>
            </div>
          </div>}

          <div className={`reader-scroll${pdf ? '' : ' welcome-scroll'}`} ref={scrollRef} onMouseUp={selectText} onKeyUp={(event) => {
            if (event.key.startsWith('Arrow') || event.key === 'Shift') selectText()
          }} onScroll={() => setAnchor(null)}>
            {pdf ? <div className="pages-stack">{Array.from({ length: pageCount }, (_, index) =>
              <PDFPage key={`${fileName}-${index + 1}`} pdf={pdf} pageNumber={index + 1} scale={scale} onVisible={onPageVisible} />,
            )}</div> : <div className="welcome-card">
              <div className="welcome-art">
                <div className="art-shadow" />
                <div className="art-page art-page-back"><i /><i /><i /></div>
                <div className="art-page art-page-front"><div className="art-page-kicker">READ · UNDERSTAND</div><div className="art-page-title">Ideas travel<br />through words.</div><div className="art-page-line" /><div className="art-page-text">A little help, right where<br />you need it.</div><div className="art-page-mark"><Languages size={21} /></div></div>
                <div className="art-translate"><span>selected text</span><div>Ideas travel through words.</div><b>思想借由文字传递。</b></div>
                <span className="art-sparkle sparkle-one">✳</span><span className="art-sparkle sparkle-two">✦</span>
              </div>
              <span className="eyebrow">PAPERLIGHT PDF</span>
              <h1>让阅读与理解，<br /><em>自然地发生。</em></h1>
              <p className="welcome-copy">打开一份英文 PDF。选中任何句子，<br />中文翻译就在眼前。</p>
              <button className="primary-button" onClick={chooseFile}><FolderOpen size={17} /> 打开 PDF <span>⌘ O</span></button>
              <div className="drop-hint">也可以将 PDF 拖到这里</div>
              <div className="welcome-divider" />
              <div className="feature-row"><div><span><Languages size={15} /></span><b>随选随译</b><small>保留原文上下文</small></div><div><span><StickyNote size={15} /></span><b>摘录笔记</b><small>本地自动保存</small></div><div><span><BookOpen size={15} /></span><b>专注阅读</b><small>简洁双栏布局</small></div></div>
            </div>}
          </div>
          {dragActive && <div className="drop-overlay"><div><FilePlus2 size={27} /><strong>松开即可打开 PDF</strong><span>文件只在此设备的浏览器中读取</span></div></div>}
        </section>

        {rightOpen && <aside className="right-sidebar">
          <div className="right-heading"><div><span className="right-kicker">READING DESK</span><h2>阅读助手</h2></div><button className="tiny-icon" title="收起侧栏" onClick={() => setRightOpen(false)}><X size={16} /></button></div>
          <div className="right-tabs">
            <button className={rightTab === 'sense' ? 'selected' : ''} onClick={() => setRightTab('sense')}><Languages size={14} /> 义项</button>
            <button className={rightTab === 'notebook' ? 'selected' : ''} onClick={() => setRightTab('notebook')}><StickyNote size={14} /> 记录本{atoms.length > 0 && <span className="notes-count">{atoms.length}</span>}</button>
            <button className={rightTab === 'chat' ? 'selected' : ''} onClick={() => setRightTab('chat')}><BookOpen size={14} /> 对话{chatMessages.length > 0 && <span className="notes-count">{chatMessages.length}</span>}</button>
          </div>

          {rightTab === 'sense' && <div className="translation-panel">
            <div className="query-row">
              <label className="field-label" htmlFor="query-term">查询词（可键盘修改）</label>
              <div className="query-input-wrap">
                <input
                  id="query-term"
                  className="text-field"
                  value={queryTerm}
                  spellCheck={false}
                  placeholder="如 within"
                  onChange={(event) => setQueryTerm(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void runSenseLookup(queryTerm, lastContextRef.current)
                  }}
                />
                <button
                  type="button"
                  className="query-go"
                  disabled={senseLoading || !queryTerm.trim()}
                  onClick={() => void runSenseLookup(queryTerm, lastContextRef.current)}
                >
                  查询
                </button>
              </div>
              {selection && <span className="query-meta">来自第 {selection.pageNumber} 页的选区 · Enter 重新查询</span>}
            </div>

            {senseLoading && <div className="loading-copy"><span className="mini-spinner" /> 正在结合上下文判断义项…</div>}

            {senseError && !senseLoading && (
              <div className="panel-error">
                <p>{senseError}</p>
                <button className="text-action" type="button" onClick={() => void runSenseLookup(queryTerm || sense?.term || '', lastContextRef.current)}>重试</button>
              </div>
            )}

            {sense && !senseLoading && (
              <>
                <SenseCard
                  sense={sense}
                  model={model}
                  added={senseInNotebook}
                  relations={relations}
                  onAdd={addCurrentSense}
                  onJumpToAtom={(id) => { setActiveAtomId(id); setRightTab('notebook') }}
                />

                <div className="sense-actions">
                  <button className="text-action" type="button" disabled={expanding} onClick={() => void expandCurrent()}>
                    {expanding ? '正在获取…' : allSenses ? '重新获取完整义项' : '查看完整词典义项'}
                  </button>
                  <button className="text-action" type="button" onClick={() => setRightTab('chat')}>继续和 Agent 对话</button>
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
                    : selection ? <button className="text-action" type="button" onClick={() => void runTranslation(selection)}>翻译选中内容</button>
                    : <p className="sense-plain">先在正文中选中文字。</p>}
                </details>

                <button className="save-note-button" type="button" onClick={() => saveExcerpt(`${sense.term}（${sense.contextualMeaning}）`)}>
                  <Bookmark size={15} /> 把这条义项存成笔记
                </button>
              </>
            )}

            {!sense && !senseLoading && !senseError && (
              <div className="translation-empty">
                <div><Languages size={20} /></div>
                <strong>选中一个词</strong>
                <span>会结合上下文给出准确的义项、例句、<br />使用建议与词根词缀分析。</span>
              </div>
            )}
          </div>}

          {rightTab === 'notebook' && <NotebookPanel
            atoms={atoms}
            notes={notebookNotes}
            activeAtomId={activeAtomId}
            model={model}
            onSelectAtom={setActiveAtomId}
            onDeleteAtom={(id) => {
              setAtoms((current) => current.filter((atom) => atom.id !== id))
              setNotebookNotes((current) => current.map((note) => ({ ...note, senseIds: note.senseIds.filter((senseId) => senseId !== id) })))
              setActiveAtomId(null)
            }}
            onAddNote={addNoteToActiveAtom}
            onDeleteNote={(id) => setNotebookNotes((current) => current.filter((note) => note.id !== id))}
          />}

          {rightTab === 'chat' && <ChatPanel
            sense={sense}
            model={model}
            messages={chatMessages}
            sending={chatSending}
            error={chatError}
            savedMessageIds={savedMessageIds}
            onSend={(question) => void sendChat(question)}
            onSaveExcerpt={(message) => saveExcerpt(message.content, message.id)}
            onOpenNotebook={() => {
              setActiveAtomId(senseId)
              setRightTab('notebook')
            }}
          />}
        </aside>}
      </div>

      {anchor && senseLoading && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot openai" />上下文义项<span className="popover-page">{selection ? `P.${selection.pageNumber}` : ''}</span></div>
        <div className="popover-loading"><span className="mini-spinner" /> 正在判断义项…</div>
        <button className="popover-close" aria-label="关闭浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}

      {anchor && !senseLoading && sense && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot openai" />上下文义项{sense.partOfSpeech ? ` · ${sense.partOfSpeech}` : ''}<span className="popover-page">{selection ? `P.${selection.pageNumber}` : ''}</span></div>
        <p className="popover-meaning">{sense.contextualMeaning}</p>
        <button className="popover-close" aria-label="关闭浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}

      {anchor && !senseLoading && !sense && senseError && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot mock" />义项查询失败</div>
        <p className="popover-meaning">{senseError}</p>
        <button className="popover-close" aria-label="关闭浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}
    </main>
  )
}

export default App
