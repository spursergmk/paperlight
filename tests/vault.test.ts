import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAILY_DIR, ENLIGHTENMENT_DIR, INBOX_FOLDER, LEGACY_DAILY_DIR, MATERIALS_DIR, NOTES_DIR,
  absoluteVaultPath, aiNoteMarkdown, aiNotePath, buildVaultTree, chatAnswerMarkdown, chatNotePath,
  collectFiles, countWords, dailyEntriesFromNotebook, dailyManagedBodyHash, dailyNoteMarkdown, dailyNotePath,
  dailyReportMarkdown, dailyReportPath, dailySourceHash, dailyUserNotes, excerptForGrounding, preserveDailyManagedEdits,
  filesUnderPath, filterVaultTree, findTreeNode, findingEntries, findingNoteMarkdown,
  findingNotePath, flattenTree, frontmatterList, frontmatterString, isSafeVaultPath,
  isValidTimeOfDay, localDailySummary, localDateKey, markdownSection, markdownSectionAtLevel,
  materialMirrorFolders,
  mirrorFolderForMaterial, noteFolderForDocument, noteFolderPath, noteKindFor, noteTitleFromPath,
  notebookNoteMarkdown, notebookNotePath, notesFolderFromPath, parseNote, parseTimeOfDay,
  mergeSemanticNoteMarkdown, remapLegacyNotePath, reportSlotDate, safeFolderName, senseNoteMarkdown, senseNotePath, slugify,
  stringifyNote, titleFromMarkdown, uniquePath, vaultBasename, vaultDirname, vaultJoin, wikiLinks,
} from '../src/lib/vault.ts'
import type { NotebookNote, SenseAtom, VaultEntry } from '../src/types.ts'

const ROOT = '/Users/me/econpolitics'

function makeAtom(overrides: Partial<SenseAtom> = {}): SenseAtom {
  return {
    id: 'numerous|adjective|many',
    term: 'numerous',
    lemma: 'numerous',
    partOfSpeech: 'adjective',
    senseId: 'many',
    contextualMeaning: '众多的、大量的',
    definition: 'existing in large numbers',
    contextSentence: 'his numerous readers',
    examples: [
      { text: 'his numerous readers', translation: '他众多的读者', sourceType: 'ai_generated', citation: null },
      { text: 'a numerous family', translation: '大家庭', sourceType: 'verified', citation: 'Oxford, 2020' },
    ],
    guidance: {
      scenarios: ['书面表达'],
      advice: ['接可数名词复数'],
      frequency: '常见',
      alternatives: [{ term: 'many', note: '更口语' }],
      synonyms: [{ term: 'abundant', contrast: '强调充裕' }],
      antonyms: [{ term: 'few', contrast: '数量少' }],
      morphology: { root: 'numer', prefix: '', suffix: '-ous', note: 'numer = 数' },
    },
    provider: 'ai',
    model: 'deepseek-flash',
    source: 'ai',
    schemaVersion: 1,
    generatedAt: '2026-02-14T08:30:00.000Z',
    ...overrides,
  }
}

function makeNote(overrides: Partial<NotebookNote> = {}): NotebookNote {
  return {
    id: '2026-02-14#1-abc',
    date: '2026-02-14',
    dailyOrdinal: 1,
    body: 'numerous 后面接可数名词复数。',
    senseIds: ['numerous|adjective|many'],
    createdAt: '2026-02-14T09:00:00.000Z',
    ...overrides,
  }
}

// Local-time stamps: the daily records are grouped by local date, so the test
// must not depend on the machine's time zone.
const at = (hour: number, minute = 0) => new Date(2026, 1, 14, hour, minute).getTime()

