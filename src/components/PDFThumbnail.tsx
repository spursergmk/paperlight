import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

export default function PDFThumbnail({ pdf, pageNumber, active, onClick }: {
  pdf: PDFDocumentProxy
  pageNumber: number
  active: boolean
  onClick: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const button = buttonRef.current
    if (!button) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: document.querySelector('.thumbnail-list'),
      rootMargin: '300px 0px',
    })
    observer.observe(button)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let renderTask: RenderTask | undefined
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        const canvas = canvasRef.current
        const context = canvas?.getContext('2d', { alpha: false })
        if (!canvas || !context || cancelled) return
        const viewport = page.getViewport({ scale: 0.2 })
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        renderTask = page.render({ canvas, viewport })
        await renderTask.promise
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
          console.warn(`Could not create thumbnail for page ${pageNumber}`, error)
        }
      }
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
      if (canvasRef.current) {
        canvasRef.current.width = 0
        canvasRef.current.height = 0
      }
    }
  }, [pageNumber, pdf, visible])

  return (
    <button ref={buttonRef} className={`thumbnail-item${active ? ' active' : ''}`} onClick={onClick}>
      <span className="thumbnail-paper"><canvas ref={canvasRef} /></span>
      <span className="thumbnail-page-label">{pageNumber}</span>
    </button>
  )
}
