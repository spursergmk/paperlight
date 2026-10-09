import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdf } from './pdf'
import { parsePrintedTocLine } from './pdfToc'

// Loaded PDF documents are cached by key and reference counted, so switching
// tabs, reopening the same file or restoring a session never re-parses a file
// that is already in memory.

interface CacheEntry {
  promise: Promise<PDFDocumentProxy>
  refs: number
}

const cache = new Map<string, CacheEntry>()

// Per-page geometry learned while rendering. Keeping it per document key means
// switching tabs (which remounts the page stack) or restoring a session does not
// have to assume every page has page 1's size.
const ratios = new Map<string, Map<number, number>>()

export function learnedRatios(key: string, pageCount: number, fallback: number): number[] {
  const known = key ? ratios.get(key) : undefined
  return Array.from({ length: pageCount }, (_, index) => known?.get(index) ?? fallback)
}

export function rememberRatio(key: string, index: number, ratio: number): void {
  if (!key || !Number.isFinite(ratio) || ratio <= 0.1 || ratio >= 10) return
  const entry = ratios.get(key) ?? new Map<number, number>()
  if (entry.get(index) === ratio) return
  entry.set(index, ratio)
  ratios.set(key, entry)
}

export function forgetRatios(key: string): void {
  ratios.delete(key)
}

export function documentKeyFor(path: string, name: string): string {
  if (path) return `path:${path}`
  return `name:${name}`
}

export function acquireDocument(
  key: string,
  loader: (onProgress: (ratio: number) => void) => Promise<Uint8Array>,
  onProgress?: (ratio: number) => void,
): Promise<PDFDocumentProxy> {
  const existing = cache.get(key)
  if (existing) {
    existing.refs += 1
    return existing.promise
  }
  const entry: CacheEntry = { refs: 1, promise: null as unknown as Promise<PDFDocumentProxy> }
  entry.promise = loader((ratio) => onProgress?.(ratio)).then((bytes) => openPdf(bytes, onProgress))
  entry.promise.catch(() => {
    // A failed load must not poison the cache.
    if (cache.get(key) === entry) cache.delete(key)
  })
  cache.set(key, entry)
  return entry.promise
}

function closeDocument(pdf: PDFDocumentProxy): void {
  // pdf.js v6 shares worker-level and static state (font metrics, text-layer
  // canvases) and `loadingTask.destroy()` terminates the worker itself, so any
  // per-document teardown while other documents are open risks breaking them —
  // `cleanup()` can even reject with "page is currently rendering". Therefore:
  // closing a tab just drops our reference, and the worker is fully torn down
  // when the last document closes, which reclaims everything at once.
  if (cache.size > 0) return
  void pdf.loadingTask?.destroy().catch(() => undefined)
}

export function releaseDocument(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  cache.delete(key)
  void entry.promise.then(closeDocument).catch(() => undefined)
}

export interface DocumentOutlineItem {
  title: string
  dest?: unknown
  /** Physical PDF page resolved from a printed contents page when no outline exists. */
  pageNumber?: number
  /** Printed page number is approximate when the PDF does not expose page labels. */
  estimatedPage?: boolean
  items?: DocumentOutlineItem[]
}

export interface DocumentMeta {
  pageCount: number
  basePageWidth: number
  firstPageRatio: number
  outline: DocumentOutlineItem[]
}

async function pdfPageTextLines(pdf: PDFDocumentProxy, pageNumber: number): Promise<string[]> {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  const rows: Array<{ y: number; items: Array<{ x: number; right: number; text: string }> }> = []
  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str.trim()) continue
    const item = raw as { str: string; transform?: number[]; width?: number }
    const x = item.transform?.[4] ?? 0
    const y = item.transform?.[5] ?? 0
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < 2.5)
    if (!row) {
      row = { y, items: [] }
      rows.push(row)
    }
    row.items.push({ x, right: x + (item.width || 0), text: item.str })
  }
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x)
    let line = ''
    let previousRight = -Infinity
    for (const item of row.items) {
      const gap = item.x - previousRight
      if (line && gap > 3) line += ' '
      line += item.text
      previousRight = Math.max(previousRight, item.right)
    }
    return { line: line.trim(), y: row.y }
  }).filter((item) => item.line).map((item) => item)
    .sort((a, b) => b.y - a.y)
    .map((item) => item.line)
}

async function detectPrintedContents(pdf: PDFDocumentProxy): Promise<DocumentOutlineItem[]> {
  const lastScanPage = Math.min(pdf.numPages, 12)
  let contentsPage = 0
  let contentsLines: string[] = []
  for (let pageNumber = 1; pageNumber <= lastScanPage; pageNumber += 1) {
    const lines = await pdfPageTextLines(pdf, pageNumber)
    if (lines.some((line) => /^(?:table\s+of\s+contents|contents|contents\s+page|目录)(?:\s|$)/i.test(line.trim()))) {
      contentsPage = pageNumber
      contentsLines = lines
      break
    }
  }
  if (!contentsPage) return []

  const labels = await pdf.getPageLabels().catch(() => null)
  const items: DocumentOutlineItem[] = []
  let emptyPages = 0
  for (let pageNumber = contentsPage; pageNumber <= Math.min(pdf.numPages, contentsPage + 12); pageNumber += 1) {
    const lines = pageNumber === contentsPage ? contentsLines : await pdfPageTextLines(pdf, pageNumber)
    const headingIndex = pageNumber === contentsPage
      ? lines.findIndex((line) => /^(?:table\s+of\s+contents|contents|contents\s+page|目录)(?:\s|$)/i.test(line.trim()))
      : -1
    const candidates = lines.slice(headingIndex + 1).map(parsePrintedTocLine).filter((item): item is NonNullable<typeof item> => Boolean(item))
    if (candidates.length === 0) {
      if (items.length > 0) break
      emptyPages += 1
      if (emptyPages > 1) break
      continue
    }
    emptyPages = 0
    for (const candidate of candidates) {
      const printed = candidate.printedPage
      let resolvedPage: number | undefined
      if (labels) {
        const exact = labels.findIndex((label) => label.toLowerCase() === printed.toLowerCase())
        if (exact >= 0) resolvedPage = exact + 1
      }
      if (resolvedPage === undefined && !labels && /^\d+$/.test(printed)) resolvedPage = Number(printed)
      if (!resolvedPage || resolvedPage > pdf.numPages) continue
      items.push({
        title: candidate.title,
        pageNumber: resolvedPage,
        estimatedPage: !labels,
      })
    }
  }
  return items
}

export async function readDocumentMeta(pdf: PDFDocumentProxy): Promise<DocumentMeta> {
  const [firstPage, outline] = await Promise.all([
    pdf.getPage(1),
    pdf.getOutline().catch(() => null),
  ])
  const nativeOutline = (outline || []) as DocumentOutlineItem[]
  const recognizedOutline = nativeOutline.length > 0 ? nativeOutline : await detectPrintedContents(pdf)
  const viewport = firstPage.getViewport({ scale: 1 })
  return {
    pageCount: pdf.numPages,
    basePageWidth: viewport.width,
    firstPageRatio: viewport.width / viewport.height,
    outline: recognizedOutline,
  }
}
