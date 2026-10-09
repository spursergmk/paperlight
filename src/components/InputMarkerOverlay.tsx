import { useEffect, useState, type RefObject } from 'react'
import type { InputMarker } from '../types'
import { locateMarkerQuote } from '../lib/markers'

interface OverlayRect {
  markerId: string
  style: 'highlight' | 'underline'
  title: string
  left: number
  top: number
  width: number
  height: number
}

function normalizedTextWithOffsets(raw: string): { text: string; offsets: number[] } {
  let text = ''
  const offsets: number[] = []
  let whitespace = false
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '\u200b' || character === '\ufeff') continue
    if (/\s/.test(character)) {
      if (!text || whitespace) continue
      text += ' '
      offsets.push(index)
      whitespace = true
      continue
    }
    text += character
    offsets.push(index)
    whitespace = false
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    offsets.pop()
  }
  return { text, offsets }
}

function pointAt(nodes: Text[], offset: number): { node: Text; offset: number } | null {
  let walked = 0
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const end = walked + (node.nodeValue?.length || 0)
    // At a text-node boundary, start in the following node. A DOM Range that
    // starts at the end of the preceding block can span different list or
    // paragraph containers and may report no client rects in WebKit.
    if (offset < end || (offset === end && index === nodes.length - 1)) {
      return { node, offset: Math.max(0, offset - walked) }
    }
    walked = end
  }
  return null
}

function markerRange(root: HTMLElement, marker: InputMarker): Range | null {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('.input-marker-overlay, script, style, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let current: Node | null
  while ((current = walker.nextNode())) nodes.push(current as Text)
  if (!nodes.length) return null

  const raw = nodes.map((node) => node.nodeValue || '').join('')
  const normalized = normalizedTextWithOffsets(raw)
  const located = locateMarkerQuote(normalized.text, marker)
  if (!located) return null
  const rawStart = normalized.offsets[located.start]
  const rawEnd = normalized.offsets[located.end - 1]
  if (rawStart === undefined || rawEnd === undefined) return null
  const start = pointAt(nodes, rawStart)
  const end = pointAt(nodes, rawEnd + 1)
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
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
    const draw = () => {
      frame = 0
      const containerRect = container.getBoundingClientRect()
      const next: OverlayRect[] = []
      let missing = 0
      for (const marker of markers) {
        if (!marker.visualStyle || !marker.quote) continue
        const range = markerRange(content, marker)
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
      frame = window.requestAnimationFrame(draw)
    }
    schedule()
    const mutation = new MutationObserver(schedule)
    mutation.observe(content, { subtree: true, childList: true, characterData: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(container)
    resize.observe(content)
    window.addEventListener('resize', schedule)
    return () => {
      mutation.disconnect()
      resize.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [containerRef, contentRef, markers])

  if (!markers.some((marker) => marker.visualStyle && marker.quote)) return null
  return <div className="input-marker-overlay" aria-hidden="true">
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