const entries: VaultEntry[] = [
  { path: MATERIALS_DIR, directory: true, size: 0, mtimeMs: 0 },
  { path: 'materials/books', directory: true, size: 0, mtimeMs: 0 },
  { path: 'materials/books/book1', directory: true, size: 0, mtimeMs: 0 },
  { path: 'materials/books/book1.pdf', directory: false, size: 100, mtimeMs: at(9) },
  { path: 'materials/books/book1/ch1.pdf', directory: false, size: 100, mtimeMs: at(9, 30) },
  { path: NOTES_DIR, directory: true, size: 0, mtimeMs: 0 },
  { path: 'notes/books', directory: true, size: 0, mtimeMs: 0 },
  { path: 'notes/books/book1', directory: true, size: 0, mtimeMs: 0 },
  { path: 'notes/books/book1/numerous--many.md', directory: false, size: 10, mtimeMs: at(8, 31) },
  { path: 'notes/_inbox/2026-02-14-note-1.md', directory: false, size: 10, mtimeMs: at(10) },
  { path: ENLIGHTENMENT_DIR, directory: true, size: 0, mtimeMs: 0 },
  { path: 'enlightenment/2026-02-14-观察.md', directory: false, size: 10, mtimeMs: at(11) },
  { path: DAILY_DIR, directory: true, size: 0, mtimeMs: 0 },
  { path: 'Daily/2026-02-14.md', directory: false, size: 10, mtimeMs: at(12) },
  { path: 'Daily/2026-02-14-report.md', directory: false, size: 10, mtimeMs: at(20) },
  { path: 'readme.txt', directory: false, size: 10, mtimeMs: 0 },
  { path: 'Empty', directory: true, size: 0, mtimeMs: 0 },
]

test('vault paths are normalized and confined', () => {
  assert.equal(vaultJoin('notes', '/books/', 'x.md'), 'notes/books/x.md')
  assert.equal(vaultDirname('a/b/c.md'), 'a/b')
  assert.equal(vaultBasename('a/b/c.md'), 'c.md')
  assert.equal(noteTitleFromPath('Daily/2026-02-14-report.md'), '2026-02-14-report')

  assert.equal(isSafeVaultPath('notes/books/x.md'), true)
  assert.equal(isSafeVaultPath('../secret.md'), false)
  assert.equal(isSafeVaultPath('/etc/passwd'), false)
  assert.equal(isSafeVaultPath('C:\\Windows\\x.md'), false)
  assert.equal(isSafeVaultPath(''), false)

  // Absolute paths are rebuilt with the separator the vault root uses.
  assert.equal(absoluteVaultPath(ROOT, 'materials/books/book1.pdf'), `${ROOT}/materials/books/book1.pdf`)
  assert.equal(absoluteVaultPath('C:\\vault', 'notes/a.md'), 'C:\\vault\\notes\\a.md')
  assert.equal(absoluteVaultPath(`${ROOT}/`, ''), ROOT)
})

test('materials folders mirror into notes', () => {
  // A single material file at the top: the file stem is the book folder.
  assert.equal(mirrorFolderForMaterial(`${ROOT}/materials/book1.pdf`, ROOT), 'book1')
  // A material file inside a category folder: category + stem.
  assert.equal(mirrorFolderForMaterial(`${ROOT}/materials/books/book1.pdf`, ROOT), 'books/book1')
  // A material folder holding chapters: the folder itself is the book.
  assert.equal(mirrorFolderForMaterial(`${ROOT}/materials/books/book1/ch1.pdf`, ROOT), 'books/book1')
  // Deeper nesting mirrors the parent chain.
  assert.equal(mirrorFolderForMaterial(`${ROOT}/materials/books/book1/part1/ch1.pdf`, ROOT), 'books/book1/part1')
  // Windows separators and a trailing slash on the root still work.
  assert.equal(mirrorFolderForMaterial('C:\\vault\\materials\\books\\book1.pdf', 'C:\\vault'), 'books/book1')
  assert.equal(mirrorFolderForMaterial(`${ROOT}/materials/books/book1.pdf`, `${ROOT}/`), 'books/book1')
  // Anything outside materials/ has no material context.
  assert.equal(mirrorFolderForMaterial(`${ROOT}/Papers/x.pdf`, ROOT), null)
  assert.equal(mirrorFolderForMaterial('/tmp/x.pdf', ROOT), null)
  assert.equal(mirrorFolderForMaterial(`${ROOT}/materials/books/book1.pdf`, null), null)

  assert.equal(noteFolderForDocument(`${ROOT}/materials/books/book1/ch1.pdf`, ROOT), 'notes/books/book1')
  assert.equal(noteFolderForDocument('/tmp/x.pdf', ROOT), `notes/${INBOX_FOLDER}`)
  assert.equal(noteFolderPath(null), `notes/${INBOX_FOLDER}`)
  assert.equal(noteFolderPath('books/book1'), 'notes/books/book1')
  assert.equal(notesFolderFromPath('notes/books/book1'), 'books/book1')
  assert.equal(notesFolderFromPath('notes/_inbox'), INBOX_FOLDER)

  assert.deepEqual(materialMirrorFolders(entries), ['books', 'books/book1'])
  assert.equal(safeFolderName('books/book 1'), 'books-book 1'.replace('/', '-'))
  assert.equal(safeFolderName('语感: 笔记'), '语感- 笔记'.replace(':', '-'))
  assert.equal(safeFolderName('...'), INBOX_FOLDER)
})

