import { test } from 'node:test'
import assert from 'node:assert/strict'
import { locateMarkerQuote, normalizeLocatorText } from '../src/lib/markers.ts'

test('marker quote offsets normalize whitespace and invisible layout characters', () => {
  assert.equal(normalizeLocatorText('  A\u200b useful\n phrase  '), 'A useful phrase')
  assert.deepEqual(locateMarkerQuote('A\u200b useful\n phrase appears here.', { quote: 'A useful phrase' }), { start: 0, end: 15 })
})

test('a unique quote is restored even when page text has reflowed around it', () => {
  assert.deepEqual(
    locateMarkerQuote('A page has reflowed. This expression remains in the same passage.', {
      quote: 'This expression', before: 'A page has reflowed. ', after: ' remains in the same passage.', startOffset: 22,
    }),
    { start: 21, end: 36 },
  )
})

test('repeated quotes require a verified surrounding context instead of choosing the nearest text', () => {
  const text = 'We can see eye to eye after discussion. Later, teams may see eye to eye on a plan.'
  assert.deepEqual(
    locateMarkerQuote(text, { quote: 'see eye to eye', before: 'Later, teams may ', after: ' on a plan.', startOffset: 2 }),
    { start: 57, end: 71 },
  )
  assert.equal(locateMarkerQuote(text, { quote: 'see eye to eye', startOffset: 2 }), null)
})

test('edited source text that no longer contains a marked quote is unresolved', () => {
  assert.equal(locateMarkerQuote('The passage has been rewritten.', { quote: 'old wording', before: 'Some', after: ' context' }), null)
})
