import { useEffect, useRef, useState } from 'react'
import { parseInline } from '../lib/textdoc'
import type { InlineToken, MarkdownBlock, TextOutlineItem } from '../lib/textdoc'
import { useFlowReader, type FlowReaderApi, type FlowScrollState } from './useFlowReader'

const INITIAL_BLOCKS = 220
const BLOCK_STEP = 220

function Inline({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        if (token.type === 'strong') return <strong key={index}>{token.text}</strong>
        if (token.type === 'em') return <em key={index}>{token.text}</em>
        if (token.type === 'code') return <code key={index}>{token.text}</code>
        if (token.type === 'link') {
          return (
            <a key={index} href={token.href} target="_blank" rel="noreferrer noopener">{token.text}</a>
          )
        }
        return <span key={index}>{token.text}</span>
      })}
    </>
  )
}

function Block({ block, index }: { block: MarkdownBlock; index: number }) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level))
      const Tag = `h${level}` as 'h1'
      return <Tag id={`flow-block-${index}`} className={`flow-heading flow-h${level}`}><Inline tokens={parseInline(block.text)} /></Tag>
    }
    case 'list':
      return block.ordered
        ? <ol className="flow-list">{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline tokens={parseInline(item)} /></li>)}</ol>
        : <ul className="flow-list">{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline tokens={parseInline(item)} /></li>)}</ul>
    case 'quote':
      return <blockquote className="flow-quote"><Inline tokens={parseInline(block.text)} /></blockquote>
    case 'code':
      return <pre className="flow-code" data-language={block.language || undefined}><code>{block.code}</code></pre>
    case 'rule':
      return <hr className="flow-rule" />
    default:
      return <p className="flow-paragraph"><Inline tokens={parseInline(block.text)} /></p>
  }
}

export default function TextReader({
  documentKey,
  blocks,
  outline,
  zoom,
  restoreRatio,
  onScrollPosition,
  onProgress,
  onLocationChange,
  onSelectionPointerUp,
  onSelectionKeyUp,
  onUserScroll,
  apiRef,
}: {
  documentKey: string
  blocks: MarkdownBlock[]
  outline: TextOutlineItem[]
  zoom: number
  restoreRatio: number
  onScrollPosition: (state: FlowScrollState) => void
  onProgress: (state: FlowScrollState) => void
  onLocationChange: (label: string) => void
  onSelectionPointerUp: () => void
  onSelectionKeyUp: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onUserScroll: () => void
  apiRef: React.RefObject<FlowReaderApi | null>
}) {
  const [visible, setVisible] = useState(() => Math.min(blocks.length, INITIAL_BLOCKS))
  const sentinelRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef(outline)
  useEffect(() => { outlineRef.current = outline }, [outline])

  // Long books are rendered progressively: the DOM stays small, so a 5 MB text
  // file opens instantly instead of blocking the first paint.
  useEffect(() => { setVisible(Math.min(blocks.length, INITIAL_BLOCKS)) }, [blocks, documentKey])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible((current) => Math.min(blocks.length, current + BLOCK_STEP))
      }
    }, { root: null, rootMargin: '1200px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [blocks.length])

  const { scrollRef, handleScroll, api } = useFlowReader({
    contentKey: documentKey,
    restoreRatio,
    onScrollPosition,
    onUserScroll,
    onProgress: (state) => {
      onProgress(state)
      const element = scrollRef.current
      if (element) {
        const anchor = element.querySelector<HTMLElement>('.flow-page')
        const offset = anchor ? anchor.offsetTop : 0
        const probe = element.scrollTop - offset + 24
        let current = ''
        for (const item of outlineRef.current) {
          const target = element.querySelector<HTMLElement>(`#flow-block-${item.block}`)
          if (target && target.offsetTop - offset <= probe) current = item.title
          else break
        }
        onLocationChange(current)
      }
    },
  })

  useEffect(() => { apiRef.current = api }, [api, apiRef])

  const rendered = blocks.slice(0, visible)

  return (
    <div
      className="reader-scroll flow-scroll"
      ref={scrollRef}
      onScroll={handleScroll}
      onMouseUp={onSelectionPointerUp}
      onKeyUp={onSelectionKeyUp}
    >
      <article className="flow-page" data-page-number="1" style={{ fontSize: `${16 * zoom}px` }}>
        {rendered.map((block, index) => <Block key={index} block={block} index={index} />)}
        {visible < blocks.length && <div ref={sentinelRef} className="flow-sentinel" aria-hidden="true" />}
      </article>
    </div>
  )
}