test('slugify keeps CJK readable and never returns an empty name', () => {
  assert.equal(slugify('Numerous Readers!'), 'numerous-readers')
  assert.equal(slugify('  语感 / 笔记  '), '语感-笔记')
  assert.equal(slugify('!!!'), 'note')
  assert.equal(slugify('a'.repeat(120)).length, 60)
})

test('uniquePath never overwrites an existing note', () => {
  const taken = new Set(['notes/_inbox/2026-02-14-x.md', 'notes/_inbox/2026-02-14-x-2.md'])
  assert.equal(uniquePath('notes/_inbox/2026-02-14-x.md', taken), 'notes/_inbox/2026-02-14-x-3.md')
  assert.equal(uniquePath('notes/_inbox/new.md', taken), 'notes/_inbox/new.md')
})

test('frontmatter round-trips through the safe subset', () => {
  const source = stringifyNote({
    title: 'numerous · many',
    kind: 'sense',
    tags: ['paperlight', 'sense'],
    senses: ['numerous|adjective|many'],
    note: 'a: tricky value',
  }, '# 标题\n\n正文\n')
  const parsed = parseNote(source)
  assert.equal(frontmatterString(parsed.data, 'title'), 'numerous · many')
  assert.deepEqual(frontmatterList(parsed.data, 'tags'), ['paperlight', 'sense'])
  assert.deepEqual(frontmatterList(parsed.data, 'senses'), ['numerous|adjective|many'])
  assert.equal(frontmatterString(parsed.data, 'note'), 'a: tricky value')
  assert.equal(parsed.body, '# 标题\n\n正文\n')
  assert.deepEqual(parseNote('# 随手记\n\n没有 frontmatter。\n').data, {})
})

test('noteKindFor prefers frontmatter and understands the vault layout', () => {
  assert.equal(noteKindFor(`${DAILY_DIR}/2026-02-14.md`), 'daily')
  assert.equal(noteKindFor(`${DAILY_DIR}/2026-02-14-report.md`), 'report')
  assert.equal(noteKindFor('notes/books/book1/numerous--many.md'), 'note')
  assert.equal(noteKindFor(`${ENLIGHTENMENT_DIR}/2026-02-14-x.md`), 'finding')
  assert.equal(noteKindFor('随便/哪里.md', { kind: 'chat' }), 'chat')
  assert.equal(noteKindFor(`${LEGACY_DAILY_DIR}/2026-02-14.md`), 'daily')
  assert.equal(noteKindFor('Paperlight/Senses/numerous--many.md'), 'sense')
  assert.equal(noteKindFor('随便/哪里.md'), 'note')
})

