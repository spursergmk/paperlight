import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDateKey } from '../src/lib/notebook.ts'
import { recordReadingInterval, readingDurationLabel } from '../src/lib/readingActivity.ts'

test('reading activity splits an interval across local midnight', () => {
  const start = new Date(2026, 9, 9, 23, 59, 45).getTime()
  const end = new Date(2026, 9, 10, 0, 0, 15).getTime()
  const before = localDateKey(new Date(start))
  const after = localDateKey(new Date(end))
  const activity = recordReadingInterval({}, start, end, '/books/example.pdf', 'example.pdf')

  assert.equal(activity[before]?.seconds, 15)
  assert.equal(activity[after]?.seconds, 15)
  assert.equal(activity[before]?.sources[0]?.seconds, 15)
  assert.equal(activity[after]?.sources[0]?.sourceName, 'example.pdf')
})

test('reading activity ignores invalid intervals and duration labels avoid false precision', () => {
  const current = { '2026-10-09': { seconds: 30, sources: [] } }
  assert.equal(recordReadingInterval(current, 10, 10, 'book.pdf', 'book.pdf'), current)
  assert.equal(recordReadingInterval(current, 20, 10, 'book.pdf', 'book.pdf'), current)
  assert.equal(readingDurationLabel(0), '今天尚无阅读时长记录。')
  assert.equal(readingDurationLabel(12), '不足 1 分钟（估算）')
  assert.equal(readingDurationLabel(91), '约 2 分钟（估算）')
})
