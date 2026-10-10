import type { MarkdownBlock } from './textdoc'

export const DEFAULT_CONTEXT_LINES = 5
export const EXPANDED_CONTEXT_LINES = 12
export const MAX_QUERY_CONTEXT_CHARS = 5_000

export interface ContextWindow {
  text: string
  before: string
  selected: string
  after: string
  startLine: number
  endLine: number
}

function cleanLine(value: string): string {
  return value.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * A format adapter supplies stable source lines: PDF.js text lines for PDF,
 * or paragraphs/list items for reflowable formats. Visual soft wraps never
 * enter this function.
 */
export function contextFromLines(
  sourceLines: readonly string[],
  firstSelectedLine: number,
  lastSelectedLine = firstSelectedLine,
  beforeCount = DEFAULT_CONTEXT_LINES,
  afterCount = DEFAULT_CONTEXT_LINES,
): ContextWindow {
  const lines = sourceLines.map(cleanLine)
  if (lines.length === 0) return { text: '', before: '', selected: '', after: '', startLine: 0, endLine: 0 }
  const first = Math.max(0, Math.min(lines.length - 1, Math.floor(firstSelectedLine)))
  const last = Math.max(first, Math.min(lines.length - 1, Math.floor(lastSelectedLine)))
  const start = Math.max(0, first - Math.max(0, beforeCount))
  const end = Math.min(lines.length - 1, last + Math.max(0, afterCount))
  const before = lines.slice(start, first).filter(Boolean).join('\n')
  const selected = lines.slice(first, last + 1).filter(Boolean).join('\n')
  const after = lines.slice(last + 1, end + 1).filter(Boolean).join('\n')
  const text = [before, selected, after].filter(Boolean).join('\n').slice(0, MAX_QUERY_CONTEXT_CHARS)
  return { text, before, selected, after, startLine: start, endLine: end }
}

/** Build source lines from PDF.js's text items, honoring native hasEOL marks. */
export function pdfTextLines(items: readonly { str?: unknown; hasEOL?: unknown }[]): string[] {
  const lines: string[] = []
  let current = ''
  for (const item of items) {
    if (typeof item.str === 'string') current += item.str
    if (item.hasEOL === true) {
      lines.push(current)
      current = ''
    }
  }
  if (current || lines.length === 0) lines.push(current)
  return lines
}

export function textForMarkdownBlock(block: MarkdownBlock): string {
  if (block.type === 'list') return block.items.join('\n')
  if (block.type === 'code') return block.code
  if (block.type === 'rule') return ''
  return block.text
}

/**
 * TXT and Markdown do not have a stable visual line after reflow. Their source
 * units are paragraphs, headings, quotes, code blocks, and list items, so use
 * those units as the context lines.
 */
export function contextFromBlocks(
  blocks: readonly string[],
  firstSelectedBlock: number,
  lastSelectedBlock = firstSelectedBlock,
  beforeCount = DEFAULT_CONTEXT_LINES,
  afterCount = DEFAULT_CONTEXT_LINES,
): ContextWindow {
  return contextFromLines(blocks, firstSelectedBlock, lastSelectedBlock, beforeCount, afterCount)
}

/** Select a hard-line window around a known text offset, without counting soft wraps. */
export function contextFromOffset(
  text: string,
  selectedText: string,
  offset = -1,
  beforeCount = DEFAULT_CONTEXT_LINES,
  afterCount = DEFAULT_CONTEXT_LINES,
): ContextWindow {
  const lines = text.split(/\r\n|\n|\r/u)
  const normalizedOffset = offset >= 0 ? Math.min(offset, text.length) : text.indexOf(selectedText)
  if (normalizedOffset < 0) return contextFromLines(lines, 0, 0, beforeCount, afterCount)
  let cursor = 0
  let firstLine = 0
  let lastLine = 0
  for (let index = 0; index < lines.length; index += 1) {
    const next = cursor + lines[index].length
    if (normalizedOffset >= cursor && normalizedOffset <= next) firstLine = index
    const selectedEnd = normalizedOffset + Math.max(0, selectedText.length)
    if (selectedEnd >= cursor && selectedEnd <= next + 1) {
      lastLine = index
      break
    }
    cursor = next + 1
    lastLine = index
  }
  return contextFromLines(lines, firstLine, lastLine, beforeCount, afterCount)
}

export interface StoredLanguageMatch {
  kind: 'semantic' | 'expression'
  text: string
  meaning: string
  start: number
  end: number
}

/** Exact local matching only; this deliberately makes no semantic inference. */
export function findStoredLanguageMatches(
  source: string,
  items: readonly { kind: StoredLanguageMatch['kind']; text: string; meaning: string }[],
): StoredLanguageMatch[] {
  const matches: StoredLanguageMatch[] = []
  const folded = source.toLocaleLowerCase()
  for (const item of items) {
    const term = item.text.trim()
    if (term.length < 2) continue
    const needle = term.toLocaleLowerCase()
    let from = 0
    while (from < folded.length) {
      const start = folded.indexOf(needle, from)
      if (start < 0) break
      const end = start + needle.length
      const wordLike = /^[\p{L}\p{N}'’-]/u.test(term[0]) && /[\p{L}\p{N}'’-]$/u.test(term.at(-1) || '')
      const before = start > 0 ? source[start - 1] : ''
      const after = end < source.length ? source[end] : ''
      const leftBoundary = !wordLike || !before || !/[\p{L}\p{N}'’-]/u.test(before)
      const rightBoundary = !wordLike || !after || !/[\p{L}\p{N}'’-]/u.test(after)
      if (leftBoundary && rightBoundary) matches.push({ kind: item.kind, text: term, meaning: item.meaning, start, end })
      from = Math.max(end, start + 1)
    }
  }
  return matches.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start))
}
