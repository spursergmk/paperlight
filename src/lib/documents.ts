import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdf } from './pdf'

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
  dest: unknown
  items?: DocumentOutlineItem[]
}

export interface DocumentMeta {
  pageCount: number
  basePageWidth: number
  firstPageRatio: number
  outline: DocumentOutlineItem[]
}

export async function readDocumentMeta(pdf: PDFDocumentProxy): Promise<DocumentMeta> {
  const [firstPage, outline] = await Promise.all([
    pdf.getPage(1),
    pdf.getOutline().catch(() => null),
  ])
  const viewport = firstPage.getViewport({ scale: 1 })
  return {
    pageCount: pdf.numPages,
    basePageWidth: viewport.width,
    firstPageRatio: viewport.width / viewport.height,
    outline: (outline || []) as DocumentOutlineItem[],
  }
}
