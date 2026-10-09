import type { ReadingActivityDay, ReadingActivitySource } from '../types'
import { localDateKey } from './notebook.ts'

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
