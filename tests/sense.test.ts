import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sentenceAround, termFromSelection } from '../src/lib/sense.ts'

test('termFromSelection strips surrounding punctuation and quotes', () => {
  assert.equal(termFromSelection('  «within»  '), 'within')
  assert.equal(termFromSelection('framework,'), 'framework')
  assert.equal(termFromSelection('(precedent)'), 'precedent')
  assert.equal(termFromSelection("'self-control'"), "'self-control'")
})

test('termFromSelection keeps a short phrase but trims long selections', () => {
  assert.equal(termFromSelection('power knowledge'), 'power knowledge')
  assert.equal(
    termFromSelection('these power knowledge classifications operate within'),
    'these power knowledge classifications',
  )
})

test('termFromSelection falls back to a bounded string for punctuation-only input', () => {
  const result = termFromSelection('———')
  assert.ok(result.length > 0 && result.length <= 120)
})

test('sentenceAround returns the sentence containing the selection', () => {
  const text = 'First sentence here. These classifications operate within a broader framework. Last sentence.'
  const index = text.indexOf('within')
  assert.equal(
    sentenceAround(text, index, 'within'.length),
    'These classifications operate within a broader framework.',
  )
})

test('sentenceAround keeps the selection at the very start and end of the text', () => {
  assert.equal(sentenceAround('within a framework', 0, 'within'.length), 'within a framework')
  const text = 'Only one sentence ends here.'
  assert.equal(sentenceAround(text, 5, 3), 'Only one sentence ends here.')
})

test('sentenceAround falls back to a window when the selection is not found', () => {
  const text = 'a'.repeat(400) + ' target ' + 'b'.repeat(400)
  const result = sentenceAround(text, -1, 6)
  assert.ok(result.length > 0)
  assert.ok(result.length <= 400)
})

test('sentenceAround caps very long paragraphs', () => {
  const text = 'word '.repeat(400) + 'within' + ' more'.repeat(400)
  const index = text.indexOf('within')
  assert.ok(sentenceAround(text, index, 6).length <= 700)
})
