// The vault: an Obsidian-style folder of Markdown notes plus the material the
// notes are about.
//
// Layout Paperlight manages (everything else in the vault is the user's):
//
//   materials/…            original reading material, freely organised by the user
//     books/book1.pdf      a single material file
//     books/book1/…        or a folder holding one material
//   notes/<mirror>/…       senses and notes for that material (mirror of materials/)
//   notes/_inbox/…         notes with no material context (chat answers, quick notes)
//   enlightenment/…        the user's own "专项发现"
//   Daily/<date>.md        the day's record list
//   Daily/<date>-report.md the day's report (generated at a fixed time, overwritten)
//
// Everything in this module is a pure function over strings and plain objects.
// The app writes the results through the vault file port (see lib/vaultfs.ts),
// and `node --test` covers path rules, the frontmatter subset, material→notes
// mirroring, note templates, daily aggregation and tree building.

import type {
  ChatMessage, DailyEntry, ExpressionRecord, NoteFrontmatter, NotebookNote, ParsedNote, ReadingActivityDay, SenseAtom,
  VaultEntry, VaultNoteKind, VaultTreeNode,
} from '../types'
import { readingDurationLabel } from './readingActivity.ts'

export const MATERIALS_DIR = 'materials'
export const NOTES_DIR = 'notes'
export const ENLIGHTENMENT_DIR = 'enlightenment'
export const DAILY_DIR = 'Daily'
export const EXPRESSIONS_DIR = 'expressions'
/** Notes folder used when nothing tells us which material is being read. */
export const INBOX_FOLDER = '_inbox'
/** Directory names the notes tree keeps visible even while they are empty. */
export const MANAGED_DIRS = [MATERIALS_DIR, NOTES_DIR, ENLIGHTENMENT_DIR, DAILY_DIR, EXPRESSIONS_DIR]

// Legacy locations from the first vault implementation. Paperlight no longer
// writes there, but it still recognises (and can migrate) those files.
export const PAPERLIGHT_DIR = 'Paperlight'
export const LEGACY_DAILY_DIR = `${PAPERLIGHT_DIR}/Daily`
export const LEGACY_SENSE_DIR = `${PAPERLIGHT_DIR}/Senses`
export const LEGACY_NOTE_DIR = `${PAPERLIGHT_DIR}/Notes`
export const LEGACY_INBOX_DIR = `${PAPERLIGHT_DIR}/Inbox`

export const REPORT_SUFFIX = '-report'
export const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i
export const SOURCE_EXTENSION = /\.(?:pdf|epub|txt|text)$/i

/** Bumping this makes every existing daily note regenerate once (format change). */
export const DAILY_FORMAT_VERSION = 4

/** Budgets for strictly grounded vault chat (mirrored by server/api.mjs). */
export const GROUNDING_FILE_LIMIT = 8
export const GROUNDING_CHARS_PER_FILE = 6_000
export const GROUNDING_TOTAL_CHARS = 24_000
/** Findings folded into a daily report. */
export const FINDING_FILE_LIMIT = 6
export const FINDING_CHARS_PER_FILE = 2_500

const FRONTMATTER_FENCE = '---'
const MAX_VAULT_DEPTH = 12
const DEFAULT_REPORT_TIME = '20:00'

const NOTE_KINDS: VaultNoteKind[] = ['daily', 'report', 'sense', 'semantic', 'expression', 'note', 'chat', 'inbox', 'finding']

export function isVaultNoteKind(value: string): value is VaultNoteKind {
  return (NOTE_KINDS as string[]).includes(value)
}

// ------------------------------------------------------------------- paths

/** POSIX-style, no leading slash, no empty or `.` segments. */
export function normalizeVaultPath(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/')
}

/**
 * True when the path can only ever point inside the vault. Mirrors the check
 * the Electron main process performs before touching the disk.
 */
export function isSafeVaultPath(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  if (/^([A-Za-z]:|[\\/])/.test(value)) return false
  return !value.replace(/\\/g, '/').split('/').some((part) => part === '..')
}

export function vaultJoin(...parts: string[]): string {
  return normalizeVaultPath(parts.filter(Boolean).join('/'))
}

export function vaultDirname(path: string): string {
  const normalized = normalizeVaultPath(path)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

export function vaultBasename(path: string): string {
  const normalized = normalizeVaultPath(path)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION.test(vaultBasename(path))
}

export function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSION.test(vaultBasename(path))
}

export function noteTitleFromPath(path: string): string {
  const name = vaultBasename(path).replace(MARKDOWN_EXTENSION, '').trim()
  return name || '未命名笔记'
}

/** A file name that is safe on every platform and keeps CJK readable. */
export function slugify(value: string, fallback = 'note'): string {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return cleaned || fallback
}

/**
 * A folder name derived from user input or an existing folder name. Unlike
 * `slugify` it keeps the original spelling (and CJK), because the notes mirror
 * must read exactly like the `materials/` folder the user created.
 */
export function safeFolderName(value: string, fallback = INBOX_FOLDER): string {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return cleaned
}

/** `2026-02-14` in local time (the app never stores UTC dates for notes). */
export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Appends `-2`, `-3`… until the path is free; keeps a folder's notes unique. */
export function uniquePath(path: string, taken: ReadonlySet<string>): string {
  const normalized = normalizeVaultPath(path)
  if (!taken.has(normalized)) return normalized
  const directory = vaultDirname(normalized)
  const name = vaultBasename(normalized).replace(MARKDOWN_EXTENSION, '')
  for (let index = 2; index < 500; index += 1) {
    const candidate = vaultJoin(directory, `${name}-${index}.md`)
    if (!taken.has(candidate)) return candidate
  }
  return vaultJoin(directory, `${name}-${Date.now()}.md`)
}

