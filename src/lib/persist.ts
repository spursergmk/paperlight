import type {
  AppSpace, ChatMessage, ChatThread, InputMarker, InputMarkerPurpose, InputMarkerVisualStyle, ReadingActivityDay,
  NoteViewMode, NotebookNote, SenseAtom, TranslateMode,
} from '../types'
// Explicit extension: `node --test` runs this module through Node's own ESM
// resolver (the app bundle resolves extensionless imports, Node does not).
import { getBridge } from './bridge.ts'
import { isValidTimeOfDay, normalizeVaultPath, isSafeVaultPath } from './vault.ts'

export interface ReaderTabState {
  path: string
  name: string
  /** PDF page number, or 1-based chapter number in a reflowed document. */
  pageNumber: number
  zoom: number
  scrollTop: number
  /** 0-based chapter index for EPUB documents. */
  chapterIndex?: number
  /** Position as a fraction of the scrollable height (reflowing readers). */
  scrollRatio?: number
}

export interface RecentFile {
  path: string
  name: string
  openedAt: number
}

export interface PersistedState {
  version: 1
  /** Epoch ms of the last change; the newer of {disk, localStorage} wins. */
  savedAt: number
  /** Which desk is on screen: reading, notes or vault chat. */
  activeSpace: AppSpace
  session: {
    tabs: ReaderTabState[]
    activePath: string | null
    activeFolder: string | null
    recentFolders: string[]
    recentFiles: RecentFile[]
    favorites: string[]
  }
  layout: {
    leftWidth: number
    rightWidth: number
    leftOpen: boolean
    rightOpen: boolean
    assistantWide: boolean
  }
  settings: {
    mode: TranslateMode
    model: string
    /** Local time the daily report is generated at (`HH:MM`). */
    dailyReportTime: string
    /** Whether the report is generated automatically at that time. */
    dailyReportAuto: boolean
  }
  notebook: {
    atoms: SenseAtom[]
    notes: NotebookNote[]
    chat: Record<string, ChatMessage[]>
  }
  /** User-created bookmarks, language/content markers and visual cues. */
  inputMarkers: InputMarker[]
  /** Estimated focused-reading activity by local calendar day. */
  readingActivity: Record<string, ReadingActivityDay>
  /** The selected notes vault (a plain folder of Markdown files). */
  vault: {
    root: string | null
    recentRoots: string[]
    /** Vault-relative folders folded shut in the notes tree. */
    collapsed: string[]
  }
  notesSpace: {
    openPaths: string[]
    activePath: string | null
    view: NoteViewMode
    treeWidth: number
    sideOpen: boolean
    sideWidth: number
  }
  chatSpace: {
    threads: ChatThread[]
    activeThreadId: string | null
    historyWidth: number
    pickerWidth: number
    historyOpen: boolean
    pickerOpen: boolean
  }
}

const STATE_KEY = 'paperlight-state-v1'

export const DEFAULT_LEFT_WIDTH = 264
export const DEFAULT_RIGHT_WIDTH = 440
export const MIN_LEFT_WIDTH = 190
export const MIN_RIGHT_WIDTH = 320
export const MIN_READER_WIDTH = 320

export const DEFAULT_TREE_WIDTH = 252
export const MIN_TREE_WIDTH = 168
export const DEFAULT_SIDE_WIDTH = 288
export const MIN_SIDE_WIDTH = 208
export const DEFAULT_HISTORY_WIDTH = 214
export const MIN_HISTORY_WIDTH = 152
export const DEFAULT_PICKER_WIDTH = 262
export const MIN_PICKER_WIDTH = 176
export const DEFAULT_REPORT_TIME = '20:00'

