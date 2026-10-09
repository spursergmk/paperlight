import { useCallback, useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { EpubBook } from '../lib/epub'
import { useFlowReader, type FlowReaderApi, type FlowScrollState } from './useFlowReader'
import InputMarkerOverlay from './InputMarkerOverlay'
import type { InputMarker } from '../types'

// Renders one EPUB chapter. The XHTML is sanitized with DOMPurify and appended
// as DOM nodes (never as an HTML string), then its images are pointed at blob
// URLs taken from the book archive. The book's own CSS is deliberately not
// applied, so every book keeps the reader's typography and the app's own styles
// cannot be broken by a hostile stylesheet.

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp',
  'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
]

export default function EpubReader({
  book,
  chapterIndex,
  zoom,
  restoreRatio,
  onScrollPosition,
  onProgress,
  onSelectionPointerUp,
  onSelectionKeyUp,
  onUserScroll,
  apiRef,
  onNextChapter,
  inputMarkers,
}: {
  book: EpubBook
  chapterIndex: number
  zoom: number
  restoreRatio: number
  onScrollPosition: (state: FlowScrollState) => void
  onProgress: (state: FlowScrollState) => void
  onSelectionPointerUp: () => void
  onSelectionKeyUp: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onUserScroll: () => void
  apiRef: React.RefObject<FlowReaderApi | null>
  onNextChapter: () => void
  inputMarkers: InputMarker[]
}) {
  const chapter = book.chapters[chapterIndex]
  const pageRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const contentKey = `${chapter?.path ?? 'none'}#${chapterIndex}`

  const { scrollRef, handleScroll, api } = useFlowReader({
    contentKey,
    restoreRatio,
    onScrollPosition,
    onUserScroll,
    onProgress,
  })

  useEffect(() => { apiRef.current = api }, [api, apiRef])

  useEffect(() => {
    const container = bodyRef.current
    if (!container || !chapter) return
    let cancelled = false
    setStatus('loading')
    setError('')

    const render = async () => {
      const clean = DOMPurify.sanitize(chapter.html, {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS,
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'id', 'class', 'lang', 'xml:lang'],
        FORBID_TAGS: ['style', 'link', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'video', 'audio'],
        FORBID_ATTR: ['style', 'onerror', 'onload', 'srcset'],
        ALLOW_DATA_ATTR: false,
      }) as unknown as DocumentFragment

      // Resolve images (and SVG references) against the book archive.
      const images = Array.from(clean.querySelectorAll('img'))
      for (const image of images) {
        const source = image.getAttribute('src') || ''
        if (!source) {
          image.remove()
          continue
        }
        try {
          const url = await book.assetUrl(chapter.path, source)
          if (cancelled) return
          if (url) image.setAttribute('src', url)
          else image.remove()
        } catch {
          image.remove()
        }
        image.removeAttribute('loading')
      }

      // External links open in the user's browser, never inside the reader.
      for (const anchor of Array.from(clean.querySelectorAll('a'))) {
        const href = anchor.getAttribute('href') || ''
        if (/^[a-z]+:/i.test(href) && !/^javascript:/i.test(href)) {
          anchor.setAttribute('target', '_blank')
          anchor.setAttribute('rel', 'noreferrer noopener')
        } else if (href) {
          anchor.removeAttribute('href')
        }
      }

      if (cancelled) return
      container.replaceChildren(clean)
      setStatus('ready')
    }

    void render().catch((reason) => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : '这一章无法显示。')
      setStatus('error')
    })

    return () => {
      cancelled = true
      container.replaceChildren()
    }
  }, [book, chapter, contentKey])

  // Reaching the end of a chapter offers the next one.
  const handleChapterScroll = useCallback(() => {
    handleScroll()
  }, [handleScroll])

  return (
    <div
      className="reader-scroll flow-scroll"
      ref={scrollRef}
      onScroll={handleChapterScroll}
      onMouseUp={onSelectionPointerUp}
      onKeyUp={onSelectionKeyUp}
    >
      <article className="flow-page epub-page" ref={pageRef} data-page-number={chapterIndex + 1} style={{ fontSize: `${16 * zoom}px` }}>
        {status === 'loading' && <div className="flow-loading"><span className="mini-spinner" /> 正在排版本章…</div>}
        {status === 'error' && <div className="flow-error">{error}</div>}
        <div ref={bodyRef} className="epub-body" />
        <InputMarkerOverlay containerRef={pageRef} contentRef={bodyRef} markers={inputMarkers} />
        {status === 'ready' && (
          <div className="epub-chapter-end">
            {chapterIndex + 1 < book.chapters.length
              ? <button type="button" className="secondary-button" onClick={onNextChapter}>下一章：{book.chapters[chapterIndex + 1].title}</button>
              : <span className="epub-finished">全书读完</span>}
          </div>
        )}
      </article>
    </div>
  )
}
