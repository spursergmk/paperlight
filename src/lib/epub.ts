// EPUB (2 and 3) reader.
//
// The book is unzipped, its OPF package is parsed, and each spine item is handed
// to the renderer as raw XHTML (the renderer sanitizes it with DOMPurify and
// rewrites its image sources to blob URLs). No iframe is involved, so text
// selection works exactly like it does in the PDF reader and the contextual
// sense lookup needs no special handling.

import JSZip from 'jszip'
import {
  elementText, findDescendant, findDescendants, findElement, resolvePath, scanElements,
// Explicit extension: `node --test` resolves this module with Node's own ESM
// resolver (the app bundle resolves extensionless imports, Node does not).
} from './xml.ts'
import type { XmlNode } from './xml.ts'

export interface EpubChapter {
  /** Manifest id. */
  id: string
  /** Zip path of the XHTML document. */
  path: string
  title: string
  html: string
}

export interface EpubOutlineItem {
  title: string
  chapterIndex: number
  level: number
  /** Fragment from an EPUB nav/NCX target, when it points inside a chapter. */
  anchorId?: string
}

export interface EpubBook {
  title: string
  author: string
  chapters: EpubChapter[]
  outline: EpubOutlineItem[]
  coverPath: string | null
  /** Blob URL for a resource referenced from a chapter (images, fonts, CSS). */
  assetUrl: (fromPath: string, href: string) => Promise<string | null>
  coverUrl: () => Promise<string | null>
  /** Revokes every blob URL this book created. */
  revokeAll: () => void
}

const MAX_ASSET_BYTES = 40 * 1024 * 1024

function isProbablyBinary(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|woff2?|ttf|otf|eot|mp3|m4a|mp4|webm)$/i.test(path)
}

/** Parses container.xml and returns the OPF path inside the archive. */
export function findPackagePath(containerXml: string): string | null {
  const elements = scanElements(containerXml)
  const rootfile = findDescendant(elements, 'rootfile')
  const path = rootfile?.attrs['full-path']
  return path ? path.replace(/^\/+/, '') : null
}

export interface PackageInfo {
  title: string
  author: string
  coverPath: string | null
  spinePaths: string[]
  /** manifest id -> zip path */
  manifest: Map<string, string>
  tocPath: string | null
  navPath: string | null
}

/** Parses the OPF package document (manifest, spine, metadata, toc). */
export function parsePackage(opfXml: string, opfPath: string): PackageInfo {
  const elements = scanElements(opfXml)
  const metadata = findElementByAnyName(elements, ['metadata'])

  const title = elementText(findDescendant(metadata ? [metadata] : elements, 'title'))
  const author = elementText(findDescendant(metadata ? [metadata] : elements, 'creator'))

  const manifest = new Map<string, string>()
  const mediaTypes = new Map<string, string>()
  const properties = new Map<string, string>()
  for (const item of findDescendants(elements, 'item')) {
    const id = item.attrs.id
    const href = item.attrs.href
    if (!id || !href) continue
    const path = resolvePath(opfPath, href)
    manifest.set(id, path)
    mediaTypes.set(id, (item.attrs['media-type'] || '').toLowerCase())
    properties.set(id, (item.attrs.properties || '').toLowerCase())
  }

  let tocPath: string | null = null
  const spineElement = findElementByAnyName(elements, ['spine'])
  if (spineElement?.attrs.toc && manifest.has(spineElement.attrs.toc)) {
    tocPath = manifest.get(spineElement.attrs.toc) || null
  }
  let navPath: string | null = null
  for (const [id, value] of properties) {
    if (value.split(/\s+/).includes('nav')) {
      navPath = manifest.get(id) || null
      break
    }
  }

  const spinePaths: string[] = []
  for (const itemref of findDescendants(spineElement ? [spineElement] : elements, 'itemref')) {
    if ((itemref.attrs.linear || '').toLowerCase() === 'no') continue
    const idref = itemref.attrs.idref
    if (!idref) continue
    const path = manifest.get(idref)
    const mediaType = mediaTypes.get(idref) || ''
    if (!path) continue
    if (mediaType && !/xhtml|html|xml/.test(mediaType)) continue
    spinePaths.push(path)
  }

  let coverPath: string | null = null
  for (const [id, value] of properties) {
    if (value.split(/\s+/).includes('cover-image')) {
      coverPath = manifest.get(id) || null
      break
    }
  }
  if (!coverPath) {
    for (const meta of findDescendants(elements, 'meta')) {
      if ((meta.attrs.name || '').toLowerCase() === 'cover' && meta.attrs.content) {
        coverPath = manifest.get(meta.attrs.content) || null
      }
    }
  }

  return { title, author, coverPath, spinePaths, manifest, tocPath, navPath }
}