export function defaultState(): PersistedState {
  return {
    version: 1,
    savedAt: 0,
    activeSpace: 'reader',
    session: {
      tabs: [],
      activePath: null,
      activeFolder: null,
      recentFolders: [],
      recentFiles: [],
      favorites: [],
    },
    layout: {
      leftWidth: DEFAULT_LEFT_WIDTH,
      rightWidth: DEFAULT_RIGHT_WIDTH,
      leftOpen: true,
      rightOpen: true,
      assistantWide: false,
    },
    settings: { mode: 'mock', model: 'deepseek-flash', dailyReportTime: DEFAULT_REPORT_TIME, dailyReportAuto: true },
    notebook: { atoms: [], notes: [], chat: {} },
    inputMarkers: [],
    readingActivity: {},
    vault: { root: null, recentRoots: [], collapsed: [] },
    notesSpace: {
      openPaths: [],
      activePath: null,
      view: 'edit',
      treeWidth: DEFAULT_TREE_WIDTH,
      sideOpen: true,
      sideWidth: DEFAULT_SIDE_WIDTH,
    },
    chatSpace: {
      threads: [],
      activeThreadId: null,
      historyWidth: DEFAULT_HISTORY_WIDTH,
      pickerWidth: DEFAULT_PICKER_WIDTH,
      historyOpen: true,
      pickerOpen: true,
    },
  }
}

function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // Storage can be unavailable (private mode, "block all cookies").
    return null
  }
}

function writeLocalStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function readLegacyLocalStorage(): Partial<PersistedState> {
  const parse = <T>(key: string, fallback: T): T => {
    try {
      const raw = readLocalStorage(key)
      if (!raw) return fallback
      const parsed = JSON.parse(raw) as T | null
      return parsed ?? fallback
    } catch {
      return fallback
    }
  }
  return {
    settings: {
      mode: readLocalStorage('paperlight-mode') === 'openai' ? 'openai' : 'mock',
      model: readLocalStorage('paperlight-model-v2') || 'deepseek-flash',
      dailyReportTime: DEFAULT_REPORT_TIME,
      dailyReportAuto: true,
    },
    notebook: {
      atoms: parse<SenseAtom[]>('paperlight-senses-v1', []),
      notes: parse<NotebookNote[]>('paperlight-notebook-v2', []),
      chat: parse<Record<string, ChatMessage[]>>('paperlight-chat-v1', {}),
    },
  }
}

function stringList(value: unknown, limit = 200): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, limit) : []
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function notePath(value: unknown): string | null {
  if (typeof value !== 'string' || !isSafeVaultPath(value)) return null
  const normalized = normalizeVaultPath(value)
  return normalized || null
}

function notePathList(value: unknown, limit = 200): string[] {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  for (const item of value) {
    const path = notePath(item)
    if (path && !paths.includes(path)) paths.push(path)
    if (paths.length >= limit) break
  }
  return paths
}

function sanitizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object')
    .slice(-500)
    .map((item) => {
      const message = item as Partial<ChatMessage>
      return {
        id: typeof message.id === 'string' && message.id ? message.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: typeof message.content === 'string' ? message.content : '',
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
        ...(typeof message.grounded === 'boolean' ? { grounded: message.grounded } : {}),
        ...(Array.isArray(message.sources) ? { sources: stringList(message.sources, 20) } : {}),
        ...(typeof message.savedPath === 'string' && message.savedPath ? { savedPath: message.savedPath } : {}),
      }
    })
}

function sanitizeThreads(value: unknown): ChatThread[] {
  if (!Array.isArray(value)) return []
  const threads: ChatThread[] = []
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue
    const thread = item as Partial<ChatThread>
    const id = typeof thread.id === 'string' && thread.id ? thread.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    threads.push({
      id,
      title: typeof thread.title === 'string' && thread.title.trim() ? thread.title.slice(0, 120) : '新的对话',
      createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : new Date().toISOString(),
      updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : new Date().toISOString(),
      messages: sanitizeMessages(thread.messages),
      contextPaths: notePathList(thread.contextPaths, 64),
    })
  }
  return threads
}

