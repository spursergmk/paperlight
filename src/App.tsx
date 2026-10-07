import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, FilePlus2,
  FileText, FolderOpen, KeyRound, Languages, Minus, MoreHorizontal, PanelLeftClose,
  PanelRightClose, Plus, RotateCcw, Settings2, StickyNote, Trash2, X,
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PDFPage from './components/PDFPage'
import PDFThumbnail from './components/PDFThumbnail'
import { openPdf } from './lib/pdf'
import {
  getApiConfigStatus, removeApiKey, saveApiKey, translateSelection,
} from './lib/translation'
import type { ApiConfigStatus } from './lib/translation'
import type { SavedNote, TextSelection, TranslateMode } from './types'

interface OutlineItem {
  title: string
  dest: unknown
  items?: OutlineItem[]
}

interface AnchorPoint { x: number; y: number }

const NOTES_KEY = 'paperlight-notes-v1'

function readNotes(): SavedNote[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]') as SavedNote[]
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function tidyText(value: string) {
  return value.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim()
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
  const [rightTab, setRightTab] = useState<'translation' | 'notes'>('translation')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [translation, setTranslation] = useState('')
  const [translationLoading, setTranslationLoading] = useState(false)
  const [translationError, setTranslationError] = useState('')
  const [anchor, setAnchor] = useState<AnchorPoint | null>(null)
  const [mode, setMode] = useState<TranslateMode>(() => localStorage.getItem('paperlight-mode') === 'openai' ? 'openai' : 'mock')
  const [model, setModel] = useState(() => localStorage.getItem('paperlight-model') || 'gpt-5-mini')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [apiConfig, setApiConfig] = useState<ApiConfigStatus | null>(null)
  const [apiBaseUrl, setApiBaseUrl] = useState('https://api.zjuailab.club')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiConfigLoading, setApiConfigLoading] = useState(false)
  const [apiConfigMessage, setApiConfigMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [notes, setNotes] = useState<SavedNote[]>(readNotes)
  const [activeNote, setActiveNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [pageInput, setPageInput] = useState('1')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)
  const scale = useMemo(() => Math.max(0.25, ((viewportWidth - 92) / basePageWidth) * zoom), [basePageWidth, viewportWidth, zoom])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth))
    observer.observe(element)
    setViewportWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  useEffect(() => { localStorage.setItem('paperlight-mode', mode) }, [mode])
  useEffect(() => { localStorage.setItem('paperlight-model', model) }, [model])
  useEffect(() => { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)) }, [notes])

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
      .finally(() => {
        if (!cancelled) setApiConfigLoading(false)
      })
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
      setApiConfigMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : '无法保存 API 密钥。',
      })
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
      setApiConfigMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : '无法移除 API 密钥。',
      })
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
      setTranslation('')
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
    const requestId = ++requestIdRef.current
    setTranslationLoading(true)
    setTranslationError('')
    try {
      const result = await translateSelection(next, requestedMode, requestedModel)
      if (requestId === requestIdRef.current) setTranslation(result)
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setTranslationError(error instanceof Error ? error.message : '翻译失败，请稍后重试。')
      }
    } finally {
      if (requestId === requestIdRef.current) setTranslationLoading(false)
    }
  }, [mode, model])

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
    setRightTab('translation')
    setAnchor({
      x: Math.max(174, Math.min(window.innerWidth - 174, rect.left + rect.width / 2)),
      y: Math.max(82, rect.top - 12),
    })
    void runTranslation(next)
  }, [runTranslation])

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

  function saveNote() {
    if (!selection || !translation) return
    const id = `${Date.now()}`
    const saved: SavedNote = { id, text: selection.text, translation, pageNumber: selection.pageNumber, note: noteDraft.trim() }
    setNotes((current) => [saved, ...current])
    setActiveNote(id)
    setRightTab('notes')
    setNoteDraft('')
  }

  const currentNote = notes.find((note) => note.id === activeNote)
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
              <span>{apiConfig?.source === 'environment' ? '由启动环境提供' : apiConfig?.source === 'local-file' ? '安全保存在本机 .env.local' : '输入密钥后即可使用真实翻译'}</span>
            </div>
          </div>
          {apiConfig?.source !== 'environment' && <>
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
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void configureApiKey()
                }}
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
        </> : <p className="settings-hint">模拟模式展示交互流程，少量常见句子有示例译文；其他内容会标记为占位结果。</p>}
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
          <div className="right-tabs"><button className={rightTab === 'translation' ? 'selected' : ''} onClick={() => setRightTab('translation')}><Languages size={14} /> 翻译</button><button className={rightTab === 'notes' ? 'selected' : ''} onClick={() => setRightTab('notes')}><StickyNote size={14} /> 笔记{notes.length > 0 && <span className="notes-count">{notes.length}</span>}</button></div>
          {rightTab === 'translation' ? <div className="translation-panel">
            {selection ? <>
              <div className="selection-meta"><span>第 {selection.pageNumber} 页</span><span className="selection-status"><i /> 已选文本</span></div>
              <div className="selected-text-card"><div className="card-label">原文</div><p>{selection.text}</p></div>
              {(selection.before || selection.after) && <details className="context-details"><summary>查看上下文 <ChevronDown size={13} /></summary><p>{selection.before && <span>{selection.before} </span>}<mark>{selection.text}</mark>{selection.after && <span> {selection.after}</span>}</p></details>}
              <div className="translation-label"><span>中文翻译</span><span className="mode-label">{mode === 'mock' ? '模拟模式' : model}</span></div>
              <div className={`translation-result${translationError ? ' is-error' : ''}`}>
                {translationLoading ? <div className="loading-copy"><span className="mini-spinner" /> 正在翻译…</div> : translationError ? <><p>{translationError}</p><button className="text-action" onClick={() => void runTranslation(selection)}>重试翻译</button></> : <p>{translation || '译文会出现在这里。'}</p>}
              </div>
              {translation && !translationError && <button className="save-note-button" onClick={saveNote}><Bookmark size={15} /> 保存为笔记</button>}
              {mode === 'mock' && <div className="mock-note"><span className="mock-note-dot" />模拟模式用于预览交互，切换兼容 API 可获取实际译文。</div>}
            </> : <div className="translation-empty"><div><Languages size={20} /></div><strong>选中一段文字</strong><span>PDF 中的英文句子会在这里<br />自动翻译成中文。</span></div>}
            <div className="translate-footer"><span className={`provider-dot ${mode}`} />{mode === 'mock' ? '模拟翻译 · 离线可用' : '通过本地代理连接兼容 API'}</div>
          </div> : <div className="notes-panel">
            {currentNote ? <>
              <button className="back-to-notes" onClick={() => setActiveNote(null)}><ChevronLeft size={14} /> 所有笔记</button>
              <div className="note-detail-meta">第 {currentNote.pageNumber} 页 · 摘录</div>
              <blockquote className="note-quote">{currentNote.text}</blockquote>
              <div className="note-translation">{currentNote.translation}</div>
              <label className="field-label note-field-label" htmlFor="note-content">我的笔记</label>
              <textarea id="note-content" className="note-editor" value={noteDraft} placeholder="写下你的想法…" onChange={(event) => setNoteDraft(event.target.value)} />
              <div className="note-actions"><button className="delete-note" onClick={() => { setNotes((list) => list.filter((item) => item.id !== currentNote.id)); setActiveNote(null); setNoteDraft('') }}>删除</button><button className="small-save" onClick={() => { setNotes((list) => list.map((item) => item.id === currentNote.id ? { ...item, note: noteDraft } : item)); setNoteDraft('') }}><Check size={13} /> 保存</button></div>
            </> : notes.length ? <div className="note-list">{notes.map((note) => <button key={note.id} className="note-list-item" onClick={() => { setActiveNote(note.id); setNoteDraft(note.note); scrollToPage(note.pageNumber) }}><span className="note-page-chip">P.{note.pageNumber}</span><strong>{note.text}</strong><span>{note.translation}</span><MoreHorizontal size={15} /></button>)}</div> : <div className="translation-empty notes-empty"><div><StickyNote size={19} /></div><strong>还没有笔记</strong><span>选中并翻译一段文字后，<br />可以将它保存到这里。</span><button className="subtle-button" onClick={() => setRightTab('translation')}>去选一段文字</button></div>}
            <div className="translate-footer"><Check size={13} /> 笔记仅保存在此浏览器</div>
          </div>}
        </aside>}
      </div>

      {selection && anchor && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot openai" />中文翻译<span className="popover-page">P.{selection.pageNumber}</span></div>
        {translationLoading ? <div className="popover-loading"><span className="mini-spinner" /> 正在翻译…</div> : translationError ? <div className="popover-error">翻译暂时不可用 <button onClick={() => void runTranslation(selection)}>重试</button></div> : <p>{translation || '已选中文本'}</p>}
        <button className="popover-close" aria-label="关闭翻译浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}
    </main>
  )
}

export default App