function findElementByAnyName(elements: XmlNode[], names: string[]): XmlNode | null {
  for (const name of names) {
    const found = findElement(elements, name)
    if (found) return found
  }
  return null
}

interface TocEntry { title: string; path: string; level: number; anchorId?: string }

function tocTarget(tocPath: string, href: string): { path: string; anchorId?: string } {
  const hash = href.indexOf('#')
  const pathHref = hash < 0 ? href : href.slice(0, hash)
  const rawAnchor = hash < 0 ? '' : href.slice(hash + 1).split('?')[0]
  let anchorId = rawAnchor
  try { anchorId = decodeURIComponent(rawAnchor) } catch { /* keep a literal fragment */ }
  return {
    path: pathHref ? resolvePath(tocPath, pathHref) : tocPath,
    ...(anchorId ? { anchorId } : {}),
  }
}

/** Parses an EPUB3 nav document (nav[epub:type=toc]) or an EPUB2 NCX. */
export function parseToc(source: string, tocPath: string): TocEntry[] {
  const elements = scanElements(source)
  const entries: TocEntry[] = []

  // EPUB 3: <nav epub:type="toc"> … <a href="…">Title</a>
  const navs = findDescendants(elements, 'nav')
  const tocNav = navs.find((nav) => (nav.attrs.type || '').toLowerCase().includes('toc')) || navs[0]
  if (tocNav) {
    let depth = 0
    for (const node of flatten(tocNav)) {
      if (node.name === 'ol') depth += 1
      if (node.name === 'a' && node.attrs.href) {
        const title = elementText(node)
        if (title) entries.push({ title, ...tocTarget(tocPath, node.attrs.href), level: Math.max(0, depth - 1) })
      }
    }
  }

  // EPUB 2: <navPoint><navLabel><text>Title</text></navLabel><content src="…"/>
  if (entries.length === 0) {
    for (const point of findDescendants(elements, 'navpoint')) {
      const title = elementText(findDescendant([point], 'text') || findDescendant([point], 'navlabel'))
      const content = findDescendant([point], 'content')
      const src = content?.attrs.src
      if (title && src) entries.push({ title, ...tocTarget(tocPath, src), level: 0 })
    }
  }

  return entries
}

function flatten(node: XmlNode, output: XmlNode[] = []): XmlNode[] {
  output.push(node)
  for (const child of node.children) flatten(child, output)
  return output
}

/** Extracts <title> or the first heading, used when the TOC has no entry. */
export function chapterTitleFromHtml(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title && title[1].trim()) return decodeText(title[1])
  const heading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html)
  if (heading && heading[1].trim()) return decodeText(stripTags(heading[1]))
  return ''
}

function chapterHeadingsFromHtml(html: string): Array<{ title: string; level: number; anchorId?: string }> {
  return scanElements(html).flatMap((node) => {
    const match = /^h([1-6])$/.exec(node.name)
    const title = elementText(node)
    if (!match || !title) return []
    return [{ title, level: Number(match[1]), ...(node.attrs.id ? { anchorId: node.attrs.id } : {}) }]
  })
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ')
}

