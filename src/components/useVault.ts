import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatThread, DailyEntry, ExpressionContext, ExpressionCognitivePath, ExpressionRecord, ExpressionRelationKind,
  NotebookNote, ReadingActivityDay, SenseAtom, SensePayload, VaultEntry, VaultTreeNode,
} from '../types'
import { getApiConfigStatus } from '../lib/translation'
import {
  DAILY_DIR, DAILY_FORMAT_VERSION, DAILY_NOTES_HEADING, ENLIGHTENMENT_DIR, FINDING_CHARS_PER_FILE, FINDING_FILE_LIMIT, INBOX_FOLDER,
  LEGACY_DAILY_DIR, MANAGED_DIRS, MATERIALS_DIR, NOTES_DIR, aiNoteMarkdown, aiNotePath,
  buildVaultTree, chatAnswerMarkdown, dailyEntriesFromNotebook, dailyNoteMarkdown, dailyNotePath, dailyReportPath,
  dailySourceHash, dailySummarySection, dailyUserNotes, excerptForGrounding, frontmatterString, preserveDailyManagedEdits,
  findingNoteMarkdown, findingNotePath, findingEntries, researchNoteMarkdown, localDailySummary, localDateKey,
  markdownSection, markdownSectionAtLevel, materialMirrorFolders, notebookNoteMarkdown,
  mergeSemanticNoteMarkdown, notebookNotePath, parseNote, readerAnswerMarkdown, readerAnswerPath, reportSlotDate, safeFolderName, senseNoteMarkdown, senseNotePath,
  slugify, stringifyNote, titleFromMarkdown, uniquePath, vaultDirname, vaultJoin,
} from '../lib/vault'
import type { ReaderAnswerOptions } from '../lib/vault'
import {
  buildGroundingContext, generateVaultNote, generateVaultReport, type VaultContextFile,
} from '../lib/vaultai'
import { isVirtualVault, vaultDisplayName, vaultErrorText, vaultFileSystem } from '../lib/vaultfs'
import {
  createExpressionRecord, expressionRecordMarkdown, expressionRecordPath, mergeExpressionRecord,
  normalizeExpression, parseExpressionRecord,
} from '../lib/memory'

export interface DailyInfo {
  date: string
  path: string
  updatedAt: string
  entryCount: number
  hash: string
}

export interface ReportInfo {
  date: string
  path: string
  source: 'local' | 'ai'
  generatedAt: string
  records: number
  /** The day's records changed after this report was written. */
  stale: boolean
}

interface DailySummary {
  text: string
  source: 'local' | 'ai'
  generatedAt: string
  hash: string
}

export interface VaultApi {
  root: string | null
  rootName: string
  virtual: boolean
  ready: boolean
  loading: boolean
  error: string
  notice: string
  busy: boolean
  apiConfigured: boolean
  entries: VaultEntry[]
  files: VaultEntry[]
  /** Notes plus the original materials under `materials/`. */
  tree: VaultTreeNode[]
  /** Markdown only: used by the vault-grounded chat picker. */
  noteTree: VaultTreeNode[]
  materialFolders: string[]
  expressions: ExpressionRecord[]
  expressionsLoading: boolean
  daily: DailyInfo | null
  report: ReportInfo | null
  organizingDaily: boolean
  generatingReport: boolean
  chooseVault(): Promise<string | null>
  useVaultPath(path: string): Promise<boolean>
  refresh(): Promise<void>
  refreshApiStatus(): Promise<void>
  clearNotice(): void
  readNote(path: string): Promise<string>
  writeNote(path: string, content: string): Promise<void>
  createNote(folder: string, name: string): Promise<string>
  createFolder(folder: string, name: string): Promise<string>
  createMaterial(name: string, parent?: string): Promise<string>
  createFinding(name: string, body?: string): Promise<string>
  createResearch(name: string): Promise<string>
  renameNote(path: string, name: string): Promise<string>
  removeEntry(path: string): Promise<void>
  revealEntry(path: string): Promise<void>
  refreshExpressions(): Promise<ExpressionRecord[]>
  captureExpression(input: {
    expression: string
    meaning?: string
    note?: string
    cognitivePath: ExpressionCognitivePath
    context?: Partial<ExpressionContext>
  }): Promise<ExpressionRecord>
  updateExpression(id: string, update: { expression: string; meaning: string; note: string }): Promise<ExpressionRecord>
  relateExpressions(sourceId: string, targetId: string, kind: ExpressionRelationKind, note?: string): Promise<void>
  deleteExpression(id: string): Promise<void>
  saveSenseNote(atom: SenseAtom): Promise<string>
  saveNotebookNote(note: NotebookNote, atoms: SenseAtom[]): Promise<string>
  generateSenseNote(sense: SensePayload, context: string, senseIds?: string[], notesFolder?: string): Promise<string>
  generateTopicNote(topic: string, notesFolder?: string): Promise<string>
  saveChatAnswer(thread: ChatThread, question: string, answer: string, sources: string[], grounded?: boolean): Promise<string>
  saveReaderAnswer(answer: ReaderAnswerOptions): Promise<string>
  groundingContext(paths: string[]): Promise<{ context: VaultContextFile[]; skipped: string[] }>
  /** Rebuilds the day's record list (local, cheap, no model call). */
  refreshDaily(date?: string, options?: { force?: boolean; silent?: boolean }): Promise<DailyInfo | null>
  /** Writes the day's report (AI when configured), overwriting the previous one. */
  generateReport(date?: string, options?: { force?: boolean; silent?: boolean }): Promise<ReportInfo | null>
  /** Scheduler entry point: generates the report once its time slot has passed. */
  maybeGenerateReport(): Promise<void>
}

