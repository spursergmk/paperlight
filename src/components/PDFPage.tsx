import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

interface PDFPageProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  onVisible: (pageNumber: number) => void
}

export default function PDFPage({ pdf, pageNumber, scale, onVisible }: PDFPageProps) {
  const shellRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [inRange, setInRange] = useState(pageNumber === 1)
  const [ratio, setRatio] = useState(0.77)
  const [rendered, setRendered] = useState(false)
  const [renderError, setRenderError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const observer = new IntersectionObserver(
      ([entry]) => setInRange(entry.isIntersecting),
      { root: document.querySelector('.reader-scroll'), rootMargin: '1000px 0px' },
    )
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onVisible(pageNumber)
    }, { root: document.querySelector('.reader-scroll'), threshold: 0.48 })
    observer.observe(shell)
    return () => observer.disconnect()
  }, [onVisible, pageNumber])

  useEffect(() => {
    if (!inRange) {
      if (canvasRef.current) {
        canvasRef.current.width = 0
        canvasRef.current.height = 0
      }
      textLayerRef.current?.replaceChildren()
      setPageSize(null)
      setRendered(false)
      return
    }
    if (!canvasRef.current || !textLayerRef.current) return
    let cancelled = false
    let renderTask: ReturnType<PDFPageProxy['render']> | undefined
    let textLayer: { render(): Promise<void>; cancel(): undefined } | undefined

    async function renderPage() {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        setRatio(viewport.width / viewport.height)
        setPageSize({ width: viewport.width, height: viewport.height })

        const canvas = canvasRef.current
        const textContainer = textLayerRef.current
        if (!canvas || !textContainer) return
        const outputScale = window.devicePixelRatio || 1
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) return
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        textContainer.style.width = `${Math.floor(viewport.width)}px`
        textContainer.style.height = `${Math.floor(viewport.height)}px`
        textContainer.style.setProperty('--scale-factor', String(scale))
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
        await textLayer.render()
        if (!cancelled) setRendered(true)
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
          console.error(`Could not render PDF page ${pageNumber}`, error)
          setRenderError(error instanceof Error ? error.message : String(error))
        }
      }
    }

    setRendered(false)
    setRenderError('')
    void renderPage()
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      if (canvasRef.current) {
        canvasRef.current.width = 0
        canvasRef.current.height = 0
      }
      textLayerRef.current?.replaceChildren()
    }
  }, [attempt, inRange, pageNumber, pdf, scale])

  const width = pageSize?.width ?? Math.max(200, (document.querySelector('.reader-scroll')?.clientWidth ?? 840) - 92)
  const height = pageSize?.height ?? width / ratio

  return (
    <article className="pdf-page-shell" ref={shellRef} data-page-number={pageNumber} style={{ minHeight: `${height}px` }}>
      <div className="pdf-page" style={{ width: `${width}px`, height: `${height}px` }}>
        <canvas ref={canvasRef} aria-label={`PDF 第 ${pageNumber} 页`} />
        <div className="textLayer" ref={textLayerRef} />
        {!rendered && (renderError
          ? <div className="page-error">
            <span>第 {pageNumber} 页无法渲染</span>
            <span className="page-error-detail">{renderError}</span>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          </div>
          : <div className="page-loading"><span className="mini-spinner" /> 正在载入第 {pageNumber} 页</div>)}
      </div>
      <div className="page-caption">{pageNumber}</div>
    </article>
  )
}
