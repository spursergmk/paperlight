import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadState, loadStateSync } from '../src/lib/persist.ts'

// The renderer keeps a synchronous localStorage copy and a debounced file copy.
// These tests pin down which one wins, because picking wrong either loses a
// freshly written note or resurrects deleted ones.

const STATE_KEY = 'paperlight-state-v1'

function makeStorage(initial?: unknown) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(STATE_KEY, JSON.stringify(initial))
  return {
    store,
    api: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => store.clear(),
      key: () => null,
      get length() { return store.size },
    } as unknown as Storage,
  }
}

function install(disk: unknown, local?: unknown) {
  const { store, api } = makeStorage(local)
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = api
  ;(globalThis as unknown as { window: unknown }).window = {
    paperlight: {
      isApp: true,
      state: {
        get: async () => disk ?? {},
        set: async () => ({ ok: true }),
      },
    },
  }
  return store
}

function stateWith(overrides: Record<string, unknown>) {
  return {
    version: 1,
    savedAt: 0,
    session: { tabs: [], activePath: null, activeFolder: null, recentFolders: [], recentFiles: [], favorites: [] },
    layout: { leftWidth: 264, rightWidth: 440, leftOpen: true, rightOpen: true, assistantWide: false },
    settings: { mode: 'mock', model: 'deepseek-flash' },
    notebook: { atoms: [], notes: [], chat: {} },
    ...overrides,
  }
}

const note = (id: string, body: string) => ({
  id, date: '2026-10-07', dailyOrdinal: 1, body, senseIds: [], createdAt: '2026-10-07T10:00:00.000Z',
})

beforeEach(() => {
  install({}, undefined)
})

test('a newer localStorage copy wins over an older state file', async () => {
  const fresh = stateWith({
    savedAt: 2_000,
    notebook: { atoms: [], notes: [note('n1', '刚写的笔记')], chat: {} },
  })
  const stale = stateWith({ savedAt: 1_000, notebook: { atoms: [], notes: [], chat: {} } })
  install(stale, fresh)

  const state = await loadState()
  assert.equal(state.notebook.notes.length, 1, 'the note written just before the crash survives')
  assert.equal(state.notebook.notes[0].body, '刚写的笔记')
})

test('an older localStorage copy from another origin cannot resurrect deleted data', async () => {
  const disk = stateWith({ savedAt: 5_000, notebook: { atoms: [], notes: [], chat: {} } })
  const staleOtherOrigin = stateWith({
    savedAt: 100,
    notebook: { atoms: [], notes: [note('deleted', '已删除的笔记')], chat: {} },
  })
  install(disk, staleOtherOrigin)

  const state = await loadState()
  assert.equal(state.notebook.notes.length, 0, 'deleted notes stay deleted')
})

test('a legacy state file still imports browser-only notes once', async () => {
  const legacyDisk = stateWith({ savedAt: 0, notebook: { atoms: [], notes: [], chat: {} } })
  const local = stateWith({ savedAt: 0, notebook: { atoms: [], notes: [note('old', '旧版笔记')], chat: {} } })
  install(legacyDisk, local)

  const state = await loadState()
  assert.equal(state.notebook.notes.length, 1)
  assert.equal(state.notebook.notes[0].body, '旧版笔记')
})

test('a state file from the disk still wins when it is the newer one', async () => {
  const disk = stateWith({ savedAt: 9_000, notebook: { atoms: [], notes: [note('disk', '磁盘上的笔记')], chat: {} } })
  install(disk, stateWith({ savedAt: 500 }))

  const state = await loadState()
  assert.equal(state.notebook.notes[0]?.body, '磁盘上的笔记')
})

test('corrupted collections degrade to empty instead of crashing the first render', async () => {
  install({
    version: 1,
    savedAt: 10,
    session: { tabs: null, activePath: 'x.pdf', activeFolder: 42, recentFiles: 'nope' },
    layout: null,
    notebook: { atoms: 'nope', notes: null, chat: [] },
  })

  const state = await loadState()
  assert.deepEqual(state.session.tabs, [])
  assert.deepEqual(state.session.recentFiles, [])
  assert.equal(state.session.activeFolder, null)
  assert.deepEqual(state.notebook.atoms, [])
  assert.deepEqual(state.notebook.notes, [])
  assert.deepEqual(state.notebook.chat, {})
  assert.equal(state.layout.leftWidth, 264, 'layout falls back to defaults')
})

