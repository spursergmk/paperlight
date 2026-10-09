import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface FlowScrollState {
  scrollTop: number
  /** 0..1 progress through the scrollable content. */
  ratio: number
}

export interface FlowReaderApi {
  scrollToTop: () => void
  scrollToAnchor: (anchorId: string) => void
  scrollToBlock?: (blockIndex: number) => void
  scrollBy: (delta: number) => void
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Scroll bookkeeping shared by the reflowing readers (plain text / Markdown and
 * EPUB chapters). Reflowed content has no fixed pages, so position is restored
 * from a ratio of the scrollable height and reported back the same way; that
 * survives window and splitter resizes, which change the content height.
 */
export function useFlowReader({
  contentKey,
  restoreRatio,
  onScrollPosition,
  onUserScroll,
  onProgress,
}: {
  /** Changing this restores the saved position (new document or new chapter). */
  contentKey: string
  restoreRatio: number
  onScrollPosition: (state: FlowScrollState) => void
  onUserScroll: () => void
  onProgress?: (state: FlowScrollState) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const restoreRef = useRef(restoreRatio)
  const [progress, setProgress] = useState(0)

  restoreRef.current = restoreRatio

  const measure = useCallback((): FlowScrollState => {
    const element = scrollRef.current
    if (!element) return { scrollTop: 0, ratio: 0 }
    const max = element.scrollHeight - element.clientHeight
    return {
      scrollTop: element.scrollTop,
      ratio: max > 4 ? clamp01(element.scrollTop / max) : 0,
    }
  }, [])

  // Restore after the content has been laid out (the reader body may be filled
  // imperatively, so a frame of delay is needed before scrollHeight is real).
  useLayoutEffect(() => {
    const apply = () => {
      const element = scrollRef.current
      if (!element) return
      const max = element.scrollHeight - element.clientHeight
      element.scrollTop = max > 4 ? Math.round(max * clamp01(restoreRef.current)) : 0
      const state = measure()
      setProgress(state.ratio)
      onProgress?.(state)
    }
    const frame = window.requestAnimationFrame(apply)
    return () => window.cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    element.dataset.scrolled = '1'
    const max = element.scrollHeight - element.clientHeight
    onScrollPosition({
      scrollTop: element.scrollTop,
      ratio: max > 4 ? clamp01(element.scrollTop / max) : 0,
    })
    onUserScroll()
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const state = measure()
      setProgress(state.ratio)
      onProgress?.(state)
    })
  }, [measure, onScrollPosition, onProgress, onUserScroll])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [])

  const api: FlowReaderApi = {
    scrollToTop: () => {
      const element = scrollRef.current
      if (element) element.scrollTo({ top: 0 })
    },
    scrollToAnchor: (anchorId: string) => {
      const element = scrollRef.current
      const target = element?.querySelector<HTMLElement>(`#${CSS.escape(anchorId)}`)
      if (element && target) element.scrollTop = Math.max(0, target.offsetTop - 16)
    },
    scrollBy: (delta: number) => {
      const element = scrollRef.current
      if (element) element.scrollBy({ top: delta })
    },
  }

  return { scrollRef, handleScroll, progress, api }
}
