import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contextFromBlocks, contextFromLines, contextFromOffset, findStoredLanguageMatches,
  pdfTextLines,
} from '../src/lib/queryContext.ts'

test('context window includes five source lines above and below without counting soft wraps', () => {
  const lines = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`)
  const result = contextFromLines(lines, 7)
  assert.equal(result.startLine, 2)
  assert.equal(result.endLine, 12)
  assert.deepEqual(result.text.split('\n'), lines.slice(2, 13))
})

test('a multi-line selection keeps all selected source lines plus five on each side', () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
  const result = contextFromLines(lines, 8, 10)
  assert.deepEqual(result.text.split('\n'), lines.slice(3, 16))
  assert.equal(result.selected, 'line 9\nline 10\nline 11')
})

test('PDF text extraction honors native line-end markers', () => {
  assert.deepEqual(pdfTextLines([
    { str: 'The first ' }, { str: 'line.', hasEOL: true },
    { str: 'A second line.', hasEOL: true }, { str: 'A third line.' },
  ]), ['The first line.', 'A second line.', 'A third line.'])
})

test('reflowable context is measured in source blocks rather than rendered rows', () => {
  const blocks = ['heading', 'paragraph with a long soft-wrapped sentence', 'second paragraph', 'third paragraph']
  const result = contextFromBlocks(blocks, 1, 1, 5, 5)
  assert.equal(result.text, blocks.join('\n'))
})

test('offset context uses explicit source newlines and finds the selected range', () => {
  const source = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve'
  const result = contextFromOffset(source, 'seven', source.indexOf('seven'), 2, 1)
  assert.deepEqual(result.text.split('\n'), ['five', 'six', 'seven', 'eight'])
})

test('local memory recognition matches exact expressions and semantic terms only', () => {
  const matches = findStoredLanguageMatches('They finally reached a consensus, unlike the consensus earlier.', [
    { kind: 'expression', text: 'consensus', meaning: '共同意见' },
    { kind: 'semantic', text: 'sense', meaning: '语义' },
  ])
  assert.deepEqual(matches.map(({ kind, text }) => [kind, text]), [
    ['expression', 'consensus'], ['expression', 'consensus'],
  ])
})

test('local memory recognition prefers a longer overlapping phrase at the same position', () => {
  const matches = findStoredLanguageMatches('make a decision', [
    { kind: 'expression', text: 'make a decision', meaning: '作出决定' },
    { kind: 'semantic', text: 'decision', meaning: '决定' },
  ])
  assert.deepEqual(matches.map((item) => item.text), ['make a decision', 'decision'])
})
