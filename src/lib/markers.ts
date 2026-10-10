import type { InputMarker } from '../types'

export interface LocatedQuote {
  start: number
  end: number
}

export function normalizeLocatorText(value: string): string {
  return value.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

function normalizedTextWithOffsets(raw: string): { text: string; offsets: number[] } {
  let text = ''
  const offsets: number[] = []
  let whitespace = false
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '\u200b' || character === '\ufeff') continue
    if (/\s/.test(character)) {
      if (!text || whitespace) continue
      text += ' '
      offsets.push(index)
      whitespace = true
      continue
    }
    text += character
    offsets.push(index)
    whitespace = false
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    offsets.pop()
  }
  return { text, offsets }
}

/** Finds the verified quote as a DOM range, preserving offsets across text nodes. */
export function markerRangeInElement(
  root: HTMLElement,
  marker: Pick<InputMarker, 'quote' | 'before' | 'after' | 'startOffset'>,
): Range | null {
  const nodes: Text[] = []
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('.input-marker-overlay, script, style, [aria-hidden="true"]')) return 2
      return 1
    },
  })
  let current: Node | null
  while ((current = walker.nextNode())) nodes.push(current as Text)
  if (!nodes.length) return null

  const pdfTextLayer = Boolean(root.closest('.textLayer'))
  const rawOffsets: Array<{ node: Text; offset: number }> = []
  let raw = ''
  let previousParent: Element | null = null
  for (const node of nodes) {
    const value = node.nodeValue || ''
    if (pdfTextLayer && previousParent && previousParent !== node.parentElement && raw && !/\s$/.test(raw) && !/^\s/.test(value)) {
      raw += ' '
      rawOffsets.push({ node, offset: 0 })
    }
    for (let offset = 0; offset < value.length; offset += 1) {
      raw += value[offset]
      rawOffsets.push({ node, offset })
    }
    previousParent = node.parentElement
  }
  const normalized = normalizedTextWithOffsets(raw)
  const located = locateMarkerQuote(normalized.text, marker)
  if (!located) return null
  const rawStart = normalized.offsets[located.start]
  const rawEnd = normalized.offsets[located.end - 1]
  const start = rawStart === undefined ? null : rawOffsets[rawStart]
  const end = rawEnd === undefined ? null : rawOffsets[rawEnd]
  if (!start || !end) return null
  const range = root.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset + 1)
  return range
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
