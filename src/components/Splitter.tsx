import { useCallback, useEffect, useRef, useState } from 'react'

// A draggable divider between two panes.
//
// The drag is driven by window-level pointer listeners while a drag is active:
// pointer capture is used when the browser allows it, but the movement maths
// does not depend on it, so a fast drag that leaves the 7px handle (or a
// synthesised pointer sequence) still resizes the panes reliably.
export default function Splitter({
  onDelta,
  onReset,
  label,
  min,
  max,
  value,
}: {
  onDelta: (delta: number, phase: 'move' | 'end') => void
  onReset: () => void
  label: string
  min: number
  max: number
  value: number
}) {
  const [dragging, setDragging] = useState(false)
  const lastX = useRef(0)
  const draggingRef = useRef(false)

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    lastX.current = event.clientX
    draggingRef.current = true
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers cannot be captured; window listeners cover that case.
    }
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const handleMove = (event: PointerEvent) => {
      if (!draggingRef.current) return
      const delta = event.clientX - lastX.current
      if (delta === 0) return
      lastX.current = event.clientX
      onDelta(delta, 'move')
    }
    const handleEnd = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      setDragging(false)
      onDelta(0, 'end')
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
    }
  }, [dragging, onDelta])

  const nudge = useCallback((delta: number) => onDelta(delta, 'end'), [onDelta])

  return (
    <div
      className={`splitter${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title={`${label}：拖动调整，双击恢复默认`}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(-16) }
        else if (event.key === 'ArrowRight') { event.preventDefault(); nudge(16) }
        else if (event.key === 'Enter') { event.preventDefault(); onReset() }
      }}
    >
      <span className="splitter-grip" />
    </div>
  )
}
