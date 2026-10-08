import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { PAGE_CAPTION } from '../lib/pagelayout'

// One page of the document. Mounting and unmounting is driven by the caller
// (PageStack only mounts the pages around the viewport), so this component just
// paints the canvas, the selectable text layer and its loading/error states.
//
// pdf.js streams the page's text content from a worker; that stream can stall
// (observed intermittently in Electron). A stalled stream must never leave a
// rendered page hidden behind a spinner, so the text layer gets a timeout and a
// retry, and the page degrades to "canvas only, selectable text unavailable"
// with an explicit way out.

const TEXT_LAYER_TIMEOUT_MS = 8000
const AUTO_RETRIES = 1

type PagePhase = 'loading' | 'ready' | 'no-text' | 'error'

interface PDFPageProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  /** Rendered width in CSS pixels; the page's own scale is derived from it. */
  width: number
  reservedHeight: number
  onRatio: (pageNumber: number, ratio: number) => void
  /** Last-resort recovery: rebuild the whole document (fresh worker). */
  onReloadDocument: () => void
}

export default function PDFPage({
  pdf, pageNumber, width, reservedHeight, onRatio, onReloadDocument,
}: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<PagePhase>('loading')
  const [renderError, setRenderError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const autoRetries = useRef(0)
  // pdf.js refuses to paint onto a canvas whose render task was replaced, and an
  // in-flight task must therefore be settled before this one reuses the canvas.
  const pendingRender = useRef<Promise<unknown> | null>(null)

  useEffect(() => {
    if (width <= 0) return
    let cancelled = false
    let renderTask: ReturnType<PDFPageProxy['render']> | undefined
    let textLayer: { render(): Promise<void>; cancel(): void } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    autoRetries.current = 0

    async function renderPage() {
      const canvas = canvasRef.current
      const textContainer = textLayerRef.current
      if (!canvas || !textContainer) return
      try {
        setPhase('loading')
        setRenderError('')
        if (pendingRender.current) {
          await pendingRender.current.catch(() => undefined)
          pendingRender.current = null
        }
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        // Scale from this page's own width: pages in one PDF can differ (fold-outs,
        // landscape inserts), and using page 1's width would clip them and
        // misalign their text layer.
        const intrinsicWidth = page.getViewport({ scale: 1 }).width
        const pageScale = intrinsicWidth > 0 ? width / intrinsicWidth : 1
        const viewport = page.getViewport({ scale: pageScale })
        onRatio(pageNumber, viewport.width / viewport.height)

        // Cap the backing store: on a 3x display a full-page canvas at native
        // resolution costs far more memory than it is worth while scrolling.
        const outputScale = Math.min(window.devicePixelRatio || 1, 2)
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) return
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        textContainer.style.width = `${Math.floor(viewport.width)}px`
        textContainer.style.height = `${Math.floor(viewport.height)}px`
        textContainer.style.setProperty('--scale-factor', String(pageScale))
        textContainer.replaceChildren()
        renderTask = page.render({
          canvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        })
        await renderTask.promise
        if (cancelled) return

        const { TextLayer } = await import('pdfjs-dist/legacy/build/pdf.mjs')
        if (cancelled) return
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textContainer,
          viewport,
        })
        await Promise.race([
          textLayer.render(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('paperlight:text-layer-timeout')), TEXT_LAYER_TIMEOUT_MS)
          }),
        ])
        if (cancelled) return
        setPhase('ready')
      } catch (error) {
        if (cancelled) return
        const timedOut = error instanceof Error && error.message === 'paperlight:text-layer-timeout'
        if (timedOut) {
          textLayer?.cancel()
          // The page itself is fine; give the stream one more chance, then let the
          // reader keep the canvas and offer an explicit retry.
          if (autoRetries.current < AUTO_RETRIES) {
            autoRetries.current += 1
            setAttempt((value) => value + 1)
            return
          }
          setPhase('no-text')
          return
        }
        if (!(error instanceof Error && error.name === 'RenderingCancelledException')) {
          console.error(`Could not render PDF page ${pageNumber}`, error)
          setRenderError(error instanceof Error ? error.message : String(error))
          setPhase('error')
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    void renderPage()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      renderTask?.cancel()
      textLayer?.cancel()
      // Remember the cancelled task instead of clearing the canvas: zeroing the
      // backing store while pdf.js is still painting raises UnknownVizError.
      // React removes the canvas element on unmount, which frees the bitmap.
      pendingRender.current = renderTask ? renderTask.promise.catch(() => undefined) : null
      textLayerRef.current?.replaceChildren()
    }
  }, [attempt, onRatio, pageNumber, pdf, width])

  const retryPage = useCallback(() => {
    autoRetries.current = 0
    setAttempt((value) => value + 1)
  }, [])

  const innerHeight = Math.max(120, reservedHeight - PAGE_CAPTION)

  return (
    <article className="pdf-page-shell" data-page-number={pageNumber}>
      <div className="pdf-page" style={{ width: `${width}px`, height: `${innerHeight}px` }}>
        {/* A fresh element per render: pdf.js paints asynchronously and refuses a
            canvas that another render task touched, which surfaced as
            UnknownVizError when zooming or switching tabs mid-render. */}
        <canvas
          key={`${pageNumber}-${attempt}-${Math.round(width)}`}
          ref={canvasRef}
          aria-label={`PDF 第 ${pageNumber} 页`}
        />
        <div className="textLayer" ref={textLayerRef} />
        {phase === 'loading' && <div className="page-loading"><span className="mini-spinner" /> 正在载入第 {pageNumber} 页</div>}
        {phase === 'no-text' && (
          <div className="page-no-text" role="status">
            <span>文字层未就绪（本页仍可阅读，但暂时不能选词）</span>
            <button type="button" className="page-retry" onClick={retryPage}>重试</button>
            <button type="button" className="page-reload" onClick={onReloadDocument}>重新载入文档</button>
          </div>
        )}
        {phase === 'error' && (
          <div className="page-error">
            <span>第 {pageNumber} 页无法渲染</span>
            <span className="page-error-detail">{renderError}</span>
            <button type="button" onClick={retryPage}>重试</button>
          </div>
        )}
      </div>
      <div className="page-caption">{pageNumber}</div>
    </article>
  )
}