export function depthOf(path: string): number {
  const normalized = normalizeVaultPath(path)
  return normalized ? normalized.split('/').length : 0
}

export function tooDeep(path: string): boolean {
  return depthOf(path) > MAX_VAULT_DEPTH
}

/** Joins the absolute vault root with a vault-relative path, platform-aware. */
export function absoluteVaultPath(root: string, relative: string): string {
  const useBackslash = root.includes('\\') && !root.includes('/')
  const separator = useBackslash ? '\\' : '/'
  const cleanRoot = String(root ?? '').replace(/[\\/]+$/, '')
  const clean = normalizeVaultPath(relative)
  if (!clean) return cleanRoot
  return `${cleanRoot}${separator}${clean.split('/').join(separator)}`
}

/** The vault root of an absolute document path, or null when it is outside. */
function relativeToVault(documentPath: string, vaultRoot: string | null): string | null {
  const doc = String(documentPath ?? '').replace(/\\/g, '/')
  if (!doc || !vaultRoot) return null
  const root = String(vaultRoot).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root || doc === root || !doc.startsWith(`${root}/`)) return null
  return doc.slice(root.length + 1).replace(/^\/+/, '')
}

// ------------------------------------------------- materials → notes mirror

/**
 * The folder (relative to `materials/`) a material belongs to.
 *
 *   materials/book1.pdf            → book1
 *   materials/books/book1.pdf      → books/book1
 *   materials/books/book1/ch1.pdf  → books/book1
 *   materials/books/book1/a/b.pdf  → books/book1/a
 */
export function mirrorFolderForMaterial(documentPath: string, vaultRoot: string | null): string | null {
  const relative = relativeToVault(documentPath, vaultRoot)
  if (!relative) return null
  const parts = normalizeVaultPath(relative).split('/')
  if (parts[0] !== MATERIALS_DIR || parts.length < 2) return null
  const inside = parts.slice(1)
  const folderName = (parts[parts.length - 1] || '').replace(MARKDOWN_EXTENSION, '').replace(SOURCE_EXTENSION, '')
  if (inside.length === 1) return safeFolderName(folderName)
  if (inside.length === 2) return vaultJoin(safeFolderName(inside[0]), safeFolderName(folderName))
  return vaultJoin(...inside.slice(0, -1).map((part) => safeFolderName(part)))
}

/** `notes/<mirror>` (or `notes/_inbox` when there is no material context). */
export function noteFolderPath(notesFolder: string | null | undefined): string {
  const folder = String(notesFolder ?? '').trim()
  if (!folder) return vaultJoin(NOTES_DIR, INBOX_FOLDER)
  const normalized = normalizeVaultPath(folder)
  if (!normalized || normalized === INBOX_FOLDER) return vaultJoin(NOTES_DIR, INBOX_FOLDER)
  return vaultJoin(NOTES_DIR, normalized)
}

/** Where the notes taken while reading this document belong. */
export function noteFolderForDocument(documentPath: string, vaultRoot: string | null): string {
  const mirror = mirrorFolderForMaterial(documentPath, vaultRoot)
  return noteFolderPath(mirror)
}

/** Stored on atoms/notes: the vault-relative folder inside `notes/`. */
export function notesFolderFromPath(path: string): string {
  const normalized = normalizeVaultPath(path)
  if (!normalized.startsWith(`${NOTES_DIR}/`)) return ''
  return normalized.slice(NOTES_DIR.length + 1)
}

/** Every folder under `materials/` (depth ≤ 3) that should exist under `notes/`. */
export function materialMirrorFolders(entries: VaultEntry[]): string[] {
  const folders: string[] = []
  for (const entry of entries) {
    if (!entry.directory) continue
    const path = normalizeVaultPath(entry.path)
    if (!path.startsWith(`${MATERIALS_DIR}/`)) continue
    const inside = path.slice(MATERIALS_DIR.length + 1)
    if (!inside || inside.split('/').length > 3) continue
    folders.push(inside)
  }
  return folders.sort((a, b) => a.localeCompare(b))
}

// ------------------------------------------------------------- frontmatter

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseFrontmatter(raw: string): NoteFrontmatter {
  const data: NoteFrontmatter = {}
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    const value = match[2].trim()
    if (!value) continue
    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value.slice(1, -1).split(',').map(unquote).filter(Boolean)
      if (items.length) data[key] = items
      continue
    }
    data[key] = unquote(value)
  }
  return data
}

/** Splits an optional leading `---` block from the Markdown body. */
export function parseNote(source: string): ParsedNote {
  const text = String(source ?? '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n')
  if (text !== FRONTMATTER_FENCE && !text.startsWith(`${FRONTMATTER_FENCE}\n`)) return { data: {}, body: text }
  const end = text.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length)
  if (end < 0) return { data: {}, body: text }
  const raw = text.slice(FRONTMATTER_FENCE.length + 1, end)
  const after = text.slice(end + 1 + FRONTMATTER_FENCE.length)
  return { data: parseFrontmatter(raw), body: after.replace(/^\n+/, '') }
}

function scalarLine(value: string): string {
  const flat = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (!flat) return ''
  return /[:#[\]"'{}]/.test(flat) ? `"${flat.replace(/"/g, "'")}"` : flat
}

/** Serializes the safe subset; empty values are dropped instead of guessed. */
export function stringifyNote(data: NoteFrontmatter, body: string): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      const items = value.filter((item) => item && item.trim())
      if (items.length) lines.push(`${key}: [${items.map((item) => item.replace(/[\[\],]/g, ' ').trim()).join(', ')}]`)
      continue
    }
    const line = scalarLine(value)
    if (line) lines.push(`${key}: ${line}`)
  }
  const head = lines.length ? `${FRONTMATTER_FENCE}\n${lines.join('\n')}\n${FRONTMATTER_FENCE}\n` : ''
  const cleaned = String(body ?? '').replace(/^\n+/, '').replace(/\s+$/, '')
  return `${head}${cleaned}\n`
}

