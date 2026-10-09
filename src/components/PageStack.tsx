import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PDFPage from './PDFPage'
import { buildLayout, currentPageFromScroll, renderWindow, scrollTopForPage } from '../lib/pagelayout'
import { learnedRatios, rememberRatio } from '../lib/documents'
import type { InputMarker } from '../types'

export interface PageStackApi {
  scrollToPage: (page: number) => void
  scrollTop: () => number
  width: () => number
}

interface PageStackProps {
  pdf: PDFDocumentProxy
  /** Cache key of the document; per-page geometry is remembered under it. */
  documentKey: string
  pageCount: number
  firstPageRatio: number
  zoom: number
  restoreScrollTop: number
  onScrollPosition: (scrollTop: number) => void
  onPageChange: (page: number) => void
  onSelectionPointerUp: () => void
  onSelectionKeyUp: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onUserScroll: () => void
  /** Rebuilds the document when a page's text layer cannot be recovered. */
  onReloadDocument: (automatic?: boolean) => boolean
  inputMarkers: InputMarker[]
  apiRef: React.RefObject<PageStackApi | null>
  children?: React.ReactNode
}

// Only pages inside a small window around the viewport are mounted. Placeholder
// slots keep the exact layout height, so the scrollbar is correct for a
// 350-page book while at most a handful of canvases exist at any time.
export default function PageStack({
  pdf,
  documentKey,
  pageCount,
  firstPageRatio,
  zoom,
  restoreScrollTop,
  onScrollPosition,
  onPageChange,
  onSelectionPointerUp,
  onSelectionKeyUp,
  onUserScroll,
  onReloadDocument,
  inputMarkers,
  apiRef,
  children,
}: PageStackProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const restoreRef = useRef(restoreScrollTop)
  const restoredRef = useRef(false)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerHeight, setContainerHeight] = useState(800)
  const [scrollTop, setScrollTop] = useState(restoreScrollTop)
  const [ratios, setRatios] = useState<number[]>(() => learnedRatios(documentKey, pageCount, firstPageRatio))

  restoreRef.current = restoreScrollTop

  // Measure before the first paint: the scroll offset can only be restored once
  // the real page width (and therefore the page geometry) is known.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    setContainerWidth(element.clientWidth)
    setContainerHeight(element.clientHeight)
  }, [])

  // A new document resets geometry (reusing anything already learned about it)
  // and waits for its own reading position.
  useLayoutEffect(() => {
    setRatios(learnedRatios(documentKey, pageCount, firstPageRatio))
    restoredRef.current = false
    setScrollTop(0)
  }, [documentKey, firstPageRatio, pageCount, pdf])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setContainerWidth(element.clientWidth)
      setContainerHeight(element.clientHeight)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const pageWidth = Math.max(220, Math.round(Math.max(containerWidth, 320) - 96) * zoom)
  const layout = useMemo(() => buildLayout(ratios, pageWidth), [pageWidth, ratios])

  // Restore the saved position exactly once per document, after layout is real.
  useLayoutEffect(() => {
    if (restoredRef.current || containerWidth <= 0) return
    const element = scrollRef.current
    if (!element) return
    restoredRef.current = true
    skipAnchorRef.current = true
    element.scrollTop = restoreRef.current || 0
    setScrollTop(element.scrollTop)
  }, [containerWidth, pageWidth])

  const currentPage = currentPageFromScroll(layout.boxes, scrollTop, containerHeight)
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  const recoverStalledPage = useCallback((pageNumber: number) => {
    if (pageNumber !== currentPageRef.current) return false
    return onReloadDocument(true)
  }, [onReloadDocument])
  const [windowStart, windowEnd] = renderWindow(pageCount, currentPage, 1)

  // Keep the reading position anchored across every layout change: a zoom step,
  // a window/splitter resize, or a page whose real size differs from the
  // placeholder (mixed-geometry PDFs) all move the boxes. Re-map the offset of
  // the page currently at the top of the viewport instead of keeping raw pixels.
  const previousLayoutRef = useRef(layout)
  const skipAnchorRef = useRef(false)
  useLayoutEffect(() => {
    const previous = previousLayoutRef.current
    previousLayoutRef.current = layout
    const element = scrollRef.current
    if (!element || !restoredRef.current || previous === layout) return
    if (skipAnchorRef.current) {
      skipAnchorRef.current = false
      return
    }
    if (previous.boxes.length !== layout.boxes.length) return
    const scroll = element.scrollTop
    let anchorIndex = 0
    for (const box of previous.boxes) {
      if (box.top <= scroll) anchorIndex = box.index
      else break
    }
    const before = previous.boxes[anchorIndex]
    const after = layout.boxes[anchorIndex]
    if (!before || !after) return
    const fraction = before.height > 0 ? Math.min(1, Math.max(0, (scroll - before.top) / before.height)) : 0
    const target = after.top + fraction * after.height
    const delta = target - scroll
    if (Math.abs(delta) > 1) {
      element.scrollTop = scroll + delta
      // Keep the derived page number in step with the adjusted offset, otherwise
      // a zoom or a late page-size correction reports a neighbouring page.
      setScrollTop(element.scrollTop)
    }
  }, [layout])

  useEffect(() => {
    onPageChange(currentPage)
  }, [currentPage, onPageChange])

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    onScrollPosition(element.scrollTop)
    onUserScroll()
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setScrollTop(element.scrollTop)
    })
  }, [onScrollPosition, onUserScroll])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [])

  const handleRatio = useCallback((pageNumber: number, ratio: number) => {
    const index = pageNumber - 1
    rememberRatio(documentKey, index, ratio)
    setRatios((previous) => {
      if (previous[index] === ratio) return previous
      const next = previous.slice()
      next[index] = ratio
      return next
    })
  }, [documentKey])

  const scrollToPage = useCallback((page: number) => {
    const element = scrollRef.current
    if (!element) return
    const top = scrollTopForPage(layout.boxes, page)
    element.scrollTop = top
    // Programmatic navigation does not reliably fire a scroll event before a
    // tab switch. Persist the position at the point where it is set so the
    // next mount restores the requested page instead of the previous anchor.
    onScrollPosition(top)
    setScrollTop(top)
  }, [layout.boxes, onScrollPosition])

  useEffect(() => {
    apiRef.current = {
      scrollToPage,
      scrollTop: () => scrollRef.current?.scrollTop ?? 0,
      width: () => scrollRef.current?.clientWidth ?? 0,
    }
    return () => { apiRef.current = null }
  }, [apiRef, scrollToPage])

  const pages = []
  for (let index = windowStart; index <= windowEnd; index += 1) {
    const box = layout.boxes[index]
    if (!box) continue
    pages.push(
      <div key={index} className="page-slot" style={{ top: `${box.top}px`, height: `${box.height}px` }}>
        <PDFPage
          pdf={pdf}
          pageNumber={index + 1}
          width={pageWidth}
          reservedHeight={box.height}
          onRatio={handleRatio}
          onReloadDocument={() => onReloadDocument(false)}
          onRecoverStalledPage={recoverStalledPage}
          inputMarkers={inputMarkers.filter((marker) => marker.pageNumber === index + 1 && Boolean(marker.visualStyle))}
        />
      </div>,
    )
  }

  return (
    <div
      className="reader-scroll"
      ref={scrollRef}
      onScroll={handleScroll}
      onMouseUp={onSelectionPointerUp}
      onKeyUp={onSelectionKeyUp}
    >
      <div className="pages-stack" style={{ height: `${layout.totalHeight}px` }}>
        {pages}
      </div>
      {children}
    </div>
  )
}
