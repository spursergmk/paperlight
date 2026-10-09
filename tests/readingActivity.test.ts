import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDateKey } from '../src/lib/notebook.ts'
import { activeReadingInterval, recordReadingInterval, readingDurationLabel } from '../src/lib/readingActivity.ts'

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

test('foreground reading starts at interaction and rejects background, idle and delayed timer gaps', () => {
  const start = 1_000_000
  assert.deepEqual(activeReadingInterval({
    previousTickMs: start,
    nowMs: start + 15_000,
    lastInteractionMs: start + 4_000,
    hidden: false,
    focused: true,
  }), { fromMs: start + 4_000, toMs: start + 15_000 })
  assert.deepEqual(activeReadingInterval({
    previousTickMs: start + 15_000,
    nowMs: start + 30_000,
    lastInteractionMs: start + 4_000,
    hidden: false,
    focused: true,
  }), { fromMs: start + 15_000, toMs: start + 30_000 }, 'a recent interaction before the tick keeps the full bounded interval')
  assert.deepEqual(activeReadingInterval({
    previousTickMs: start,
    nowMs: start + 15_000,
    lastInteractionMs: start + 13_000,
    hidden: false,
    focused: true,
  }), { fromMs: start + 13_000, toMs: start + 15_000 }, 'an interaction during the interval avoids counting earlier idle time')
  assert.equal(activeReadingInterval({
    previousTickMs: start,
    nowMs: start + 15_000,
    lastInteractionMs: start + 4_000,
    hidden: true,
    focused: true,
  }), null)
  assert.equal(activeReadingInterval({
    previousTickMs: start,
    nowMs: start + 15_000,
    lastInteractionMs: start + 4_000,
    hidden: false,
    focused: false,
  }), null)
  assert.equal(activeReadingInterval({
    previousTickMs: start,
    nowMs: start + 60_000,
    lastInteractionMs: start + 1_000,
    hidden: false,
    focused: true,
  }), null, 'a late timer callback cannot count sleep/background time')
  assert.equal(activeReadingInterval({
    previousTickMs: start,
    nowMs: start + 46_001,
    lastInteractionMs: start + 1_000,
    hidden: false,
    focused: true,
  }), null, 'long inactivity is not counted as reading')
})
