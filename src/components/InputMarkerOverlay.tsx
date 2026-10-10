import { useEffect, useState, type RefObject } from 'react'
import type { InputMarker } from '../types'
import { markerRangeInElement } from '../lib/markers'

interface OverlayRect {
  markerId: string
  style: 'highlight' | 'underline'
  title: string
  left: number
  top: number
  width: number
  height: number
}

export default function InputMarkerOverlay({
  containerRef, contentRef, markers,
}: {
  containerRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  markers: InputMarker[]
}) {
  const [rects, setRects] = useState<OverlayRect[]>([])
  const [unresolved, setUnresolved] = useState(0)

  useEffect(() => {
    if (!markers.some((marker) => marker.visualStyle && marker.quote)) {
      setRects([])
      setUnresolved(0)
      return
    }
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return
    let frame = 0
    let fallbackTimer = 0
    const draw = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = 0
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
      fallbackTimer = 0
      const containerRect = container.getBoundingClientRect()
      const next: OverlayRect[] = []
      let missing = 0
      for (const marker of markers) {
        if (!marker.visualStyle || !marker.quote) continue
        const range = markerRangeInElement(content, marker)
        if (!range) { missing += 1; continue }
        const positions = Array.from(range.getClientRects())
        if (!positions.length) { missing += 1; continue }
        for (const rect of positions) {
          const left = rect.left - containerRect.left
          const top = rect.top - containerRect.top
          const width = rect.width
          const height = rect.height
          if (width <= 0 || height <= 0) continue
          next.push({
            markerId: marker.id,
            style: marker.visualStyle,
            title: marker.comment || (marker.purpose === 'form' ? '形式标记' : '内容标记'),
            left, top, width, height,
          })
        }
      }
      setRects((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      setUnresolved((previous) => previous === missing ? previous : missing)
    }
    const schedule = () => {
      if (frame) window.cancelAnimationFrame(frame)
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
      frame = window.requestAnimationFrame(draw)
      // WebKit may pause animation frames while a window is backgrounded.
      // Keep a timer fallback so saved source marks still resolve after reopen.
      fallbackTimer = window.setTimeout(draw, 120)
    }
    schedule()
    const mutation = new MutationObserver(schedule)
    mutation.observe(content, { subtree: true, childList: true, characterData: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(container)
    resize.observe(content)
    window.addEventListener('resize', schedule)
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', schedule)
    return () => {
      mutation.disconnect()
      resize.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', schedule)
      if (frame) window.cancelAnimationFrame(frame)
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
    }
  }, [containerRef, contentRef, markers])

  if (!markers.some((marker) => marker.visualStyle && marker.quote)) return null
  return <div className="input-marker-overlay" aria-hidden="true" data-rendered-rects={rects.length} data-unresolved-count={unresolved}>
    {rects.map((rect, index) => <span
      key={`${rect.markerId}-${index}`}
      className={`input-marker-visual ${rect.style}`}
      data-marker-id={rect.markerId}
      title={rect.title}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    />)}
    {unresolved > 0 && <span className="input-marker-unresolved">{unresolved} 条标记无法可靠定位</span>}
  </div>
}
