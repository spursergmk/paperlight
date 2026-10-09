import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createExpressionRecord, expressionRecordId, expressionRecordMarkdown, expressionRecordPath,
  makeExpressionContext, mergeExpressionRecord, normalizeExpression, parseExpressionRecord,
} from '../src/lib/memory.ts'

test('expression identity normalizes case, Unicode width, spacing and edge punctuation', () => {
  assert.equal(normalizeExpression('  “Ｔake   a stance!”  '), 'take a stance')
  assert.equal(expressionRecordId('take a stance'), expressionRecordId('TAKE A STANCE.'))
  assert.notEqual(expressionRecordId('take a stance'), expressionRecordId('take the stance'))
})

test('PDF and EPUB captures of one expression accumulate separate source contexts', () => {
  const pdf = createExpressionRecord({
    expression: 'take a stance',
    cognitivePath: 'recognition',
    context: {
      sourceKind: 'pdf', sourceName: 'Research.pdf', sourcePath: '/library/Research.pdf',
      pageNumber: 12, quote: 'The authors take a stance on the question.',
    },
    now: '2026-10-09T02:00:00.000Z',
  })
  const epub = createExpressionRecord({
    expression: 'TAKE A STANCE!',
    cognitivePath: 'recognition',
    context: {
      sourceKind: 'epub', sourceName: 'Essays.epub', sourcePath: '/library/Essays.epub',
      pageNumber: 3, locationLabel: 'Chapter 3', quote: 'She chose to take a stance early.',
    },
    now: '2026-10-09T03:00:00.000Z',
  })
  const merged = mergeExpressionRecord(pdf, epub)
  assert.equal(merged.id, pdf.id)
  assert.equal(merged.expression, 'take a stance')
  assert.equal(merged.contexts.length, 2)
  assert.deepEqual(merged.contexts.map((item) => item.sourceKind), ['pdf', 'epub'])
  assert.equal(expressionRecordPath(merged), `expressions/${pdf.id}.md`)
})

test('only exact normalized expression duplicates merge automatically', () => {
  const first = createExpressionRecord({ expression: 'break new ground' })
  const nearby = createExpressionRecord({ expression: 'break ground' })
  assert.throws(() => mergeExpressionRecord(first, nearby), /完全相同/)
})

test('expression Markdown round-trips meanings, notes, relations and provenance', () => {
  const record = createExpressionRecord({
    expression: 'on the same wavelength',
    meaning: '想法或感受相近',
    note: '适合描述合作默契。',
    cognitivePath: 'manual',
    context: {
      sourceKind: 'assistant', sourceName: '阅读助手回答', quote: 'We seem to be on the same wavelength.',
      sourcePath: '/library/article.pdf', pageNumber: 5, blockIndex: 17,
    },
  })
  record.relations.push({
    id: 'rel-1', targetId: 'share-a-view-82', kind: 'similar', note: '强调意见相似', source: 'user', createdAt: record.createdAt,
  })
  const markdown = expressionRecordMarkdown(record)
  assert.match(markdown, /We seem to be on the same wavelength/)
  assert.match(markdown, /\/library\/article\.pdf/)
  const loaded = parseExpressionRecord(markdown)
  assert.deepEqual(loaded, record)
})

test('AI exploration contexts are marked as generated and never retain a source quote', () => {
  const context = makeExpressionContext({
    sourceKind: 'ai_exploration', generated: true, usageScenario: '表达观点一致', quote: 'An invented sentence',
  })
  const record = createExpressionRecord({ expression: 'see eye to eye', cognitivePath: 'exploration', context })
  assert.equal(record.contexts[0]?.generated, true)
  assert.equal(record.contexts[0]?.quote, undefined)
  assert.match(expressionRecordMarkdown(record), /AI 生成候选；此条不是原文摘录/)
})

test('a damaged expression metadata block falls back to its visible Markdown title', () => {
  const restored = parseExpressionRecord('---\nkind: expression\ntitle: see eye to eye\nexpressionData: not-base64\n---\n# see eye to eye\n')
  assert.equal(restored?.expression, 'see eye to eye')
  assert.equal(restored?.contexts.length, 0)
})
