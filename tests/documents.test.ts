import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePrintedTocLine } from '../src/lib/pdfToc.ts'

test('printed PDF contents lines preserve headings and Arabic page numbers', () => {
  assert.deepEqual(parsePrintedTocLine('1 Introduction ........ 3'), {
    title: '1 Introduction',
    printedPage: '3',
  })
})

test('printed PDF contents lines recognize leader dots, ellipses, and Roman page labels', () => {
  assert.deepEqual(parsePrintedTocLine('Background … 14'), { title: 'Background', printedPage: '14' })
  assert.deepEqual(parsePrintedTocLine('Appendix A ........ ix'), { title: 'Appendix A', printedPage: 'ix' })
  assert.equal(parsePrintedTocLine('a sentence with no page number'), null)
  assert.equal(parsePrintedTocLine('Contents'), null)
})