function sanitizeInputMarkers(value: unknown): InputMarker[] {
  if (!Array.isArray(value)) return []
  const sourceKinds = ['pdf', 'epub', 'text', 'assistant', 'chat', 'note', 'enlightenment', 'ai_exploration', 'manual']
  const purposes: InputMarkerPurpose[] = ['progress', 'form', 'content']
  const visualStyles: InputMarkerVisualStyle[] = ['highlight', 'underline']
  return value.slice(-5_000).flatMap((item): InputMarker[] => {
    if (!item || typeof item !== 'object') return []
    const marker = item as Partial<InputMarker>
    if (typeof marker.id !== 'string' || !marker.id || typeof marker.sourcePath !== 'string' || !marker.sourcePath.trim()) return []
    if (!purposes.includes(marker.purpose as InputMarkerPurpose)) return []
    const sourceKind = sourceKinds.includes(String(marker.sourceKind))
      ? marker.sourceKind as InputMarker['sourceKind'] : 'manual'
    const pageNumber = typeof marker.pageNumber === 'number' && Number.isFinite(marker.pageNumber) && marker.pageNumber > 0
      ? Math.floor(marker.pageNumber) : undefined
    const startOffset = typeof marker.startOffset === 'number' && Number.isSafeInteger(marker.startOffset) && marker.startOffset >= 0
      ? marker.startOffset : undefined
    const endOffset = typeof marker.endOffset === 'number' && Number.isSafeInteger(marker.endOffset) && marker.endOffset >= 0
      ? marker.endOffset : undefined
    const blockIndex = typeof marker.blockIndex === 'number' && Number.isSafeInteger(marker.blockIndex) && marker.blockIndex >= 0
      ? marker.blockIndex : undefined
    const scrollRatio = typeof marker.scrollRatio === 'number' && Number.isFinite(marker.scrollRatio)
      ? Math.max(0, Math.min(1, marker.scrollRatio)) : undefined
    return [{
      id: marker.id.slice(0, 160),
      sourcePath: marker.sourcePath.trim().slice(0, 4_096),
      sourceKind,
      purpose: marker.purpose as InputMarkerPurpose,
      ...(visualStyles.includes(marker.visualStyle as InputMarkerVisualStyle)
        ? { visualStyle: marker.visualStyle as InputMarkerVisualStyle } : {}),
      ...(typeof marker.quote === 'string' && marker.quote ? { quote: marker.quote.slice(0, 1_200) } : {}),
      ...(typeof marker.before === 'string' && marker.before ? { before: marker.before.slice(-500) } : {}),
      ...(typeof marker.after === 'string' && marker.after ? { after: marker.after.slice(0, 500) } : {}),
      ...(pageNumber ? { pageNumber } : {}),
      ...(typeof marker.locationLabel === 'string' && marker.locationLabel ? { locationLabel: marker.locationLabel.slice(0, 300) } : {}),
      ...(startOffset !== undefined ? { startOffset } : {}),
      ...(endOffset !== undefined ? { endOffset } : {}),
      ...(blockIndex !== undefined ? { blockIndex } : {}),
      ...(scrollRatio !== undefined ? { scrollRatio } : {}),
      comment: typeof marker.comment === 'string' ? marker.comment.slice(0, 2_000) : '',
      createdAt: typeof marker.createdAt === 'string' ? marker.createdAt.slice(0, 60) : new Date().toISOString(),
    }]
  })
}

function sanitizeReadingActivity(value: unknown): Record<string, ReadingActivityDay> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && day && typeof day === 'object' && !Array.isArray(day))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-90)
  return Object.fromEntries(entries.map(([date, raw]) => {
    const day = raw as Partial<ReadingActivityDay>
    const seconds = typeof day.seconds === 'number' && Number.isFinite(day.seconds)
      ? Math.max(0, Math.min(86_400, Math.floor(day.seconds))) : 0
    const sources = Array.isArray(day.sources) ? day.sources.slice(0, 100).flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const source = item as Partial<ReadingActivityDay['sources'][number]>
      if (typeof source.sourcePath !== 'string' || !source.sourcePath.trim()) return []
      return [{
        sourcePath: source.sourcePath.slice(0, 4_096),
        sourceName: typeof source.sourceName === 'string' ? source.sourceName.slice(0, 300) : '阅读材料',
        seconds: typeof source.seconds === 'number' && Number.isFinite(source.seconds)
          ? Math.max(0, Math.min(86_400, Math.floor(source.seconds))) : 0,
        lastReadAt: typeof source.lastReadAt === 'string' ? source.lastReadAt.slice(0, 60) : '',
      }]
    }) : []
    return [date, { seconds, sources }]
  }))
}