export function frontmatterString(data: NoteFrontmatter, key: string): string {
  const value = data[key]
  if (Array.isArray(value)) return value[0] ?? ''
  return typeof value === 'string' ? value : ''
}

export function frontmatterList(data: NoteFrontmatter, key: string): string[] {
  const value = data[key]
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}

export function noteKindFor(path: string, data: NoteFrontmatter = {}): VaultNoteKind {
  const declared = frontmatterString(data, 'kind')
  if (isVaultNoteKind(declared)) return declared
  const normalized = normalizeVaultPath(path)
  if (normalized.startsWith(`${DAILY_DIR}/`)) {
    return noteTitleFromPath(normalized).endsWith(REPORT_SUFFIX) ? 'report' : 'daily'
  }
  if (normalized.startsWith(`${ENLIGHTENMENT_DIR}/`)) return 'finding'
  if (normalized.startsWith(`${NOTES_DIR}/`)) return 'note'
  if (normalized.startsWith(`${LEGACY_INBOX_DIR}/`)) return 'inbox'
  if (normalized.startsWith(`${LEGACY_DAILY_DIR}/`)) return 'daily'
  if (normalized.startsWith(`${LEGACY_SENSE_DIR}/`)) return 'sense'
  if (normalized.startsWith(`${LEGACY_NOTE_DIR}/`)) return 'note'
  return 'note'
}

// ---------------------------------------------------------------- templates

export function dailyNotePath(date: string): string {
  return vaultJoin(DAILY_DIR, `${date}.md`)
}

export function dailyReportPath(date: string): string {
  return vaultJoin(DAILY_DIR, `${date}${REPORT_SUFFIX}.md`)
}

export function legacyDailyPath(date: string): string {
  return vaultJoin(LEGACY_DAILY_DIR, `${date}.md`)
}

/** Rewrites a pre-restructure path to its vault-root location. */
export function remapLegacyNotePath(path: string): string {
  const normalized = normalizeVaultPath(path)
  const match = /^Paperlight\/Daily\/(\d{4}-\d{2}-\d{2})(-report)?\.md$/i.exec(normalized)
  if (match) return match[2] ? dailyReportPath(match[1]) : dailyNotePath(match[1])
  return normalized
}

/**
 * Where a sense's note lives. The recorded path wins over the derived one: a
 * sense collected before any material context existed must still link to the
 * file it was actually written to.
 */
export function senseNotePath(atom: Pick<SenseAtom, 'lemma' | 'term' | 'senseId'> & { notesFolder?: string; notePath?: string }): string {
  const recorded = recordedNotePath(atom.notePath)
  if (recorded) return recorded
  const term = slugify(atom.lemma || atom.term, 'term')
  const sense = slugify(atom.senseId, 'sense')
  return vaultJoin(noteFolderPath(atom.notesFolder), `${term}--${sense}.md`)
}

export function notebookNotePath(note: Pick<NotebookNote, 'date' | 'dailyOrdinal'> & { notesFolder?: string; notePath?: string }): string {
  const recorded = recordedNotePath(note.notePath)
  if (recorded) return recorded
  return vaultJoin(noteFolderPath(note.notesFolder), `${note.date}-note-${note.dailyOrdinal}.md`)
}

function recordedNotePath(value: string | undefined): string {
  if (!value || !isSafeVaultPath(value) || !isMarkdownPath(value)) return ''
  return normalizeVaultPath(value)
}

export function aiNotePath(notesFolder: string | null | undefined, date: string, title: string): string {
  return vaultJoin(noteFolderPath(notesFolder), `${date}-${slugify(title, 'note')}.md`)
}

export function findingNotePath(date: string, title: string): string {
  return vaultJoin(ENLIGHTENMENT_DIR, `${date}-${slugify(title, 'finding')}.md`)
}

export function chatNotePath(date: string, title: string): string {
  return vaultJoin(noteFolderPath(null), `${date}-${slugify(title, 'note')}.md`)
}

