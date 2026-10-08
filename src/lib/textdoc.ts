// Plain-text and Markdown parsing for the reflowing reader.
//
// Deliberately small and dependency-free: the output is a block model that the
// renderer turns into React elements, so document content is never injected as
// HTML (no `dangerouslySetInnerHTML`, no sanitizer needed, and a hostile file
// cannot reach the app's bridge).

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'rule' }

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }

export interface TextOutlineItem {
  title: string
  level: number
  /** Index into the block array, used as the scroll anchor. */
  block: number
}

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const UNORDERED = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/

/** Splits inline Markdown into tokens; unsupported syntax stays literal text. */
export function parseInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let buffer = ''
  let index = 0

  const flush = () => {
    if (buffer) {
      tokens.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }

  while (index < input.length) {
    const rest = input.slice(index)

    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      flush()
      tokens.push({ type: 'code', text: code[1] })
      index += code[0].length
      continue
    }

    const strong = /^(\*\*|__)([^\s][\s\S]*?)\1/.exec(rest)
    if (strong) {
      flush()
      tokens.push({ type: 'strong', text: strong[2] })
      index += strong[0].length
      continue
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link) {
      flush()
      tokens.push({ type: 'link', text: link[1], href: link[2] })
      index += link[0].length
      continue
    }

    const em = /^(\*|_)([^\s][\s\S]*?)\1/.exec(rest)
    if (em) {
      flush()
      tokens.push({ type: 'em', text: em[2] })
      index += em[0].length
      continue
    }

    buffer += input[index]
    index += 1
  }

  flush()
  return tokens
}

/** Parses Markdown into blocks. Tables, HTML and footnotes are treated as text. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const language = fence[2] || ''
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        code.push(lines[index])
        index += 1
      }
      index += 1 // closing fence
      blocks.push({ type: 'code', language, code: code.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const collected: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) {
        collected.push(QUOTE.exec(lines[index])![1])
        index += 1
      }
      blocks.push({ type: 'quote', text: collected.join(' ').trim() })
      continue
    }

    const isUnordered = UNORDERED.test(line)
    const isOrdered = !isUnordered && ORDERED.test(line)
    if (isUnordered || isOrdered) {
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index]
        const match = isOrdered ? ORDERED.exec(current) : UNORDERED.exec(current)
        if (!match) {
          // A wrapped list item continues on the next indented line.
          if (items.length > 0 && /^\s+\S/.test(current) && current.trim()) {
            items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`
            index += 1
            continue
          }
          break
        }
        items.push(match[1].trim())
        index += 1
      }
      blocks.push({ type: 'list', ordered: isOrdered, items })
      continue
    }

    // Paragraph: consecutive non-empty lines that do not start a new block.
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index]
      if (!current.trim()) break
      if (paragraph.length > 0 && (FENCE.test(current) || HEADING.test(current) || RULE.test(current)
        || QUOTE.test(current) || UNORDERED.test(current) || ORDERED.test(current))) break
      paragraph.push(current.trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
  }

  return blocks
}

/** Plain text keeps its paragraph structure; indentation is preserved. */
export function parsePlainText(source: string): MarkdownBlock[] {
  const paragraphs = source
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((chunk) => chunk.replace(/[ \t]+$/gm, '').trim())
    .filter(Boolean)
  return paragraphs.map((text) => ({ type: 'paragraph' as const, text }))
}

export function parseTextDocument(source: string, markdown: boolean): MarkdownBlock[] {
  return markdown ? parseMarkdown(source) : parsePlainText(source)
}

/** Markdown headings become the 目录 entries of a text document. */
export function outlineFromBlocks(blocks: MarkdownBlock[]): TextOutlineItem[] {
  const outline: TextOutlineItem[] = []
  blocks.forEach((block, blockIndex) => {
    if (block.type === 'heading') {
      outline.push({ title: block.text, level: block.level, block: blockIndex })
    }
  })
  return outline
}

/** Visible text of a block, used for accessibility labels and tests. */
export function blockText(block: MarkdownBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return block.text
    case 'list':
      return block.items.join(' ')
    case 'code':
      return block.code
    default:
      return ''
  }
}