// Anything read from disk is untrusted: a truncated or hand-edited state file
// must degrade to defaults instead of crashing the first render.
function mergeState(value: unknown): PersistedState | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<PersistedState>
  const base = defaultState()
  const session = (input.session && typeof input.session === 'object' ? input.session : {}) as Partial<PersistedState['session']>
  const notebook = input.notebook && typeof input.notebook === 'object' ? input.notebook : base.notebook
  const chat = notebook.chat && typeof notebook.chat === 'object' && !Array.isArray(notebook.chat) ? notebook.chat : {}
  const vault = (input.vault && typeof input.vault === 'object' ? input.vault : {}) as Partial<PersistedState['vault']>
  const notesSpace = (input.notesSpace && typeof input.notesSpace === 'object' ? input.notesSpace : {}) as Partial<PersistedState['notesSpace']>
  const chatSpace = (input.chatSpace && typeof input.chatSpace === 'object' ? input.chatSpace : {}) as Partial<PersistedState['chatSpace']>
  const view: NoteViewMode = notesSpace.view === 'edit' || notesSpace.view === 'preview'
    ? notesSpace.view
    : base.notesSpace.view
  const settingsInput = (input.settings && typeof input.settings === 'object' ? input.settings : {}) as Partial<PersistedState['settings']>
  const reportTime = typeof settingsInput.dailyReportTime === 'string' && isValidTimeOfDay(settingsInput.dailyReportTime)
    ? settingsInput.dailyReportTime
    : DEFAULT_REPORT_TIME
  const threads = sanitizeThreads(chatSpace.threads)
  const activeThreadId = optionalString(chatSpace.activeThreadId)
  const activeSpace: AppSpace = input.activeSpace === 'notes' || input.activeSpace === 'expressions' || input.activeSpace === 'chat'
    ? input.activeSpace
    : 'reader'
  return {
    version: 1,
    savedAt: typeof input.savedAt === 'number' && Number.isFinite(input.savedAt) ? input.savedAt : 0,
    activeSpace,
    session: {
      ...base.session,
      ...session,
      activePath: optionalString(session.activePath),
      activeFolder: optionalString(session.activeFolder),
      tabs: Array.isArray(session.tabs) ? session.tabs.filter((tab) => tab && typeof tab.path === 'string') : [],
      recentFolders: stringList(session.recentFolders),
      recentFiles: Array.isArray(session.recentFiles) ? session.recentFiles.filter((item) => item && typeof item.path === 'string') : [],
      favorites: stringList(session.favorites),
    },
    layout: { ...base.layout, ...(input.layout && typeof input.layout === 'object' ? input.layout : {}) },
    settings: {
      mode: settingsInput.mode === 'openai' ? 'openai' : 'mock',
      model: typeof settingsInput.model === 'string' && settingsInput.model ? settingsInput.model : base.settings.model,
      dailyReportTime: reportTime,
      dailyReportAuto: boolValue(settingsInput.dailyReportAuto, base.settings.dailyReportAuto),
    },
    notebook: {
      atoms: Array.isArray(notebook.atoms) ? notebook.atoms : [],
      notes: Array.isArray(notebook.notes) ? notebook.notes : [],
      chat,
    },
    inputMarkers: sanitizeInputMarkers(input.inputMarkers),
    readingActivity: sanitizeReadingActivity(input.readingActivity),
    vault: {
      root: optionalString(vault.root),
      recentRoots: stringList(vault.recentRoots, 12),
      collapsed: stringList(vault.collapsed, 400),
    },
    notesSpace: {
      openPaths: notePathList(notesSpace.openPaths),
      activePath: notePath(notesSpace.activePath),
      view,
      treeWidth: finiteNumber(notesSpace.treeWidth, DEFAULT_TREE_WIDTH, MIN_TREE_WIDTH, 720),
      sideOpen: boolValue(notesSpace.sideOpen, base.notesSpace.sideOpen),
      sideWidth: finiteNumber(notesSpace.sideWidth, DEFAULT_SIDE_WIDTH, MIN_SIDE_WIDTH, 720),
    },
    chatSpace: {
      threads,
      activeThreadId: activeThreadId && threads.some((thread) => thread.id === activeThreadId) ? activeThreadId : (threads[0]?.id ?? null),
      historyWidth: finiteNumber(chatSpace.historyWidth, DEFAULT_HISTORY_WIDTH, MIN_HISTORY_WIDTH, 520),
      pickerWidth: finiteNumber(chatSpace.pickerWidth, DEFAULT_PICKER_WIDTH, MIN_PICKER_WIDTH, 640),
      historyOpen: boolValue(chatSpace.historyOpen, base.chatSpace.historyOpen),
      pickerOpen: boolValue(chatSpace.pickerOpen, base.chatSpace.pickerOpen),
    },
  }
}

