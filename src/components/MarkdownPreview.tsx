import type { ReactNode } from 'react'
import { parseInline, parseMarkdown } from '../lib/textdoc'
import type { InlineToken, MarkdownBlock } from '../lib/textdoc'

/**
 * Renders a vault note the same safe way the reflowing reader does: the
 * Markdown subset becomes React elements (never HTML), and `[[wiki links]]`
 * become buttons that open the linked note.
 */
export default function MarkdownPreview({
  markdown, onOpenWikiLink, className = '',
}: {
  markdown: string
  onOpenWikiLink?: (target: string) => void
  className?: string
}) {
  const blocks = parseMarkdown(markdown)
  if (blocks.length === 0) {
    return <p className={`note-preview-empty ${className}`.trim()}>这份笔记还是空的，切到「编辑」开始写。</p>
  }
  return (
    <article className={`markdown-preview ${className}`.trim()}>
      {blocks.map((block, index) => <Block key={index} block={block} index={index} onOpenWikiLink={onOpenWikiLink} />)}
    </article>
  )
}

function WikiText({ text, onOpenWikiLink }: { text: string; onOpenWikiLink?: (target: string) => void }) {
  if (!onOpenWikiLink || !text.includes('[[')) return <>{text}</>
  const parts: ReactNode[] = []
  const pattern = /\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g
  let last = 0
  let match = pattern.exec(text)
  while (match) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const target = match[1].trim()
    const alias = (match[2] || '').trim()
    parts.push(
      <button key={`${target}-${match.index}`} type="button" className="wiki-link" title={`打开 ${target}`} onClick={() => onOpenWikiLink(target)}>
        {alias || target}
      </button>,
    )
    last = match.index + match[0].length
    match = pattern.exec(text)
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function Inline({ tokens, onOpenWikiLink }: { tokens: InlineToken[]; onOpenWikiLink?: (target: string) => void }) {
  return (
    <>
      {tokens.map((token, index) => {
        if (token.type === 'strong') return <strong key={index}>{token.text}</strong>
        if (token.type === 'em') return <em key={index}>{token.text}</em>
        if (token.type === 'code') return <code key={index}>{token.text}</code>
        if (token.type === 'link') {
          return <a key={index} href={token.href} target="_blank" rel="noreferrer noopener">{token.text}</a>
        }
        return <WikiText key={index} text={token.text} onOpenWikiLink={onOpenWikiLink} />
      })}
    </>
  )
}

function Block({ block, index, onOpenWikiLink }: { block: MarkdownBlock; index: number; onOpenWikiLink?: (target: string) => void }) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level))
      const Tag = `h${level}` as 'h1'
      return (
        <Tag id={`note-heading-${index}`} className={`flow-heading flow-h${level}`}>
          <Inline tokens={parseInline(block.text)} onOpenWikiLink={onOpenWikiLink} />
        </Tag>
      )
    }
    case 'list':
      return block.ordered
        ? <ol className="flow-list">{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline tokens={parseInline(item)} onOpenWikiLink={onOpenWikiLink} /></li>)}</ol>
        : <ul className="flow-list">{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline tokens={parseInline(item)} onOpenWikiLink={onOpenWikiLink} /></li>)}</ul>
    case 'quote':
      return <blockquote className="flow-quote"><Inline tokens={parseInline(block.text)} onOpenWikiLink={onOpenWikiLink} /></blockquote>
    case 'code':
      return <pre className="flow-code" data-language={block.language || undefined}><code>{block.code}</code></pre>
    case 'rule':
      return <hr className="flow-rule" />
    default:
      return <p className="flow-paragraph"><Inline tokens={parseInline(block.text)} onOpenWikiLink={onOpenWikiLink} /></p>
  }
}
