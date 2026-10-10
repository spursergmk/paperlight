import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, BookmarkPlus, ChevronDown, ChevronLeft, ChevronRight, Files, FilePlus2, FileText, FolderOpen,
  Highlighter, KeyRound, Layers, List, Minus, PanelLeftClose, PanelLeftOpen, PanelRightClose,
  PanelRightOpen, Plus, RotateCcw, Settings2, Trash2, X,
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import AssistantPanel, { type AssistantTab } from './components/AssistantPanel'
import ChatSpace from './components/ChatSpace'
import EpubReader from './components/EpubReader'
import FileExplorer from './components/FileExplorer'
import NotesSpace from './components/NotesSpace'
import ExpressionSpace from './components/ExpressionSpace'
import PageStack, { type PageStackApi } from './components/PageStack'
import PDFThumbnail from './components/PDFThumbnail'
import SpaceRail from './components/SpaceRail'
import TextReader from './components/TextReader'
import type { FlowReaderApi, FlowScrollState } from './components/useFlowReader'
import { useVault } from './components/useVault'
import Splitter from './components/Splitter'
import TabStrip from './components/TabStrip'
import WelcomeScreen from './components/WelcomeScreen'
import type { DirListing, QuickRoot } from './lib/bridge'
import { getBridge } from './lib/bridge'
import {
  acquireDocument, documentKeyFor, readDocumentMeta, releaseDocument,
  type DocumentOutlineItem,
} from './lib/documents'
import {
  documentKindFor, isMarkdownPath, positionLabel, type DocumentKind,
} from './lib/documentKind'
import { openEpub, type EpubBook, type EpubOutlineItem } from './lib/epub'
import { displayNameForPath, fileSystem } from './lib/fsaccess'
import { isAbortError } from './lib/abort'
import { markerRangeInElement } from './lib/markers'
import {
  outlineFromBlocks, parseTextDocument, type MarkdownBlock, type TextOutlineItem,
} from './lib/textdoc'
import {
  DEFAULT_HISTORY_WIDTH, DEFAULT_LEFT_WIDTH, DEFAULT_PICKER_WIDTH, DEFAULT_RIGHT_WIDTH,
  DEFAULT_SIDE_WIDTH, DEFAULT_TREE_WIDTH, MIN_HISTORY_WIDTH, MIN_LEFT_WIDTH, MIN_PICKER_WIDTH,
  MIN_READER_WIDTH, MIN_RIGHT_WIDTH, MIN_SIDE_WIDTH, MIN_TREE_WIDTH,
  flushState, loadState, loadStateSync, saveState,
  type PersistedState, type ReaderTabState, type RecentFile,
} from './lib/persist'
import { askSense, expandSenses, lookupSense, sentenceAround, termFromSelection } from './lib/sense'
import {
  confirmSemanticMerge, createNote, mergeSemanticAtom, possibleSemanticMergeCandidates, relateSense, semanticRecordForId,
  selectionMatchesSemanticTerm, senseKeyOf, toAtom,
} from './lib/notebook'
import { activeReadingInterval, recordReadingInterval, READING_TICK_INTERVAL_MS } from './lib/readingActivity'
import {
  absoluteVaultPath, isValidTimeOfDay, localDateKey, mirrorFolderForMaterial, noteFolderPath,
  readerAnswerPath, remapLegacyNotePath, resolveLegacyInboxPath, semanticAnswerMarkdown,
} from './lib/vault'
import {
  getApiConfigStatus, protocolForBaseUrl, removeApiKey, saveApiKey, translateSelection,
} from './lib/translation'
import type { ApiConfigStatus } from './lib/translation'
import type {
  AppSpace, ChatMessage, ChatThread, NoteViewMode, NotebookNote, SenseAtom, SensePayload, SenseSummary,
  ExpressionContext, InputMarker, InputMarkerPurpose, InputMarkerVisualStyle, TextSelection, TranslateMode,
} from './types'

type LeftTab = 'files' | 'pages' | 'outline'

type FlowOutlineItem = TextOutlineItem | EpubOutlineItem
type InputMarkerDraft = Omit<InputMarker, 'id' | 'createdAt'> & { x: number; y: number }
type SemanticCaptureDestination = 'notebook' | 'vault'

interface LoadedDocument {
  kind: DocumentKind
  status: 'loading' | 'ready' | 'error'
  progress: number
  error: string
  // PDF
  pdf: PDFDocumentProxy | null
  pageCount: number
  basePageWidth: number
  firstPageRatio: number
  outline: DocumentOutlineItem[]
  // ref lowed documents (text / Markdown)
  blocks: MarkdownBlock[]
  flowOutline: FlowOutlineItem[]
  // EPUB
  epub: EpubBook | null
}

const MODEL_KEY = 'paperlight-model-v2'
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function bookmarkText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function captureFlowBookmark(scroller: HTMLElement): Pick<InputMarker, 'quote' | 'before' | 'after' | 'blockIndex'> {
  const area = scroller.getBoundingClientRect()
  const probeY = area.top + Math.min(150, Math.max(70, scroller.clientHeight * 0.28))
  const candidates = Array.from(scroller.querySelectorAll<HTMLElement>(
    '.flow-page p, .flow-page h1, .flow-page h2, .flow-page h3, .flow-page h4, .flow-page h5, .flow-page h6, .flow-page li, .flow-page blockquote, .flow-page pre, .epub-body p, .epub-body h1, .epub-body h2, .epub-body h3, .epub-body h4, .epub-body h5, .epub-body h6, .epub-body li, .epub-body blockquote, .epub-body pre',
  )).filter((element) => bookmarkText(element.innerText || element.textContent || ''))
  const visible = candidates.filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > area.top && rect.top < area.bottom
  })
  const target = visible.find((element) => {
    const rect = element.getBoundingClientRect()
    return rect.top <= probeY && rect.bottom >= probeY
  }) || visible.reduce<HTMLElement | null>((closest, element) => {
    if (!closest) return element
    const center = element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2
    const closestCenter = closest.getBoundingClientRect().top + closest.getBoundingClientRect().height / 2
    return Math.abs(center - probeY) < Math.abs(closestCenter - probeY) ? element : closest
  }, null)
  if (!target) return {}
  const quote = bookmarkText(target.innerText || target.textContent || '').slice(0, 900)
  const previous = target.previousElementSibling?.textContent || target.parentElement?.previousElementSibling?.textContent || ''
  const next = target.nextElementSibling?.textContent || target.parentElement?.nextElementSibling?.textContent || ''
  const block = target.closest<HTMLElement>('[id^="flow-block-"]')
  const blockIndex = block?.id.match(/^flow-block-(\d+)$/)?.[1]
  return {
    ...(quote ? { quote } : {}),
    ...(bookmarkText(previous) ? { before: bookmarkText(previous).slice(-100) } : {}),
    ...(bookmarkText(next) ? { after: bookmarkText(next).slice(0, 100) } : {}),
    ...(blockIndex ? { blockIndex: Number(blockIndex) } : {}),
  }
}

function capturePdfBookmark(scroller: HTMLElement, fallbackPage: number): Pick<InputMarker, 'quote' | 'before' | 'after' | 'pageNumber' | 'startOffset' | 'endOffset'> {
  const area = scroller.getBoundingClientRect()
  const probeY = area.top + Math.min(190, Math.max(85, scroller.clientHeight * 0.3))
  const pages = Array.from(scroller.querySelectorAll<HTMLElement>('.pdf-page-shell[data-page-number]'))
  const page = pages.find((candidate) => {
    const rect = candidate.getBoundingClientRect()
    return rect.top <= probeY && rect.bottom >= probeY
  }) || pages.reduce<HTMLElement | null>((closest, candidate) => {
    if (!closest) return candidate
    const distance = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return probeY < rect.top ? rect.top - probeY : probeY > rect.bottom ? probeY - rect.bottom : 0
    }
    return distance(candidate) < distance(closest) ? candidate : closest
  }, null)
  if (!page) return { pageNumber: fallbackPage }
  const pageNumber = Number(page.dataset.pageNumber) || fallbackPage
  const textLayer = page.querySelector<HTMLElement>('.textLayer')
  if (!textLayer) return { pageNumber }
  // PDF.js exposes positioned text runs instead of semantic paragraphs. Rebuild
  // lines from their baselines, then use the larger vertical gaps as paragraph
  // boundaries so a bookmark can still return to actual source text.
  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>('span'))
    .map((element) => ({ text: tidyText(element.textContent || ''), rect: element.getBoundingClientRect() }))
    .filter((item) => item.text && item.rect.width > 0 && item.rect.height > 0)
  if (!spans.length) return { pageNumber }
  const heights = spans.map((item) => item.rect.height).sort((a, b) => a - b)
  const typicalLineHeight = heights[Math.floor(heights.length / 2)]
  const lineTolerance = Math.max(2, typicalLineHeight * 0.45)
  const lines: Array<{ top: number; bottom: number; height: number; parts: typeof spans }> = []
  for (const item of [...spans].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
    const line = lines.find((candidate) => Math.abs(candidate.top - item.rect.top) <= lineTolerance)
    if (line) {
      line.parts.push(item)
      line.top = Math.min(line.top, item.rect.top)
      line.bottom = Math.max(line.bottom, item.rect.bottom)
      line.height = Math.max(line.height, item.rect.height)
    } else lines.push({ top: item.rect.top, bottom: item.rect.bottom, height: item.rect.height, parts: [item] })
  }
  const orderedLines = lines.sort((a, b) => a.top - b.top)
  const paragraphs: Array<{ top: number; bottom: number; lines: typeof orderedLines; text: string }> = []
  for (const line of orderedLines) {
    const previous = paragraphs[paragraphs.length - 1]
    const lineText = line.parts.sort((a, b) => a.rect.left - b.rect.left).map((part) => part.text).join(' ')
    const gap = previous ? line.top - previous.bottom : Number.POSITIVE_INFINITY
    if (previous && gap <= Math.max(4, line.height * 0.7)) {
      previous.lines.push(line)
      previous.bottom = Math.max(previous.bottom, line.bottom)
      previous.text = tidyText(`${previous.text} ${lineText}`)
    } else paragraphs.push({ top: line.top, bottom: line.bottom, lines: [line], text: lineText })
  }
  const target = paragraphs.reduce((closest, item) => {
    const distance = probeY < item.top ? item.top - probeY : probeY > item.bottom ? probeY - item.bottom : 0
    const closestDistance = probeY < closest.top ? closest.top - probeY : probeY > closest.bottom ? probeY - closest.bottom : 0
    return distance < closestDistance ? item : closest
  })
  const quote = target.text.slice(0, 1600)
  const sourceText = paragraphs.map((item) => item.text).join(' ')
  const startOffset = sourceText.indexOf(quote)
  const targetIndex = paragraphs.indexOf(target)
  const previous = paragraphs[targetIndex - 1]?.text || ''
  const next = paragraphs[targetIndex + 1]?.text || ''
  return {
    pageNumber,
    ...(quote ? { quote } : {}),
    ...(startOffset >= 0 ? {
      startOffset,
      endOffset: startOffset + quote.length,
      before: previous.slice(-100),
      after: next.slice(0, 100),
    } : {}),
  }
}

function findFlowBookmarkTarget(scroller: HTMLElement, marker: InputMarker): HTMLElement | null {
  const quote = bookmarkText(marker.quote || '')
  if (!quote) return null
  const candidates = Array.from(scroller.querySelectorAll<HTMLElement>(
    '.flow-page p, .flow-page h1, .flow-page h2, .flow-page h3, .flow-page h4, .flow-page h5, .flow-page h6, .flow-page li, .flow-page blockquote, .flow-page pre, .epub-body p, .epub-body h1, .epub-body h2, .epub-body h3, .epub-body h4, .epub-body h5, .epub-body h6, .epub-body li, .epub-body blockquote, .epub-body pre',
  ))
  const matches = candidates.filter((element) => bookmarkText(element.innerText || element.textContent || '').includes(quote))
  if (matches.length < 2) return matches[0] || null
  const contextMatches = matches.filter((element) => {
    const before = marker.before ? bookmarkText(element.previousElementSibling?.textContent || '') : ''
    const after = marker.after ? bookmarkText(element.nextElementSibling?.textContent || '') : ''
    return (!marker.before || before.endsWith(bookmarkText(marker.before)))
      && (!marker.after || after.startsWith(bookmarkText(marker.after)))
  })
  return contextMatches[0] || matches[0]
}

function alignReaderElement(scroller: HTMLElement, target: HTMLElement, topPadding = 16): void {
  const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  scroller.scrollTop = Math.max(0, scroller.scrollTop + targetTop - topPadding)
}

function touchRecent(list: RecentFile[], entry: RecentFile, limit = 12): RecentFile[] {
  const without = list.filter((item) => item.path !== entry.path)
  return [entry, ...without].slice(0, limit)
}

function touchStrings(list: string[], value: string, limit = 12): string[] {
  if (!value) return list
  return [value, ...list.filter((item) => item !== value)].slice(0, limit)
}

function emptyDocument(kind: DocumentKind = 'pdf'): LoadedDocument {
  return {
    kind,
    status: 'loading', progress: 0, error: '',
    pdf: null, pageCount: 0, basePageWidth: 612, firstPageRatio: 0.773, outline: [],
    blocks: [], flowOutline: [], epub: null,
  }
}

const TEXT_DECODER_LABELS = ['utf-8', 'gb18030', 'big5']

/** Decodes a text file, falling back for legacy Chinese encodings. */
function decodeDocumentText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  const replacementRatio = (utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, utf8.length)
  if (replacementRatio < 0.005) return utf8
  for (const label of TEXT_DECODER_LABELS.slice(1)) {
    try {
      const decoded = new TextDecoder(label).decode(bytes)
      const ratio = (decoded.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, decoded.length)
      if (ratio < replacementRatio) return decoded
    } catch {
      // Encoding not supported by this build; try the next one.
    }
  }
  return utf8
}

