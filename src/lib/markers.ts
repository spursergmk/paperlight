import type { InputMarker } from '../types'

export interface LocatedQuote {
  start: number
  end: number
}

export function normalizeLocatorText(value: string): string {
  return value.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

/** Resolve only unique or strongly context-confirmed matches; ambiguity stays visible to the caller. */
export function locateMarkerQuote(source: string, marker: Pick<InputMarker, 'quote' | 'before' | 'after' | 'startOffset'>): LocatedQuote | null {
  const body = normalizeLocatorText(source)
  const quote = normalizeLocatorText(marker.quote || '')
  if (!quote) return null
  const candidates: number[] = []
  let cursor = 0
  while (cursor <= body.length - quote.length) {
    const found = body.indexOf(quote, cursor)
    if (found < 0) break
    candidates.push(found)
    cursor = found + 1
  }
  if (candidates.length === 1) return { start: candidates[0], end: candidates[0] + quote.length }
  if (candidates.length === 0) return null

  const expectedBefore = normalizeLocatorText(marker.before || '').slice(-100)
  const expectedAfter = normalizeLocatorText(marker.after || '').slice(0, 100)
  const scored = candidates.map((start) => {
    const actualBefore = body.slice(Math.max(0, start - expectedBefore.length - 1), start).trimEnd()
    const actualAfter = body.slice(start + quote.length, start + quote.length + expectedAfter.length + 1).trimStart()
    let beforeMatch = 0
    while (beforeMatch < expectedBefore.length && beforeMatch < actualBefore.length
      && expectedBefore[expectedBefore.length - 1 - beforeMatch] === actualBefore[actualBefore.length - 1 - beforeMatch]) beforeMatch += 1
    let afterMatch = 0
    while (afterMatch < expectedAfter.length && afterMatch < actualAfter.length
      && expectedAfter[afterMatch] === actualAfter[afterMatch]) afterMatch += 1
    return { start, score: beforeMatch + afterMatch }
  }).sort((a, b) => b.score - a.score)

  const best = scored[0]
  const next = scored[1]
  const offsetMatches = marker.startOffset === best.start
  const hasStrongContext = best.score >= 20 && (!next || best.score - next.score >= 8)
  if (offsetMatches && best.score >= 8) return { start: best.start, end: best.start + quote.length }
  if (hasStrongContext) return { start: best.start, end: best.start + quote.length }
  return null
}