test('a collected sense becomes one Markdown note inside its material folder', () => {
  const source = senseNoteMarkdown(makeAtom({ notesFolder: 'books/book1', alternateSemanticIds: ['within|prep|limits-v2'] }))
  const { data, body } = parseNote(source)
  assert.equal(frontmatterString(data, 'kind'), 'semantic')
  assert.deepEqual(frontmatterList(data, 'senses'), ['numerous|adjective|many'])
  assert.deepEqual(frontmatterList(data, 'alternateSemanticIds'), ['within|prep|limits-v2'])
  assert.equal(frontmatterString(data, 'folder'), 'books/book1')
  assert.match(body, /# numerous（adjective · many）/)
  assert.match(body, /出处：Oxford, 2020/)
  assert.equal(senseNotePath(makeAtom({ notesFolder: 'books/book1' })), 'notes/books/book1/numerous--many.md')
  assert.equal(senseNotePath(makeAtom()), `notes/${INBOX_FOLDER}/numerous--many.md`)
  // A recorded path wins: an atom collected without a material context still
  // links to the file it was actually written to later.
  assert.equal(
    senseNotePath(makeAtom({ notesFolder: '', notePath: 'notes/books/book1/numerous--many.md' })),
    'notes/books/book1/numerous--many.md',
  )
  assert.equal(senseNotePath(makeAtom({ notePath: '../escape.md' })), `notes/${INBOX_FOLDER}/numerous--many.md`)
})

test('semantic note updates append contexts while preserving user-edited Markdown', () => {
  const first = makeAtom({ contexts: [{ id: 'ctx-one', createdAt: '2026-02-14T08:00:00.000Z', sourceKind: 'pdf', sourcePath: 'materials/one.pdf', sourceName: 'one.pdf', quote: 'A user-verified sentence.' }] })
  const second = makeAtom({ contexts: [
    ...(first.contexts || []),
    { id: 'ctx-two', createdAt: '2026-02-15T08:00:00.000Z', sourceKind: 'epub', sourcePath: 'materials/two.epub', sourceName: 'two.epub', quote: 'A different source sentence.' },
  ], alternateSemanticIds: ['within|preposition|alternate-model-id'] })
  const edited = senseNoteMarkdown(first).replace('**英文释义**：existing in large numbers', '**英文释义**：我手动改过的释义') + '\n### 我的补充\n\n保留这段笔记。\n'
  const merged = parseNote(mergeSemanticNoteMarkdown(edited, second))
  assert.match(merged.body, /我手动改过的释义/)
  assert.match(merged.body, /保留这段笔记/)
  assert.match(merged.body, /A different source sentence/)
  assert.deepEqual(frontmatterList(merged.data, 'semantics'), [first.id])
  assert.deepEqual(frontmatterList(merged.data, 'alternateSemanticIds'), ['within|preposition|alternate-model-id'])
  assert.equal(frontmatterString(merged.data, 'kind'), 'semantic')
})

test('notebook notes, AI notes and chat answers land where they belong', () => {
  const notebook = notebookNoteMarkdown(makeNote({ notesFolder: 'books/book1' }), [makeAtom({ notesFolder: 'books/book1' })])
  const parsed = parseNote(notebook)
  assert.equal(frontmatterString(parsed.data, 'kind'), 'inbox')
  assert.equal(frontmatterString(parsed.data, 'folder'), 'books/book1')
  assert.match(parsed.body, /\[\[notes\/books\/book1\/numerous--many\.md\]\]/)
  assert.equal(notebookNotePath(makeNote({ notesFolder: 'books/book1' })), 'notes/books/book1/2026-02-14-note-1.md')
  assert.equal(notebookNotePath(makeNote()), `notes/${INBOX_FOLDER}/2026-02-14-note-1.md`)
  assert.equal(notebookNotePath(makeNote({ notePath: 'notes/books/book1/2026-02-14-note-1.md' })), 'notes/books/book1/2026-02-14-note-1.md')

  const ai = aiNoteMarkdown({ title: 'numerous 全解', markdown: '正文第一段。', date: '2026-02-14', senses: ['x|y|z'], notesFolder: 'books/book1' })
  assert.match(parseNote(ai).body, /^# numerous 全解/)
  assert.equal(aiNotePath('books/book1', '2026-02-14', 'numerous 全解'), 'notes/books/book1/2026-02-14-numerous-全解.md')
  assert.equal(aiNotePath(null, '2026-02-14', 'numerous 全解'), `notes/${INBOX_FOLDER}/2026-02-14-numerous-全解.md`)

  const chat = chatAnswerMarkdown({
    threadTitle: '义项整理',
    question: 'numerous 怎么用？',
    answer: '接可数名词复数。',
    sources: ['notes/books/book1/numerous--many.md'],
    model: 'deepseek-flash',
    date: '2026-02-14',
  })
  assert.equal(chat.path, `notes/${INBOX_FOLDER}/2026-02-14-义项整理.md`)
  assert.equal(chatNotePath('2026-02-14', '义项整理'), chat.path)
  assert.match(chat.content, /## 依据的 vault 内容/)
})

test('a finding is a plain note in enlightenment/', () => {
  const source = findingNoteMarkdown({ title: '货币的两种含义', body: '## 观察\n\n名义与实际。', date: '2026-02-14' })
  const parsed = parseNote(source)
  assert.equal(frontmatterString(parsed.data, 'kind'), 'finding')
  assert.equal(frontmatterString(parsed.data, 'date'), '2026-02-14')
  assert.match(parsed.body, /^# 货币的两种含义/)
  assert.equal(findingNotePath('2026-02-14', '货币的两种含义'), 'enlightenment/2026-02-14-货币的两种含义.md')
})

test('a day rolls senses, notebook notes and vault files into one record list', () => {
  const day = '2026-02-14'
  const list = dailyEntriesFromNotebook(
    [makeAtom({ notesFolder: 'books/book1' })],
    [makeNote({ notesFolder: 'books/book1' })],
    day,
    { files: entries, selfPath: dailyNotePath(day) },
  )
  const kinds = list.map((entry) => entry.kind)
  assert.deepEqual(kinds.slice(0, 2), ['sense', 'note'])
  assert.equal(list[0].path, 'notes/books/book1/numerous--many.md')
  // The notes listed above are not repeated as "vault files of the day".
  assert.ok(!list.some((entry) => entry.path === 'notes/books/book1/numerous--many.md' && entry.kind === 'file'))
  assert.ok(list.some((entry) => entry.path === 'enlightenment/2026-02-14-观察.md'))
  assert.ok(list.some((entry) => entry.path === 'Daily/2026-02-14.md') === false, 'the day\'s own notes are not inputs')
  assert.equal(dailyEntriesFromNotebook([], [], day).length, 0)

  // A note that was filed under a material folder is not repeated as a file.
  const withPath = dailyEntriesFromNotebook(
    [makeAtom({ notePath: 'notes/books/book1/numerous--many.md' })],
    [],
    day,
    { files: entries, selfPath: dailyNotePath(day) },
  )
  assert.equal(withPath.filter((entry) => entry.path === 'notes/books/book1/numerous--many.md').length, 1)

  const findings = findingEntries(entries, day)
  assert.deepEqual(findings.map((entry) => entry.path), ['enlightenment/2026-02-14-观察.md'])
})

test('a sense saved near local midnight is grouped by its local date, not its UTC date prefix', () => {
  const localLate = new Date(2026, 1, 14, 23, 30, 0)
  const atom = makeAtom({ generatedAt: localLate.toISOString(), notePath: 'notes/books/book1/numerous--many.md' })
  const list = dailyEntriesFromNotebook([atom], [], '2026-02-14')
  assert.equal(list.length, 1)
  assert.equal(list[0]?.kind, 'sense')
  assert.equal(list[0]?.path, 'notes/books/book1/numerous--many.md')
})

test('the record list links every entry and keeps the user\'s own section', () => {
  const day = '2026-02-14'
  const list = dailyEntriesFromNotebook(
    [makeAtom({ notesFolder: 'books/book1' })],
    [makeNote({ notesFolder: 'books/book1' })],
    day,
    { files: entries, selfPath: dailyNotePath(day) },
  )
  const hash = dailySourceHash(list)
  assert.match(hash, /^[0-9a-f]{8}$/)
  assert.notEqual(hash, dailySourceHash([]), 'a changed day changes the hash')

  const summary = localDailySummary(day, list)
  assert.match(summary, /## 语义/)
  assert.match(summary, /\[\[enlightenment\/2026-02-14-观察\.md\]\]/)

  const content = dailyNoteMarkdown({
    date: day,
    entries: list,
    hash,
    reportPath: dailyReportPath(day),
    reportTime: '20:00',
    updated: '2026-02-14T12:00:00.000Z',
    userNotes: '自己补的一条：读第三章。',
  })
  const parsed = parseNote(content)
  assert.equal(frontmatterString(parsed.data, 'kind'), 'daily')
  assert.equal(frontmatterString(parsed.data, 'hash'), hash)
  assert.equal(frontmatterString(parsed.data, 'report'), 'Daily/2026-02-14-report.md')
  // The daily note links its senses, so the info panel can resolve them.
  assert.deepEqual(frontmatterList(parsed.data, 'senses'), ['numerous|adjective|many'])
  assert.match(parsed.body, /\[\[Daily\/2026-02-14-report\.md\]\]/)
  assert.match(parsed.body, /\[\[notes\/books\/book1\/numerous--many\.md\|numerous（adjective · many）\]\]/)
  assert.equal(dailyUserNotes(parsed.body), '自己补的一条：读第三章。')
})

test('daily format has five evidence-backed sections and preserves legacy additions', () => {
  const content = dailyNoteMarkdown({
    date: '2026-02-14',
    entries: [
      { id: 'phrase-1', kind: 'expression', label: 'take a stance', body: 'takes a stance', path: 'expressions/take-a-stance.md' },
      { id: 'numerous|adjective|many', kind: 'sense', label: 'numerous · many', body: '大量的', path: 'notes/numerous.md' },
    ],
    hash: '12345678',
    readingActivity: {
      seconds: 360,
      sources: [{ sourcePath: 'materials/book1.pdf', sourceName: 'book1.pdf', seconds: 360, lastReadAt: '2026-02-14T10:06:00.000Z' }],
    },
    userNotes: '自己写的补充。',
  })
  const body = parseNote(content).body
  for (const heading of ['## 读了多久', '## 读了什么', '## 表达', '## 语义', '## 总结与勉励（继往开来）']) {
    assert.ok(body.includes(heading), `missing ${heading}`)
  }
  assert.match(body, /约 6 分钟（估算）/)
  assert.match(body, /\[\[expressions\/take-a-stance\.md\|take a stance\]\]/)
  assert.equal(dailyUserNotes(body), '自己写的补充。')
  assert.equal(dailyUserNotes('## 我的补充\n\n旧版用户文本'), '旧版用户文本')
})

test('daily rewrites preserve edits outside the designated user section', () => {
  const generated = dailyNoteMarkdown({ date: '2026-02-14', entries: [], hash: '12345678' })
  const parsed = parseNote(generated)
  const managedHash = frontmatterString(parsed.data, 'managedHash')
  assert.equal(dailyManagedBodyHash(parsed.body), managedHash)

  const supplementOnly = parsed.body.replace('### 我的补充\n\n', '### 我的补充\n\n我自己的补充。\n')
  assert.equal(preserveDailyManagedEdits(supplementOnly, managedHash, '我自己的补充。'), '我自己的补充。')

  const editedGeneratedSection = parsed.body.replace('- 今天没有新增表达。', '- 我手动写入的表达记录。')
  assert.notEqual(dailyManagedBodyHash(editedGeneratedSection), managedHash)
  const preserved = preserveDailyManagedEdits(editedGeneratedSection, managedHash)
  assert.match(preserved, /检测到生成区域曾被手动修改/)
  assert.match(preserved, /我手动写入的表达记录/)

  const regenerated = parseNote(dailyNoteMarkdown({ date: '2026-02-14', entries: [], hash: '87654321', userNotes: preserved }))
  assert.match(regenerated.body, /### Paperlight 自动保留的旧记录清单/)
  assert.match(regenerated.body, /我手动写入的表达记录/)
  assert.equal(dailyManagedBodyHash(regenerated.body), frontmatterString(regenerated.data, 'managedHash'))
})

test('new expression and semantic contexts appear in that day\'s Daily', () => {
  const date = '2026-02-14'
  const expression = {
    id: 'take-a-stance-12345678', expression: 'take a stance', normalizedExpression: 'take a stance', meaning: '表明立场', note: '',
    cognitivePaths: ['recognition' as const], relations: [], createdAt: '2026-02-13T12:00:00.000Z', updatedAt: '2026-02-14T12:00:00.000Z',
    contexts: [{ id: 'ctx-1', createdAt: '2026-02-14T12:00:00.000Z', sourceKind: 'pdf' as const, sourcePath: 'materials/book1.pdf', quote: 'The authors take a stance.' }],
  }
  const repeated = makeAtom({
    generatedAt: '2026-02-13T12:00:00.000Z',
    contexts: [{ id: 'ctx-sense', createdAt: '2026-02-14T13:00:00.000Z', sourcePath: 'materials/book2.epub', quote: 'numerous examples' }],
  })
  const list = dailyEntriesFromNotebook([repeated], [], date, { expressions: [expression] })
  assert.equal(list.length, 2)
  assert.match(list.find((entry) => entry.kind === 'expression')?.body || '', /The authors take a stance/)
  assert.match(list.find((entry) => entry.kind === 'sense')?.body || '', /numerous examples/)
})

test('the report is its own file, overwritten with every generation', () => {
  const day = '2026-02-14'
  const list = dailyEntriesFromNotebook([makeAtom()], [], day, { files: entries, selfPath: dailyNotePath(day) })
  const content = dailyReportMarkdown({
    date: day,
    summary: '今天的关键收获……',
    source: 'ai',
    entries: list,
    hash: 'abcd1234',
    generated: '2026-02-14T20:00:00.000Z',
    reportTime: '20:00',
  })
  const parsed = parseNote(content)
  assert.equal(frontmatterString(parsed.data, 'kind'), 'report')
  assert.equal(frontmatterString(parsed.data, 'source'), 'ai')
  assert.equal(frontmatterString(parsed.data, 'hash'), 'abcd1234')
  assert.equal(frontmatterString(parsed.data, 'generated'), '2026-02-14T20:00:00.000Z')
  assert.match(parsed.body, /今天的关键收获/)
  assert.match(parsed.body, /## 来源/)
  assert.equal(dailyReportPath(day), 'Daily/2026-02-14-report.md')
  assert.match(markdownSection(parsed.body, '## 来源'), /numerous/)
})

test('the report slot is the last configured time that has passed', () => {
  assert.deepEqual(parseTimeOfDay('20:00'), { hours: 20, minutes: 0 })
  assert.deepEqual(parseTimeOfDay('nope'), { hours: 20, minutes: 0 })
  assert.deepEqual(parseTimeOfDay('7:05'), { hours: 7, minutes: 5 })
  assert.equal(isValidTimeOfDay('20:00'), true)
  assert.equal(isValidTimeOfDay('24:00'), false)
  assert.equal(isValidTimeOfDay('8:5'), false)

  const before = new Date(2026, 1, 14, 19, 30)
  const after = new Date(2026, 1, 14, 20, 5)
  assert.equal(reportSlotDate(before, '20:00'), '2026-02-13', 'before the time: yesterday is the last slot')
  assert.equal(reportSlotDate(after, '20:00'), '2026-02-14', 'after the time: today is due')
  assert.equal(reportSlotDate(new Date(2026, 1, 14, 0, 5), '20:00'), '2026-02-13')
})

test('a legacy daily summary keeps its sub-sections when it moves to the report', () => {
  const body = [
    '## 当日汇总',
    '',
    '今天以词汇卡片为主。',
    '',
    '### 主题脉络',
    '',
    '- 多元与单一的对峙：pluralism。',
    '',
    '### 待跟进',
    '',
    '- 没有具体的阅读材料。',
    '',
    '## 当日收录',
    '',
    '- 一条记录',
  ].join('\n')
  const summary = markdownSectionAtLevel(body, '## 当日汇总')
  assert.match(summary, /^今天以词汇卡片为主。/)
  assert.match(summary, /### 主题脉络/)
  assert.match(summary, /多元与单一的对峙：pluralism。/)
  assert.match(summary, /### 待跟进/)
  assert.ok(!summary.includes('## 当日收录'), 'the next section of the same level ends the slice')
  assert.equal(markdownSectionAtLevel(body, '## 不存在的节'), '')
})

test('legacy daily paths are remapped to the vault root', () => {
  assert.equal(remapLegacyNotePath('Paperlight/Daily/2026-02-14.md'), 'Daily/2026-02-14.md')
  assert.equal(remapLegacyNotePath('Paperlight/Daily/2026-02-14-report.md'), 'Daily/2026-02-14-report.md')
  assert.equal(remapLegacyNotePath('notes/books/book1/a.md'), 'notes/books/book1/a.md')
})

test('the vault tree shows notes everywhere and materials only under materials/', () => {
  const tree = buildVaultTree(entries)
  const paths = flattenTree(tree).map((node) => node.path)
  assert.ok(paths.includes('notes/books/book1/numerous--many.md'))
  assert.ok(paths.includes('materials/books/book1/ch1.pdf'))
  assert.ok(paths.includes('enlightenment/2026-02-14-观察.md'))
  assert.ok(paths.includes('Daily/2026-02-14-report.md'))
  assert.ok(!paths.includes('readme.txt'), 'unknown file types stay out of the notes tree')
  assert.ok(!paths.includes('Empty'), 'a folder without notes is pruned')
  assert.deepEqual(tree.map((node) => node.name), [DAILY_DIR, ENLIGHTENMENT_DIR, MATERIALS_DIR, NOTES_DIR])

  const source = findTreeNode(tree, 'materials/books/book1/ch1.pdf')
  assert.equal(source?.kind, 'source')
  assert.deepEqual(collectFiles(source!), [], 'a material is not a note')
  assert.deepEqual(
    flattenTree([findTreeNode(tree, 'notes/books/book1')!]).filter((node) => node.type === 'file').map((node) => node.path),
    ['notes/books/book1/numerous--many.md'],
  )
  assert.deepEqual(filesUnderPath(tree, 'materials'), [], 'selecting materials selects no notes')

  // The chat picker never sees materials.
  const notesOnly = buildVaultTree(entries, { sources: 'none' })
  assert.ok(!flattenTree(notesOnly).some((node) => node.kind === 'source'))

  // Empty managed folders stay visible when asked for.
  const withKeep = buildVaultTree([{ path: 'notes/books', directory: true, size: 0, mtimeMs: 0 }], { keepDirs: ['notes/books'] })
  assert.deepEqual(flattenTree(withKeep).map((node) => node.path), ['notes', 'notes/books'])

  const filtered = filterVaultTree(tree, 'numerous')
  assert.deepEqual(
    flattenTree(filtered).filter((node) => node.type === 'file').map((node) => node.path),
    ['notes/books/book1/numerous--many.md'],
  )
})

test('markdown helpers used by the notes desk', () => {
  assert.deepEqual(wikiLinks('见 [[notes/books/book1/a.md]] 与 [[b|别名]]、[[c#标题]]'), [
    'notes/books/book1/a.md', 'b', 'c',
  ])
  assert.equal(titleFromMarkdown('前言\n\n# 真正的标题\n', '回退'), '真正的标题')
  assert.equal(titleFromMarkdown('没有标题', '回退'), '回退')
  assert.equal(countWords('numerous 众多的 readers'), 5)
  const long = 'x'.repeat(100)
  assert.ok(excerptForGrounding(long, 10).startsWith('xxxxxxxxxx'))
  assert.match(excerptForGrounding(long, 10), /截断/)
  assert.equal(excerptForGrounding('短的', 10), '短的')
  assert.equal(localDateKey(new Date(2026, 1, 14, 23, 30)), '2026-02-14')
})
