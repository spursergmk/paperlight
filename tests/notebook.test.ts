import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createNote, loadNotes, noteLabel, relateSense, saveNotes, senseAtomId, toAtom,
} from '../src/lib/notebook.ts'
import type { SenseAtom, SensePayload } from '../src/types.ts'

// Minimal localStorage so the notebook persistence layer can be tested in Node.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  },
})

function reset(): void {
  store.clear()
}

function makeSense(overrides: Partial<SensePayload> = {}): SensePayload {
  return {
    term: 'within',
    lemma: 'within',
    partOfSpeech: 'preposition',
    senseId: 'inside-limits',
    contextualMeaning: '在……范围之内',
    definition: 'inside the limits of something',
    contextSentence: 'operate within a framework',
    examples: [],
    guidance: {
      scenarios: [], advice: [], frequency: '',
      alternatives: [], synonyms: [], antonyms: [],
      morphology: { root: '', prefix: '', suffix: '', note: '' },
    },
    ...overrides,
  }
}

test('sense identity is stable and case-insensitive', () => {
  assert.equal(
    senseAtomId({ lemma: 'Within', partOfSpeech: 'Preposition', senseId: 'Inside-Limits' }),
    'within|preposition|inside-limits',
  )
})

test('note ordinals increment per day and are never reused after deletion', () => {
  reset()
  const first = createNote('第一条', ['within|preposition|inside-limits'])
  const second = createNote('第二条', ['within|preposition|inside-limits'])
  assert.equal(first.dailyOrdinal, 1)
  assert.equal(second.dailyOrdinal, 2)
  assert.equal(noteLabel(first), `${first.date} 第 1 份笔记`)

  // Deleting the newest note must not free its ordinal.
  saveNotes([first])
  const third = createNote('第三条', [])
  assert.equal(third.dailyOrdinal, 3)
})

test('saving notes keeps the source chat message id when provided', () => {
  reset()
  const fromChat = createNote('对话内容', ['a|b|c'], new Date(), 'msg-1')
  const manual = createNote('手动笔记', ['a|b|c'])
  assert.equal(fromChat.sourceMessageId, 'msg-1')
  assert.equal('sourceMessageId' in manual, false)
  saveNotes([fromChat, manual])
  assert.deepEqual(loadNotes().map((note) => note.sourceMessageId), ['msg-1', undefined])
})

test('toAtom freezes one term-sense pair and keeps provenance', () => {
  const atom = toAtom(makeSense({ examples: [{ text: 'x', translation: 'y', sourceType: 'ai_generated', citation: null }] }), 'deepseek-flash')
  assert.equal(atom.id, 'within|preposition|inside-limits')
  assert.equal(atom.model, 'deepseek-flash')
  assert.equal(atom.source, 'ai')
  assert.equal(atom.schemaVersion, 1)
  assert.equal(atom.examples.length, 1)
})

function atomFor(overrides: Partial<SenseAtom> = {}): SenseAtom {
  return { ...toAtom(makeSense(), 'deepseek-flash'), ...overrides }
}

function guidance(overrides: Partial<SensePayload['guidance']> = {}): SensePayload['guidance'] {
  return {
    scenarios: [], advice: [], frequency: '',
    alternatives: [], synonyms: [], antonyms: [],
    morphology: { root: '', prefix: '', suffix: '', note: '' },
    ...overrides,
  }
}

test('relations only surface strong connections', () => {
  const current = makeSense({
    guidance: guidance({
      alternatives: [{ term: 'inside', note: '' }],
      synonyms: [{ term: 'amid', contrast: '' }],
      morphology: { root: 'with+in', prefix: '', suffix: '', note: '' },
    }),
  })

  const sameLemma = atomFor({ id: 'within|noun|other', lemma: 'within', senseId: 'other', guidance: guidance() })
  const sameRoot = atomFor({
    id: 'without|preposition|x', lemma: 'without', senseId: 'x',
    guidance: guidance({ morphology: { root: 'with+in', prefix: '', suffix: '', note: '' } }),
  })
  const shared = atomFor({
    id: 'amid|preposition|y', lemma: 'amid', senseId: 'y',
    guidance: guidance({ synonyms: [{ term: 'amid', contrast: '' }] }),
  })
  const unrelated = atomFor({
    id: 'banana|noun|z', lemma: 'banana', senseId: 'z',
    guidance: guidance({ morphology: { root: 'banana', prefix: '', suffix: '', note: '' } }),
  })

  const reasons = relateSense(current, [sameLemma, sameRoot, shared, unrelated]).map((relation) => relation.reason)
  assert.deepEqual(reasons, ['同一词的另一个义项', '同词根', '共享近义表达：amid'])
  assert.equal(relateSense(current, [unrelated]).length, 0)
})

test('relations never include the atom itself', () => {
  const current = makeSense()
  const self = atomFor({ id: senseAtomId(current) })
  assert.equal(relateSense(current, [self]).length, 0)
})