test('legacy state loads without marks and new input markers survive safe state migration', async () => {
  install(stateWith({ savedAt: 10, notebook: { atoms: [], notes: [], chat: {} } }))
  const legacy = await loadState()
  assert.deepEqual(legacy.inputMarkers, [])
  assert.deepEqual(legacy.readingActivity, {})

  const marker = {
    id: 'mark-1', sourcePath: '/books/sample.pdf', sourceKind: 'pdf', purpose: 'content',
    visualStyle: 'highlight', quote: 'worth considering', before: 'This is ', after: ' again.',
    pageNumber: 4, startOffset: 28, endOffset: 45, blockIndex: 7, scrollRatio: 0.62,
    comment: 'check the claim', createdAt: '2026-10-08T12:00:00.000Z',
  }
  install(stateWith({ savedAt: 20, inputMarkers: [marker, { ...marker, id: '', purpose: 'unknown' }] }))
  const migrated = await loadState()
  assert.equal(migrated.inputMarkers.length, 1)
  assert.equal(migrated.inputMarkers[0]?.quote, 'worth considering')
  assert.equal(migrated.inputMarkers[0]?.sourcePath, '/books/sample.pdf')
  assert.equal(migrated.inputMarkers[0]?.blockIndex, 7)
  assert.equal(migrated.inputMarkers[0]?.scrollRatio, 0.62)

  install(stateWith({ savedAt: 21, readingActivity: {
    '2026-10-09': {
      seconds: 900,
      sources: [{ sourcePath: 'materials/book1.pdf', sourceName: 'book1.pdf', seconds: 900, lastReadAt: '2026-10-09T10:00:00.000Z' }],
    },
    invalid: { seconds: 999_999, sources: [] },
  } }))
  const activity = await loadState()
  assert.equal(activity.readingActivity['2026-10-09']?.seconds, 900)
  assert.equal(activity.readingActivity.invalid, undefined)
})

test('the notes and chat desks survive a round trip and reject unsafe paths', async () => {
  const disk = stateWith({
    savedAt: 3_000,
    activeSpace: 'notes',
    vault: { root: '/tmp/vault', recentRoots: ['/tmp/vault'], collapsed: ['Paperlight'] },
    notesSpace: {
      openPaths: ['Paperlight/Daily/2026-02-14.md', '../../etc/passwd', '/etc/passwd', 'Paperlight/Senses/a.md', 'Paperlight/Senses/a.md'],
      activePath: '../evil.md',
      view: 'preview',
      treeWidth: 300,
      sideOpen: false,
      sideWidth: 260,
    },
    chatSpace: {
      threads: [{
        id: 't1', title: '义项整理', createdAt: '2026-02-14T09:00:00.000Z', updatedAt: '2026-02-14T09:01:00.000Z',
        messages: [
          { id: 'm1', role: 'user', content: 'numerous 怎么用？', createdAt: '2026-02-14T09:00:10.000Z' },
          { id: 'm2', role: 'assistant', content: '接可数名词复数。', createdAt: '2026-02-14T09:00:20.000Z', grounded: true, sources: ['Paperlight/Senses/numerous--many.md'] },
        ],
        contextPaths: ['Paperlight/Senses/numerous--many.md', 'C:\\Windows\\x.md', '../secret.md'],
      }],
      activeThreadId: 't1', historyWidth: 200, pickerWidth: 240, historyOpen: true, pickerOpen: false,
    },
  })
  install(disk, undefined)

  const state = await loadState()
  assert.equal(state.activeSpace, 'notes')
  assert.equal(state.vault.root, '/tmp/vault')
  assert.deepEqual(state.notesSpace.openPaths, ['Paperlight/Daily/2026-02-14.md', 'Paperlight/Senses/a.md'])
  assert.equal(state.notesSpace.activePath, null, 'an unsafe active path is dropped')
  assert.equal(state.notesSpace.view, 'preview')
  assert.equal(state.notesSpace.sideOpen, false)
  assert.equal(state.vault.collapsed.length, 1)
  assert.equal(state.chatSpace.threads.length, 1)
  assert.deepEqual(state.chatSpace.threads[0].contextPaths, ['Paperlight/Senses/numerous--many.md'])
  assert.equal(state.chatSpace.threads[0].messages[1].grounded, true)
  assert.equal(state.chatSpace.activeThreadId, 't1')
})

test('a corrupted notes/chat space degrades to defaults', async () => {
  install({
    version: 1,
    savedAt: 10,
    activeSpace: 'nope',
    vault: 'nope',
    notesSpace: { openPaths: 'nope', activePath: 42, view: 'hologram', treeWidth: 'wide', sideOpen: 'yes' },
    chatSpace: { threads: 'nope', activeThreadId: 5, historyWidth: null },
  })

  const state = await loadState()
  assert.equal(state.activeSpace, 'reader')
  assert.equal(state.vault.root, null)
  assert.deepEqual(state.notesSpace.openPaths, [])
  assert.equal(state.notesSpace.view, 'edit', 'a legacy split view falls back to one full-width mode')
  assert.equal(state.notesSpace.treeWidth, 252)
  assert.equal(state.notesSpace.sideOpen, true)
  assert.deepEqual(state.chatSpace.threads, [])
  assert.equal(state.chatSpace.activeThreadId, null)
  assert.equal(state.chatSpace.historyWidth, 214)
  assert.equal(state.settings.dailyReportTime, '20:00')
  assert.equal(state.settings.dailyReportAuto, true)
})

test('an invalid daily report time falls back to the default', async () => {
  install(stateWith({ savedAt: 4_000, settings: { mode: 'mock', model: 'deepseek-flash', dailyReportTime: '99:99', dailyReportAuto: false } }))
  const state = await loadState()
  assert.equal(state.settings.dailyReportTime, '20:00')
  assert.equal(state.settings.dailyReportAuto, false)
})

test('the synchronous fast path never throws when storage is unavailable', () => {
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem() { throw new Error('storage blocked') },
    setItem() { throw new Error('storage blocked') },
  }
  const state = loadStateSync()
  assert.equal(state.session.tabs.length, 0)
  assert.equal(state.settings.model, 'deepseek-flash')
})