function oneLine(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** A collected semantic record becomes one Markdown note at its stable V1 path. */
export function senseNoteMarkdown(atom: SenseAtom): string {
  const body: string[] = [
    `# ${atom.term}（${atom.partOfSpeech || 'unknown'} · ${atom.senseId}）`,
    '',
    `**语境含义**：${oneLine(atom.contextualMeaning) || '（未提供）'}`,
  ]
  if (atom.definition) body.push('', `**英文释义**：${oneLine(atom.definition)}`)
  if (atom.contextSentence) body.push('', `> ${oneLine(atom.contextSentence)}`)
  if (atom.examples.length) {
    body.push('', '## 例句', '')
    for (const example of atom.examples) {
      body.push(`- ${oneLine(example.text)}`)
      if (example.translation) body.push(`  - ${oneLine(example.translation)}`)
      body.push(`  - ${example.sourceType === 'verified' && example.citation ? `出处：${oneLine(example.citation)}` : 'AI 生成例句'}`)
    }
  }
  const guidance = atom.guidance || {}
  if (guidance.scenarios?.length) body.push('', '## 使用场景', '', ...guidance.scenarios.map((item) => `- ${oneLine(item)}`))
  if (guidance.advice?.length) body.push('', '## 使用建议', '', ...guidance.advice.map((item) => `- ${oneLine(item)}`))
  if (guidance.frequency) body.push('', `**使用频率**：${oneLine(guidance.frequency)}`)
  if (guidance.synonyms?.length) {
    body.push('', '## 近义词对比', '', ...guidance.synonyms.map((item) => `- **${oneLine(item.term)}** ${oneLine(item.contrast)}`))
  }
  if (guidance.alternatives?.length) {
    body.push('', '## 替代表达', '', ...guidance.alternatives.map((item) => `- **${oneLine(item.term)}** ${oneLine(item.note)}`))
  }
  if (guidance.antonyms?.length) {
    body.push('', '## 反义词对比', '', ...guidance.antonyms.map((item) => `- **${oneLine(item.term)}** ${oneLine(item.contrast)}`))
  }
  const morphology = guidance.morphology
  if (morphology && (morphology.root || morphology.prefix || morphology.suffix || morphology.note)) {
    body.push('', '## 词根词缀', '')
    if (morphology.prefix) body.push(`- 前缀：${oneLine(morphology.prefix)}`)
    if (morphology.root) body.push(`- 词根：${oneLine(morphology.root)}`)
    if (morphology.suffix) body.push(`- 后缀：${oneLine(morphology.suffix)}`)
    if (morphology.note) body.push('', oneLine(morphology.note))
  }
  body.push('', `<!-- paperlight:semantic-contexts:start -->`)
  body.push(...semanticContextLines(atom))
  body.push('<!-- paperlight:semantic-contexts:end -->', '', '---', `由 ${atom.model || 'AI'} 生成 · 来源：阅读助手语义记录 · ${atom.generatedAt}`, '')
  return stringifyNote({
    title: `${atom.term} · ${atom.senseId}`,
    kind: 'semantic',
    created: atom.generatedAt,
    updated: atom.generatedAt,
    tags: ['paperlight', 'semantic', atom.lemma || atom.term],
    semanticId: atom.id,
    semantics: [atom.id],
    senses: [atom.id],
    alternateSemanticIds: atom.alternateSemanticIds || [],
    source: atom.model || 'ai',
    ...(atom.notesFolder ? { folder: atom.notesFolder } : {}),
  }, body.join('\n'))
}

/** The V2 user-facing name for the V1-compatible semantic-note formatter. */
export const semanticNoteMarkdown = senseNoteMarkdown

function semanticContextLines(atom: SenseAtom): string[] {
  const contexts = atom.contexts || []
  if (contexts.length === 0) return []
  const lines = ['', '## 语境实例', '']
  for (const context of contexts) {
    const where = [context.sourceName, context.locationLabel || (context.pageNumber ? `第 ${context.pageNumber} 页` : '')]
      .filter((value): value is string => Boolean(value)).map(oneLine)
    lines.push(`- ${where.length ? `${where.join(' · ')}：` : ''}> ${oneLine(context.quote)}`)
    if (context.sourcePath) lines.push(`  - 来源：\`${oneLine(context.sourcePath)}\``)
  }
  return lines
}

/** Updates only Paperlight's marked context block and preserves user-edited Markdown. */
export function mergeSemanticNoteMarkdown(existing: string, atom: SenseAtom): string {
  const parsed = parseNote(existing)
  const start = '<!-- paperlight:semantic-contexts:start -->'
  const end = '<!-- paperlight:semantic-contexts:end -->'
  const block = [start, ...semanticContextLines(atom), end].join('\n')
  const startIndex = parsed.body.indexOf(start)
  const endIndex = startIndex >= 0 ? parsed.body.indexOf(end, startIndex + start.length) : -1
  const body = startIndex >= 0 && endIndex >= startIndex
    ? `${parsed.body.slice(0, startIndex)}${block}${parsed.body.slice(endIndex + end.length)}`
    : `${parsed.body.trimEnd()}\n\n${block}\n`
  const senses = frontmatterList(parsed.data, 'senses')
  const semantics = frontmatterList(parsed.data, 'semantics')
  const alternateSemanticIds = Array.from(new Set([
    ...frontmatterList(parsed.data, 'alternateSemanticIds'),
    ...(atom.alternateSemanticIds || []),
  ])).filter((id) => id && id !== atom.id)
  return stringifyNote({
    ...parsed.data,
    kind: 'semantic',
    semanticId: atom.id,
    semantics: semantics.includes(atom.id) ? semantics : [...semantics, atom.id],
    senses: senses.includes(atom.id) ? senses : [...senses, atom.id],
    alternateSemanticIds,
    updated: new Date().toISOString(),
  }, body)
}

/** Wraps a model-written Markdown note with Paperlight frontmatter. */
export function aiNoteMarkdown(options: {
  title: string
  markdown: string
  date: string
  tags?: string[]
  senses?: string[]
  source?: string
  notesFolder?: string
}): string {
  const { title, markdown, date, tags = [], senses = [], source = 'ai', notesFolder } = options
  const body = markdown.trim().startsWith('#') ? markdown.trim() : `# ${title}\n\n${markdown.trim()}`
  return stringifyNote({
    title,
    kind: 'note',
    created: new Date().toISOString(),
    date,
    tags: ['paperlight', 'ai-note', ...tags],
    senses,
    source,
    ...(notesFolder ? { folder: notesFolder } : {}),
  }, `${body}\n`)
}

/** One notebook entry (记录本笔记) written into the vault. */
export function notebookNoteMarkdown(note: NotebookNote, atoms: SenseAtom[]): string {
  const linked = note.senseIds
    .map((id) => atoms.find((atom) => atom.id === id))
    .filter((atom): atom is SenseAtom => Boolean(atom))
  const body: string[] = [`# ${note.date} 第 ${note.dailyOrdinal} 份笔记`, '', note.body.trim()]
  if (linked.length) {
    body.push('', '## 关联语义', '')
    for (const atom of linked) {
      body.push(`- [[${senseNotePath(atom)}]] ${atom.term} · ${oneLine(atom.contextualMeaning)}`)
    }
  }
  body.push('')
  return stringifyNote({
    title: `${note.date} 第 ${note.dailyOrdinal} 份笔记`,
    kind: 'inbox',
    date: note.date,
    created: note.createdAt,
    updated: note.createdAt,
    tags: ['paperlight', 'note'],
    senses: note.senseIds,
    source: 'notebook',
    ...(note.notesFolder ? { folder: note.notesFolder } : {}),
  }, body.join('\n'))
}

/** A quick note the user writes in the `enlightenment/` folder. */
export function findingNoteMarkdown(options: { title: string; body: string; date: string }): string {
  const { title, body, date } = options
  // Only a real top-level heading counts as "the note already has a title";
  // a body that starts with `##` still gets the titled heading prepended.
  const text = /^#\s/m.test(body) ? body.trim() : `# ${title}\n\n${body.trim()}`
  return stringifyNote({
    title,
    kind: 'finding',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    date,
    tags: ['paperlight', 'finding'],
    source: 'user',
  }, `${text}\n`)
}

/** The assistant's grounded answer, saved as a vault note. */
export function chatAnswerMarkdown(options: {
  threadTitle: string
  question: string
  answer: string
  sources: string[]
  model: string
  date: string
}): { path: string; content: string } {
  const { threadTitle, question, answer, sources, model, date } = options
  const title = threadTitle || `vault 对话 · ${date}`
  const body: string[] = [
    `# ${oneLine(title)}`,
    '',
    `> ${oneLine(question)}`,
    '',
    answer.trim(),
  ]
  if (sources.length) {
    body.push('', '## 依据的 vault 内容', '', ...sources.map((path) => `- [[${path}]]`))
  }
  body.push('', '---', `由 ${model} 生成 · 来源：对话空间（vault grounded） · ${date}`, '')
  const path = chatNotePath(date, title)
  return {
    path,
    content: stringifyNote({
      title,
      kind: 'chat',
      date,
      created: new Date().toISOString(),
      tags: ['paperlight', 'chat'],
      senses: [],
      source: model || 'ai',
      folder: INBOX_FOLDER,
    }, body.join('\n')),
  }
}

// ------------------------------------------------------------ daily records

/** Everything that belongs to one local day: senses, notebook notes, vault files. */
export function dailyEntriesFromNotebook(
  atoms: SenseAtom[],
  notes: NotebookNote[],
  date: string,
  options: { files?: VaultEntry[]; selfPath?: string; expressions?: ExpressionRecord[] } = {},
): DailyEntry[] {
  const entries: DailyEntry[] = []
  const claimed = new Set<string>()

  for (const atom of atoms) {
    const dayContexts = (atom.contexts || []).filter((context) => {
      const createdAt = new Date(context.createdAt)
      return !Number.isNaN(createdAt.getTime()) && localDateKey(createdAt) === date
    })
    const generatedAt = atom.generatedAt ? new Date(atom.generatedAt) : null
    if (dayContexts.length === 0 && (!generatedAt || Number.isNaN(generatedAt.getTime()) || localDateKey(generatedAt) !== date)) continue
    const path = senseNotePath(atom)
    claimed.add(path)
    entries.push({
      id: atom.id,
      kind: 'sense',
      label: `${atom.term}（${atom.partOfSpeech || 'unknown'} · ${atom.senseId}）`,
      body: [atom.contextualMeaning, atom.definition, ...dayContexts.map((context) => context.quote)].filter(Boolean).join(' · '),
      path,
    })
  }

  for (const record of options.expressions || []) {
    const dayContexts = record.contexts.filter((context) => {
      const createdAt = new Date(context.createdAt)
      return !Number.isNaN(createdAt.getTime()) && localDateKey(createdAt) === date
    })
    const createdAt = new Date(record.createdAt)
    if (dayContexts.length === 0 && (Number.isNaN(createdAt.getTime()) || localDateKey(createdAt) !== date)) continue
    if (!/^[a-z0-9-]{1,96}$/i.test(record.id)) continue
    const path = `expressions/${record.id}.md`
    claimed.add(path)
    entries.push({
      id: record.id,
      kind: 'expression',
      label: record.expression,
      body: [...dayContexts.map((context) => context.quote).filter(Boolean), record.meaning].filter(Boolean).join(' · '),
      path,
    })
  }

  for (const note of notes) {
    if (note.date !== date) continue
    const path = notebookNotePath(note)
    claimed.add(path)
    entries.push({
      id: note.id,
      kind: 'note',
      label: `${note.date} 第 ${note.dailyOrdinal} 份笔记`,
      body: note.body,
      path,
    })
  }

  const self = normalizeVaultPath(options.selfPath || '')
  for (const file of options.files || []) {
    if (file.directory || !isMarkdownPath(file.path)) continue
    const path = normalizeVaultPath(file.path)
    if (!path || path === self) continue
    // The daily notes of the day are the aggregation itself, not an input, and
    // the notes listed above are already represented by their own record.
    if (path.startsWith(`${DAILY_DIR}/`) || path.startsWith(`${LEGACY_DAILY_DIR}/`)) continue
    if (claimed.has(path)) continue
    if (localDateKey(new Date(file.mtimeMs || Date.now())) !== date) continue
    entries.push({ id: path, kind: 'file', label: path, body: '', path })
  }
  return entries
}

/** Markdown files the user wrote in `enlightenment/`, for a given day. */
export function findingEntries(entries: VaultEntry[], date: string): VaultEntry[] {
  return entries.filter((entry) => {
    if (entry.directory || !isMarkdownPath(entry.path)) return false
    const path = normalizeVaultPath(entry.path)
    if (!path.startsWith(`${ENLIGHTENMENT_DIR}/`)) return false
    return localDateKey(new Date(entry.mtimeMs || Date.now())) === date
  })
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Changes whenever the day's records change, so a report can note staleness. */
export function dailySourceHash(entries: DailyEntry[], extra: string[] = []): string {
  const material = [
    `v${DAILY_FORMAT_VERSION}`,
    // The path belongs in the hash: a note that moves (e.g. into the material
    // mirror it belongs to) must change the list, even when its text does not.
    ...entries.map((entry) => `${entry.kind}|${entry.id}|${entry.path || ''}|${entry.label}|${oneLine(entry.body)}`),
    ...extra.map((item) => oneLine(item)),
  ]
  return hashString(material.join('\n'))
}

/** Always-available aggregation, used as the report body until (or without) AI. */
export function localDailySummary(date: string, entries: DailyEntry[], activity?: ReadingActivityDay): string {
  const senses = entries.filter((entry) => entry.kind === 'sense' || entry.kind === 'semantic')
  const expressions = entries.filter((entry) => entry.kind === 'expression')
  const notes = entries.filter((entry) => entry.kind === 'note')
  const files = entries.filter((entry) => entry.kind === 'file')
  const sources = [...(activity?.sources || [])].sort((a, b) => b.seconds - a.seconds)
  const timeText = readingDurationLabel(activity?.seconds || 0)
  const section = (heading: string, lines: string[]) => `## ${heading}\n\n${lines.length ? lines.join('\n') : '- 今天暂无记录。'}`
  const readWhat = sources.map((source) => `- ${oneLine(source.sourceName)}（约 ${Math.max(1, Math.round(source.seconds / 60))} 分钟）`)
  const expressionLines = expressions.map(entryLine)
  const semanticLines = senses.map(entryLine)
  const review = entries.length || (activity?.seconds || 0) > 0
    ? `今天${timeText}，阅读记录涉及 ${sources.length} 份材料，收录 ${expressions.length} 条表达和 ${senses.length} 条语义。下次阅读时，可以回看这些积累，并观察它们在新语境中的用法。`
    : `${date} 还没有记录到阅读活动或新的积累。下次开始阅读后，可以留意一个具体表达或语义，把新观察接到已有积累上。`
  const additional = [...notes.map(entryLine), ...files.map(entryLine)]
  return [
    section('读了多久', [`- ${timeText}`]),
    section('读了什么', readWhat),
    section('表达', expressionLines),
    section('语义', semanticLines),
    section('总结与勉励（继往开来）', [review, ...(additional.length ? ['', '### 笔记与其他记录', ...additional] : [])]),
  ].join('\n\n')
}

export const DAILY_NOTES_HEADING = '### 我的补充'

/** User-written additions to a daily note survive Paperlight's rewrites. */
export function dailyUserNotes(body: string): string {
  const text = String(body ?? '')
  const index = text.indexOf(DAILY_NOTES_HEADING)
  const heading = index >= 0 ? DAILY_NOTES_HEADING : '## 我的补充'
  const actualIndex = index >= 0 ? index : text.indexOf(heading)
  if (actualIndex < 0) return ''
  return text.slice(actualIndex + heading.length).trim()
}

/** Generated Daily content ends before either version of the user's section. */
export function dailyManagedBody(body: string): string {
  const text = String(body ?? '')
  const heading = /^#{2,3}\s+我的补充\s*$/m.exec(text)
  return (heading ? text.slice(0, heading.index) : text).trim()
}

export function dailyManagedBodyHash(body: string): string {
  return hashString(dailyManagedBody(body))
}

/** Preserve edits made outside the designated user section before rebuilding. */
export function preserveDailyManagedEdits(body: string, storedHash: string, userNotes = ''): string {
  const managed = dailyManagedBody(body)
  if (!managed || (storedHash && dailyManagedBodyHash(body) === storedHash)) return userNotes
  const snapshot = [
    userNotes.trim(),
    '#### Paperlight 自动保留的旧记录清单',
    '> 检测到生成区域曾被手动修改；以下是重建前的原文副本，可在确认无用后自行删除。',
    '',
    '```markdown',
    managed,
    '```',
  ].filter(Boolean).join('\n\n')
  return snapshot
}

/**
 * Text of one `## heading` section, stopping at the next heading of the SAME or
 * a higher level. Used by the legacy daily migration: a summary may contain
 * `###` sub-sections that must survive the move into the report file.
 */
export function markdownSectionAtLevel(body: string, heading: string): string {
  const text = String(body ?? '')
  const index = text.indexOf(heading)
  if (index < 0) return ''
  const level = (heading.match(/^#+/) || ['##'])[0].length
  const rest = text.slice(index + heading.length)
  const stop = new RegExp(`\\n#{1,${level}}\\s`).exec(rest)
  return (stop ? rest.slice(0, stop.index) : rest).trim()
}

/** Text of one `## heading` section, used to read generated content back. */
export function markdownSection(body: string, heading: string): string {
  const text = String(body ?? '')
  const index = text.indexOf(heading)
  if (index < 0) return ''
  const rest = text.slice(index + heading.length)
  const next = /\n#{1,3}\s/.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

function entryLine(entry: DailyEntry): string {
  const label = entry.kind === 'file'
    ? `[[${entry.path || entry.label}]]`
    : `[[${entry.path || entry.label}|${entry.label}]]`
  return `- ${label}${entry.body && entry.kind !== 'file' ? `：${oneLine(entry.body)}` : ''}`
}

/**
 * The day's record list. The AI report lives in its own file, so this file is
 * always cheap to rebuild (no model call) and always current.
 */
export function dailyNoteMarkdown(options: {
  date: string
  entries: DailyEntry[]
  hash: string
  updated?: string
  reportPath?: string | null
  reportTime?: string
  userNotes?: string
  readingActivity?: ReadingActivityDay
}): string {
  const { date, entries, hash, updated, reportPath, reportTime = DEFAULT_REPORT_TIME, userNotes = '', readingActivity } = options
  const duration = readingActivity?.seconds || 0
  const sources = [...(readingActivity?.sources || [])].sort((a, b) => b.seconds - a.seconds)
  const expressions = entries.filter((entry) => entry.kind === 'expression')
  const semantics = entries.filter((entry) => entry.kind === 'sense' || entry.kind === 'semantic')
  const otherNotes = entries.filter((entry) => entry.kind === 'note' || entry.kind === 'file')
  const readingText = duration > 0 ? readingDurationLabel(duration) : '尚无可确认的阅读时长'
  const summary = entries.length || duration > 0
    ? `今天${readingText}，阅读记录涉及 ${sources.length} 份材料，收录 ${expressions.length} 条表达和 ${semantics.length} 条语义。下次阅读时，可以回看这些积累，并观察它们在新语境中的用法。`
    : '今天还没有记录到阅读活动或新的积累。下次开始阅读后，可以留意一个具体表达或语义，把新观察接到已有积累上。'
  const body: string[] = [
    `# ${date}`,
    '',
    reportPath
      ? `> 日报：[[${reportPath}]] · 每天 ${reportTime} 自动生成，也可以手动重新生成`
      : `> 日报：每天 ${reportTime} 自动生成（也可以在右侧手动生成）`,
    '',
    '## 读了多久',
    '',
    `- ${readingText}`,
    '',
    '## 读了什么',
    '',
  ]
  if (sources.length === 0) {
    body.push('- 今天尚无可确认的材料阅读记录。')
  } else {
    for (const source of sources) {
      body.push(`- ${oneLine(source.sourceName)}（约 ${Math.max(1, Math.round(source.seconds / 60))} 分钟）`)
    }
  }
  body.push('', '## 表达', '')
  if (expressions.length === 0) body.push('- 今天没有新增表达。')
  else for (const entry of expressions) body.push(entryLine(entry))
  body.push('', '## 语义', '')
  if (semantics.length === 0) body.push('- 今天没有新增语义。')
  else for (const entry of semantics) body.push(entryLine(entry))
  body.push('', '## 总结与勉励（继往开来）', '', summary)
  if (reportPath) body.push('', `当天的回顾与后续建议：[[${reportPath}]]`)
  if (otherNotes.length) {
    body.push('', '### 笔记与其他记录')
    for (const entry of otherNotes) body.push(entryLine(entry))
  }
  body.push('', DAILY_NOTES_HEADING, '')
  if (userNotes.trim()) body.push(userNotes.trim())
  body.push('')
  const bodyText = body.join('\n')
  return stringifyNote({
    title: date,
    kind: 'daily',
    date,
    updated: updated || new Date().toISOString(),
    hash,
    managedHash: dailyManagedBodyHash(bodyText),
    format: String(DAILY_FORMAT_VERSION),
    ...(reportPath ? { report: reportPath } : {}),
    tags: ['paperlight', 'daily'],
    // The day's senses stay linkable from the note itself, so the info panel
    // (and any backlink view) can resolve them without parsing the body.
    senses: entries.filter((entry) => entry.kind === 'sense' || entry.kind === 'semantic').map((entry) => entry.id),
    expressions: entries.filter((entry) => entry.kind === 'expression').map((entry) => entry.id),
  }, bodyText)
}

/** The report itself: one file per day, overwritten on every generation. */
export function dailyReportMarkdown(options: {
  date: string
  summary: string
  source: 'local' | 'ai'
  entries: DailyEntry[]
  hash: string
  generated?: string
  reportTime?: string
}): string {
  const { date, summary, source, entries, hash, generated, reportTime = DEFAULT_REPORT_TIME } = options
  const body: string[] = [
    `# ${date} 日报`,
    '',
    `> ${source === 'ai' ? 'AI 整理' : '本地整理'} · 收录 ${entries.length} 条记录 · 每天 ${reportTime} 生成，可手动重新生成`,
    '',
    summary.trim() || `${date} 还没有新的笔记内容。`,
    '',
    '## 来源',
    '',
  ]
  if (entries.length === 0) body.push('- 暂无记录。')
  else for (const entry of entries) body.push(entryLine(entry))
  body.push('')
  return stringifyNote({
    title: `${date} 日报`,
    kind: 'report',
    date,
    generated: generated || new Date().toISOString(),
    source,
    records: String(entries.length),
    hash,
    format: String(DAILY_FORMAT_VERSION),
    tags: ['paperlight', 'report'],
  }, body.join('\n'))
}

// ------------------------------------------------------------- report slots

export function parseTimeOfDay(value: string, fallback = { hours: 20, minutes: 0 }): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return fallback
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback
  return { hours, minutes }
}

export function isValidTimeOfDay(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value ?? '').trim())
}

/**
 * The most recent day whose report slot has passed: today once the configured
 * time is reached, otherwise yesterday. Generation is deliberately tied to a
 * fixed time instead of every keystroke.
 */
export function reportSlotDate(now: Date, reportTime: string): string {
  const { hours, minutes } = parseTimeOfDay(reportTime)
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
  if (now.getTime() >= slot.getTime()) return localDateKey(slot)
  return localDateKey(new Date(slot.getFullYear(), slot.getMonth(), slot.getDate() - 1))
}

// ---------------------------------------------------------------- tree view

export function buildVaultTree(
  entries: VaultEntry[],
  options: { sources?: 'materials' | 'none'; keepDirs?: string[] } = {},
): VaultTreeNode[] {
  const includeSources = (options.sources ?? 'materials') === 'materials'
  const keepDirs = options.keepDirs ?? MANAGED_DIRS
  const root: VaultTreeNode = { name: '', path: '', type: 'dir', kind: 'note', children: [], size: 0, mtimeMs: 0 }
  const directories = new Map<string, VaultTreeNode>([['', root]])
  const ensureDir = (path: string): VaultTreeNode => {
    const existing = directories.get(path)
    if (existing) return existing
    const parent = ensureDir(vaultDirname(path))
    const node: VaultTreeNode = { name: vaultBasename(path), path, type: 'dir', kind: 'note', children: [], size: 0, mtimeMs: 0 }
    parent.children.push(node)
    directories.set(path, node)
    return node
  }

  for (const entry of entries) {
    const path = normalizeVaultPath(entry.path)
    if (!path || tooDeep(path)) continue
    if (entry.directory) {
      ensureDir(path)
      continue
    }
    const note = isMarkdownPath(path)
    const source = !note && isSourcePath(path) && includeSources
      && (path === MATERIALS_DIR || path.startsWith(`${MATERIALS_DIR}/`))
    if (!note && !source) continue
    const parent = ensureDir(vaultDirname(path))
    parent.children.push({
      name: vaultBasename(path),
      path,
      type: 'file',
      kind: note ? 'note' : 'source',
      children: [],
      size: entry.size || 0,
      mtimeMs: entry.mtimeMs || 0,
    })
  }

  // Folders with no Markdown at all are dropped — except the ones Paperlight
  // manages (and the mirrors of `materials/` folders), which stay visible so
  // the structure is discoverable from day one.
  const prune = (nodes: VaultTreeNode[]): VaultTreeNode[] => nodes
    .map((node) => (node.type === 'dir' ? { ...node, children: prune(node.children) } : node))
    .filter((node) => node.type === 'file' || node.children.length > 0 || keepDirs.includes(node.path))
  return sortVaultTree(prune(root.children))
}

export function sortVaultTree(nodes: VaultTreeNode[]): VaultTreeNode[] {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
  for (const node of nodes) if (node.children.length) sortVaultTree(node.children)
  return nodes
}

export function flattenTree(nodes: VaultTreeNode[]): VaultTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)])
}