// Synchronous fast path: the renderer paints immediately with the last known
// state, then `loadState` reconciles with the on-disk copy owned by the app.
export function loadStateSync(): PersistedState {
  const raw = readLocalStorage(STATE_KEY)
  if (raw) {
    try {
      const merged = mergeState(JSON.parse(raw))
      if (merged) return merged
    } catch {
      // Fall through to the legacy migration path.
    }
  }
  const base = defaultState()
  const legacy = readLegacyLocalStorage()
  return {
    ...base,
    settings: legacy.settings || base.settings,
    notebook: legacy.notebook || base.notebook,
  }
}

export async function loadState(): Promise<PersistedState> {
  const local = loadStateSync()
  const bridge = getBridge()
  if (!bridge) return local
  let disk: PersistedState | null = null
  try {
    const raw = await bridge.state.get()
    disk = raw && Object.keys(raw).length > 0 ? mergeState(raw) : null
  } catch {
    disk = null
  }
  if (!disk) return local

  const localAt = local.savedAt || 0
  const diskAt = disk.savedAt || 0
  // The localStorage copy is written synchronously on every change, so it can
  // be up to one debounce interval (400 ms) newer than the file. Never discard
  // the newer copy: that is exactly how a note written just before a crash or a
  // failed disk write would disappear.
  if (localAt > diskAt) {
    return {
      ...local,
      // Keep disk-only session knowledge (a folder picked in another window).
      session: local.session.tabs.length > 0 || !disk.session.activeFolder
        ? local.session
        : { ...local.session, activeFolder: disk.session.activeFolder, recentFolders: disk.session.recentFolders },
    }
  }

  const diskHasNotebook = disk.notebook.atoms.length > 0
    || disk.notebook.notes.length > 0
    || Object.keys(disk.notebook.chat).length > 0
  const localHasNotebook = local.notebook.atoms.length > 0
    || local.notebook.notes.length > 0
    || Object.keys(local.notebook.chat).length > 0
  // Legacy import: an older build only had the browser store.
  if (diskAt === 0 && !diskHasNotebook && localHasNotebook) {
    return { ...disk, notebook: local.notebook }
  }
  return disk
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

function pushToDisk(state: PersistedState, warnOnFailure: boolean): void {
  const bridge = getBridge()
  if (!bridge) return
  void bridge.state.set(state).then((result) => {
    if (warnOnFailure && result && result.ok === false) {
      console.warn('[paperlight] could not write the app state file; the browser copy is newer')
    }
  }).catch((error) => {
    if (warnOnFailure) console.warn('[paperlight] app state write failed:', error)
  })
}

export function saveState(state: PersistedState): void {
  const payload = { ...state, savedAt: Date.now() }
  writeLocalStorage(STATE_KEY, JSON.stringify(payload))
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    pushToDisk(payload, true)
  }, 400)
}

// Used on window teardown: the synchronous localStorage copy is already
// durable, this just avoids leaving the debounced disk write pending.
export function flushState(state: PersistedState): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  const payload = { ...state, savedAt: Date.now() }
  writeLocalStorage(STATE_KEY, JSON.stringify(payload))
  pushToDisk(payload, false)
}
