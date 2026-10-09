import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  confirmSemanticMerge, createNote, loadNotes, mergeSemanticAtom, noteLabel, possibleSemanticMergeCandidates, relateSense,
  saveNotes, selectionMatchesSemanticTerm, semanticRecordForId, senseAtomId, toAtom,
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

test('semantic source contexts use the actual selected wording, not an AI paraphrase', () => {
  const atom = toAtom(makeSense({ contextSentence: 'An AI-generated version of the sentence.' }), 'model', undefined, {
    text: 'The source material says these exact words.', before: 'It begins: ', after: ' and then continues.', pageNumber: 3,
    documentName: 'source.pdf', documentPath: '/books/source.pdf',
  })
  assert.equal(atom.contextSentence, 'The source material says these exact words.')
  assert.equal(atom.contexts?.[0]?.quote, 'The source material says these exact words.')
})

test('a stale reader selection is not attached to an unrelated typed semantic query', () => {
  assert.equal(selectionMatchesSemanticTerm('The word within appears here.', ['within']), true)
  assert.equal(selectionMatchesSemanticTerm('The word within appears here.', ['inside limits', 'within']), true)
  assert.equal(selectionMatchesSemanticTerm('The word within appears here.', ['bank']), false)
})

test('same semantic accumulates distinct source contexts without replacing its explanation', () => {
  const selected = (documentPath: string, pageNumber: number) => ({
    text: 'within a framework', before: 'operate ', after: '', pageNumber,
    documentName: documentPath.split('/').pop(), documentPath,
  })
  const first = toAtom(makeSense({ definition: 'inside a system of rules' }), 'model-a', undefined, selected('/books/a.pdf', 4))
  const repeated = toAtom(makeSense({ definition: 'inside specified limits' }), 'model-b', undefined, selected('/books/b.epub', 2))
  const merged = mergeSemanticAtom(first, repeated)

  assert.equal(merged.id, first.id)
  assert.equal(merged.definition, 'inside a system of rules')
  assert.equal(merged.contexts?.length, 2)
  assert.deepEqual(merged.contexts?.map((context) => context.sourcePath).sort(), ['/books/a.pdf', '/books/b.epub'])
  assert.deepEqual(mergeSemanticAtom(merged, repeated).contexts?.length, 2, 'same source occurrence is deduplicated')
})

test('same lemma and part of speech with a different AI id requires a user merge choice', () => {
  const existing = toAtom(makeSense({ senseId: 'inside-limits', contextualMeaning: '在范围以内' }), 'model-a')
  const sameAnchorDifferentMeaning = toAtom(makeSense({
    term: 'WITHIN', lemma: 'within', senseId: 'internal-relation', contextualMeaning: '在某个群体或关系内部',
  }), 'model-b')
  const sameId = toAtom(makeSense({ senseId: 'inside-limits' }), 'model-c')
  const otherPartOfSpeech = toAtom(makeSense({
    partOfSpeech: 'adverb', senseId: 'inside-limits', contextualMeaning: '在内部',
  }), 'model-d')

  assert.deepEqual(possibleSemanticMergeCandidates(sameAnchorDifferentMeaning, [existing]), [existing])
  assert.deepEqual(possibleSemanticMergeCandidates(sameId, [existing]), [])
  assert.deepEqual(possibleSemanticMergeCandidates(otherPartOfSpeech, [existing]), [])
  assert.notEqual(existing.id, sameAnchorDifferentMeaning.id, 'different semantic IDs remain independent by default')
})

test('confirmed semantic merge keeps the old explanation and adds distinct AI details', () => {
  const first = toAtom(makeSense({
    contextualMeaning: '在范围以内', definition: 'inside a boundary', contextSentence: 'Stay within the line.',
    examples: [{ text: 'Stay within the line.', translation: '留在界线内。', sourceType: 'ai_generated', citation: null }],
    guidance: guidance({ scenarios: ['用于表示边界'], advice: ['搭配范围词使用'], frequency: '常见' }),
  }), 'model-a')
  const incoming = toAtom(makeSense({
    senseId: 'within-range',
    contextualMeaning: '限制范围之内', definition: 'inside an allowed range', contextSentence: 'Keep it within reach.',
    examples: [
      { text: 'Stay within the line.', translation: '留在界线内。', sourceType: 'ai_generated', citation: null },
      { text: 'Keep it within reach.', translation: '让它在够得到的范围内。', sourceType: 'ai_generated', citation: null },
    ],
    guidance: guidance({ scenarios: ['用于表示边界'], advice: ['说明允许的范围'], frequency: '偶见' }),
  }), 'model-b')

  assert.throws(() => mergeSemanticAtom(first, incoming), /必须先由用户确认/)
  const confirmed = confirmSemanticMerge(first, incoming)
  assert.equal(confirmed.contextualMeaning, '在范围以内')
  assert.equal(confirmed.definition, 'inside a boundary')
  assert.deepEqual(confirmed.alternateSemanticIds, [incoming.id])
  assert.equal(semanticRecordForId(incoming.id, [confirmed])?.id, first.id)
  assert.deepEqual(possibleSemanticMergeCandidates(incoming, [confirmed]), [], 'a confirmed alternate ID no longer prompts again')
  assert.deepEqual(confirmed.examples.map((item) => item.text), ['Stay within the line.', 'Keep it within reach.'])
  assert.deepEqual(confirmed.guidance.scenarios, ['用于表示边界'])
  assert.deepEqual(confirmed.guidance.advice, ['搭配范围词使用', '说明允许的范围'])
  assert.equal(confirmed.guidance.frequency, '常见')
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