function App() {
  const [state, setState] = useState<PersistedState>(loadStateSync)
  const [hydrated, setHydrated] = useState(false)
  const [docs, setDocs] = useState<Record<string, LoadedDocument>>({})
  const automaticPdfReloads = useRef(new Map<string, number>())
  const [leftTab, setLeftTab] = useState<LeftTab>('files')
  const [rightTab, setRightTab] = useState<AssistantTab>('sense')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  const [pageInput, setPageInput] = useState('1')
  const [flowLocation, setFlowLocation] = useState('')

  const [explorer, setExplorer] = useState<{
    root: string | null
    current: string
    listing: DirListing | null
    loading: boolean
    error: string
  }>({ root: null, current: '', listing: null, loading: false, error: '' })
  const [roots, setRoots] = useState<QuickRoot[]>([])

  // Sense lookup
  const [queryTerm, setQueryTerm] = useState('')
  const [sense, setSense] = useState<SensePayload | null>(null)
  const [senseAnswerId, setSenseAnswerId] = useState<string | null>(null)
  const [senseLoading, setSenseLoading] = useState(false)
  const [senseError, setSenseError] = useState('')
  const [allSenses, setAllSenses] = useState<SenseSummary[] | null>(null)
  const [expanding, setExpanding] = useState(false)
  const [pendingSemanticCapture, setPendingSemanticCapture] = useState<{
    atom: SenseAtom
    candidates: SenseAtom[]
    destination: SemanticCaptureDestination
    note?: NotebookNote
  } | null>(null)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [pendingSourceJump, setPendingSourceJump] = useState<{ path: string; position: number; marker?: InputMarker } | null>(null)
  const [expressionSourcePreview, setExpressionSourcePreview] = useState<InputMarker | null>(null)
  const [epubAlignmentTail, setEpubAlignmentTail] = useState<{ path: string; chapterIndex: number; padding: number } | null>(null)
  const [expressionCapture, setExpressionCapture] = useState<{
    text: string
    context: Partial<ExpressionContext>
    x: number
    y: number
    reader: boolean
  } | null>(null)
  const [expressionCaptureNotice, setExpressionCaptureNotice] = useState('')
  const [inputMarkerDraft, setInputMarkerDraft] = useState<InputMarkerDraft | null>(null)
  const [inputMarkerNotice, setInputMarkerNotice] = useState('')
  const [inputMarkerMenuOpen, setInputMarkerMenuOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [activeAtomId, setActiveAtomId] = useState<string | null>(null)
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState('')

  // Sentence translation kept from the original reader
  const [translation, setTranslation] = useState('')
  const [translationLoading, setTranslationLoading] = useState(false)
  const [translationError, setTranslationError] = useState('')

  // Provider configuration
  const [apiConfig, setApiConfig] = useState<ApiConfigStatus | null>(null)
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiConfigLoading, setApiConfigLoading] = useState(false)
  const [apiConfigMessage, setApiConfigMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const stateRef = useRef(state)
  stateRef.current = state
  const docsRef = useRef(docs)
  docsRef.current = docs
  const loadTokens = useRef(new Map<string, number>())
  const loadTokenRef = useRef(0)
  const scrollPositions = useRef<Record<string, number>>({})
  const scrollRatios = useRef<Record<string, number>>({})
  const flowApiRef = useRef<FlowReaderApi | null>(null)
  const scrollDirty = useRef(false)
  const pageApiRef = useRef<PageStackApi | null>(null)
  const restoredRef = useRef(false)
  const translationRequestRef = useRef(0)
  const senseRequestRef = useRef(0)
  const translationControllerRef = useRef<AbortController | null>(null)
  const senseControllerRef = useRef<AbortController | null>(null)
  const expandControllerRef = useRef<AbortController | null>(null)
  const readerChatControllerRef = useRef<AbortController | null>(null)
  const completeNoteControllerRef = useRef<AbortController | null>(null)
  const lastContextRef = useRef('')
  const lastReadingInteractionRef = useRef(0)
  const lastReadingTickRef = useRef(0)

  useEffect(() => () => {
    translationControllerRef.current?.abort()
    senseControllerRef.current?.abort()
    expandControllerRef.current?.abort()
    readerChatControllerRef.current?.abort()
    completeNoteControllerRef.current?.abort()
  }, [])

  const session = state.session
  const layout = state.layout
  const notebook = state.notebook
  const activePath = session.activePath
  const activeTab = session.tabs.find((tab) => tab.path === activePath) || null
  const activeDoc = activePath ? docs[activePath] : undefined
  const activePdf = activeDoc?.status === 'ready' ? activeDoc.pdf : null
  const openPaths = useMemo(() => session.tabs.map((tab) => tab.path), [session.tabs])

  const mode = state.settings.mode
  const model = state.settings.model
  const atoms = notebook.atoms
  const notebookNotes = notebook.notes
  const activeInputMarkers = activePath ? state.inputMarkers.filter((marker) => marker.sourcePath === activePath) : []
  const readerInputMarkers = expressionSourcePreview?.sourcePath === activePath
    ? [...activeInputMarkers, expressionSourcePreview]
    : activeInputMarkers
  const chat = notebook.chat
  const senseId = sense ? senseKeyOf(sense) : null
  const senseInNotebook = Boolean(senseId && semanticRecordForId(senseId, atoms))
  const relations = useMemo(() => (sense ? relateSense(sense, atoms) : []), [sense, atoms])
  const chatMessages = senseId ? chat[senseId] || [] : []

  useEffect(() => {
    setEpubAlignmentTail((current) => current && current.path !== activePath ? null : current)
  }, [activePath])
  const savedMessageIds = useMemo(() => new Set(
    notebookNotes.map((note) => note.sourceMessageId).filter((id): id is string => Boolean(id)),
  ), [notebookNotes])

  const setSession = useCallback((updater: (current: PersistedState['session']) => PersistedState['session']) => {
    setState((prev) => ({ ...prev, session: updater(prev.session) }))
  }, [])

  const updateTab = useCallback((path: string, patch: Partial<ReaderTabState>) => {
    setSession((current) => ({ ...current, tabs: current.tabs.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)) }))
  }, [setSession])

  const setNotebook = useCallback((updater: (current: PersistedState['notebook']) => PersistedState['notebook']) => {
    setState((prev) => ({ ...prev, notebook: updater(prev.notebook) }))
  }, [])

  // --------------------------------------------------------------- spaces

  const activeSpace = state.activeSpace
  const vaultState = state.vault
  const notesSpace = state.notesSpace
  const chatSpace = state.chatSpace

  // Estimate active reading only while a loaded document is in the foreground
  // reader. Recent interaction and focus checks exclude idle/background time.
  useEffect(() => {
    if (!hydrated || activeSpace !== 'reader' || !activePath || activeDoc?.status !== 'ready') return
    lastReadingInteractionRef.current = 0
    lastReadingTickRef.current = Date.now()
    const markInteraction = () => { lastReadingInteractionRef.current = Date.now() }
    const clearForegroundActivity = () => {
      lastReadingTickRef.current = Date.now()
      lastReadingInteractionRef.current = 0
    }
    const resetForegroundClock = () => { lastReadingTickRef.current = Date.now() }
    const handleVisibilityChange = () => {
      lastReadingTickRef.current = Date.now()
      if (document.hidden) lastReadingInteractionRef.current = 0
    }
    const interval = window.setInterval(() => {
      const now = Date.now()
      const previous = lastReadingTickRef.current || now
      lastReadingTickRef.current = now
      const activeInterval = activeReadingInterval({
        previousTickMs: previous,
        nowMs: now,
        lastInteractionMs: lastReadingInteractionRef.current,
        hidden: document.hidden,
        focused: document.hasFocus(),
      })
      if (activeInterval) {
        const name = activeTab?.name || activePath.split(/[\\/]/).pop() || '阅读材料'
        setState((current) => ({
          ...current,
          readingActivity: recordReadingInterval(current.readingActivity, activeInterval.fromMs, activeInterval.toMs, activePath, name),
        }))
      }
    }, READING_TICK_INTERVAL_MS)
    document.documentElement.dataset.paperlightReadingTimer = 'active'
    window.addEventListener('pointerdown', markInteraction, true)
    window.addEventListener('pointermove', markInteraction, { capture: true, passive: true })
    window.addEventListener('keydown', markInteraction, true)
    window.addEventListener('wheel', markInteraction, { capture: true, passive: true })
    window.addEventListener('scroll', markInteraction, true)
    window.addEventListener('touchstart', markInteraction, { capture: true, passive: true })
    window.addEventListener('blur', clearForegroundActivity)
    window.addEventListener('focus', resetForegroundClock)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearInterval(interval)
      delete document.documentElement.dataset.paperlightReadingTimer
      window.removeEventListener('pointerdown', markInteraction, true)
      window.removeEventListener('pointermove', markInteraction, true)
      window.removeEventListener('keydown', markInteraction, true)
      window.removeEventListener('wheel', markInteraction, true)
      window.removeEventListener('scroll', markInteraction, true)
      window.removeEventListener('touchstart', markInteraction, true)
      window.removeEventListener('blur', clearForegroundActivity)
      window.removeEventListener('focus', resetForegroundClock)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activeDoc?.status, activePath, activeSpace, activeTab?.name, hydrated])

  const setVaultState = useCallback((updater: (current: PersistedState['vault']) => PersistedState['vault']) => {
    setState((prev) => ({ ...prev, vault: updater(prev.vault) }))
  }, [])

  const setNotesSpace = useCallback((updater: (current: PersistedState['notesSpace']) => PersistedState['notesSpace']) => {
    setState((prev) => ({ ...prev, notesSpace: updater(prev.notesSpace) }))
  }, [])

  const setChatSpace = useCallback((updater: (current: PersistedState['chatSpace']) => PersistedState['chatSpace']) => {
    setState((prev) => ({ ...prev, chatSpace: updater(prev.chatSpace) }))
  }, [])

  const switchSpace = useCallback((space: AppSpace) => {
    setState((prev) => (prev.activeSpace === space ? prev : { ...prev, activeSpace: space }))
  }, [])

  const rememberVaultRoot = useCallback((root: string) => {
    setVaultState((current) => ({
      ...current,
      root,
      recentRoots: touchStrings(current.recentRoots, root, 8),
    }))
  }, [setVaultState])

  const vaultApi = useVault({
    root: vaultState.root,
    atoms: notebook.atoms,
    notes: notebook.notes,
    readingActivity: state.readingActivity,
    model,
    reportTime: state.settings.dailyReportTime,
    reportAuto: state.settings.dailyReportAuto,
    onRootChange: rememberVaultRoot,
  })
  const vaultRef = useRef(vaultApi)
  vaultRef.current = vaultApi

  // While a document from `materials/` is open, its notes mirror tells us where
  // every sense and note of this reading session belongs.
  const readingMirror = useMemo(
    () => (activePath ? mirrorFolderForMaterial(activePath, vaultState.root) : null),
    [activePath, vaultState.root],
  )
  const readerNotesFolder = readingMirror || ''
  const readingContext = useMemo(
    () => (readingMirror && activePath
      ? { document: displayNameForPath(activePath), notesFolder: noteFolderPath(readingMirror) }
      : null),
    [activePath, readingMirror],
  )

  /** Opens a vault note and brings the notes desk to the front. */
  const openNoteInNotesSpace = useCallback((path: string) => {
    const known = new Set(vaultApi.files.filter((entry) => !entry.directory).map((entry) => entry.path))
    const resolvedPath = resolveLegacyInboxPath(path, known)
    setNotesSpace((current) => ({
      ...current,
      openPaths: current.openPaths.includes(resolvedPath) ? current.openPaths : [...current.openPaths, resolvedPath],
      activePath: resolvedPath,
    }))
    setState((prev) => ({ ...prev, activeSpace: 'notes' }))
  }, [setNotesSpace, vaultApi.files])

  const openNote = useCallback((path: string, options?: { background?: boolean }) => {
    if (!path) return
    setNotesSpace((current) => ({
      ...current,
      openPaths: current.openPaths.includes(path) ? current.openPaths : [...current.openPaths, path],
      activePath: options?.background ? (current.activePath ?? path) : path,
    }))
  }, [setNotesSpace])

  const closeNote = useCallback((path: string) => {
    setNotesSpace((current) => {
      const index = current.openPaths.indexOf(path)
      const openPaths = current.openPaths.filter((item) => item !== path)
      let activePath = current.activePath
      if (activePath === path) {
        const neighbour = openPaths[Math.min(Math.max(index, 0), openPaths.length - 1)]
        activePath = neighbour ?? null
      }
      return { ...current, openPaths, activePath }
    })
  }, [setNotesSpace])

  const activateNote = useCallback((path: string) => {
    setNotesSpace((current) => ({ ...current, activePath: path }))
  }, [setNotesSpace])

  const setNoteView = useCallback((view: NoteViewMode) => {
    setNotesSpace((current) => ({ ...current, view }))
  }, [setNotesSpace])

  const resizeNoteTree = useCallback((delta: number) => {
    setNotesSpace((current) => ({ ...current, treeWidth: clamp(current.treeWidth + delta, MIN_TREE_WIDTH, 560) }))
  }, [setNotesSpace])

  const resizeNoteSide = useCallback((delta: number) => {
    setNotesSpace((current) => ({ ...current, sideWidth: clamp(current.sideWidth - delta, MIN_SIDE_WIDTH, 560) }))
  }, [setNotesSpace])

  const toggleNoteSide = useCallback(() => {
    setNotesSpace((current) => ({ ...current, sideOpen: !current.sideOpen }))
  }, [setNotesSpace])

  const toggleVaultCollapsed = useCallback((path: string) => {
    setVaultState((current) => ({
      ...current,
      collapsed: current.collapsed.includes(path)
        ? current.collapsed.filter((item) => item !== path)
        : [...current.collapsed, path],
    }))
  }, [setVaultState])

  // ------------------------------------------------------------ chat space

  const createThread = useCallback((): string => {
    const now = new Date().toISOString()
    const thread: ChatThread = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: '新的对话',
      createdAt: now,
      updatedAt: now,
      messages: [],
      contextPaths: [],
    }
    setChatSpace((current) => ({ ...current, threads: [thread, ...current.threads], activeThreadId: thread.id }))
    return thread.id
  }, [setChatSpace])

  const activateThread = useCallback((id: string) => {
    setChatSpace((current) => ({ ...current, activeThreadId: id }))
  }, [setChatSpace])

  const openChatThread = useCallback((id: string) => {
    activateThread(id)
    switchSpace('chat')
  }, [activateThread, switchSpace])

  const updateThread = useCallback((id: string, updater: (thread: ChatThread) => ChatThread) => {
    setChatSpace((current) => ({
      ...current,
      threads: current.threads.map((thread) => (thread.id === id ? updater(thread) : thread)),
    }))
  }, [setChatSpace])

  const deleteThread = useCallback((id: string) => {
    setChatSpace((current) => {
      const threads = current.threads.filter((thread) => thread.id !== id)
      return {
        ...current,
        threads,
        activeThreadId: current.activeThreadId === id ? (threads[0]?.id ?? null) : current.activeThreadId,
      }
    })
  }, [setChatSpace])

  const resizeHistory = useCallback((delta: number) => {
    setChatSpace((current) => ({ ...current, historyWidth: clamp(current.historyWidth + delta, MIN_HISTORY_WIDTH, 420) }))
  }, [setChatSpace])

  const resizePicker = useCallback((delta: number) => {
    setChatSpace((current) => ({ ...current, pickerWidth: clamp(current.pickerWidth + delta, MIN_PICKER_WIDTH, 520) }))
  }, [setChatSpace])

  const toggleChatColumn = useCallback((column: 'history' | 'picker') => {
    setChatSpace((current) => (column === 'history'
      ? { ...current, historyOpen: !current.historyOpen }
      : { ...current, pickerOpen: !current.pickerOpen }))
  }, [setChatSpace])

  // Reader-only overlays must not follow the user into another desk.
  useEffect(() => {
    setAnchor(null)
    setDragActive(false)
  }, [activeSpace])

  // One conversation is always ready, so the composer is never dead on arrival.
  useEffect(() => {
    if (!hydrated || activeSpace !== 'chat') return
    if (chatSpace.threads.length === 0) createThread()
  }, [activeSpace, chatSpace.threads.length, createThread, hydrated])

  // Validate a restored vault once, so a moved folder shows up instead of failing later.
  const vaultCheckedRef = useRef(false)
  useEffect(() => {
    if (!hydrated || vaultCheckedRef.current || !vaultState.root) return
    vaultCheckedRef.current = true
    void vaultRef.current.useVaultPath(vaultState.root)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, vaultState.root])

  // The day's record list is rebuilt locally (no model call) whenever the
  // senses or notes change; the AI report is written once per day slot instead.
  useEffect(() => {
    if (!hydrated || !vaultState.root) return
    const timer = window.setTimeout(() => {
      void vaultRef.current.refreshDaily(undefined, { silent: true })
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [hydrated, notebook.atoms, notebook.notes, state.readingActivity, vaultState.root])

  // Report scheduler: one check per minute, one attempt per day slot.
  useEffect(() => {
    if (!hydrated || !vaultState.root) return
    const tick = () => { void vaultRef.current.maybeGenerateReport() }
    tick()
    const timer = window.setInterval(tick, 60_000)
    return () => window.clearInterval(timer)
  }, [hydrated, vaultState.root, state.settings.dailyReportAuto, state.settings.dailyReportTime])

  // Notes opened before the restructure (`Paperlight/Daily/…`) move to `Daily/`.
  useEffect(() => {
    if (!vaultApi.ready) return
    setNotesSpace((current) => {
      const openPaths = current.openPaths.map(remapLegacyNotePath)
      const activeMapped = current.activePath ? remapLegacyNotePath(current.activePath) : null
      const uniqueOpen = Array.from(new Set(openPaths))
      if (activeMapped === current.activePath && uniqueOpen.join('|') === current.openPaths.join('|')) return current
      return { ...current, openPaths: uniqueOpen, activePath: activeMapped }
    })
  }, [vaultApi.ready, vaultApi.entries, setNotesSpace])

  // ------------------------------------------------------- reader → vault

  const [vaultActionBusy, setVaultActionBusy] = useState(false)
  const [vaultActionMessage, setVaultActionMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const runVaultAction = useCallback(async (action: () => Promise<string>, successText: (path: string) => string) => {
    if (!vaultRef.current.ready) {
      setVaultActionMessage({ kind: 'error', text: '先在笔记空间里选择一个 vault 文件夹。' })
      return
    }
    setVaultActionBusy(true)
    setVaultActionMessage(null)
    try {
      const path = await action()
      setVaultActionMessage({ kind: 'success', text: successText(path) })
      openNoteInNotesSpace(path)
    } catch (error) {
      setVaultActionMessage(isAbortError(error)
        ? { kind: 'success', text: '已停止生成，未保存笔记。' }
        : { kind: 'error', text: error instanceof Error ? error.message : '写入 vault 失败。' })
    } finally {
      setVaultActionBusy(false)
    }
  }, [openNoteInNotesSpace])

  const commitSemanticCapture = useCallback((incoming: SenseAtom, mergeTargetId: string | null, destination: SemanticCaptureDestination, note?: NotebookNote) => {
    setPendingSemanticCapture(null)
    const findResolved = (current: SenseAtom[]) => mergeTargetId
      ? current.find((item) => item.id === mergeTargetId)
      : semanticRecordForId(incoming.id, current)
    const resolve = (existing?: SenseAtom) => {
      if (!existing) return incoming
      return incoming.id === existing.id
        ? mergeSemanticAtom(existing, incoming)
        : confirmSemanticMerge(existing, incoming)
    }

    if (destination === 'vault') {
      if (!vaultRef.current.ready) {
        setVaultActionMessage({ kind: 'error', text: '先在笔记空间里选择一个 vault 文件夹。' })
        return
      }
      void runVaultAction(async () => {
        const record = resolve(findResolved(stateRef.current.notebook.atoms))
        const path = await vaultRef.current.saveSenseNote(record)
        setNotebook((current) => {
          const existing = current.atoms.find((item) => item.id === record.id)
          const merged = existing ? mergeSemanticAtom(existing, record) : record
          const stored = {
            ...merged,
            notesFolder: merged.notesFolder || record.notesFolder,
            notePath: path,
          }
          return {
            ...current,
            atoms: existing
              ? current.atoms.map((item) => item.id === record.id ? stored : item)
              : [stored, ...current.atoms],
          }
        })
        setActiveAtomId(record.id)
        return path
      }, (path) => `语义已写入 vault：${path}`)
      return
    }

    const existing = findResolved(stateRef.current.notebook.atoms)
    const resolved = resolve(existing)
    setNotebook((current) => {
      const latest = findResolved(current.atoms)
      const stored = latest ? resolve(latest) : resolved
      return {
        ...current,
        atoms: latest
          ? current.atoms.map((item) => item.id === latest.id ? stored : item)
          : [stored, ...current.atoms],
        notes: note
          ? [{ ...note, senseIds: Array.from(new Set(note.senseIds.map((id) => id === incoming.id ? stored.id : id))) }, ...current.notes]
          : current.notes,
      }
    })
    setActiveAtomId(resolved.id)
  }, [runVaultAction, setNotebook])

  const requestSemanticCapture = useCallback((destination: SemanticCaptureDestination) => {
    if (!sense) return
    if (destination === 'vault' && !vaultRef.current.ready) {
      setVaultActionMessage({ kind: 'error', text: '先在笔记空间里选择一个 vault 文件夹。' })
      return
    }
    const selectedSource = selection?.documentPath === activePath
      && selectionMatchesSemanticTerm(selection.text, [sense.term, sense.lemma, queryTerm])
      ? selection : null
    const atom = toAtom(sense, model, readerNotesFolder, selectedSource)
    const current = stateRef.current.notebook.atoms
    const existing = semanticRecordForId(atom.id, current)
    if (existing) {
      commitSemanticCapture(atom, existing.id, destination)
      return
    }
    const candidates = possibleSemanticMergeCandidates(atom, current)
    if (candidates.length > 0) {
      setPendingSemanticCapture({ atom, candidates, destination })
      return
    }
    commitSemanticCapture(atom, null, destination)
  }, [activePath, commitSemanticCapture, model, queryTerm, readerNotesFolder, sense, selection])

  const saveSenseToVault = useCallback(() => requestSemanticCapture('vault'), [requestSemanticCapture])

  const [completeNoteGenerating, setCompleteNoteGenerating] = useState(false)
  const generateCompleteNote = useCallback(() => {
    if (!sense) return
    completeNoteControllerRef.current?.abort()
    const controller = new AbortController()
    completeNoteControllerRef.current = controller
    setCompleteNoteGenerating(true)
    void runVaultAction(
      () => vaultRef.current.generateSenseNote(
        sense, lastContextRef.current, senseId ? [senseId] : [], readerNotesFolder, controller.signal,
        () => setCompleteNoteGenerating(false),
      ),
      (path) => `AI 完整笔记已生成：${path}`,
    ).finally(() => {
      if (completeNoteControllerRef.current === controller) completeNoteControllerRef.current = null
      setCompleteNoteGenerating(false)
    })
  }, [readerNotesFolder, runVaultAction, sense, senseId])

  const cancelCompleteNote = useCallback(() => completeNoteControllerRef.current?.abort(), [])

  // A sense needs archiving when it has no file yet — or when the file it was
  // written to is gone (deleted or moved outside the notes tree).
  const vaultFilePaths = useMemo(() => new Set(vaultApi.files.map((file) => file.path)), [vaultApi.files])
  const readerAnswerTitle = sense ? `${sense.term} · ${sense.contextualMeaning}` : ''
  const savedReaderAnswerPath = sense && senseAnswerId
    ? readerAnswerPath(senseAnswerId, readerAnswerTitle)
    : null
  const savedReaderAnswer = savedReaderAnswerPath && vaultFilePaths.has(savedReaderAnswerPath)
    ? savedReaderAnswerPath
    : null
  const saveReaderFirstAnswer = useCallback(() => {
    if (!sense || !senseAnswerId) return
    const currentSelection = selection?.documentPath === activePath ? selection : null
    const root = vaultRef.current.root?.replace(/\\/g, '/').replace(/\/+$/, '')
    const source = activePath?.replace(/\\/g, '/') || ''
    const sourcePath = root && source.startsWith(`${root}/`) ? source.slice(root.length + 1) : ''
    void runVaultAction(
      () => vaultRef.current.saveReaderAnswer({
        answerId: senseAnswerId,
        title: readerAnswerTitle,
        markdown: semanticAnswerMarkdown(sense, currentSelection),
        date: localDateKey(),
        question: `阅读助手对「${sense.term}」的初次回答`,
        sourcePath: sourcePath.startsWith('materials/') ? sourcePath : undefined,
        sourceName: activeTab?.name || (activePath ? displayNameForPath(activePath) : undefined),
        locationLabel: currentSelection?.locationLabel || flowLocation || (activeTab ? `第 ${activeTab.pageNumber} 页/章` : undefined),
        quote: currentSelection?.text,
      }),
      (path) => `完整回答已存入 notes/inbox：${path}`,
    )
  }, [activePath, activeTab, flowLocation, readerAnswerTitle, runVaultAction, sense, senseAnswerId, selection])
  const pendingSenseAtoms = useMemo(
    () => atoms.filter((atom) => !atom.notePath || !vaultFilePaths.has(atom.notePath)),
    [atoms, vaultFilePaths],
  )

  /** Notes collected before the vault existed are written on demand. */
  const savePendingSenses = useCallback(() => {
    if (pendingSenseAtoms.length === 0) return
    void runVaultAction(
      async () => {
        const written: Array<{ id: string; path: string }> = []
        for (const atom of pendingSenseAtoms) {
          written.push({ id: atom.id, path: await vaultRef.current.saveSenseNote(atom) })
        }
        setNotebook((current) => ({
          ...current,
          atoms: current.atoms.map((item) => {
            const match = written.find((entry) => entry.id === item.id)
            return match ? { ...item, notePath: match.path } : item
          }),
        }))
        return written[written.length - 1].path
      },
      (path) => `${pendingSenseAtoms.length} 条语义已写入 vault（最后一份：${path}）`,
    )
  }, [pendingSenseAtoms, runVaultAction, setNotebook])

  const saveNotebookNoteToVault = useCallback((note: NotebookNote) => {
    void runVaultAction(
      async () => {
        const path = await vaultRef.current.saveNotebookNote(note, atoms)
        setNotebook((current) => ({
          ...current,
          notes: current.notes.map((item) => (item.id === note.id ? { ...item, notePath: path } : item)),
        }))
        return path
      },
      (path) => `笔记已写入 vault：${path}`,
    )
  }, [atoms, runVaultAction, setNotebook])

  const saveReaderChatAnswer = useCallback((message: ChatMessage) => {
    if (!sense || !senseId || message.role !== 'assistant') return
    const currentMessages = stateRef.current.notebook.chat[senseId] || []
    const messageIndex = currentMessages.findIndex((item) => item.id === message.id)
    const question = currentMessages.slice(0, messageIndex).reverse().find((item) => item.role === 'user')?.content || sense.term
    const currentSelection = selection?.documentPath === activePath ? selection : null
    const root = vaultRef.current.root?.replace(/\\/g, '/').replace(/\/+$/, '')
    const source = activePath?.replace(/\\/g, '/') || ''
    const sourcePath = root && source.startsWith(`${root}/`) ? source.slice(root.length + 1) : ''
    void runVaultAction(async () => {
      const path = await vaultRef.current.saveReaderAnswer({
        answerId: `reader-followup:${senseId}:${message.id}`,
        title: `${sense.term} · ${question.slice(0, 80)}`,
        markdown: message.content,
        date: localDateKey(),
        question,
        sourcePath: sourcePath.startsWith('materials/') ? sourcePath : undefined,
        sourceName: activeTab?.name || (activePath ? displayNameForPath(activePath) : undefined),
        locationLabel: currentSelection?.locationLabel || flowLocation || (activeTab ? `第 ${activeTab.pageNumber} 页/章` : undefined),
        quote: currentSelection?.text,
      })
      setNotebook((current) => ({
        ...current,
        chat: {
          ...current.chat,
          [senseId]: (current.chat[senseId] || []).map((item) => item.id === message.id ? { ...item, savedPath: path } : item),
        },
      }))
      return path
    }, (path) => `追问回答已存入 notes/inbox：${path}`)
  }, [activePath, activeTab, flowLocation, runVaultAction, sense, senseId, selection, setNotebook])

  // ------------------------------------------------------------- persistence

  // Persist only after hydration. Writing before `state:get` resolves could
  // overwrite a good state file with this renderer's empty default.
  useEffect(() => {
    if (hydrated) saveState(state)
  }, [hydrated, state])

  useEffect(() => {
    const flushLatest = () => {
      const current = stateRef.current
      const positions = scrollPositions.current
      const ratios = scrollRatios.current
      const next = {
        ...current,
        session: {
          ...current.session,
          tabs: current.session.tabs.map((tab) => tab.path in positions ? {
            ...tab,
            scrollTop: positions[tab.path],
            ...(tab.path in ratios ? { scrollRatio: ratios[tab.path] } : {}),
          } : tab),
        },
      }
      flushState(next)
    }
    window.addEventListener('pagehide', flushLatest)
    window.addEventListener('beforeunload', flushLatest)
    window.addEventListener('blur', flushLatest)
    return () => {
      window.removeEventListener('pagehide', flushLatest)
      window.removeEventListener('beforeunload', flushLatest)
      window.removeEventListener('blur', flushLatest)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadState().then((loaded) => {
      if (cancelled) return
      setState(loaded)
      setHydrated(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Keep the persisted model name in sync with the legacy key for older builds.
  useEffect(() => {
    try { localStorage.setItem(MODEL_KEY, model) } catch { /* ignore */ }
  }, [model])

  // ------------------------------------------------------------- documents

  const loadDocument = useCallback(async (path: string, name: string, force = false) => {
    const kind = documentKindFor(path)
    if (!kind) {
      setDocs((prev) => ({
        ...prev,
        [path]: { ...emptyDocument(), status: 'error', error: '暂不支持这种文件格式（支持 PDF、EPUB、TXT、Markdown）。' },
      }))
      return
    }
    const existing = docsRef.current[path]
    // Opening the same path again while its first load is still in flight must
    // reuse that load. Starting a second PDF load for the same cache key races
    // page metadata/render work and leaks the first cache reference.
    if (!force && existing?.kind === kind && (existing.status === 'ready' || existing.status === 'loading')) return

    // A generation token per path: closing (and reopening) a tab while its file
    // is still loading must not let the stale load write into the new tab.
    const token = ++loadTokenRef.current
    loadTokens.current.set(path, token)
    const isCurrent = () => loadTokens.current.get(path) === token
    const port = fileSystem()
    let acquired = false
    const documentKey = documentKeyFor(path, name)
    setDocs((prev) => {
      // Closing a replaced document must not leak its blob URLs.
      const previous = prev[path]
      if (previous?.epub) previous.epub.revokeAll()
      return { ...prev, [path]: emptyDocument(kind) }
    })

    try {
      if (kind === 'pdf') {
        const pdf = await acquireDocument(
          documentKey,
          () => port.read(path),
          (ratio) => {
            if (isCurrent()) setDocs((prev) => (prev[path] ? { ...prev, [path]: { ...prev[path], progress: ratio } } : prev))
          },
        )
        acquired = true
        const meta = await readDocumentMeta(pdf)
        if (!isCurrent()) return
        setDocs((prev) => ({
          ...prev,
          [path]: {
            ...emptyDocument('pdf'),
            status: 'ready', progress: 1, pdf, error: '',
            pageCount: meta.pageCount, basePageWidth: meta.basePageWidth,
            firstPageRatio: meta.firstPageRatio, outline: meta.outline,
          },
        }))
        return
      }

      const bytes = await port.read(path)
      if (!isCurrent()) return
      if (kind === 'text') {
        const marks = isMarkdownPath(path)
        const blocks = parseTextDocument(decodeDocumentText(bytes), marks)
        if (!isCurrent()) return
        setDocs((prev) => ({
          ...prev,
          [path]: {
            ...emptyDocument('text'),
            status: 'ready', progress: 1, error: '',
            blocks, flowOutline: outlineFromBlocks(blocks),
          },
        }))
        return
      }

      const epub = await openEpub(bytes)
      if (!isCurrent()) {
        epub.revokeAll()
        return
      }
      setDocs((prev) => ({
        ...prev,
        [path]: {
          ...emptyDocument('epub'),
          status: 'ready', progress: 1, error: '',
          epub, flowOutline: epub.outline, pageCount: epub.chapters.length,
        },
      }))
    } catch (error) {
      console.error('document could not be opened', path, error)
      // Balance the acquire: without this the cached document is never released
      // and every 重试 would leak another reference.
      if (acquired && isCurrent()) releaseDocument(documentKey)
      if (!isCurrent()) return
      setDocs((prev) => ({
        ...prev,
        [path]: {
          ...emptyDocument(kind),
          status: 'error',
          error: error instanceof Error ? error.message : '无法读取这个文件。它可能已损坏、受密码保护或已被移动。',
        },
      }))
    }
  }, [])

  const openDocument = useCallback((path: string, options?: { background?: boolean }) => {
    if (!path) return
    const name = displayNameForPath(path)
    setState((prev) => {
      const exists = prev.session.tabs.some((tab) => tab.path === path)
      const tabs = exists ? prev.session.tabs : [...prev.session.tabs, { path, name, pageNumber: 1, zoom: 1, scrollTop: 0 }]
      return {
        ...prev,
        session: {
          ...prev.session,
          tabs,
          activePath: options?.background ? (prev.session.activePath ?? path) : path,
          recentFiles: touchRecent(prev.session.recentFiles, { path, name, openedAt: Date.now() }),
        },
      }
    })
    void loadDocument(path, name)
  }, [loadDocument])

  /** The `+` on any tab strip: a new blank note in the vault, opened for editing. */
  const createBlankNote = useCallback(async () => {
    if (!vaultRef.current.ready) {
      const picked = await vaultRef.current.chooseVault()
      if (!picked) return
    }
    try {
      const path = await vaultRef.current.createNote(noteFolderPath(null), '未命名')
      openNoteInNotesSpace(path)
    } catch (error) {
      setVaultActionMessage({ kind: 'error', text: error instanceof Error ? error.message : '无法新建笔记。' })
    }
  }, [openNoteInNotesSpace])

  /** Opens a material from the vault in the reading desk. */
  const openVaultSource = useCallback((relativePath: string) => {
    const root = stateRef.current.vault.root
    if (!root) return
    switchSpace('reader')
    openDocument(absoluteVaultPath(root, relativePath))
  }, [openDocument, switchSpace])

  const openExpressionSource = useCallback((context: ExpressionContext) => {
    const sourcePath = context.sourcePath || ''
    if (!sourcePath) return
    if (context.sourceKind === 'chat' && sourcePath.startsWith('chat:')) {
      setExpressionSourcePreview(null)
      const threadId = sourcePath.slice('chat:'.length)
      if (threadId) activateThread(threadId)
      switchSpace('chat')
      return
    }
    if (sourcePath.startsWith('notes/') || sourcePath.startsWith('enlightenment/') || sourcePath.startsWith('Daily/')) {
      setExpressionSourcePreview(null)
      openNoteInNotesSpace(sourcePath)
      return
    }
    const root = stateRef.current.vault.root
    const path = sourcePath.startsWith('materials/') && root ? absoluteVaultPath(root, sourcePath) : sourcePath
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('\\\\')) return
    const preview: InputMarker | undefined = context.quote && !context.generated
      && (context.sourceKind === 'pdf' || context.sourceKind === 'epub' || context.sourceKind === 'text')
      ? {
        id: `expression-source-${context.id}`,
        sourcePath: path,
        sourceKind: context.sourceKind,
        purpose: 'form',
        visualStyle: 'highlight',
        quote: context.quote,
        before: context.before,
        after: context.after,
        pageNumber: context.pageNumber,
        locationLabel: context.locationLabel,
        startOffset: context.startOffset,
        endOffset: context.endOffset,
        blockIndex: context.blockIndex,
        comment: '表达来源',
        createdAt: context.createdAt,
      }
      : undefined
    setExpressionSourcePreview(preview || null)
    setPendingSourceJump({ path, position: Math.max(1, context.pageNumber || 1), ...(preview ? { marker: preview } : {}) })
    switchSpace('reader')
    openDocument(path)
  }, [activateThread, openDocument, openNoteInNotesSpace, switchSpace])

  const expressionPreviewPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!expressionSourcePreview) {
      expressionPreviewPathRef.current = null
      return
    }
    if (activePath === expressionSourcePreview.sourcePath) {
      expressionPreviewPathRef.current = expressionSourcePreview.sourcePath
      return
    }
    if (expressionPreviewPathRef.current === expressionSourcePreview.sourcePath) setExpressionSourcePreview(null)
  }, [activePath, expressionSourcePreview])

  const commitScroll = useCallback(() => {
    if (!scrollDirty.current) return
    scrollDirty.current = false
    const positions = { ...scrollPositions.current }
    const ratios = { ...scrollRatios.current }
    setSession((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => {
        if (!(tab.path in positions)) return tab
        return {
          ...tab,
          scrollTop: positions[tab.path],
          ...(tab.path in ratios ? { scrollRatio: ratios[tab.path] } : {}),
        }
      }),
    }))
  }, [setSession])

  const closeTab = useCallback((path: string) => {
    commitScroll()
    // Drop any in-flight load for this path so it cannot resolve into a closed tab.
    loadTokens.current.delete(path)
    releaseDocument(documentKeyFor(path, displayNameForPath(path)))
    delete scrollPositions.current[path]
    setDocs((prev) => {
      if (!(path in prev)) return prev
      const closing = prev[path]
      if (closing?.epub) closing.epub.revokeAll()
      const next = { ...prev }
      delete next[path]
      return next
    })
    setSession((current) => {
      const index = current.tabs.findIndex((tab) => tab.path === path)
      const tabs = current.tabs.filter((tab) => tab.path !== path)
      let nextActive = current.activePath
      if (nextActive === path) {
        const neighbour = tabs[Math.min(Math.max(index, 0), tabs.length - 1)]
        nextActive = neighbour ? neighbour.path : null
      }
      return { ...current, tabs, activePath: nextActive }
    })
  }, [commitScroll, setSession])

  const activateTab = useCallback((path: string) => {
    commitScroll()
    setSession((current) => ({ ...current, activePath: path }))
  }, [commitScroll, setSession])

  // Restore the previous session: folder, open tabs and reading positions.
  useEffect(() => {
    if (!hydrated || restoredRef.current) return
    restoredRef.current = true
    const restored = stateRef.current.session
    if (restored.activeFolder) void openFolderInternal(restored.activeFolder)
    const paths = restored.tabs.map((tab) => tab.path)
    if (paths.length === 0) return
    const ordered = restored.activePath && paths.includes(restored.activePath)
      ? [restored.activePath, ...paths.filter((path) => path !== restored.activePath)]
      : paths
    void (async () => {
      for (const path of ordered) {
        const info = await fileSystem().stat(path).catch(() => ({ exists: false }))
        if (info.exists) await loadDocument(path, displayNameForPath(path))
        else closeTab(path)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  // Periodically persist the reading position without re-rendering per scroll.
  useEffect(() => {
    const timer = window.setInterval(() => commitScroll(), 5000)
    return () => window.clearInterval(timer)
  }, [commitScroll])

  // ------------------------------------------------------------- file browser

  const openFolderInternal = useCallback(async (path: string, options?: { asRoot?: boolean }) => {
    if (!path) return
    setExplorer((prev) => ({ ...prev, loading: true, error: '' }))
    try {
      const listing = await fileSystem().list(path)
      setExplorer((prev) => ({
        ...prev,
        current: listing.path,
        root: options?.asRoot ? listing.path : (prev.root ?? listing.path),
        listing,
        loading: false,
        error: '',
      }))
      setSession((current) => ({
        ...current,
        activeFolder: listing.path,
        recentFolders: touchStrings(current.recentFolders, listing.path),
      }))
    } catch (error) {
      setExplorer((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : '无法读取这个文件夹。',
      }))
    }
  }, [setSession])

  const pickFolder = useCallback(async () => {
    const port = fileSystem()
    if (!port.canBrowse) {
      window.alert('当前运行环境无法浏览文件夹。请在 Paperlight app 中使用此功能。')
      return
    }
    const picked = await port.pickFolder()
    if (picked) await openFolderInternal(picked, { asRoot: true })
  }, [openFolderInternal])

  const pickFiles = useCallback(async () => {
    const paths = await fileSystem().pickDocuments()
    paths.forEach((path: string, index: number) => openDocument(path, { background: index > 0 }))
  }, [openDocument])

  const goUpFolder = useCallback(() => {
    const parent = explorer.listing?.parent
    if (parent && parent !== explorer.current) void openFolderInternal(parent)
  }, [explorer.current, explorer.listing, openFolderInternal])

  const toggleFavoriteFolder = useCallback((path: string) => {
    setSession((current) => ({
      ...current,
      favorites: current.favorites.includes(path)
        ? current.favorites.filter((item) => item !== path)
        : [path, ...current.favorites].slice(0, 12),
    }))
  }, [setSession])

  useEffect(() => {
    void fileSystem().roots().then(setRoots).catch(() => setRoots([]))
  }, [])

  // ------------------------------------------------------------- bridge events

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge) return
    const offPaths = bridge.on.openPaths((paths) => {
      paths.forEach((path, index) => openDocument(path, { background: index > 0 }))
    })
    const offFolder = bridge.on.openFolder((path) => { void openFolderInternal(path, { asRoot: true }) })
    const offVault = bridge.on.setVault((path) => {
      void vaultRef.current.useVaultPath(path).then((ok) => { if (ok) switchSpace('notes') })
    })
    const offCommand = bridge.on.command((command) => {
      const current = stateRef.current
      if (command === 'space-reader' || command === 'space-notes' || command === 'space-chat') {
        switchSpace(command === 'space-reader' ? 'reader' : command === 'space-notes' ? 'notes' : 'chat')
        return
      }
      if (command === 'pick-vault') {
        void vaultRef.current.chooseVault()
        return
      }
      const path = current.session.activePath
      if (!path) return
      const tab = current.session.tabs.find((item) => item.path === path)
      if (command === 'close-tab') closeTab(path)
      else if (command === 'zoom-in') updateTab(path, { zoom: clamp(Number(((tab?.zoom ?? 1) + 0.1).toFixed(2)), 0.5, 3) })
      else if (command === 'zoom-out') updateTab(path, { zoom: clamp(Number(((tab?.zoom ?? 1) - 0.1).toFixed(2)), 0.5, 3) })
      else if (command === 'zoom-fit') updateTab(path, { zoom: 1 })
      else if (command === 'next-page') pageApiRef.current?.scrollToPage((tab?.pageNumber ?? 1) + 1)
      else if (command === 'prev-page') pageApiRef.current?.scrollToPage((tab?.pageNumber ?? 1) - 1)
    })
    return () => { offPaths(); offFolder(); offVault(); offCommand() }
  }, [closeTab, openDocument, openFolderInternal, switchSpace, updateTab])

  // ------------------------------------------------------------- sense + chat

  const runTranslation = useCallback(async (next: TextSelection, requestedMode = mode, requestedModel = model) => {
    translationControllerRef.current?.abort()
    const controller = new AbortController()
    translationControllerRef.current = controller
    const requestId = ++translationRequestRef.current
    setTranslationLoading(true)
    setTranslationError('')
    try {
      const result = await translateSelection(next, requestedMode, requestedModel, controller.signal)
      if (requestId === translationRequestRef.current) setTranslation(result)
    } catch (error) {
      if (requestId === translationRequestRef.current && !isAbortError(error)) {
        setTranslationError(error instanceof Error ? error.message : '翻译失败，请稍后重试。')
      }
    } finally {
      if (requestId === translationRequestRef.current) {
        translationControllerRef.current = null
        setTranslationLoading(false)
      }
    }
  }, [mode, model])

  const cancelTranslation = useCallback(() => translationControllerRef.current?.abort(), [])

  const runSenseLookup = useCallback(async (term: string, context: string) => {
    const cleaned = term.trim()
    if (!cleaned) return
    setPendingSemanticCapture(null)
    const requestId = ++senseRequestRef.current
    senseControllerRef.current?.abort()
    const controller = new AbortController()
    senseControllerRef.current = controller
    lastContextRef.current = context
    setSenseAnswerId(null)
    setSenseLoading(true)
    setSenseError('')
    setAllSenses(null)
    setChatError('')
    try {
      const result = await lookupSense(cleaned, context, model, controller.signal)
      if (requestId !== senseRequestRef.current) return
      setSense({
        ...result,
        term: result.term || cleaned,
        lemma: result.lemma || cleaned,
        examples: Array.isArray(result.examples) ? result.examples : [],
      })
      setSenseAnswerId(`reader-answer:${requestId}`)
      setRightTab('sense')
    } catch (error) {
      if (requestId === senseRequestRef.current && !isAbortError(error)) {
        setSenseError(error instanceof Error ? error.message : '语义查询失败。')
      }
    } finally {
      if (requestId === senseRequestRef.current) {
        senseControllerRef.current = null
        setSenseLoading(false)
      }
    }
  }, [model])

  const cancelSenseLookup = useCallback(() => senseControllerRef.current?.abort(), [])

  const captureSelectedExpression = useCallback((event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('.expression-capture-popover, .expression-inline-add, .input-mark-inline, .input-marker-composer, .input-marker-menu, .reader-toolbar')) return
    let text = ''
    let context: Partial<ExpressionContext> = {}
    let rect: DOMRect | null = null
    let isReader = false

    if (target instanceof HTMLTextAreaElement && target.classList.contains('note-textarea')) {
      const start = target.selectionStart
      const end = target.selectionEnd
      if (end <= start) { setExpressionCapture(null); return }
      text = target.value.slice(start, end).trim()
      const scope = target.closest<HTMLElement>('[data-expression-source]')
      const sourceKind = scope?.dataset.expressionSource === 'enlightenment' ? 'enlightenment' : 'note'
      context = {
        sourceKind,
        sourcePath: scope?.dataset.expressionPath || notesSpace.activePath || undefined,
        sourceName: scope?.dataset.expressionName || 'Vault 笔记',
        startOffset: start,
        endOffset: end,
        before: target.value.slice(Math.max(0, start - 350), start),
        after: target.value.slice(end, end + 350),
      }
      rect = target.getBoundingClientRect()
    } else {
      const browserSelection = window.getSelection()
      const range = browserSelection && browserSelection.rangeCount ? browserSelection.getRangeAt(0) : null
      const raw = browserSelection?.toString() || ''
      text = tidyText(raw)
      if (!range || !text) { setExpressionCapture(null); return }
      const startNode = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
      const pageElement = startNode?.closest<HTMLElement>('[data-page-number]')
      const scope = pageElement || startNode?.closest<HTMLElement>('[data-expression-source]')
      if (!scope) { setExpressionCapture(null); return }
      rect = range.getBoundingClientRect()
      if (pageElement) {
        isReader = true
        const pageLayer = pageElement.querySelector('.textLayer') || pageElement
        const sourceText = tidyText(pageLayer.textContent || '')
        const index = sourceText.indexOf(text)
        const blockElement = startNode?.closest<HTMLElement>('[id^="flow-block-"], [data-paperlight-block-index]')
        const blockIndexText = blockElement?.id.match(/^flow-block-(\d+)$/)?.[1]
          ?? blockElement?.dataset.paperlightBlockIndex
        context = {
          sourceKind: activeDoc?.kind === 'pdf' ? 'pdf' : activeDoc?.kind === 'epub' ? 'epub' : 'text',
          sourcePath: activePath || undefined,
          sourceName: activeTab?.name || '当前材料',
          locationLabel: pageElement.dataset.location || undefined,
          pageNumber: Number(pageElement.dataset.pageNumber || 1),
          startOffset: index >= 0 ? index : undefined,
          endOffset: index >= 0 ? index + text.length : undefined,
          blockIndex: blockIndexText !== undefined && Number.isSafeInteger(Number(blockIndexText)) ? Number(blockIndexText) : undefined,
          quote: text,
          before: index >= 0 ? sourceText.slice(Math.max(0, index - 350), index) : '',
          after: index >= 0 ? sourceText.slice(index + text.length, index + text.length + 350) : '',
        }
      } else {
        const sourceKind = scope.dataset.expressionSource
        if (sourceKind !== 'assistant' && sourceKind !== 'chat' && sourceKind !== 'note' && sourceKind !== 'enlightenment') {
          setExpressionCapture(null)
          return
        }
        const sourceText = tidyText(scope.textContent || '')
        const index = sourceText.indexOf(text)
        context = {
          sourceKind,
          sourcePath: scope.dataset.expressionPath || (sourceKind === 'assistant' ? activePath || undefined : undefined),
          sourceName: scope.dataset.expressionName || (sourceKind === 'chat' ? '自由对话' : sourceKind === 'assistant' ? '阅读助手' : 'Vault 笔记'),
          startOffset: index >= 0 ? index : undefined,
          endOffset: index >= 0 ? index + text.length : undefined,
          quote: text,
          before: index >= 0 ? sourceText.slice(Math.max(0, index - 350), index) : '',
          after: index >= 0 ? sourceText.slice(index + text.length, index + text.length + 350) : '',
        }
      }
    }

    if (text.length < 2 || text.length > 280 || !rect) { setExpressionCapture(null); return }
    setExpressionCapture({
      text,
      context,
      x: Math.max(180, Math.min(window.innerWidth - 180, rect.left + rect.width / 2)),
      y: Math.max(56, Math.min(window.innerHeight - 70, rect.bottom + 8)),
      reader: isReader,
    })
  }, [activeDoc?.kind, activePath, activeTab?.name, notesSpace.activePath])

  const saveSelectedExpression = useCallback(async () => {
    if (!expressionCapture) return
    if (!vaultApi.ready) {
      setExpressionCaptureNotice('请先选择 Vault，收录内容会保存为其中的 Markdown 文件。')
      return
    }
    try {
      const record = await vaultApi.captureExpression({
        expression: expressionCapture.text,
        cognitivePath: 'recognition',
        context: { ...expressionCapture.context, quote: expressionCapture.text },
      })
      setExpressionCapture(null)
      window.getSelection()?.removeAllRanges()
      setExpressionCaptureNotice(`已收录「${record.expression}」，来源语境已保留。`)
      window.setTimeout(() => setExpressionCaptureNotice(''), 4000)
    } catch (error) {
      setExpressionCaptureNotice(error instanceof Error ? error.message : '表达收录失败。')
    }
  }, [expressionCapture, vaultApi.captureExpression, vaultApi.ready])

  const startInputMarker = (context: Partial<ExpressionContext> & { blockIndex?: number }, x = window.innerWidth / 2, y = window.innerHeight / 2) => {
    const sourceKind = context.sourceKind || (activeDoc?.kind === 'pdf' ? 'pdf' : activeDoc?.kind === 'epub' ? 'epub' : activeDoc?.kind === 'text' ? 'text' : 'manual')
    const sourcePath = context.sourcePath || (sourceKind === 'assistant' ? activePath || undefined : undefined)
    if (!sourcePath) {
      setInputMarkerNotice('当前选区没有可回溯的来源，暂时无法创建输入标记。')
      window.setTimeout(() => setInputMarkerNotice(''), 4000)
      return
    }
    const activeScroller = sourcePath === activePath && (sourceKind === 'text' || sourceKind === 'epub')
      ? document.querySelector<HTMLElement>('.reader-scroll')
      : null
    const scrollMax = activeScroller ? Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight) : 0
    const liveScrollRatio = activeScroller && scrollMax > 4 ? activeScroller.scrollTop / scrollMax : undefined
    setInputMarkerDraft({
      sourcePath,
      sourceKind,
      purpose: 'form',
      quote: context.quote,
      before: context.before,
      after: context.after,
      pageNumber: context.pageNumber,
      locationLabel: context.locationLabel,
      startOffset: context.startOffset,
      endOffset: context.endOffset,
      blockIndex: context.blockIndex,
      scrollRatio: (sourceKind === 'text' || sourceKind === 'epub') && sourcePath === activePath
        ? (liveScrollRatio ?? scrollRatios.current[sourcePath] ?? activeTab?.scrollRatio)
        : undefined,
      comment: '',
      x: Math.max(190, Math.min(window.innerWidth - 190, x)),
      y: Math.max(60, Math.min(window.innerHeight - 320, y)),
    })
    setExpressionCapture(null)
  }

  const startMarkerFromReaderSelection = () => {
    if (!selection) return
    startInputMarker({
      sourceKind: activeDoc?.kind === 'pdf' ? 'pdf' : activeDoc?.kind === 'epub' ? 'epub' : 'text',
      sourcePath: selection.documentPath || activePath || undefined,
      sourceName: selection.documentName,
      quote: selection.text,
      before: selection.before,
      after: selection.after,
      pageNumber: selection.pageNumber,
      locationLabel: selection.locationLabel,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      blockIndex: selection.blockIndex,
    }, anchor?.x, anchor ? anchor.y + 12 : undefined)
  }

  const saveInputMarker = () => {
    if (!inputMarkerDraft) return
    const { x: _x, y: _y, ...marker } = inputMarkerDraft
    const saved: InputMarker = {
      ...marker,
      id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: new Date().toISOString(),
    }
    setState((current) => ({ ...current, inputMarkers: [...current.inputMarkers, saved] }))
    setInputMarkerDraft(null)
    setInputMarkerNotice('输入标记已保存；关闭材料后仍可从标记菜单返回。')
    window.setTimeout(() => setInputMarkerNotice(''), 4000)
  }

  const addProgressBookmark = () => {
    if (!activePath || !activeDoc || !activeTab) return
    const scroller = document.querySelector<HTMLElement>('.reader-scroll')
    const scrollMax = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0
    const scrollRatio = scroller && scrollMax > 4 ? scroller.scrollTop / scrollMax : activeTab.scrollRatio ?? 0
    const sourceKind: InputMarker['sourceKind'] = activeDoc.kind === 'pdf' ? 'pdf' : activeDoc.kind === 'epub' ? 'epub' : 'text'
    const position: Pick<InputMarker, 'quote' | 'before' | 'after' | 'blockIndex' | 'pageNumber' | 'startOffset' | 'endOffset'> = sourceKind === 'pdf'
      ? scroller ? capturePdfBookmark(scroller, activeTab.pageNumber || 1) : { pageNumber: activeTab.pageNumber || 1 }
      : scroller ? captureFlowBookmark(scroller) : {}
    const duplicate = activeInputMarkers.find((marker) => {
      if (marker.purpose !== 'progress' || marker.sourcePath !== activePath) return false
      const quote = bookmarkText(position.quote || '')
      if (sourceKind === 'pdf' && quote && marker.quote) {
        return marker.pageNumber === (position.pageNumber || activeTab.pageNumber)
          && bookmarkText(marker.quote) === quote
          && (marker.startOffset === position.startOffset
            || (bookmarkText(marker.before || '') === bookmarkText(position.before || '')
              && bookmarkText(marker.after || '') === bookmarkText(position.after || '')))
      }
      if (quote && marker.quote) return bookmarkText(marker.quote) === quote
      return marker.pageNumber === activeTab.pageNumber && Math.abs((marker.scrollRatio ?? -1) - scrollRatio) < 0.015
    })
    if (duplicate) {
      setInputMarkerNotice('这个阅读位置已有书签。')
      window.setTimeout(() => setInputMarkerNotice(''), 2500)
      setInputMarkerMenuOpen(true)
      return
    }
    const locationLabel = flowLocation
      || (activeDoc.kind === 'epub' ? activeDoc.epub?.chapters[activeTab.chapterIndex ?? 0]?.title : undefined)
      || undefined
    const saved: InputMarker = {
      id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      sourcePath: activePath,
      sourceKind,
      purpose: 'progress',
      pageNumber: position.pageNumber || activeTab.pageNumber || 1,
      locationLabel,
      scrollRatio,
      ...position,
      comment: `阅读进度${locationLabel ? ` · ${locationLabel}` : position.quote ? ` · ${position.quote.slice(0, 44)}` : ''}`,
      createdAt: new Date().toISOString(),
    }
    setState((current) => ({ ...current, inputMarkers: [...current.inputMarkers, saved] }))
    setInputMarkerMenuOpen(true)
    setInputMarkerNotice(position.quote
      ? '当前位置和段落已加入阅读书签。'
      : activeDoc.kind === 'pdf'
        ? 'PDF 当前页已加入书签；该页没有可定位的文本层。'
        : '阅读位置已加入书签。')
    window.setTimeout(() => setInputMarkerNotice(''), 3000)
  }

  const removeInputMarker = (id: string) => {
    setState((current) => ({ ...current, inputMarkers: current.inputMarkers.filter((marker) => marker.id !== id) }))
  }

  const restoreFlowBookmark = useCallback((marker: InputMarker) => {
    if (marker.sourceKind === 'text' && marker.blockIndex !== undefined) {
      flowApiRef.current?.scrollToBlock?.(marker.blockIndex)
    }
    if (marker.sourceKind === 'epub' && marker.blockIndex !== undefined) {
      let attempt = 0
      const jumpToEpubBlock = () => {
        if (stateRef.current.session.activePath !== marker.sourcePath) return
        const scroller = document.querySelector<HTMLElement>('.reader-scroll')
        const target = scroller?.querySelector<HTMLElement>(`[data-paperlight-block-index="${marker.blockIndex}"]`)
        if (target && scroller) {
          alignReaderElement(scroller, target)
          return
        }
        if (attempt++ < 24) window.setTimeout(jumpToEpubBlock, 80)
      }
      window.setTimeout(jumpToEpubBlock, 60)
    }
    if (!marker.quote) return
    let attempt = 0
    const find = () => {
      if (stateRef.current.session.activePath !== marker.sourcePath) return
      const scroller = document.querySelector<HTMLElement>('.reader-scroll')
      const target = scroller ? findFlowBookmarkTarget(scroller, marker) : null
      if (target && scroller) {
        alignReaderElement(scroller, target)
        return
      }
      if (attempt++ < 24) {
        window.setTimeout(find, 80)
        return
      }
      if (scroller && marker.scrollRatio !== undefined) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * marker.scrollRatio
      }
      setInputMarkerNotice('找不到书签中的原文段落，已保留在近似阅读位置；材料内容可能已改变。')
      window.setTimeout(() => setInputMarkerNotice(''), 4500)
    }
    window.setTimeout(find, 60)
  }, [])

  const restorePdfBookmark = useCallback((marker: InputMarker) => {
    if (!marker.quote) return
    pageApiRef.current?.scrollToPage(marker.pageNumber || 1)
    let attempt = 0
    const find = () => {
      if (stateRef.current.session.activePath !== marker.sourcePath) return
      const scroller = document.querySelector<HTMLElement>('.reader-scroll')
      const page = scroller?.querySelector<HTMLElement>(`.pdf-page-shell[data-page-number="${marker.pageNumber || 1}"]`)
      const textLayer = page?.querySelector<HTMLElement>('.textLayer')
      const range = textLayer ? markerRangeInElement(textLayer, marker) : null
      const rect = range?.getBoundingClientRect()
      if (scroller && rect && rect.width > 0 && rect.height > 0) {
        const offset = rect.top - scroller.getBoundingClientRect().top - 120
        if (Math.abs(offset) > 4) scroller.scrollTop = Math.max(0, scroller.scrollTop + offset)
        return
      }
      if (attempt++ < 36) {
        window.setTimeout(find, 80)
        return
      }
      setInputMarkerNotice('找不到书签中的原文行，已定位到所在页；材料内容可能已改变。')
      window.setTimeout(() => setInputMarkerNotice(''), 4500)
    }
    window.setTimeout(find, 80)
  }, [])

  const jumpToInputMarker = (marker: InputMarker) => {
    if (activeDoc?.kind === 'epub') setEpubAlignmentTail(null)
    setInputMarkerMenuOpen(false)
    if (marker.sourceKind === 'chat' && marker.sourcePath.startsWith('chat:')) {
      activateThread(marker.sourcePath.slice('chat:'.length))
      switchSpace('chat')
      return
    }
    if (marker.sourceKind === 'note' || marker.sourceKind === 'enlightenment') {
      if (marker.sourcePath.startsWith('notes/') || marker.sourcePath.startsWith('enlightenment/')) {
        openNoteInNotesSpace(marker.sourcePath)
        return
      }
    }
    if (marker.sourcePath !== activePath) {
      if (marker.sourcePath.startsWith('materials/') && stateRef.current.vault.root) {
        const path = absoluteVaultPath(stateRef.current.vault.root, marker.sourcePath)
        setPendingSourceJump({ path, position: marker.pageNumber || 1, marker })
        switchSpace('reader')
        openDocument(path)
      } else if (marker.sourcePath.startsWith('/')) {
        setPendingSourceJump({ path: marker.sourcePath, position: marker.pageNumber || 1, marker })
        switchSpace('reader')
        openDocument(marker.sourcePath)
      }
      return
    }
    if (activeDoc?.kind === 'pdf') {
      pageApiRef.current?.scrollToPage(marker.pageNumber || 1)
      window.setTimeout(() => restorePdfBookmark(marker), 100)
    }
    else if (activeDoc?.kind === 'epub') {
      handleChapterChange((marker.pageNumber || 1) - 1)
      window.setTimeout(() => restoreFlowBookmark(marker), 80)
    }
    else if (activeDoc?.kind === 'text') {
      const scroller = document.querySelector<HTMLElement>('.reader-scroll')
      if (marker.blockIndex !== undefined) flowApiRef.current?.scrollToBlock?.(marker.blockIndex)
      else if (scroller && marker.scrollRatio !== undefined) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * marker.scrollRatio
      } else flowApiRef.current?.scrollToTop()
      window.setTimeout(() => restoreFlowBookmark(marker), 80)
    }
    const alignVisualMarker = (attempt = 0) => {
      const visual = document.querySelector<HTMLElement>(`.input-marker-visual[data-marker-id="${CSS.escape(marker.id)}"]`)
      const scroller = document.querySelector<HTMLElement>('.reader-scroll')
      if (visual && scroller) {
        const offset = visual.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 110
        if (Math.abs(offset) > 4) {
          const desiredScrollTop = scroller.scrollTop + offset
          const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          const additionalTail = Math.ceil(desiredScrollTop - maxScrollTop)
          if (additionalTail > 0 && activeDoc?.kind === 'epub' && activePath) {
            setEpubAlignmentTail((current) => current?.path === activePath
              && current.chapterIndex === (activeTab?.chapterIndex ?? 0)
              && current.padding >= additionalTail
              ? current
              : { path: activePath, chapterIndex: activeTab?.chapterIndex ?? 0, padding: additionalTail })
            if (attempt < 12) window.setTimeout(() => alignVisualMarker(attempt + 1), 80)
            return
          }
          scroller.scrollTop = Math.min(desiredScrollTop, maxScrollTop)
        }
        if (attempt < 12 && Math.abs(offset) > 4) window.setTimeout(() => alignVisualMarker(attempt + 1), 60)
      } else if (marker.visualStyle && attempt < 12) {
        window.setTimeout(() => alignVisualMarker(attempt + 1), 60)
      }
    }
    window.setTimeout(() => alignVisualMarker(), 120)
  }

  const selectText = useCallback(() => {
    const browserSelection = window.getSelection()
    const rawText = browserSelection?.toString() || ''
    const text = tidyText(rawText)
    if (text.length < 2 || !browserSelection || browserSelection.rangeCount === 0) return
    const range = browserSelection.getRangeAt(0)
    const startNode = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    // Works for every reader: PDF pages, reflowed text and EPUB chapters all
    // expose their selectable content under [data-page-number].
    const pageElement = startNode?.closest<HTMLElement>('[data-page-number]')
    if (!pageElement) return
    const pageLayer = pageElement.querySelector('.textLayer') || pageElement
    const pageText = tidyText(pageLayer.textContent || '')
    const index = pageText.indexOf(text)
    const blockElement = startNode?.closest<HTMLElement>('[id^="flow-block-"], [data-paperlight-block-index]')
    const blockIndexText = blockElement?.id.match(/^flow-block-(\d+)$/)?.[1]
      ?? blockElement?.dataset.paperlightBlockIndex
    const rect = range.getBoundingClientRect()
    const next: TextSelection = {
      text,
      before: index >= 0 ? pageText.slice(Math.max(0, index - 500), index) : '',
      after: index >= 0 ? pageText.slice(index + text.length, index + text.length + 500) : '',
      pageNumber: Number(pageElement.dataset.pageNumber || 1),
      startOffset: index >= 0 ? index : undefined,
      endOffset: index >= 0 ? index + text.length : undefined,
      blockIndex: blockIndexText !== undefined && Number.isSafeInteger(Number(blockIndexText)) ? Number(blockIndexText) : undefined,
      locationLabel: pageElement.dataset.location || undefined,
      documentName: activeTab?.name,
      documentPath: activePath || undefined,
    }
    setSelection(next)
    setTranslation('')
    setTranslationError('')
    setLayout((current) => ({ ...current, rightOpen: true }))
    setRightTab('sense')
    setAnchor({
      x: Math.max(174, Math.min(window.innerWidth - 174, rect.left + rect.width / 2)),
      y: Math.max(82, rect.top - 12),
    })
    const term = termFromSelection(text)
    setQueryTerm(term)
    lastContextRef.current = sentenceAround(pageText, index, text.length)
    senseRequestRef.current += 1
    setSenseLoading(false)
    setSense(null)
    setSenseAnswerId(null)
    setSenseError('')
    setAllSenses(null)
  }, [activePath, activeTab?.name])

  const setLayout = useCallback((updater: (current: PersistedState['layout']) => PersistedState['layout']) => {
    setState((prev) => ({ ...prev, layout: updater(prev.layout) }))
  }, [])

  function addCurrentSense() {
    requestSemanticCapture('notebook')
  }

  async function expandCurrent() {
    const term = (sense?.lemma || queryTerm).trim()
    if (!term || expanding) return
    setExpanding(true)
    setSenseError('')
    expandControllerRef.current?.abort()
    const controller = new AbortController()
    expandControllerRef.current = controller
    try {
      setAllSenses(await expandSenses(term, model, controller.signal))
    } catch (error) {
      if (!isAbortError(error)) setSenseError(error instanceof Error ? error.message : '无法获取其他语义。')
    } finally {
      expandControllerRef.current = null
      setExpanding(false)
    }
  }

  function cancelExpand() { expandControllerRef.current?.abort() }

  function pushChat(message: ChatMessage) {
    if (!senseId) return
    setNotebook((current) => ({ ...current, chat: { ...current.chat, [senseId]: [...(current.chat[senseId] || []), message] } }))
  }

  async function sendChat(question: string) {
    if (!sense || !senseId) return
    const history = (chat[senseId] || []).slice(-8).map((message) => ({ role: message.role, content: message.content }))
    pushChat(newMessage('user', question))
    readerChatControllerRef.current?.abort()
    const controller = new AbortController()
    readerChatControllerRef.current = controller
    setChatSending(true)
    setChatError('')
    try {
      const answer = await askSense({
        term: sense.term || sense.lemma,
        sense: { contextualMeaning: sense.contextualMeaning, definition: sense.definition },
        question,
        history,
        model,
      }, controller.signal)
      pushChat(newMessage('assistant', answer))
    } catch (error) {
      if (isAbortError(error)) setChatError('已停止生成。')
      else setChatError(error instanceof Error ? error.message : '对话失败，请重试。')
    } finally {
      readerChatControllerRef.current = null
      setChatSending(false)
    }
  }

  function cancelReaderChat() { readerChatControllerRef.current?.abort() }

  // Saving any excerpt also stores the term ↔ sense atom so the link resolves.
  function saveExcerpt(body: string, sourceMessageId?: string) {
    if (!sense || (sourceMessageId && savedMessageIds.has(sourceMessageId))) return
    const selectedSource = selection?.documentPath === activePath
      && selectionMatchesSemanticTerm(selection.text, [sense.term, sense.lemma, queryTerm])
      ? selection : null
    const atom = toAtom(sense, model, readerNotesFolder, selectedSource)
    const note = createNote(body, [atom.id], new Date(), sourceMessageId, readerNotesFolder)
    const existing = semanticRecordForId(atom.id, stateRef.current.notebook.atoms)
    if (existing) {
      commitSemanticCapture(atom, existing.id, 'notebook', note)
      return
    }
    const candidates = possibleSemanticMergeCandidates(atom, stateRef.current.notebook.atoms)
    if (candidates.length > 0) {
      setPendingSemanticCapture({ atom, candidates, destination: 'notebook', note })
      return
    }
    commitSemanticCapture(atom, null, 'notebook', note)
  }

  function addNoteToActiveAtom(body: string) {
    if (!activeAtomId) return
    const activeAtom = atoms.find((atom) => atom.id === activeAtomId)
    const note = createNote(body, [activeAtomId], new Date(), undefined, activeAtom?.notesFolder || readerNotesFolder)
    setNotebook((current) => ({ ...current, notes: [note, ...current.notes] }))
  }

  // ------------------------------------------------------------- provider config

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

  // ------------------------------------------------------------- keyboard

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      const modifier = event.metaKey || event.ctrlKey
      const current = stateRef.current
      const space = current.activeSpace
      const path = current.session.activePath
      const tab = current.session.tabs.find((item) => item.path === path)
      if (modifier && event.altKey && (event.key === '1' || event.key === '2' || event.key === '3')) {
        event.preventDefault()
        switchSpace(event.key === '1' ? 'reader' : event.key === '2' ? 'notes' : 'chat')
      } else if (modifier && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createBlankNote()
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        void vaultRef.current.chooseVault()
      } else if (modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (event.shiftKey) void pickFolder()
        else void pickFiles()
      } else if (modifier && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (path) closeTab(path)
      } else if (modifier && (event.key === '+' || event.key === '=') && space === 'reader') {
        event.preventDefault()
        if (path) updateTab(path, { zoom: clamp(Number(((tab?.zoom ?? 1) + 0.1).toFixed(2)), 0.5, 3) })
      } else if (modifier && event.key === '-' && space === 'reader') {
        event.preventDefault()
        if (path) updateTab(path, { zoom: clamp(Number(((tab?.zoom ?? 1) - 0.1).toFixed(2)), 0.5, 3) })
      } else if (modifier && event.key === '0' && space === 'reader') {
        event.preventDefault()
        if (path) updateTab(path, { zoom: 1 })
      } else if (modifier && /^[1-9]$/.test(event.key) && space === 'reader') {
        const target = current.session.tabs[Number(event.key) - 1]
        if (target) {
          event.preventDefault()
          activateTab(target.path)
        }
      } else if (event.key === 'Escape') {
        setAnchor(null)
        setSettingsOpen(false)
      } else if (!editing && space === 'reader' && event.key === 'ArrowRight' && path) {
        pageApiRef.current?.scrollToPage((tab?.pageNumber ?? 1) + 1)
      } else if (!editing && space === 'reader' && event.key === 'ArrowLeft' && path) {
        pageApiRef.current?.scrollToPage((tab?.pageNumber ?? 1) - 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activateTab, closeTab, createBlankNote, pickFiles, pickFolder, switchSpace, updateTab])

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    setDragActive(false)
    const files = Array.from(event.dataTransfer.files || [])
    const port = fileSystem()
    const paths = files.map((file) => port.pathForFile(file)).filter(Boolean)
    if (paths.length === 0) {
      window.alert('无法读取拖入的文件。请使用“打开文档”或“打开文件夹”。')
      return
    }
    // Dropping a document always means reading it, whichever desk is on screen.
    switchSpace('reader')
    paths.forEach((path, index) => openDocument(path, { background: index > 0 }))
  }

  // ------------------------------------------------------------- layout maths

  const leftMax = Math.min(560, Math.max(MIN_LEFT_WIDTH, Math.round(viewportWidth * 0.42)))
  const rightMax = Math.max(MIN_RIGHT_WIDTH, viewportWidth - layout.leftWidth - MIN_READER_WIDTH - 16)
  const platform = getBridge()?.platform || ''
  const isMacApp = platform === 'darwin'

  const resizeLeft = useCallback((delta: number) => {
    setLayout((current) => ({ ...current, leftWidth: clamp(current.leftWidth + delta, MIN_LEFT_WIDTH, leftMax) }))
  }, [leftMax, setLayout])

  const resizeRight = useCallback((delta: number) => {
    setLayout((current) => ({ ...current, rightWidth: clamp(current.rightWidth - delta, MIN_RIGHT_WIDTH, rightMax), assistantWide: false }))
  }, [rightMax, setLayout])

  const toggleAssistantWide = useCallback(() => {
    setLayout((current) => {
      if (current.assistantWide) return { ...current, assistantWide: false, rightWidth: DEFAULT_RIGHT_WIDTH }
      const wide = clamp(Math.round(viewportWidth * 0.56), MIN_RIGHT_WIDTH, rightMax)
      return { ...current, assistantWide: true, rightWidth: wide }
    })
  }, [rightMax, setLayout, viewportWidth])

  const updateActiveTab = useCallback((patch: Partial<ReaderTabState>) => {
    if (!activePath) return
    setSession((current) => {
      const tab = current.tabs.find((item) => item.path === activePath)
      if (!tab) return current
      const unchanged = Object.entries(patch).every(
        ([key, value]) => (tab as unknown as Record<string, unknown>)[key] === value,
      )
      if (unchanged) return current
      return { ...current, tabs: current.tabs.map((item) => (item.path === activePath ? { ...item, ...patch } : item)) }
    })
  }, [activePath, setSession])

  const handlePageChange = useCallback((page: number) => {
    setPageInput(String(page))
    updateActiveTab({ pageNumber: page })
  }, [updateActiveTab])

  const handleChapterChange = useCallback((chapterIndex: number) => {
    setEpubAlignmentTail(null)
    setPageInput(String(chapterIndex + 1))
    // A new chapter starts at the top; the previous chapter's offset is stale.
    scrollPositions.current[activePath || ''] = 0
    // `pageNumber` mirrors the chapter so the toolbar indicator stays in step.
    updateActiveTab({ chapterIndex, pageNumber: chapterIndex + 1, scrollTop: 0, scrollRatio: 0 })
  }, [activePath, updateActiveTab])

  useEffect(() => {
    if (!pendingSourceJump || pendingSourceJump.path !== activePath || activeDoc?.status !== 'ready') return
    if (activeDoc.kind === 'pdf') {
      pageApiRef.current?.scrollToPage(pendingSourceJump.position)
      if (pendingSourceJump.marker) window.setTimeout(() => restorePdfBookmark(pendingSourceJump.marker!), 100)
    }
    else if (activeDoc.kind === 'epub') {
      handleChapterChange(pendingSourceJump.position - 1)
      if (pendingSourceJump.marker) window.setTimeout(() => restoreFlowBookmark(pendingSourceJump.marker!), 80)
    }
    else if (activeDoc.kind === 'text') {
      const scroller = document.querySelector<HTMLElement>('.reader-scroll')
      if (pendingSourceJump.marker?.blockIndex !== undefined) {
        flowApiRef.current?.scrollToBlock?.(pendingSourceJump.marker.blockIndex)
        window.setTimeout(() => restoreFlowBookmark(pendingSourceJump.marker!), 80)
      } else if (scroller && pendingSourceJump.marker?.scrollRatio !== undefined) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * pendingSourceJump.marker.scrollRatio
        if (pendingSourceJump.marker) window.setTimeout(() => restoreFlowBookmark(pendingSourceJump.marker!), 80)
      } else if (pendingSourceJump.position > 1) flowApiRef.current?.scrollBy((pendingSourceJump.position - 1) * 480)
    }
    setPendingSourceJump(null)
  }, [activeDoc, activePath, handleChapterChange, pendingSourceJump, restoreFlowBookmark, restorePdfBookmark])

  // PDF reports a pixel offset; the reflowing readers report a ratio as well so
  // the position survives window/splitter resizes that change the text height.
  const handleScrollPosition = useCallback((position: number | FlowScrollState) => {
    if (!activePath) return
    const state = typeof position === 'number'
      ? { scrollTop: position, ratio: scrollRatios.current[activePath] ?? 0 }
      : position
    scrollPositions.current[activePath] = state.scrollTop
    scrollRatios.current[activePath] = state.ratio
    scrollDirty.current = true
  }, [activePath])

  const handleFlowProgress = useCallback((state: FlowScrollState) => {
    if (!activePath) return
    scrollRatios.current[activePath] = state.ratio
    scrollDirty.current = true
  }, [activePath])

  useEffect(() => {
    if (activeTab) setPageInput(String((activeTab.chapterIndex ?? 0) + 1 || activeTab.pageNumber))
    setFlowLocation('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath])

  // Position paging works for every document kind: PDF pages, EPUB chapters
  // (the reflowing readers have no pages) and free scrolling in plain text.
  const positionTotal = activeDoc?.kind === 'text' ? 0 : (activeDoc?.pageCount ?? 0)
  const positionIndex = activeDoc?.kind === 'epub'
    ? (activeTab?.chapterIndex ?? 0) + 1
    : (activeTab?.pageNumber ?? 1)

  const navigatePosition = useCallback((delta: number) => {
    if (!activeDoc) return
    if (activeDoc.kind === 'pdf') {
      pageApiRef.current?.scrollToPage((activeTab?.pageNumber ?? 1) + delta)
      return
    }
    if (activeDoc.kind === 'epub') {
      const next = clamp((activeTab?.chapterIndex ?? 0) + delta, 0, Math.max(0, activeDoc.pageCount - 1))
      if (next !== (activeTab?.chapterIndex ?? 0)) handleChapterChange(next)
      return
    }
    flowApiRef.current?.scrollBy(delta * 480)
  }, [activeDoc, activeTab?.chapterIndex, activeTab?.pageNumber, handleChapterChange])

  const jumpToPosition = useCallback((value: number) => {
    if (!activeDoc) return
    if (activeDoc.kind === 'pdf') {
      pageApiRef.current?.scrollToPage(value)
      return
    }
    if (activeDoc.kind === 'epub') {
      handleChapterChange(clamp(value - 1, 0, Math.max(0, activeDoc.pageCount - 1)))
      return
    }
    flowApiRef.current?.scrollToTop()
  }, [activeDoc, handleChapterChange])

  const flattenOutline = (items: DocumentOutlineItem[], depth = 0): Array<{ item: DocumentOutlineItem; depth: number }> =>
    items.flatMap((item) => [{ item, depth }, ...flattenOutline(item.items || [], depth + 1)])

  const tabsForStrip = session.tabs.map((tab) => ({
    path: tab.path,
    name: tab.name,
    kind: docs[tab.path]?.kind ?? documentKindFor(tab.path) ?? undefined,
    loading: docs[tab.path]?.status === 'loading',
    failed: docs[tab.path]?.status === 'error',
  }))

  const retryActive = useCallback(() => {
    const path = stateRef.current.session.activePath
    if (!path) return
    // A forced reload acquires a new PDF cache reference. Release the current
    // tab's reference first so repeated retries do not pin stale workers.
    releaseDocument(documentKeyFor(path, displayNameForPath(path)))
    setDocs((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    void loadDocument(path, displayNameForPath(path), true)
  }, [loadDocument])

  // Rebuilds the PDF from scratch (new loading task and worker). Releasing first
  // matters: `acquireDocument` would otherwise hand back the wedged document.
  const reloadActiveDocument = useCallback((automatic = false) => {
    const path = stateRef.current.session.activePath
    if (!path) return false
    if (automatic) {
      const lastReloadedAt = automaticPdfReloads.current.get(path) ?? 0
      if (Date.now() - lastReloadedAt < 60_000) return false
      automaticPdfReloads.current.set(path, Date.now())
    } else {
      automaticPdfReloads.current.delete(path)
    }
    const name = displayNameForPath(path)
    const scrollTop = pageApiRef.current?.scrollTop()
    if (scrollTop !== undefined && Number.isFinite(scrollTop)) {
      setState((current) => ({
        ...current,
        session: {
          ...current.session,
          tabs: current.session.tabs.map((tab) => tab.path === path ? { ...tab, scrollTop } : tab),
        },
      }))
    }
    releaseDocument(documentKeyFor(path, name))
    setDocs((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    void loadDocument(path, name, true)
    return true
  }, [loadDocument])

  return (
    <main
      className={`app-shell${isMacApp ? ' is-app mac' : ''}`}
      onMouseUp={captureSelectedExpression}
      onKeyUp={captureSelectedExpression}
      onDragOver={(event) => { event.preventDefault(); setDragActive(true) }}
      onDragLeave={(event) => { if (event.target === event.currentTarget) setDragActive(false) }}
      onDrop={handleDrop}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><BookOpen size={17} strokeWidth={1.8} /></div>
          <div className="brand-name">paperlight<span>PDF</span></div>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" title={layout.leftOpen ? '收起左侧栏' : '展开左侧栏'} onClick={() => setLayout((current) => ({ ...current, leftOpen: !current.leftOpen }))}>
            {layout.leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <button className="icon-button" title="打开文档（PDF / EPUB / TXT / Markdown，⌘O）" onClick={() => void pickFiles()}><FilePlus2 size={17} /></button>
          <button className="icon-button" title="打开文件夹（⌘⇧O）" onClick={() => void pickFolder()}><FolderOpen size={17} /></button>
          <button className={`provider-pill ${mode === 'openai' ? 'provider-openai' : ''}`} onClick={() => setSettingsOpen((value) => !value)} title="翻译设置">
            <span className={`provider-dot ${mode}`} />{mode === 'mock' ? '模拟翻译' : '兼容 API'}<ChevronDown size={13} />
          </button>
          <button className="icon-button" title={layout.rightOpen ? '收起阅读助手' : '展开阅读助手'} onClick={() => setLayout((current) => ({ ...current, rightOpen: !current.rightOpen }))}>
            {layout.rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
          <button className="icon-button" title="设置" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={17} /></button>
        </div>
      </header>

      {activeSpace === 'reader' && <TabStrip
        tabs={tabsForStrip}
        activePath={activePath}
        onActivate={activateTab}
        onClose={closeTab}
        onOpenPicker={() => void pickFiles()}
        onNewNote={() => void createBlankNote()}
      />}

      {settingsOpen && <div className="settings-popover">
        <div className="settings-heading"><div><strong>设置</strong><p>翻译服务与日报</p></div><button className="tiny-icon" onClick={() => setSettingsOpen(false)}><X size={15} /></button></div>
        <label className="field-label" htmlFor="provider-mode">翻译方式</label>
        <select id="provider-mode" className="select-field" value={mode} onChange={(event) => {
          const nextMode = event.target.value as TranslateMode
          setState((prev) => ({ ...prev, settings: { ...prev.settings, mode: nextMode } }))
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
              <span>{apiConfig?.source === 'environment' ? '由启动环境提供' : apiConfig?.source === 'local-file' ? '安全保存在本机配置文件' : '输入密钥后即可使用真实翻译'}{` · ${protocolForBaseUrl(apiBaseUrl) === 'chat-completions' ? 'Chat Completions' : 'Responses'}`}</span>
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
                    if (preset.model) setState((prev) => ({ ...prev, settings: { ...prev.settings, model: preset.model as string } }))
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
          <p className="settings-hint">{apiConfig?.source === 'environment' ? <>密钥由启动环境管理，页面不会读取、显示或覆盖它。</> : <>密钥仅写入本机配置文件，不会保存在浏览器、显示在页面或打包进应用。</>}</p>
          <label className="field-label model-label" htmlFor="model-name">模型名称</label>
          <input id="model-name" className="text-field" value={model} onChange={(event) => setState((prev) => ({ ...prev, settings: { ...prev.settings, model: event.target.value } }))} />
        </> : <p className="settings-hint">模拟模式只影响整句翻译；语义查询、例句与对话始终使用已配置的 API。</p>}

        <div className="settings-section">
          <label className="field-label" htmlFor="report-time">日报生成时间</label>
          <div className="report-time-row">
            <input
              id="report-time"
              className="text-field"
              type="time"
              value={state.settings.dailyReportTime}
              onChange={(event) => {
                const value = event.target.value
                if (!isValidTimeOfDay(value)) return
                setState((prev) => ({ ...prev, settings: { ...prev.settings, dailyReportTime: value } }))
              }}
            />
            <label className="report-auto">
              <input
                type="checkbox"
                checked={state.settings.dailyReportAuto}
                onChange={(event) => setState((prev) => ({ ...prev, settings: { ...prev.settings, dailyReportAuto: event.target.checked } }))}
              />
              到点自动生成
            </label>
          </div>
          <p className="settings-hint">
            日报写在 <code>Daily/&lt;日期&gt;-report.md</code>，每次生成覆盖上一版；每天的记录清单是分开的文件，会随笔记实时更新。日报也会读取你写在 <code>enlightenment/</code> 里的专项发现。
          </p>
        </div>
      </div>}

      {activeSpace === 'reader' ? (
      <div className={`workspace${dragActive ? ' drag-active' : ''}`}>
        <SpaceRail active="reader" onSelect={switchSpace} onChooseVault={() => void vaultApi.chooseVault()} vaultName={vaultApi.rootName} />
        {layout.leftOpen && <aside className="left-sidebar" style={{ width: `${layout.leftWidth}px` }}>
          <div className="sidebar-tabs">
            <button className={leftTab === 'files' ? 'selected' : ''} onClick={() => setLeftTab('files')} title="文件"><Files size={13} /> 文件</button>
            <button className={leftTab === 'pages' ? 'selected' : ''} onClick={() => setLeftTab('pages')} title="页面"><Layers size={13} /> 页面</button>
            <button className={leftTab === 'outline' ? 'selected' : ''} onClick={() => setLeftTab('outline')} title="目录"><List size={13} /> 目录</button>
          </div>

          {leftTab === 'files' && <FileExplorer
            root={explorer.root}
            currentDir={explorer.current}
            listing={explorer.listing}
            loading={explorer.loading}
            error={explorer.error}
            roots={roots}
            recents={session.recentFiles}
            recentFolders={session.recentFolders}
            favorites={session.favorites}
            openPaths={openPaths}
            browseMode={fileSystem().kind}
            onPickFolder={() => void pickFolder()}
            onOpenDir={(path) => void openFolderInternal(path)}
            onGoUp={goUpFolder}
            onRefresh={() => explorer.current && void openFolderInternal(explorer.current)}
            onOpenFile={(path, options) => openDocument(path, options)}
            onReveal={(path) => void fileSystem().reveal(path)}
            onToggleFavorite={toggleFavoriteFolder}
            onOpenRecent={(path) => openDocument(path)}
            onOpenRecentFolder={(path) => void openFolderInternal(path)}
          />}

          {leftTab === 'pages' && (!activePdf || !activeDoc || activeDoc.kind !== 'pdf'
            ? <div className="sidebar-empty"><span className="sidebar-empty-icon"><Layers size={19} /></span><span>{activeDoc && activeDoc.kind !== 'pdf' ? '这个格式没有固定页面\n可用左侧「目录」跳转' : '打开 PDF 后\n在这里浏览页面'}</span></div>
            : <div className="thumbnail-list">{Array.from({ length: activeDoc.pageCount }, (_, index) => (
              <PDFThumbnail
                key={index + 1}
                pdf={activePdf}
                pageNumber={index + 1}
                active={activeTab?.pageNumber === index + 1}
                onClick={() => pageApiRef.current?.scrollToPage(index + 1)}
              />
            ))}</div>)}

          {leftTab === 'outline' && (!activeDoc
            ? <div className="sidebar-empty"><span className="sidebar-empty-icon"><List size={19} /></span><span>打开文档后<br />在这里查看目录</span></div>
            : activeDoc.kind === 'pdf'
              ? <div className="outline-list">
                {flattenOutline(activeDoc.outline).map(({ item, depth }, index) => <button
                  key={`${item.title}-${index}`}
                  className="outline-entry"
                  style={{ paddingLeft: `${15 + depth * 13}px` }}
                  title={item.estimatedPage ? `按目录印刷页码估算跳转到第 ${item.pageNumber} 页；PDF 没有页标签，可能存在偏移。` : item.title}
                  onClick={async () => {
                  if (item.pageNumber) {
                    pageApiRef.current?.scrollToPage(item.pageNumber)
                    return
                  }
                  if (!activePdf || !item.dest) return
                  try {
                    const destination = typeof item.dest === 'string' ? await activePdf.getDestination(item.dest) : item.dest
                    const reference = Array.isArray(destination) ? destination[0] : null
                    if (!reference) return
                    const pageIndex = await activePdf.getPageIndex(reference as never)
                    pageApiRef.current?.scrollToPage(pageIndex + 1)
                  } catch { /* Some PDFs contain incomplete outline destinations. */ }
                }}><ChevronRight size={12} /><span>{item.title}{item.estimatedPage ? ` · ${item.pageNumber}?` : ''}</span></button>)}
                {activeDoc.outline.length === 0 && <div className="outline-empty">此 PDF 没有目录</div>}
              </div>
              : <div className="outline-list">
                {activeDoc.flowOutline.map((item, index) => (
                  <button
                    key={`${item.title}-${index}`}
                    className="outline-entry"
                    style={{ paddingLeft: `${15 + item.level * 13}px` }}
                    onClick={() => {
                      if ('chapterIndex' in item) {
                        handleChapterChange(item.chapterIndex)
                        if (item.anchorId) {
                          const sourcePath = activePath
                          const anchorId = item.anchorId
                          const jump = (attempt = 0) => {
                            if (stateRef.current.session.activePath !== sourcePath) return
                            const scroller = document.querySelector<HTMLElement>('.reader-scroll')
                            const target = scroller?.querySelector<HTMLElement>(`#${CSS.escape(anchorId)}`)
                            if (target) {
                              target.scrollIntoView({ block: 'start' })
                              return
                            }
                            if (attempt < 30) window.setTimeout(() => jump(attempt + 1), 100)
                          }
                          window.setTimeout(() => jump(), 50)
                        }
                        return
                      }
                      flowApiRef.current?.scrollToAnchor(`flow-block-${item.block}`)
                    }}
                  >
                    <ChevronRight size={12} /><span>{item.title}</span>
                  </button>
                ))}
                {activeDoc.flowOutline.length === 0 && <div className="outline-empty">这个文档没有可跳转的标题</div>}
              </div>)}

          <div className="sidebar-footer">
            {activeDoc?.status === 'ready'
              ? `${activeDoc.kind === 'pdf' ? `${activeDoc.pageCount} 页` : activeDoc.kind === 'epub' ? `${activeDoc.pageCount} 章` : `${activeDoc.blocks.length} 段`} · ${activeTab?.name ?? ''}`
              : explorer.current ? '文件浏览器' : 'Paperlight'}
          </div>
        </aside>}

        {layout.leftOpen && <Splitter
          label="调整左侧栏宽度"
          value={layout.leftWidth}
          min={MIN_LEFT_WIDTH}
          max={leftMax}
          onDelta={resizeLeft}
          onReset={() => setLayout((current) => ({ ...current, leftWidth: DEFAULT_LEFT_WIDTH }))}
        />}

        <section className="reader-column">
          {activeTab && <div className="reader-toolbar">
            <div className="page-navigation">
              <button
                className="toolbar-button"
                title={activeDoc?.kind === 'epub' ? '上一章' : activeDoc?.kind === 'text' ? '向上' : '上一页（←）'}
                disabled={activeDoc?.kind !== 'text' && positionIndex <= 1}
                onClick={() => navigatePosition(-1)}
              >
                <ChevronLeft size={17} />
              </button>
              <input
                className="page-number-input"
                aria-label={activeDoc?.kind === 'pdf' ? '页码' : '章节'}
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') jumpToPosition(Number(pageInput) || 1)
                }}
                onBlur={() => setPageInput(String(positionIndex))}
              />
              <span className="page-total">{positionLabel(activeDoc?.kind ?? 'pdf', positionIndex, positionTotal)}</span>
              <button
                className="toolbar-button"
                title={activeDoc?.kind === 'epub' ? '下一章' : activeDoc?.kind === 'text' ? '向下' : '下一页（→）'}
                disabled={activeDoc?.kind !== 'text' && positionTotal > 0 && positionIndex >= positionTotal}
                onClick={() => navigatePosition(1)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
            <div className="reader-toolbar-title" title={activePath || ''}>{flowLocation || activeTab.name}</div>
            <div className="zoom-controls">
              <button className="toolbar-button input-marker-menu-toggle" title="书签与输入标记" onClick={() => setInputMarkerMenuOpen((open) => !open)}><BookmarkPlus size={14} /><span>{activeInputMarkers.length || '标记'}</span></button>
              <span className="toolbar-separator" />
              <button className="toolbar-button" title="缩小（⌘/Ctrl + -）" onClick={() => activePath && updateTab(activePath, { zoom: clamp(Number(((activeTab?.zoom ?? 1) - 0.1).toFixed(2)), 0.5, 3) })}><Minus size={15} /></button>
              <span className="zoom-label">{Math.round((activeTab?.zoom ?? 1) * 100)}%</span>
              <button className="toolbar-button" title="放大（⌘/Ctrl + +）" onClick={() => activePath && updateTab(activePath, { zoom: clamp(Number(((activeTab?.zoom ?? 1) + 0.1).toFixed(2)), 0.5, 3) })}><Plus size={15} /></button>
              <span className="toolbar-separator" />
              <button className="toolbar-button fit-button" title={activeDoc?.kind === 'pdf' ? '适合页面宽度（⌘0）' : '恢复默认字号（⌘0）'} onClick={() => activePath && updateTab(activePath, { zoom: 1 })}><RotateCcw size={14} /><span>{activeDoc?.kind === 'pdf' ? '适宽' : '默认'}</span></button>
            </div>
          </div>}

          {activeTab && inputMarkerMenuOpen && <section className="input-marker-menu" aria-label="书签与输入标记">
            <header><strong>输入标记</strong><button type="button" className="tiny-icon" aria-label="关闭标记菜单" onClick={() => setInputMarkerMenuOpen(false)}><X size={13} /></button></header>
            <button type="button" className="primary-button input-marker-progress" onClick={addProgressBookmark}><BookmarkPlus size={13} /> 保存当前位置</button>
            <div className="input-marker-list">
              {activeInputMarkers.length === 0 && <p>当前材料还没有书签或输入标记。</p>}
              {[...activeInputMarkers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((marker) => <div className="input-marker-list-item" key={marker.id}>
                <button type="button" onClick={() => jumpToInputMarker(marker)}>
                  <small>{marker.purpose === 'progress' ? '进度' : marker.purpose === 'form' ? '形式' : '内容'}{marker.visualStyle ? ` · ${marker.visualStyle === 'highlight' ? '高亮' : '下划线'}` : ''}</small>
                  <strong>{marker.quote || marker.comment || '阅读进度'}</strong>
                  <span>{[marker.locationLabel, marker.pageNumber ? `第 ${marker.pageNumber} 页/章` : ''].filter(Boolean).join(' · ')}</span>
                  {marker.comment && marker.comment !== marker.quote && marker.comment !== '阅读进度' && <em>{marker.comment}</em>}
                </button>
                <button type="button" className="tiny-icon" aria-label="删除输入标记" onClick={() => removeInputMarker(marker.id)}><Trash2 size={12} /></button>
              </div>)}
            </div>
          </section>}

          {!activeTab ? (
            <WelcomeScreen
              onOpenFiles={() => void pickFiles()}
              onOpenFolder={() => void pickFolder()}
              canBrowse={fileSystem().canBrowse}
              recents={session.recentFiles}
              onOpenRecent={(path) => openDocument(path)}
            />
          ) : activeDoc?.status === 'ready' && activeDoc.kind === 'pdf' && activePdf ? (
            <PageStack
              key={activePath}
              pdf={activePdf}
              documentKey={documentKeyFor(activePath || '', activeTab.name)}
              pageCount={activeDoc.pageCount}
              firstPageRatio={activeDoc.firstPageRatio}
              zoom={activeTab.zoom}
              restoreScrollTop={activeTab.scrollTop}
              onScrollPosition={handleScrollPosition}
              onPageChange={handlePageChange}
              onSelectionPointerUp={selectText}
              onSelectionKeyUp={(event) => { if (event.key.startsWith('Arrow') || event.key === 'Shift') selectText() }}
              onUserScroll={() => setAnchor(null)}
              onReloadDocument={reloadActiveDocument}
              inputMarkers={readerInputMarkers}
              apiRef={pageApiRef}
            />
          ) : activeDoc?.status === 'ready' && activeDoc.kind === 'text' ? (
            <TextReader
              key={activePath}
              documentKey={documentKeyFor(activePath || '', activeTab.name)}
              blocks={activeDoc.blocks}
              outline={activeDoc.flowOutline.filter((item): item is TextOutlineItem => 'block' in item)}
              zoom={activeTab.zoom}
              restoreRatio={activeTab.scrollRatio ?? 0}
              onScrollPosition={handleScrollPosition}
              onProgress={handleFlowProgress}
              onLocationChange={setFlowLocation}
              onSelectionPointerUp={selectText}
              onSelectionKeyUp={(event) => { if (event.key.startsWith('Arrow') || event.key === 'Shift') selectText() }}
              onUserScroll={() => setAnchor(null)}
              apiRef={flowApiRef}
              inputMarkers={readerInputMarkers.filter((marker) => marker.pageNumber === 1 && Boolean(marker.visualStyle))}
            />
          ) : activeDoc?.status === 'ready' && activeDoc.kind === 'epub' && activeDoc.epub ? (
            <EpubReader
              key={`${activePath}#${activeTab.chapterIndex ?? 0}`}
              book={activeDoc.epub}
              chapterIndex={activeTab.chapterIndex ?? 0}
              zoom={activeTab.zoom}
              restoreRatio={activeTab.scrollRatio ?? 0}
              onScrollPosition={handleScrollPosition}
              onProgress={handleFlowProgress}
              onSelectionPointerUp={selectText}
              onSelectionKeyUp={(event) => { if (event.key.startsWith('Arrow') || event.key === 'Shift') selectText() }}
              onUserScroll={() => setAnchor(null)}
              apiRef={flowApiRef}
              onNextChapter={() => handleChapterChange((activeTab.chapterIndex ?? 0) + 1)}
              inputMarkers={readerInputMarkers.filter((marker) => marker.pageNumber === (activeTab.chapterIndex ?? 0) + 1 && Boolean(marker.visualStyle))}
              alignmentTailPadding={epubAlignmentTail?.path === activePath && epubAlignmentTail.chapterIndex === (activeTab.chapterIndex ?? 0) ? epubAlignmentTail.padding : 0}
            />
          ) : activeDoc?.status === 'error' ? (
            <div className="reader-status">
              <FileText size={26} />
              <strong>无法打开这个文件</strong>
              <span>{activeDoc.error}</span>
              <span className="reader-status-path">{activePath}</span>
              <div className="reader-status-actions">
                <button className="primary-button" type="button" onClick={retryActive}><RotateCcw size={15} /> 重试</button>
                <button className="secondary-button" type="button" onClick={() => activePath && closeTab(activePath)}>关闭标签页</button>
              </div>
            </div>
          ) : (
            <div className="reader-status">
              <span className="mini-spinner" />
              <strong>正在载入 {activeTab.name}</strong>
              <span>{Math.round((activeDoc?.progress ?? 0) * 100)}%</span>
            </div>
          )}

          {dragActive && <div className="drop-overlay"><div><FilePlus2 size={27} /><strong>松开即可打开 PDF</strong><span>文件只在此设备上读取</span></div></div>}
        </section>

        {layout.rightOpen && <Splitter
          label="调整阅读助手宽度"
          value={layout.rightWidth}
          min={MIN_RIGHT_WIDTH}
          max={rightMax}
          onDelta={resizeRight}
          onReset={() => setLayout((current) => ({ ...current, rightWidth: DEFAULT_RIGHT_WIDTH, assistantWide: false }))}
        />}

        {layout.rightOpen && <div className="right-pane" style={{ width: `${layout.rightWidth}px` }}>
          <AssistantPanel
            tab={rightTab}
            onTab={setRightTab}
            wide={layout.assistantWide}
            onToggleWide={toggleAssistantWide}
            onCollapse={() => setLayout((current) => ({ ...current, rightOpen: false }))}
            queryTerm={queryTerm}
            onQueryTerm={setQueryTerm}
            onQuery={() => void runSenseLookup(queryTerm, lastContextRef.current)}
            onCancelQuery={cancelSenseLookup}
            sense={sense}
            senseLoading={senseLoading}
            senseError={senseError}
            allSenses={allSenses}
            expanding={expanding}
            onExpand={() => void expandCurrent()}
            onCancelExpand={cancelExpand}
            translation={translation}
            translationLoading={translationLoading}
            translationError={translationError}
            onTranslate={() => selection && void runTranslation(selection)}
            onCancelTranslation={cancelTranslation}
            selection={selection}
            senseInNotebook={senseInNotebook}
            semanticMergeCandidates={pendingSemanticCapture?.candidates || []}
            relations={relations}
            onAddSense={addCurrentSense}
            onConfirmSemanticMerge={(semanticId) => {
              if (pendingSemanticCapture) commitSemanticCapture(pendingSemanticCapture.atom, semanticId, pendingSemanticCapture.destination, pendingSemanticCapture.note)
            }}
            onKeepSeparateSemantic={() => {
              if (pendingSemanticCapture) commitSemanticCapture(pendingSemanticCapture.atom, null, pendingSemanticCapture.destination, pendingSemanticCapture.note)
            }}
            onCancelSemanticMerge={() => setPendingSemanticCapture(null)}
            model={model}
            onJumpToAtom={(id) => { setActiveAtomId(id); setRightTab('notebook') }}
            atoms={atoms}
            notes={notebookNotes}
            activeAtomId={activeAtomId}
            onSelectAtom={setActiveAtomId}
            onDeleteAtom={(id) => {
              setNotebook((current) => ({
                ...current,
                atoms: current.atoms.filter((atom) => atom.id !== id),
                notes: current.notes.map((note) => ({ ...note, senseIds: note.senseIds.filter((senseRef) => senseRef !== id) })),
              }))
              setActiveAtomId(null)
            }}
            onAddNote={addNoteToActiveAtom}
            onDeleteNote={(id) => setNotebook((current) => ({ ...current, notes: current.notes.filter((note) => note.id !== id) }))}
            chatMessages={chatMessages}
            savedMessageIds={savedMessageIds}
            chatSending={chatSending}
            onCancelChat={cancelReaderChat}
            chatError={chatError}
            onSend={(question) => void sendChat(question)}
            onSaveExcerpt={(message) => saveExcerpt(message.content, message.id)}
            onSaveReaderMessage={saveReaderChatAnswer}
            onOpenSavedReaderAnswer={openNoteInNotesSpace}
            readerAnswerSavedPath={savedReaderAnswer}
            onSaveReaderAnswer={saveReaderFirstAnswer}
            onSaveSense={() => sense && saveExcerpt(`${sense.term}（${sense.contextualMeaning}）`)}
            onRetrySense={() => void runSenseLookup(queryTerm || sense?.term || '', lastContextRef.current)}
            vaultReady={vaultApi.ready}
            vaultRootName={vaultApi.rootName}
            vaultTarget={noteFolderPath(readingMirror || null)}
            vaultBusy={vaultActionBusy}
            vaultMessage={vaultActionMessage}
            onOpenNotesSpace={() => switchSpace('notes')}
            onSaveSenseToVault={saveSenseToVault}
            onGenerateCompleteNote={generateCompleteNote}
            completeNoteGenerating={completeNoteGenerating}
            onCancelCompleteNote={cancelCompleteNote}
            onSaveNoteToVault={saveNotebookNoteToVault}
          />
        </div>}
      </div>
      ) : activeSpace === 'notes' ? (
        <NotesSpace
          vault={vaultApi}
          atoms={atoms}
          notes={notebookNotes}
          chatThreads={chatSpace.threads}
          recentRoots={vaultState.recentRoots}
          openPaths={notesSpace.openPaths}
          activePath={notesSpace.activePath}
          view={notesSpace.view}
          treeWidth={notesSpace.treeWidth}
          sideOpen={notesSpace.sideOpen}
          sideWidth={notesSpace.sideWidth}
          collapsed={vaultState.collapsed}
          onOpen={openNote}
          onClose={closeNote}
          onActivate={activateNote}
          onView={setNoteView}
          onTreeWidth={resizeNoteTree}
          onTreeReset={() => setNotesSpace((current) => ({ ...current, treeWidth: DEFAULT_TREE_WIDTH }))}
          onSideWidth={resizeNoteSide}
          onSideReset={() => setNotesSpace((current) => ({ ...current, sideWidth: DEFAULT_SIDE_WIDTH }))}
          onToggleCollapsed={toggleVaultCollapsed}
          onToggleSide={toggleNoteSide}
          onSwitchSpace={switchSpace}
          onOpenSense={(id) => { setActiveAtomId(id); setRightTab('notebook'); switchSpace('reader') }}
          readingContext={readingContext}
          reportTime={state.settings.dailyReportTime}
          onOpenSource={openVaultSource}
          onOpenChatThread={openChatThread}
          pendingSenseCount={pendingSenseAtoms.length}
          onSavePendingSenses={savePendingSenses}
          onCreateBlankNote={() => void createBlankNote()}
        />
      ) : activeSpace === 'expressions' ? (
        <ExpressionSpace
          vault={vaultApi}
          model={model}
          onSwitchSpace={switchSpace}
          onOpenSource={openExpressionSource}
        />
      ) : (
        <ChatSpace
          vault={vaultApi}
          threads={chatSpace.threads}
          activeThreadId={chatSpace.activeThreadId}
          historyWidth={chatSpace.historyWidth}
          pickerWidth={chatSpace.pickerWidth}
          historyOpen={chatSpace.historyOpen}
          pickerOpen={chatSpace.pickerOpen}
          model={model}
          onCreateThread={createThread}
          onActivateThread={activateThread}
          onUpdateThread={updateThread}
          onDeleteThread={deleteThread}
          onHistoryWidth={resizeHistory}
          onHistoryReset={() => setChatSpace((current) => ({ ...current, historyWidth: DEFAULT_HISTORY_WIDTH }))}
          onPickerWidth={resizePicker}
          onPickerReset={() => setChatSpace((current) => ({ ...current, pickerWidth: DEFAULT_PICKER_WIDTH }))}
          onToggleColumn={toggleChatColumn}
          onSwitchSpace={switchSpace}
          onOpenNote={openNoteInNotesSpace}
        />
      )}

      {activeSpace === 'reader' && anchor && senseLoading && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot openai" />上下文语义<span className="popover-page">{selection ? `P.${selection.pageNumber}` : ''}</span></div>
        <div className="popover-loading"><span className="mini-spinner" /> 正在判断语义…</div>
        {selection && <button className="input-mark-inline" type="button" onMouseDown={(event) => event.preventDefault()} onClick={startMarkerFromReaderSelection}><Highlighter size={12} /> 标记输入</button>}
        <button className="popover-close" aria-label="关闭浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}

      {activeSpace === 'reader' && anchor && !senseLoading && sense && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot openai" />上下文语义{sense.partOfSpeech ? ` · ${sense.partOfSpeech}` : ''}<span className="popover-page">{selection ? `P.${selection.pageNumber}` : ''}</span></div>
        <p className="popover-meaning">{sense.contextualMeaning}</p>
        {selection && <button className="input-mark-inline" type="button" onMouseDown={(event) => event.preventDefault()} onClick={startMarkerFromReaderSelection}><Highlighter size={12} /> 标记输入</button>}
        <button className="popover-close" aria-label="关闭浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}

      {activeSpace === 'reader' && anchor && selection && !senseLoading && !sense && !senseError && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot mock" />已选文本<span className="popover-page">P.{selection.pageNumber}</span></div>
        <p className="popover-meaning">文本已填入查询框；点击「查询」或按 Enter 后才会请求 AI。</p>
        <button className="input-mark-inline" type="button" onMouseDown={(event) => event.preventDefault()} onClick={startMarkerFromReaderSelection}><Highlighter size={12} /> 标记输入</button>
        <button className="popover-close" aria-label="关闭浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}

      {activeSpace === 'reader' && anchor && !senseLoading && !sense && senseError && <div className="selection-popover" style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}>
        <div className="popover-title"><span className="provider-dot mock" />语义查询失败</div>
        <p className="popover-meaning">{senseError}</p>
        {selection && <button className="input-mark-inline" type="button" onMouseDown={(event) => event.preventDefault()} onClick={startMarkerFromReaderSelection}><Highlighter size={12} /> 标记输入</button>}
        <button className="popover-close" aria-label="关闭浮层" onClick={() => setAnchor(null)}><X size={13} /></button>
        <span className="popover-pointer" />
      </div>}
      {expressionCapture && <div
        className={`expression-capture-popover${expressionCapture.reader ? ' reader' : ''}`}
        style={{ left: `${expressionCapture.x}px`, top: `${expressionCapture.y}px` }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <span>收录「{expressionCapture.text}」</span>
        <button type="button" className="primary-button" onClick={() => void saveSelectedExpression()}><Plus size={12} /> 收录表达</button>
        <button type="button" className="secondary-button" onClick={() => startInputMarker({ ...expressionCapture.context, quote: expressionCapture.text }, expressionCapture.x, expressionCapture.y + 24)}><Highlighter size={12} /> 标记输入</button>
        <button type="button" className="tiny-icon" aria-label="关闭收录工具" onClick={() => setExpressionCapture(null)}><X size={13} /></button>
      </div>}
      {inputMarkerDraft && <section
        className="input-marker-composer"
        style={{ left: `${inputMarkerDraft.x}px`, top: `${inputMarkerDraft.y}px` }}
        aria-label="创建输入标记"
      >
        <header><div><span className="eyebrow">INPUT MARK</span><h2>标记这段输入</h2></div><button type="button" className="tiny-icon" aria-label="关闭" onClick={() => setInputMarkerDraft(null)}><X size={13} /></button></header>
        <div className="input-marker-purpose" role="group" aria-label="标记目的">
          {(['form', 'content'] as InputMarkerPurpose[]).map((purpose) => <button key={purpose} type="button" className={inputMarkerDraft.purpose === purpose ? 'active' : ''} onClick={() => setInputMarkerDraft({ ...inputMarkerDraft, purpose })}>{purpose === 'form' ? '形式' : '内容'}</button>)}
        </div>
        {inputMarkerDraft.quote && <blockquote>{inputMarkerDraft.quote}</blockquote>}
        <label className="input-marker-visual-choice">视觉提醒<select aria-label="视觉提醒" value={inputMarkerDraft.visualStyle || ''} onChange={(event) => setInputMarkerDraft({ ...inputMarkerDraft, visualStyle: event.target.value ? event.target.value as InputMarkerVisualStyle : undefined })}><option value="">不加视觉标记</option><option value="highlight">高亮</option><option value="underline">下划线</option></select></label>
        <label className="input-marker-comment">评论或提醒（可选）<textarea value={inputMarkerDraft.comment} onChange={(event) => setInputMarkerDraft({ ...inputMarkerDraft, comment: event.target.value })} rows={2} placeholder="写下为什么标记这段内容" /></label>
        <footer><button type="button" className="subtle-button" onClick={() => setInputMarkerDraft(null)}>取消</button><button type="button" className="primary-button" onClick={saveInputMarker}>保存标记</button></footer>
      </section>}
      {inputMarkerNotice && <div className="input-marker-notice" role="status">{inputMarkerNotice}</div>}
      {expressionCaptureNotice && <div className="expression-capture-notice" role="status">{expressionCaptureNotice}</div>}
    </main>
  )
}

export default App