function decodeText(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export async function openEpub(data: Uint8Array): Promise<EpubBook> {
  const zip = await JSZip.loadAsync(data)
  const objectUrls: string[] = []

  const readText = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    if (!file) return null
    return file.async('string')
  }
  const readArray = async (path: string): Promise<Uint8Array | null> => {
    const file = zip.file(path)
    if (!file) return null
    return file.async('uint8array')
  }

  const containerXml = await readText('META-INF/container.xml')
  const opfPath = containerXml ? findPackagePath(containerXml) : null
  // Some archives have no container.xml; fall back to the first .opf found.
  const fallbackOpf = opfPath ?? Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.opf')) ?? null
  if (!fallbackOpf) throw new Error('这个 EPUB 缺少 OPF 包文件，无法打开。')

  const opfXml = await readText(fallbackOpf)
  if (!opfXml) throw new Error('无法读取 EPUB 的包文件。')

  const pkg = parsePackage(opfXml, fallbackOpf)
  if (pkg.spinePaths.length === 0) throw new Error('这个 EPUB 没有可阅读的章节。')

  const tocEntries = pkg.navPath
    ? parseToc(await readText(pkg.navPath) ?? '', pkg.navPath)
    : []
  const toc = tocEntries.length > 0
    ? tocEntries
    : pkg.tocPath
      ? parseToc(await readText(pkg.tocPath) ?? '', pkg.tocPath)
      : []

  const titleByPath = new Map<string, string>()
  for (const entry of toc) {
    if (!titleByPath.has(entry.path)) titleByPath.set(entry.path, entry.title)
  }

  const chapters: EpubChapter[] = []
  for (const path of pkg.spinePaths) {
    const html = await readText(path)
    if (html === null) continue
    const id = findManifestId(pkg.manifest, path) ?? path
    const title = titleByPath.get(path) || chapterTitleFromHtml(html) || `第 ${chapters.length + 1} 节`
    chapters.push({ id, path, title, html })
  }
  if (chapters.length === 0) throw new Error('无法读取这个 EPUB 的正文。')

  const tocByChapter = chapters.map((chapter, chapterIndex) => toc.flatMap((entry) =>
    entry.path === chapter.path
      ? [{ title: entry.title, chapterIndex, level: entry.level, ...(entry.anchorId ? { anchorId: entry.anchorId } : {}) }]
      : [],
  ))
  const outline: EpubOutlineItem[] = chapters.flatMap((chapter, chapterIndex) => {
    const navItems = tocByChapter[chapterIndex]
    const headings = chapterHeadingsFromHtml(chapter.html)
    if (navItems.length === 0) {
      return headings.length
        ? headings.map((heading) => ({ ...heading, chapterIndex }))
        : [{ title: chapter.title, chapterIndex, level: 0 }]
    }

    const matched = new Set<EpubOutlineItem>()
    const result: EpubOutlineItem[] = headings.map((heading) => {
      const navItem = navItems.find((item) => !matched.has(item)
        && ((heading.anchorId && item.anchorId === heading.anchorId)
          || item.title.localeCompare(heading.title, undefined, { sensitivity: 'base' }) === 0))
      if (navItem) {
        matched.add(navItem)
        return navItem
      }
      return { ...heading, chapterIndex }
    })
    result.push(...navItems.filter((item) => !matched.has(item)))
    return result
  })

  const assetCache = new Map<string, string | null>()
  const assetUrl = async (fromPath: string, href: string): Promise<string | null> => {
    if (!href || /^(https?:|data:|blob:)/i.test(href)) return href || null
    const path = resolvePath(fromPath, href)
    if (assetCache.has(path)) return assetCache.get(path) ?? null
    const bytes = await readArray(path)
    if (!bytes || bytes.byteLength > MAX_ASSET_BYTES) {
      assetCache.set(path, null)
      return null
    }
    const mime = mimeFor(path)
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
    objectUrls.push(url)
    assetCache.set(path, url)
    return url
  }

  return {
    title: pkg.title || '未命名',
    author: pkg.author,
    chapters,
    outline,
    coverPath: pkg.coverPath,
    assetUrl,
    coverUrl: async () => (pkg.coverPath ? assetUrl(opfPath ?? '', pkg.coverPath) : null),
    revokeAll: () => {
      for (const url of objectUrls) URL.revokeObjectURL(url)
      objectUrls.length = 0
      assetCache.clear()
    },
  }
}

function findManifestId(manifest: Map<string, string>, path: string): string | null {
  for (const [id, value] of manifest) {
    if (value === path) return id
  }
  return null
}

export function mimeFor(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.woff2')) return 'font/woff2'
  if (lower.endsWith('.woff')) return 'font/woff'
  if (lower.endsWith('.ttf')) return 'font/ttf'
  if (lower.endsWith('.otf')) return 'font/otf'
  if (lower.endsWith('.css')) return 'text/css'
  if (isProbablyBinary(lower)) return 'application/octet-stream'
  return 'text/plain'
}
