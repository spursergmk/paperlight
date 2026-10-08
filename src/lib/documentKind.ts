// Which file types the reader can open, and how each one is rendered.
//
//   pdf   fixed pages rendered by pdf.js          (selectable when a text layer exists)
//   text  reflowed plain text / Markdown          (always selectable)
//   epub  reflowed book chapters (XHTML spine)    (always selectable)
//
// Everything else stays visible in the folder browser but is not openable.

export type DocumentKind = 'pdf' | 'text' | 'epub'

export const TEXT_EXTENSIONS = ['.txt', '.text', '.md', '.markdown', '.mdown'] as const

export const OPENABLE_EXTENSIONS = ['.pdf', '.epub', ...TEXT_EXTENSIONS] as const

export function documentKindFor(path: string): DocumentKind | null {
  const lower = (path || '').toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.epub')) return 'epub'
  if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'text'
  return null
}

export function isOpenablePath(path: string): boolean {
  return documentKindFor(path) !== null
}

export function isMarkdownPath(path: string): boolean {
  const lower = (path || '').toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdown')
}

export const KIND_LABELS: Record<DocumentKind, string> = {
  pdf: 'PDF',
  text: '文本',
  epub: 'EPUB',
}

/** Human label for the position indicator ("12 / 340" vs "第 3 章 / 12"). */
export function positionLabel(kind: DocumentKind, index: number, total: number): string {
  if (kind === 'epub') return `第 ${index} 章 / ${total}`
  if (kind === 'text') return '全文'
  return `${index} / ${total}`
}