export function findTreeNode(nodes: VaultTreeNode[], path: string): VaultTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    const found = node.children.length ? findTreeNode(node.children, path) : null
    if (found) return found
  }
  return null
}

/** Notes and original materials below a node, for the tree's count badge. */
export function countTree(node: VaultTreeNode): { notes: number; sources: number } {
  if (node.type === 'file') return { notes: node.kind === 'note' ? 1 : 0, sources: node.kind === 'source' ? 1 : 0 }
  return node.children.reduce(
    (total, child) => {
      const counts = countTree(child)
      return { notes: total.notes + counts.notes, sources: total.sources + counts.sources }
    },
    { notes: 0, sources: 0 },
  )
}

/** Every Markdown file at or below a node (used for folder rows and selection). */
export function collectFiles(node: VaultTreeNode): string[] {
  if (node.type === 'file') return node.kind === 'note' ? [node.path] : []
  return node.children.flatMap((child) => collectFiles(child))
}

/** Every Markdown file at or below `path` (used when a folder is selected). */
export function filesUnderPath(nodes: VaultTreeNode[], path: string): string[] {
  const target = normalizeVaultPath(path)
  if (!target) return flattenTree(nodes).filter((node) => node.type === 'file' && node.kind === 'note').map((node) => node.path)
  const node = findTreeNode(nodes, target)
  if (!node) return []
  return collectFiles(node)
}

