import type { ReadingActivityDay, ReadingActivitySource } from '../types'
import { localDateKey } from './notebook.ts'

export const READING_TICK_INTERVAL_MS = 15_000
const READING_MAX_TICK_GAP_MS = 25_000
const READING_IDLE_LIMIT_MS = 45_000

/** A countable foreground interval from one timer tick to the next. */
export function activeReadingInterval(input: {
  previousTickMs: number
  nowMs: number
  lastInteractionMs: number
  hidden: boolean
  focused: boolean
}): { fromMs: number; toMs: number } | null {
  const { previousTickMs, nowMs, lastInteractionMs, hidden, focused } = input
  if (![previousTickMs, nowMs, lastInteractionMs].every(Number.isFinite) || nowMs <= previousTickMs) return null
  const elapsed = nowMs - previousTickMs
  if (elapsed < 1_000 || elapsed > READING_MAX_TICK_GAP_MS) return null
  if (hidden || !focused || lastInteractionMs <= 0 || lastInteractionMs > nowMs) return null
  if (nowMs - lastInteractionMs > READING_IDLE_LIMIT_MS) return null
  // An interaction inside this sampling window only proves activity from that
  // point onward. If the last interaction predates the previous tick, its
  // recent timestamp proves the whole bounded interval stayed active.
  const fromMs = lastInteractionMs > previousTickMs ? lastInteractionMs : previousTickMs
  return nowMs - fromMs >= 1_000 ? { fromMs, toMs: nowMs } : null
}

/** Add a bounded foreground-reading interval, splitting it at local midnight. */
export function recordReadingInterval(
  current: Record<string, ReadingActivityDay>,
  fromMs: number,
  toMs: number,
  sourcePath: string,
  sourceName: string,
): Record<string, ReadingActivityDay> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || !sourcePath.trim()) return current
  const next = { ...current }
  let cursor = fromMs
  while (cursor < toMs) {
    const date = new Date(cursor)
    const boundary = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
    const segmentEnd = Math.min(boundary, toMs)
    const seconds = Math.floor((segmentEnd - cursor) / 1000)
    if (seconds > 0) {
      const dayKey = localDateKey(date)
      const day = next[dayKey] || { seconds: 0, sources: [] }
      const existing = day.sources.find((source) => source.sourcePath === sourcePath)
      const source: ReadingActivitySource = existing
        ? { ...existing, seconds: existing.seconds + seconds, lastReadAt: new Date(segmentEnd).toISOString() }
        : { sourcePath, sourceName, seconds, lastReadAt: new Date(segmentEnd).toISOString() }
      next[dayKey] = {
        seconds: day.seconds + seconds,
        sources: [source, ...day.sources.filter((item) => item.sourcePath !== sourcePath)].slice(0, 100),
      }
    }
    cursor = segmentEnd
  }
  const keep = Object.keys(next).sort().slice(-90)
  return Object.fromEntries(keep.map((key) => [key, next[key]]))
}

/** Format an estimate without implying second-level precision. */
export function readingDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '今天尚无阅读时长记录。'
  if (seconds < 30) return '不足 1 分钟（估算）'
  return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟（估算）`
}