/**
 * Owns the notes vault: the folder listing, every Markdown read/write, the
 * materials → notes mirror, the sense/chat/AI notes that land in it, the day's
 * record list and its report.
 *
 * Drafts stay in the notes desk; this hook is only about the vault on disk.
 */
export function useVault(options: {
  root: string | null
  atoms: SenseAtom[]
  notes: NotebookNote[]
  readingActivity: Record<string, ReadingActivityDay>
  model: string
  reportTime: string
  reportAuto: boolean
  onRootChange: (root: string) => void
}): VaultApi {
  const { root, atoms, notes, readingActivity, model, reportTime, reportAuto, onRootChange } = options
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [apiConfigured, setApiConfigured] = useState(false)
  const [daily, setDaily] = useState<DailyInfo | null>(null)
  const [report, setReport] = useState<ReportInfo | null>(null)
  const [organizingDaily, setOrganizingDaily] = useState(false)
  const [generatingReport, setGeneratingReport] = useState(false)
  const [expressions, setExpressions] = useState<ExpressionRecord[]>([])
  const [expressionsLoading, setExpressionsLoading] = useState(false)

  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const atomsRef = useRef(atoms)
  atomsRef.current = atoms
  const notesRef = useRef(notes)
  notesRef.current = notes
  const modelRef = useRef(model)
  modelRef.current = model
  const apiConfiguredRef = useRef(apiConfigured)
  apiConfiguredRef.current = apiConfigured
  const rootRef = useRef(root)
  rootRef.current = root
  const reportTimeRef = useRef(reportTime)
  reportTimeRef.current = reportTime
  const reportAutoRef = useRef(reportAuto)
  reportAutoRef.current = reportAuto
  const expressionsRef = useRef(expressions)
  expressionsRef.current = expressions
  const readingActivityRef = useRef(readingActivity)
  readingActivityRef.current = readingActivity

  const scaffolding = useRef(new Set<string>())
  const legacyChecked = useRef(new Set<string>())
  const scheduledAttempts = useRef(new Set<string>())
  const reportGenerationInProgress = useRef(new Set<string>())
  const noticeTimer = useRef<number | null>(null)
  const dailyTimer = useRef<number | null>(null)
  const refreshDailyRef = useRef<((date?: string, options?: { force?: boolean; silent?: boolean }) => Promise<DailyInfo | null>) | null>(null)

  const port = vaultFileSystem()

  const refreshExpressions = useCallback(async () => {
    const current = rootRef.current
    if (!current) {
      expressionsRef.current = []
      setExpressions([])
      return []
    }
    setExpressionsLoading(true)
    try {
      const listing = await port.tree(current)
      const records = await Promise.all(listing
        .filter((entry) => !entry.directory && /^expressions\/[^/]+\.(?:md|markdown)$/i.test(entry.path))
        .map(async (entry) => {
          try { return parseExpressionRecord(await port.read(current, entry.path)) } catch { return null }
        }))
      const next = records.filter((record): record is ExpressionRecord => Boolean(record))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      if (rootRef.current === current) {
        expressionsRef.current = next
        setExpressions(next)
      }
      return next
    } finally {
      setExpressionsLoading(false)
    }
  }, [port])

  const flashNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 8000)
  }, [])

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    if (dailyTimer.current) window.clearTimeout(dailyTimer.current)
  }, [])

  const patchEntries = useCallback((path: string, content: string) => {
    setEntries((previous) => {
      const next = previous.filter((entry) => entry.path !== path)
      next.push({ path, directory: false, size: content.length, mtimeMs: Date.now() })
      let parent = vaultDirname(path)
      while (parent) {
        if (!next.some((entry) => entry.path === parent)) {
          next.push({ path: parent, directory: true, size: 0, mtimeMs: 0 })
        }
        parent = vaultDirname(parent)
      }
      return next
    })
  }, [])

  const dropEntries = useCallback((path: string) => {
    setEntries((previous) => previous.filter((entry) => entry.path !== path && !entry.path.startsWith(`${path}/`)))
  }, [])

  const afterWrite = useCallback((path: string) => {
    if (path.startsWith(`${DAILY_DIR}/`) || path.startsWith(`${LEGACY_DAILY_DIR}/`)) return
    if (dailyTimer.current) window.clearTimeout(dailyTimer.current)
    dailyTimer.current = window.setTimeout(() => { void refreshDailyRef.current?.() }, 2000)
  }, [])

  // ------------------------------------------------------------- listing

  const ensureScaffold = useCallback(async (listing: VaultEntry[]) => {
    const current = rootRef.current
    if (!current) return null
    const wanted = [...MANAGED_DIRS]
    for (const folder of materialMirrorFolders(listing)) wanted.push(vaultJoin(NOTES_DIR, folder))
    let created = false
    for (const folder of wanted) {
      scaffolding.current.add(folder)
      if (listing.some((entry) => entry.directory && entry.path === folder)) continue
      try {
        await port.mkdir(current, folder)
        created = true
      } catch {
        scaffolding.current.delete(folder)
      }
    }
    // The new folders must show up in the tree right away.
    return created ? port.tree(current) : null
  }, [port])

  const refresh = useCallback(async () => {
    const current = rootRef.current
    if (!current) {
      setEntries([])
      expressionsRef.current = []
      setExpressions([])
      setDaily(null)
      setReport(null)
      return
    }
    setLoading(true)
    setError('')
    try {
      let listing = await port.tree(current)
      const afterScaffold = await ensureScaffold(listing)
      if (afterScaffold) listing = afterScaffold
      setEntries(listing)
      await refreshExpressions()
    } catch (caught) {
      setError(vaultErrorText(caught, '无法读取这个 vault。'))
    } finally {
      setLoading(false)
    }
  }, [ensureScaffold, port, refreshExpressions])

  useEffect(() => { void refresh() }, [refresh, root])

  const refreshApiStatus = useCallback(async () => {
    try {
      const status = await getApiConfigStatus()
      setApiConfigured(status.configured)
    } catch {
      setApiConfigured(false)
    }
  }, [])

  useEffect(() => { void refreshApiStatus() }, [refreshApiStatus, root])

  // ------------------------------------------------------------- roots

  const useVaultPath = useCallback(async (path: string) => {
    try {
      const info = await port.stat(path)
      if (!info.exists || !info.directory) {
        setError('这个文件夹不存在，无法作为 vault。')
        return false
      }
      setError('')
      scaffolding.current.clear()
      legacyChecked.current.clear()
      onRootChange(path)
      return true
    } catch (caught) {
      setError(vaultErrorText(caught, '无法打开这个 vault。'))
      return false
    }
  }, [onRootChange, port])

  const chooseVault = useCallback(async () => {
    try {
      const picked = await port.pick()
      if (!picked) return null
      const ok = await useVaultPath(picked)
      return ok ? picked : null
    } catch (caught) {
      setError(vaultErrorText(caught, '无法选择 vault 文件夹。'))
      return null
    }
  }, [port, useVaultPath])

  // ------------------------------------------------------------- file io

  const readNote = useCallback(async (path: string) => {
    const current = rootRef.current
    if (!current) throw new Error('尚未选择笔记 vault。')
    return port.read(current, path)
  }, [port])

  const writeNote = useCallback(async (path: string, content: string) => {
    const current = rootRef.current
    if (!current) throw new Error('尚未选择笔记 vault。')
    await port.write(current, path, content)
    patchEntries(path, content)
    if (/^expressions\/[^/]+\.(?:md|markdown)$/i.test(path)) await refreshExpressions()
    afterWrite(path)
  }, [afterWrite, patchEntries, port, refreshExpressions])

  const takenPaths = useMemo(() => new Set(entries.map((entry) => entry.path)), [entries])

  const createNote = useCallback(async (folder: string, name: string) => {
    const title = name.replace(/\.md$/i, '').trim() || '未命名笔记'
    const path = uniquePath(vaultJoin(folder, `${slugify(title, 'note')}.md`), takenPaths)
    const content = stringifyNote({
      title,
      kind: 'note',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      tags: ['paperlight'],
    }, `# ${title}\n\n`)
    await writeNote(path, content)
    return path
  }, [takenPaths, writeNote])

  const createFolder = useCallback(async (folder: string, name: string) => {
    const current = rootRef.current
    if (!current) throw new Error('尚未选择笔记 vault。')
    const path = vaultJoin(folder, slugify(name, 'new-folder'))
    await port.mkdir(current, path)
    await refresh()
    return path
  }, [port, refresh])

  /** A material folder: `materials/<name>` plus its `notes/<name>` mirror. */
  const createMaterial = useCallback(async (name: string, parent = '') => {
    const current = rootRef.current
    if (!current) throw new Error('尚未选择笔记 vault。')
    const folder = safeFolderName(name)
    const materialPath = vaultJoin(MATERIALS_DIR, parent, folder)
    await port.mkdir(current, materialPath)
    await port.mkdir(current, vaultJoin(NOTES_DIR, parent, folder))
    scaffolding.current.add(vaultJoin(NOTES_DIR, parent, folder))
    await refresh()
    return materialPath
  }, [port, refresh])

  /** A quick note in the user's own `enlightenment/` folder. */
  const createFinding = useCallback(async (name: string, body = '') => {
    const title = name.trim() || '未命名发现'
    const date = localDateKey()
    const path = uniquePath(findingNotePath(date, title), takenPaths)
    await writeNote(path, findingNoteMarkdown({ title, body: body || `## 观察\n\n## 推论\n\n## 待验证\n`, date }))
    return path
  }, [takenPaths, writeNote])

  const createResearch = useCallback(async (name: string) => {
    const title = name.trim() || '未命名研究'
    const date = localDateKey()
    const path = uniquePath(vaultJoin(ENLIGHTENMENT_DIR, `${date}-research-${slugify(title, 'research')}.md`), takenPaths)
    await writeNote(path, researchNoteMarkdown({ title, date }))
    return path
  }, [takenPaths, writeNote])

  const renameNote = useCallback(async (path: string, name: string) => {
    const title = name.replace(/\.md$/i, '').trim()
    if (!title) return path
    const next = uniquePath(vaultJoin(vaultDirname(path), `${slugify(title, 'note')}.md`), new Set([...takenPaths].filter((item) => item !== path)))
    if (next === path) return path
    const source = await readNote(path)
    const parsed = parseNote(source)
    const body = /^#\s+/m.test(parsed.body)
      ? parsed.body.replace(/^#\s+.*$/m, `# ${title}`)
      : `# ${title}\n\n${parsed.body}`
    await writeNote(next, stringifyNote({ ...parsed.data, title, updated: new Date().toISOString() }, body))
    await port.remove(rootRef.current!, path)
    dropEntries(path)
    return next
  }, [dropEntries, port, readNote, takenPaths, writeNote])

  const removeEntry = useCallback(async (path: string) => {
    const current = rootRef.current
    if (!current) throw new Error('尚未选择笔记 vault。')
    await port.remove(current, path)
    dropEntries(path)
  }, [dropEntries, port])

  const revealEntry = useCallback(async (path: string) => {
    const current = rootRef.current
    if (!current) return
    await port.reveal(current, path).catch(() => false)
  }, [port])

  const captureExpression = useCallback(async (input: {
    expression: string
    meaning?: string
    note?: string
    cognitivePath: ExpressionCognitivePath
    context?: Partial<ExpressionContext>
  }) => {
    const current = rootRef.current
    if (!current) throw new Error('请先选择一个 Vault，表达将以 Markdown 保存在其中。')
    const incoming = createExpressionRecord(input)
    let known = expressionsRef.current
    if (!known.some((record) => record.normalizedExpression === incoming.normalizedExpression)) {
      known = await refreshExpressions()
    }
    const existing = known.find((record) => record.normalizedExpression === incoming.normalizedExpression)
    const record = existing ? mergeExpressionRecord(existing, incoming) : incoming
    await writeNote(expressionRecordPath(record), expressionRecordMarkdown(record))
    expressionsRef.current = [record, ...expressionsRef.current.filter((item) => item.id !== record.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    setExpressions(expressionsRef.current)
    return record
  }, [refreshExpressions, writeNote])

  const updateExpression = useCallback(async (id: string, update: { expression: string; meaning: string; note: string }) => {
    const record = expressionsRef.current.find((item) => item.id === id)
    if (!record) throw new Error('找不到这条表达记录。')
    const normalizedExpression = normalizeExpression(update.expression)
    if (!normalizedExpression) throw new Error('表达本体不能为空。')
    if (expressionsRef.current.some((item) => item.id !== id && item.normalizedExpression === normalizedExpression)) {
      throw new Error('这个表达与另一条记录相同；请先检查来源语境，再手动整合。')
    }
    const next: ExpressionRecord = {
      ...record,
      expression: update.expression.trim().slice(0, 280),
      normalizedExpression,
      meaning: update.meaning.trim().slice(0, 2_000),
      note: update.note.trim().slice(0, 8_000),
      updatedAt: new Date().toISOString(),
    }
    await writeNote(expressionRecordPath(next), expressionRecordMarkdown(next))
    expressionsRef.current = [next, ...expressionsRef.current.filter((item) => item.id !== id)]
    setExpressions(expressionsRef.current)
    return next
  }, [writeNote])

  const relateExpressions = useCallback(async (sourceId: string, targetId: string, kind: ExpressionRelationKind, note = '') => {
    if (sourceId === targetId) throw new Error('表达不能关联到自身。')
    const source = expressionsRef.current.find((item) => item.id === sourceId)
    const target = expressionsRef.current.find((item) => item.id === targetId)
    if (!source || !target) throw new Error('找不到要关联的表达。')
    const createdAt = new Date().toISOString()
    const relation = (targetId: string) => ({ id: `${kind}-${targetId}`, targetId, kind, note: note.trim().slice(0, 500), source: 'user' as const, createdAt })
    const nextSource = { ...source, relations: [...source.relations.filter((item) => item.targetId !== targetId), relation(targetId)], updatedAt: createdAt }
    const nextTarget = { ...target, relations: [...target.relations.filter((item) => item.targetId !== sourceId), relation(sourceId)], updatedAt: createdAt }
    await writeNote(expressionRecordPath(nextSource), expressionRecordMarkdown(nextSource))
    try {
      await writeNote(expressionRecordPath(nextTarget), expressionRecordMarkdown(nextTarget))
    } catch (error) {
      await writeNote(expressionRecordPath(source), expressionRecordMarkdown(source)).catch(() => undefined)
      throw error
    }
    expressionsRef.current = expressionsRef.current.map((item) => item.id === sourceId ? nextSource : item.id === targetId ? nextTarget : item)
    setExpressions(expressionsRef.current)
  }, [writeNote])

  const deleteExpression = useCallback(async (id: string) => {
    const record = expressionsRef.current.find((item) => item.id === id)
    if (!record) return
    await removeEntry(expressionRecordPath(record))
    expressionsRef.current = expressionsRef.current.filter((item) => item.id !== id)
    setExpressions(expressionsRef.current)
  }, [removeEntry])

  // -------------------------------------------------- notes from the reader

  const saveSenseNote = useCallback(async (atom: SenseAtom) => {
    const path = senseNotePath(atom)
    const existing = entriesRef.current.some((entry) => entry.path === path && !entry.directory)
      ? await readNote(path)
      : null
    await writeNote(path, existing ? mergeSemanticNoteMarkdown(existing, atom) : senseNoteMarkdown(atom))
    return path
  }, [readNote, writeNote])

  const saveNotebookNote = useCallback(async (note: NotebookNote, knownAtoms: SenseAtom[]) => {
    const path = notebookNotePath(note)
    await writeNote(path, notebookNoteMarkdown(note, knownAtoms))
    return path
  }, [writeNote])

  const generateSenseNote = useCallback(async (
    sense: SensePayload,
    context: string,
    senseIds: string[] = [],
    notesFolder?: string,
  ) => {
    setBusy(true)
    try {
      const result = await generateVaultNote({
        task: 'sense',
        term: sense.term || sense.lemma,
        sense,
        context,
        model: modelRef.current,
      })
      const date = localDateKey()
      const title = titleFromMarkdown(result.markdown, result.title || sense.term || 'AI 笔记')
      const path = uniquePath(aiNotePath(notesFolder ?? INBOX_FOLDER, date, title), new Set([...takenPaths]))
      await writeNote(path, aiNoteMarkdown({
        title,
        markdown: result.markdown,
        date,
        tags: [slugify(sense.lemma || sense.term, 'term')],
        senses: senseIds,
        source: modelRef.current || 'ai',
        notesFolder: notesFolder ?? INBOX_FOLDER,
      }))
      return path
    } finally {
      setBusy(false)
    }
  }, [takenPaths, writeNote])

  const generateTopicNote = useCallback(async (topic: string, notesFolder?: string) => {
    setBusy(true)
    try {
      const result = await generateVaultNote({
        task: 'topic',
        term: topic,
        question: topic,
        model: modelRef.current,
      })
      const date = localDateKey()
      const title = titleFromMarkdown(result.markdown, result.title || topic)
      const path = uniquePath(aiNotePath(notesFolder ?? INBOX_FOLDER, date, title), new Set([...takenPaths]))
      await writeNote(path, aiNoteMarkdown({
        title,
        markdown: result.markdown,
        date,
        tags: [slugify(topic, 'topic')],
        source: modelRef.current || 'ai',
        notesFolder: notesFolder ?? INBOX_FOLDER,
      }))
      return path
    } finally {
      setBusy(false)
    }
  }, [takenPaths, writeNote])

  const saveChatAnswer = useCallback(async (thread: ChatThread, question: string, answer: string, sources: string[], grounded = false) => {
    const date = localDateKey()
    let target = chatAnswerMarkdown({
      threadTitle: thread.title,
      question,
      answer,
      sources,
      model: modelRef.current,
      date,
      grounded,
    })
    const occupied = new Set(entriesRef.current.map((entry) => entry.path))
    if (occupied.has(target.path)) {
      target = { path: uniquePath(target.path, occupied), content: target.content }
    }
    await writeNote(target.path, target.content)
    return target.path
  }, [writeNote])

  const saveReaderAnswer = useCallback(async (answer: ReaderAnswerOptions) => {
    const basePath = readerAnswerPath(answer.answerId, answer.title)
    const occupied = new Set(entriesRef.current.map((entry) => entry.path))
    let path = basePath
    if (occupied.has(basePath)) {
      try {
        const existing = parseNote(await readNote(basePath))
        if (frontmatterString(existing.data, 'source') === 'reader-assistant'
          && frontmatterString(existing.data, 'answerId') === answer.answerId) return basePath
      } catch { /* A stale or unreadable path is treated as occupied below. */ }
      path = uniquePath(basePath, new Set([...occupied, basePath]))
    }
    await writeNote(path, readerAnswerMarkdown(answer))
    return path
  }, [readNote, writeNote])

  const groundingContext = useCallback(async (paths: string[]) => buildGroundingContext(paths, readNote), [readNote])

  // ------------------------------------------------------- day + report

  const readDayState = useCallback(async (date: string, listing: VaultEntry[]): Promise<{
    entries: DailyEntry[]
    hash: string
    files: VaultEntry[]
    readingActivity: ReadingActivityDay
  }> => {
    const activity = readingActivityRef.current[date] || { seconds: 0, sources: [] }
    const entriesForDay = dailyEntriesFromNotebook(atomsRef.current, notesRef.current, date, {
      files: listing,
      selfPath: dailyNotePath(date),
      expressions: expressionsRef.current,
    })
    const findings = findingEntries(listing, date)
    const activityHash = [`reading:${activity.seconds}`, ...activity.sources.map((source) => `${source.sourcePath}:${source.seconds}`)]
    return {
      entries: entriesForDay,
      hash: dailySourceHash(entriesForDay, [...findings.map((entry) => entry.path), ...activityHash]),
      files: findings,
      readingActivity: activity,
    }
  }, [])

  const refreshDaily = useCallback(async (date = localDateKey(), runOptions: {
    force?: boolean
    silent?: boolean
    summary?: DailySummary
  } = {}) => {
    const current = rootRef.current
    if (!current) return null
    setOrganizingDaily(true)
    try {
      let listing = entriesRef.current
      try {
        listing = await port.tree(current)
        entriesRef.current = listing
        setEntries(listing)
      } catch {
        listing = entriesRef.current
      }
      const path = dailyNotePath(date)
      const { entries: list, hash } = await readDayState(date, listing)

      let existing = ''
      if (listing.some((entry) => entry.path === path)) {
        try {
          existing = await readNote(path)
        } catch {
          existing = ''
        }
      }
      const parsed = existing ? parseNote(existing) : null

      let userNotes = parsed ? dailyUserNotes(parsed.body) : ''
      if (!parsed && existing) {
        // An older note without our headings: keep whatever the user wrote.
        userNotes = markdownSection(existing, DAILY_NOTES_HEADING) || existing.trim()
      }

      if (parsed && (parsed.data.hash !== hash || runOptions.force || runOptions.summary)) {
        const managedHash = typeof parsed.data.managedHash === 'string' ? parsed.data.managedHash : ''
        userNotes = preserveDailyManagedEdits(parsed.body, managedHash, userNotes)
      }

      let dailySummary = runOptions.summary
      if (!dailySummary && parsed && frontmatterString(parsed.data, 'summarySource') === 'ai') {
        const text = dailySummarySection(parsed.body)
        if (text) {
          dailySummary = {
            text,
            source: 'ai',
            generatedAt: frontmatterString(parsed.data, 'summaryGeneratedAt'),
            hash: frontmatterString(parsed.data, 'summaryHash') || frontmatterString(parsed.data, 'hash'),
          }
        }
      }
      if (!dailySummary && parsed) {
        const archivePath = frontmatterString(parsed.data, 'report') || dailyReportPath(date)
        if (listing.some((entry) => !entry.directory && entry.path === archivePath)) {
          try {
            const archived = parseNote(await readNote(archivePath))
            const text = dailySummarySection(archived.body)
            if (text && frontmatterString(archived.data, 'source') === 'ai') {
              dailySummary = {
                text,
                source: 'ai',
                generatedAt: frontmatterString(archived.data, 'generated'),
                hash: frontmatterString(archived.data, 'hash') || frontmatterString(parsed.data, 'hash'),
              }
            }
          } catch { /* the archived report remains untouched if it cannot be read */ }
        }
      }

      const settled = Boolean(parsed)
        && frontmatterString(parsed!.data, 'hash') === hash
        && frontmatterString(parsed!.data, 'format') === String(DAILY_FORMAT_VERSION)
        && !frontmatterString(parsed!.data, 'report')
        && (!dailySummary || frontmatterString(parsed!.data, 'summarySource') === dailySummary.source)

      if (!runOptions.force && !runOptions.summary && settled) {
        const info: DailyInfo = {
          date,
          path,
          updatedAt: String(parsed?.data.updated || ''),
          entryCount: list.length,
          hash,
        }
        setDaily(info)
        await loadReportInfo(date, path, list, hash)
        return info
      }

      await writeNote(path, dailyNoteMarkdown({
        date,
        entries: list,
        readingActivity: readingActivityRef.current[date],
        reportTime: reportTimeRef.current,
        userNotes,
        hash,
        summaryText: dailySummary?.text,
        summarySource: dailySummary?.source,
        summaryGeneratedAt: dailySummary?.generatedAt,
        summaryHash: dailySummary?.hash,
      }))
      const info: DailyInfo = { date, path, updatedAt: new Date().toISOString(), entryCount: list.length, hash }
      setDaily(info)
      await loadReportInfo(date, path, list, hash)
      if (!runOptions.silent) flashNotice(`${date} 的记录清单已更新（${list.length} 条）。`)
      return info
    } catch (caught) {
      setError(vaultErrorText(caught, '无法更新当天的记录清单。'))
      return null
    } finally {
      setOrganizingDaily(false)
    }
  }, [flashNotice, port, readDayState, readNote, writeNote])

  const loadReportInfo = useCallback(async (
    date: string,
    path: string,
    list: DailyEntry[],
    hash: string,
  ) => {
    try {
      const parsed = parseNote(await readNote(path))
      const source = frontmatterString(parsed.data, 'summarySource')
      if (source !== 'ai' && source !== 'local') {
        setReport(null)
        return null
      }
      const info: ReportInfo = {
        date,
        path,
        source,
        generatedAt: frontmatterString(parsed.data, 'summaryGeneratedAt'),
        records: list.length,
        stale: frontmatterString(parsed.data, 'summaryHash') !== hash,
      }
      setReport(info)
      return info
    } catch {
      setReport(null)
      return null
    }
  }, [readNote])

  refreshDailyRef.current = refreshDaily

  const generateReport = useCallback(async (date = localDateKey(), runOptions: { force?: boolean; silent?: boolean } = {}) => {
    const current = rootRef.current
    if (!current || reportGenerationInProgress.current.has(date)) return null
    reportGenerationInProgress.current.add(date)
    setGeneratingReport(true)
    if (!runOptions.silent) setBusy(true)
    try {
      let listing = entriesRef.current
      try {
        listing = await port.tree(current)
        setEntries(listing)
      } catch {
        listing = entriesRef.current
      }
      const { entries: list, hash, files: findingFiles, readingActivity } = await readDayState(date, listing)

      // The user's own findings are read in full: the report must reflect them.
      const findings: Array<{ path: string; content: string }> = []
      for (const file of findingFiles.slice(0, FINDING_FILE_LIMIT)) {
        try {
          findings.push({ path: file.path, content: excerptForGrounding(await readNote(file.path), FINDING_CHARS_PER_FILE) })
        } catch { /* an unreadable finding is simply skipped */ }
      }

      if (list.length === 0 && findings.length === 0 && readingActivity.seconds === 0) {
        setReport(null)
        if (!runOptions.silent) flashNotice(`${date} 还没有可汇总的记录。`)
        return null
      }

      let summary = dailySummarySection(localDailySummary(date, list, readingActivity))
      let source: 'local' | 'ai' = 'local'
      if (apiConfiguredRef.current) {
        try {
          const generated = await generateVaultReport({
            date,
            records: [
              { kind: 'reading_time', label: '读了多久', body: readingActivity.seconds ? `约 ${Math.max(1, Math.round(readingActivity.seconds / 60))} 分钟（估算）` : '今天尚无可确认的阅读时长。' },
              ...readingActivity.sources.map((source) => ({ kind: 'reading_source', label: source.sourceName, body: `约 ${Math.max(1, Math.round(source.seconds / 60))} 分钟（估算）` })),
              ...list.map((entry) => ({ kind: entry.kind, label: entry.label, body: entry.body, path: entry.path })),
            ],
            findings,
            model: modelRef.current,
          })
          if (generated) {
            summary = generated.trim()
            source = 'ai'
          }
        } catch (caught) {
          flashNotice(`AI 日报生成失败，已改用本地整理：${vaultErrorText(caught, '未知错误')}`)
        }
      } else {
        flashNotice('还没有配置 API：日报先按本地规则整理。')
      }

      const generatedAt = new Date().toISOString()
      const path = dailyNotePath(date)
      await refreshDaily(date, {
        silent: true,
        summary: { text: summary, source, generatedAt, hash },
      })
      const info: ReportInfo = {
        date,
        path,
        source,
        generatedAt,
        records: list.length,
        stale: false,
      }
      setReport(info)
      if (!runOptions.silent) flashNotice(`${date} 的总结已${source === 'ai' ? '由 AI 整理' : '按本地规则整理'}并写入当天的 Daily。`)
      return info
    } catch (caught) {
      setError(vaultErrorText(caught, '无法生成日报。'))
      return null
    } finally {
      reportGenerationInProgress.current.delete(date)
      setGeneratingReport(false)
      if (!runOptions.silent) setBusy(false)
    }
  }, [flashNotice, port, readDayState, readNote, refreshDaily])

  /** One attempt per day slot: a failure must not retry on every tick. */
  const maybeGenerateReport = useCallback(async () => {
    if (!reportAutoRef.current || !rootRef.current) return
    const now = new Date()
    const slot = reportSlotDate(now, reportTimeRef.current)
    if (scheduledAttempts.current.has(slot) || reportGenerationInProgress.current.has(slot)) return
    const listing = entriesRef.current
    const { entries: list, files, readingActivity, hash } = await readDayState(slot, listing)
    if (list.length === 0 && files.length === 0 && readingActivity.seconds === 0) return
    if (listing.some((entry) => !entry.directory && entry.path === dailyNotePath(slot))) {
      try {
        const parsed = parseNote(await readNote(dailyNotePath(slot)))
        const source = frontmatterString(parsed.data, 'summarySource')
        if ((source === 'ai' || source === 'local') && frontmatterString(parsed.data, 'summaryHash') === hash) return
      } catch { /* the scheduler can still build today's summary */ }
    }
    scheduledAttempts.current.add(slot)
    const info = await generateReport(slot, { silent: true })
    if (info) flashNotice(`${slot} 的日报已自动生成。`)
  }, [flashNotice, generateReport, readDayState, readNote])

  // -------------------------------------------------- legacy daily migration

  useEffect(() => {
    if (!root || loading) return
    if (legacyChecked.current.has(root)) return
    if (!entries.some((entry) => entry.path.startsWith(`${LEGACY_DAILY_DIR}/`))) {
      legacyChecked.current.add(root)
      return
    }
    legacyChecked.current.add(root)
    void (async () => {
      const legacy = entries
        .filter((entry) => !entry.directory && /^Paperlight\/Daily\/\d{4}-\d{2}-\d{2}\.md$/i.test(entry.path))
        .slice(0, 40)
      if (legacy.length === 0) return
      let copied = 0
      let conflicts = 0
      const occupiedPaths = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.path))
      for (const file of legacy) {
        const date = /(\d{4}-\d{2}-\d{2})\.md$/i.exec(file.path)?.[1]
        if (!date) continue
        const target = dailyNotePath(date)
        if (occupiedPaths.has(target)) {
          conflicts += 1
          continue
        }
        try {
          const parsed = parseNote(await readNote(file.path))
          // Fold a legacy fifth-section summary into the canonical Daily file.
          // The original Paperlight/Daily note and any pre-existing `-report`
          // file remain untouched as recovery copies.
          const legacySummary = markdownSectionAtLevel(parsed.body, '## 当日汇总')
            || markdownSection(parsed.body, '## 当日汇总')
          const summaryText = legacySummary
            ? dailySummarySection(legacySummary) || (legacySummary.includes('\n## ') ? '' : legacySummary)
            : ''
          const userNotes = dailyUserNotes(parsed.body)
          const { entries: list, hash } = await readDayState(date, entries)
          await writeNote(target, dailyNoteMarkdown({
            date, entries: list, reportTime: reportTimeRef.current, userNotes, hash,
            readingActivity: readingActivityRef.current[date],
            summaryText,
            summarySource: summaryText ? (frontmatterString(parsed.data, 'summary') === 'ai' ? 'ai' : 'local') : undefined,
            summaryGeneratedAt: String(parsed.data.updated || '') || undefined,
            summaryHash: summaryText ? hash : undefined,
          }))
          occupiedPaths.add(target)
          // Keep the original V1 Markdown as a recovery copy. Cleanup can be a
          // separate user decision after they have checked the new files.
          copied += 1
        } catch {
          // Leave a legacy file alone when it cannot be migrated cleanly.
        }
      }
      if (copied > 0 || conflicts > 0) {
        const details = [
          copied > 0 ? `已复制 ${copied} 份旧记录到 Daily/；原始 Paperlight/Daily 文件仍保留，供核对或恢复。` : '',
          conflicts > 0 ? `${conflicts} 份因目标文件已存在而跳过，未覆盖现有内容。` : '',
        ].filter(Boolean).join(' ')
        flashNotice(details)
        await refresh()
      }
    })()
  }, [entries, flashNotice, loading, readDayState, readNote, refresh, root, writeNote])

  // ------------------------------------------------------------- derived

  const keepDirs = useMemo(
    () => [...MANAGED_DIRS, ...materialMirrorFolders(entries).map((folder) => vaultJoin(NOTES_DIR, folder))],
    [entries],
  )
  const tree = useMemo(() => {
    const result = buildVaultTree(entries, { keepDirs })
    const dailyNode = result.find((node) => node.path === DAILY_DIR && node.type === 'dir')
    if (dailyNode) {
      dailyNode.children = dailyNode.children.map((node) => {
        const archivedDate = /^(\d{4}-\d{2}-\d{2})-report\.md$/i.exec(node.name)
        return archivedDate ? { ...node, name: `${archivedDate[1]}（旧版日报保留）` } : node
      })
    }
    return result
  }, [entries, keepDirs])
  const noteTree = useMemo(() => buildVaultTree(entries, { sources: 'none', keepDirs }), [entries, keepDirs])
  const files = useMemo(() => entries.filter((entry) => !entry.directory), [entries])
  const materialFolders = useMemo(() => materialMirrorFolders(entries), [entries])

  return {
    root,
    rootName: vaultDisplayName(root),
    virtual: isVirtualVault(root),
    ready: Boolean(root),
    loading,
    error,
    notice,
    busy,
    apiConfigured,
    entries,
    files,
    expressions,
    expressionsLoading,
    tree,
    noteTree,
    materialFolders,
    daily,
    report,
    organizingDaily,
    generatingReport,
    chooseVault,
    useVaultPath,
    refresh,
    refreshApiStatus,
    clearNotice: () => setNotice(''),
    readNote,
    writeNote,
    createNote,
    createFolder,
    createMaterial,
    createFinding,
    createResearch,
    renameNote,
    removeEntry,
    revealEntry,
    refreshExpressions,
    captureExpression,
    updateExpression,
    relateExpressions,
    deleteExpression,
    saveSenseNote,
    saveNotebookNote,
    generateSenseNote,
    generateTopicNote,
    saveChatAnswer,
    saveReaderAnswer,
    groundingContext,
    refreshDaily,
    generateReport,
    maybeGenerateReport,
  }
}