/** Keeps directories that contain a match, so the tree stays navigable. */
export function filterVaultTree(nodes: VaultTreeNode[], query: string): VaultTreeNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return nodes
  const visit = (node: VaultTreeNode): VaultTreeNode | null => {
    if (node.type === 'file') return node.name.toLowerCase().includes(needle) ? node : null
    const children = node.children.map(visit).filter((child): child is VaultTreeNode => Boolean(child))
    if (children.length === 0 && !node.name.toLowerCase().includes(needle)) return null
    return { ...node, children }
  }
  return nodes.map(visit).filter((node): node is VaultTreeNode => Boolean(node))
}

// ------------------------------------------------------------------ markdown

export function titleFromMarkdown(markdown: string, fallback: string): string {
  const match = /^#{1,3}\s+(.+)$/m.exec(String(markdown ?? ''))
  const title = match ? match[1].replace(/[#*`]/g, '').trim() : ''
  return (title || fallback).slice(0, 120)
}

/** `[[note]]` / `[[note|alias]]` / `[[note#heading]]` links, alias stripped. */
export function wikiLinks(markdown: string): string[] {
  const links = new Set<string>()
  for (const match of String(markdown ?? '').matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1].trim()
    if (target) links.add(target)
  }
  return [...links]
}

/** Trims a note down to a grounding excerpt, keeping the start of the note. */
export function excerptForGrounding(source: string, limit = GROUNDING_CHARS_PER_FILE): string {
  const text = String(source ?? '').replace(/\r\n?/g, '\n').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n…（此处截断，原文共 ${text.length} 字符）`
}

export function countWords(source: string): number {
  const text = String(source ?? '')
  const latin = text.match(/[A-Za-z0-9']+/g)?.length || 0
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length || 0
  return latin + cjk
}

export function relativeTime(value: string, now = Date.now()): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const diff = Math.max(0, now - time)
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  return localDateKey(new Date(time))
}

export function chatThreadTitle(question: string, fallback = '新的对话'): string {
  const cleaned = oneLine(question).replace(/^[#>\-*\s]+/, '')
  return (cleaned || fallback).slice(0, 40)
}

export function newChatMessage(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  }
}
