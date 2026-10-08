import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatThread, DailyEntry, NotebookNote, SenseAtom, SensePayload, VaultEntry, VaultTreeNode,
} from '../types'
import { getApiConfigStatus } from '../lib/translation'
import {
  DAILY_DIR, DAILY_NOTES_HEADING, FINDING_CHARS_PER_FILE, FINDING_FILE_LIMIT, INBOX_FOLDER,
  LEGACY_DAILY_DIR, MANAGED_DIRS, MATERIALS_DIR, NOTES_DIR, aiNoteMarkdown, aiNotePath,
  buildVaultTree, chatAnswerMarkdown, dailyEntriesFromNotebook, dailyNoteMarkdown, dailyNotePath,
  dailyReportMarkdown, dailyReportPath, dailySourceHash, dailyUserNotes, excerptForGrounding,
  findingNoteMarkdown, findingNotePath, findingEntries, localDailySummary, localDateKey,
  markdownSection, markdownSectionAtLevel, materialMirrorFolders, notebookNoteMarkdown,
  notebookNotePath, parseNote, reportSlotDate, safeFolderName, senseNoteMarkdown, senseNotePath,
  slugify, stringifyNote, titleFromMarkdown, uniquePath, vaultDirname, vaultJoin,
} from '../lib/vault'
import {
  buildGroundingContext, generateVaultNote, generateVaultReport, type VaultContextFile,
} from '../lib/vaultai'
import { isVirtualVault, vaultDisplayName, vaultErrorText, vaultFileSystem } from '../lib/vaultfs'

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
  renameNote(path: string, name: string): Promise<string>
  removeEntry(path: string): Promise<void>
  revealEntry(path: string): Promise<void>
  saveSenseNote(atom: SenseAtom): Promise<string>
  saveNotebookNote(note: NotebookNote, atoms: SenseAtom[]): Promise<string>
  generateSenseNote(sense: SensePayload, context: string, senseIds?: string[], notesFolder?: string): Promise<string>
  generateTopicNote(topic: string, notesFolder?: string): Promise<string>
  saveChatAnswer(thread: ChatThread, question: string, answer: string, sources: string[]): Promise<string>
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
  model: string
  reportTime: string
  reportAuto: boolean
  onRootChange: (root: string) => void
}): VaultApi {
  const { root, atoms, notes, model, reportTime, reportAuto, onRootChange } = options
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

  const scaffolding = useRef(new Set<string>())
  const legacyChecked = useRef(new Set<string>())
  const scheduledAttempts = useRef(new Set<string>())
  const noticeTimer = useRef<number | null>(null)
  const dailyTimer = useRef<number | null>(null)
  const refreshDailyRef = useRef<((date?: string, options?: { force?: boolean; silent?: boolean }) => Promise<DailyInfo | null>) | null>(null)

  const port = vaultFileSystem()

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
    } catch (caught) {
      setError(vaultErrorText(caught, '无法读取这个 vault。'))
    } finally {
      setLoading(false)
    }
  }, [ensureScaffold, port])

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
    afterWrite(path)
  }, [afterWrite, patchEntries, port])

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

  // -------------------------------------------------- notes from the reader

  const saveSenseNote = useCallback(async (atom: SenseAtom) => {
    const path = senseNotePath(atom)
    await writeNote(path, senseNoteMarkdown(atom))
    return path
  }, [writeNote])

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

  const saveChatAnswer = useCallback(async (thread: ChatThread, question: string, answer: string, sources: string[]) => {
    const date = localDateKey()
    let target = chatAnswerMarkdown({
      threadTitle: thread.title,
      question,
      answer,
      sources,
      model: modelRef.current,
      date,
    })
    if (takenPaths.has(target.path)) {
      target = { path: uniquePath(target.path, takenPaths), content: target.content }
    }
    await writeNote(target.path, target.content)
    return target.path
  }, [takenPaths, writeNote])

  const groundingContext = useCallback(async (paths: string[]) => buildGroundingContext(paths, readNote), [readNote])

  // ------------------------------------------------------- day + report

  const readDayState = useCallback(async (date: string, listing: VaultEntry[]): Promise<{
    entries: DailyEntry[]
    hash: string
    files: VaultEntry[]
  }> => {
    const entriesForDay = dailyEntriesFromNotebook(atomsRef.current, notesRef.current, date, {
      files: listing,
      selfPath: dailyNotePath(date),
    })
    const findings = findingEntries(listing, date)
    return { entries: entriesForDay, hash: dailySourceHash(entriesForDay, findings.map((entry) => entry.path)), files: findings }
  }, [])

  const refreshDaily = useCallback(async (date = localDateKey(), runOptions: { force?: boolean; silent?: boolean } = {}) => {
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
      const reportPath = dailyReportPath(date)
      const reportKnown = listing.some((entry) => entry.path === reportPath)

      let existing = ''
      if (listing.some((entry) => entry.path === path)) {
        try {
          existing = await readNote(path)
        } catch {
          existing = ''
        }
      }
      const parsed = existing ? parseNote(existing) : null
      const settled = Boolean(parsed)
        && parsed?.data.hash === hash
        && (parsed?.data.report === (reportKnown ? reportPath : undefined)
          || (!reportKnown && !parsed?.data.report))

      let userNotes = parsed ? dailyUserNotes(parsed.body) : ''
      if (!parsed && existing) {
        // An older note without our headings: keep whatever the user wrote.
        userNotes = markdownSection(existing, DAILY_NOTES_HEADING) || existing.trim()
      }

      if (!runOptions.force && settled) {
        const info: DailyInfo = {
          date,
          path,
          updatedAt: String(parsed?.data.updated || ''),
          entryCount: list.length,
          hash,
        }
        setDaily(info)
        await loadReportInfo(date, reportPath, list, hash, listing)
        return info
      }

      await writeNote(path, dailyNoteMarkdown({
        date,
        entries: list,
        reportPath: reportKnown ? reportPath : null,
        reportTime: reportTimeRef.current,
        userNotes,
        hash,
      }))
      const info: DailyInfo = { date, path, updatedAt: new Date().toISOString(), entryCount: list.length, hash }
      setDaily(info)
      await loadReportInfo(date, reportPath, list, hash, listing)
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
    reportPath: string,
    list: DailyEntry[],
    hash: string,
    listing: VaultEntry[],
  ) => {
    if (!listing.some((entry) => entry.path === reportPath)) {
      setReport(null)
      return null
    }
    try {
      const parsed = parseNote(await readNote(reportPath))
      const info: ReportInfo = {
        date,
        path: reportPath,
        source: parsed.data.source === 'ai' ? 'ai' : 'local',
        generatedAt: String(parsed.data.generated || ''),
        records: list.length,
        stale: String(parsed.data.hash || '') !== hash,
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
    if (!current) return null
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
      const { entries: list, hash, files: findingFiles } = await readDayState(date, listing)

      // The user's own findings are read in full: the report must reflect them.
      const findings: Array<{ path: string; content: string }> = []
      for (const file of findingFiles.slice(0, FINDING_FILE_LIMIT)) {
        try {
          findings.push({ path: file.path, content: excerptForGrounding(await readNote(file.path), FINDING_CHARS_PER_FILE) })
        } catch { /* an unreadable finding is simply skipped */ }
      }

      if (list.length === 0 && findings.length === 0) {
        setReport(null)
        if (!runOptions.silent) flashNotice(`${date} 还没有可汇总的记录。`)
        return null
      }

      let summary = localDailySummary(date, list)
      let source: 'local' | 'ai' = 'local'
      if (apiConfiguredRef.current) {
        try {
          const generated = await generateVaultReport({
            date,
            records: list.map((entry) => ({ kind: entry.kind, label: entry.label, body: entry.body, path: entry.path })),
            findings,
            model: modelRef.current,
          })
          if (generated) {
            summary = generated
            source = 'ai'
          }
        } catch (caught) {
          flashNotice(`AI 日报生成失败，已改用本地整理：${vaultErrorText(caught, '未知错误')}`)
        }
      } else {
        flashNotice('还没有配置 API：日报先按本地规则整理。')
      }

      const path = dailyReportPath(date)
      await writeNote(path, dailyReportMarkdown({
        date,
        summary,
        source,
        entries: list,
        hash,
        reportTime: reportTimeRef.current,
      }))
      const info: ReportInfo = {
        date,
        path,
        source,
        generatedAt: new Date().toISOString(),
        records: list.length,
        stale: false,
      }
      setReport(info)
      // The day's note links the report, so refresh its header line.
      await refreshDailyRef.current?.(date, { silent: true })
      if (!runOptions.silent) flashNotice(`${date} 的日报已${source === 'ai' ? '由 AI 整理' : '按本地规则整理'}并写入 ${path}。`)
      return info
    } catch (caught) {
      setError(vaultErrorText(caught, '无法生成日报。'))
      return null
    } finally {
      setGeneratingReport(false)
      if (!runOptions.silent) setBusy(false)
    }
  }, [flashNotice, port, readDayState, readNote, writeNote])

  /** One attempt per day slot: a failure must not retry on every tick. */
  const maybeGenerateReport = useCallback(async () => {
    if (!reportAutoRef.current || !rootRef.current) return
    const now = new Date()
    const slot = reportSlotDate(now, reportTimeRef.current)
    if (scheduledAttempts.current.has(slot)) return
    const reportPath = dailyReportPath(slot)
    if (entriesRef.current.some((entry) => entry.path === reportPath)) return
    const { entries: list, files } = await readDayState(slot, entriesRef.current)
    if (list.length === 0 && files.length === 0) return
    scheduledAttempts.current.add(slot)
    const info = await generateReport(slot, { silent: true })
    if (info) flashNotice(`${slot} 的日报已自动生成。`)
  }, [flashNotice, generateReport, readDayState])

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
      let moved = 0
      for (const file of legacy) {
        const date = /(\d{4}-\d{2}-\d{2})\.md$/i.exec(file.path)?.[1]
        if (!date) continue
        const target = dailyNotePath(date)
        if (entries.some((entry) => entry.path === target)) continue
        try {
          const parsed = parseNote(await readNote(file.path))
          // Keep every sub-section of the old summary: it becomes the report.
          const summary = markdownSectionAtLevel(parsed.body, '## 当日汇总')
            || markdownSection(parsed.body, '## 当日汇总')
          const userNotes = dailyUserNotes(parsed.body)
          const { entries: list, hash } = await readDayState(date, entries)
          await writeNote(target, dailyNoteMarkdown({
            date, entries: list, reportTime: reportTimeRef.current, userNotes, hash,
            reportPath: summary ? dailyReportPath(date) : null,
          }))
          if (summary) {
            await writeNote(dailyReportPath(date), dailyReportMarkdown({
              date,
              summary,
              source: parsed.data.summary === 'ai' ? 'ai' : 'local',
              entries: list,
              hash,
              generated: String(parsed.data.updated || '') || undefined,
              reportTime: reportTimeRef.current,
            }))
          }
          await removeEntry(file.path)
          moved += 1
        } catch {
          // Leave a legacy file alone when it cannot be migrated cleanly.
        }
      }
      if (moved > 0) {
        flashNotice(`已把 ${moved} 份旧的 Paperlight/Daily 笔记迁移到 Daily/（汇总整理成独立的日报文件）。`)
        await refresh()
      }
    })()
  }, [entries, flashNotice, loading, readDayState, readNote, refresh, removeEntry, root, writeNote])

  // ------------------------------------------------------------- derived

  const keepDirs = useMemo(
    () => [...MANAGED_DIRS, ...materialMirrorFolders(entries).map((folder) => vaultJoin(NOTES_DIR, folder))],
    [entries],
  )
  const tree = useMemo(() => buildVaultTree(entries, { keepDirs }), [entries, keepDirs])
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
    renameNote,
    removeEntry,
    revealEntry,
    saveSenseNote,
    saveNotebookNote,
    generateSenseNote,
    generateTopicNote,
    saveChatAnswer,
    groundingContext,
    refreshDaily,
    generateReport,
    maybeGenerateReport,
  }
}
