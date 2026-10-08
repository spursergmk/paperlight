// A minimal, lenient XML/HTML scanner.
//
// EPUB container.xml, the OPF package and the NCX/nav table of contents only
// need elements, attributes and text. Doing this without `DOMParser` keeps the
// EPUB parser usable (and unit-testable) outside a browser, and tolerating
// unbalanced tags means real-world EPUBs with sloppy XHTML still parse.

export interface XmlNode {
  /** Local name, namespace prefix removed, lower-cased. */
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** Direct text content of this element (entity-decoded, trimmed per segment). */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

export function localName(name: string): string {
  const colon = name.indexOf(':')
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase()
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))*)\s*(\/?)>/g
const ATTR = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr'])
// Elements that implicitly close an open element of the same name, so a document
// with unclosed <p>/<li>/<td> (common in hand-written XHTML and nav documents)
// does not swallow its siblings' text.
const SELF_CLOSING_SAME = new Set(['p', 'li', 'dt', 'dd', 'td', 'th', 'tr', 'option', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const SKIP_CONTENT = new Set(['script', 'style'])

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!source) return attrs
  ATTR.lastIndex = 0
  let match = ATTR.exec(source)
  while (match) {
    const name = match[1].includes(':') ? match[1].slice(match[1].indexOf(':') + 1) : match[1]
    attrs[name.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
    match = ATTR.exec(source)
  }
  return attrs
}

/** Scans a document and returns every element in document order. */
export function scanElements(source: string): XmlNode[] {
  const flat: XmlNode[] = []
  const stack: XmlNode[] = []
  const textBuffers: string[] = []
  const skipDepth: { node: XmlNode; depth: number }[] = []
  let cursor = 0

  const appendText = (raw: string) => {
    if (!raw) return
    const text = decodeEntities(raw)
    if (stack.length > 0) {
      const node = stack[stack.length - 1]
      if (!SKIP_CONTENT.has(node.name)) node.text += text
    }
    if (textBuffers.length > 0) textBuffers[textBuffers.length - 1] += text
  }

  TAG.lastIndex = 0
  let match = TAG.exec(source)
  while (match) {
    appendText(source.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const closing = match[1] === '/'
    const name = localName(match[2])
    const selfClosing = match[4] === '/'

    if (closing) {
      // Pop to the matching element; tolerate stray end tags.
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].name === name) {
          stack.length = index
          break
        }
      }
    } else {
      if (SELF_CLOSING_SAME.has(name)) {
        while (stack.length > 0 && stack[stack.length - 1].name === name) stack.pop()
      }
      const node: XmlNode = { name, attrs: parseAttrs(match[3]), children: [], text: '' }
      flat.push(node)
      if (stack.length > 0) stack[stack.length - 1].children.push(node)
      if (!selfClosing && !VOID_TAGS.has(name)) {
        stack.push(node)
        if (SKIP_CONTENT.has(name)) skipDepth.push({ node, depth: stack.length })
      }
    }

    match = TAG.exec(source)
  }
  appendText(source.slice(cursor))

  if (skipDepth.length > 0) {
    for (const entry of skipDepth) entry.node.text = ''
  }

  return flat
}

/** First element with the given local name, in document order. */
export function findElement(elements: XmlNode[], name: string): XmlNode | null {
  const wanted = localName(name)
  return elements.find((element) => element.name === wanted) ?? null
}

export function findElements(elements: XmlNode[], name: string): XmlNode[] {
  const wanted = localName(name)
  return elements.filter((element) => element.name === wanted)
}

/** Depth-first search for the first descendant with the given local name. */
export function findDescendant(elements: XmlNode[], name: string): XmlNode | null {
  const wanted = localName(name)
  for (const element of elements) {
    if (element.name === wanted) return element
    const nested = findDescendant(element.children, name)
    if (nested) return nested
  }
  return null
}

export function findDescendants(
  elements: XmlNode[],
  name: string,
  found: XmlNode[] = [],
  seen: Set<XmlNode> = new Set(),
): XmlNode[] {
  const wanted = localName(name)
  for (const element of elements) {
    // `scanElements` returns a flat list and callers also recurse into children,
    // so the same node can be reached twice; track identity to match once.
    if (seen.has(element)) continue
    seen.add(element)
    if (element.name === wanted) found.push(element)
    findDescendants(element.children, name, found, seen)
  }
  return found
}

/** All text inside an element, whitespace collapsed. */
export function elementText(element: XmlNode | null): string {
  if (!element) return ''
  const collect = (node: XmlNode): string => `${node.text} ${node.children.map(collect).join(' ')}`
  return collect(element).replace(/\s+/g, ' ').trim()
}

/** Resolves a (possibly relative, percent-encoded) href against a base path. */
export function resolvePath(fromPath: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0]
  let decoded = clean
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  if (/^[a-zA-Z]+:/.test(decoded)) return decoded
  const baseSegments = fromPath.split('/').slice(0, -1)
  const segments = decoded.startsWith('/') ? [] : baseSegments
  const output: string[] = [...segments]
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') output.pop()
    else output.push(part)
  }
  return output.join('/')
}
