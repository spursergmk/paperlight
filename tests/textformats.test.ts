import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  outlineFromBlocks, parseInline, parseMarkdown, parsePlainText, parseTextDocument,
} from '../src/lib/textdoc.ts'
import {
  decodeEntities, elementText, findDescendant, findElements, resolvePath, scanElements,
} from '../src/lib/xml.ts'
import {
  chapterTitleFromHtml, findPackagePath, mimeFor, openEpub, parsePackage, parseToc,
} from '../src/lib/epub.ts'
import { documentKindFor, isMarkdownPath, isOpenablePath, positionLabel } from '../src/lib/documentKind.ts'
import { createTestEpub } from './fixtures/make-epub.mjs'

// ------------------------------------------------------------------ formats

test('documentKindFor recognises the supported formats', () => {
  assert.equal(documentKindFor('/books/a.pdf'), 'pdf')
  assert.equal(documentKindFor('/books/a.EPUB'), 'epub')
  assert.equal(documentKindFor('/notes/a.md'), 'text')
  assert.equal(documentKindFor('/notes/a.txt'), 'text')
  assert.equal(documentKindFor('/books/a.mobi'), null)
  assert.equal(documentKindFor('/books/a.docx'), null)
  assert.equal(isOpenablePath('/books/a.epub'), true)
  assert.equal(isMarkdownPath('/notes/a.markdown'), true)
  assert.equal(positionLabel('pdf', 12, 340), '12 / 340')
  assert.equal(positionLabel('epub', 3, 12), '第 3 章 / 12')
})

// -------------------------------------------------------------- markdown

test('parseInline handles code, strong, emphasis and links', () => {
  assert.deepEqual(parseInline('plain'), [{ type: 'text', text: 'plain' }])
  assert.deepEqual(parseInline('a `code` b'), [
    { type: 'text', text: 'a ' },
    { type: 'code', text: 'code' },
    { type: 'text', text: ' b' },
  ])
  assert.deepEqual(parseInline('**bold** and *em*'), [
    { type: 'strong', text: 'bold' },
    { type: 'text', text: ' and ' },
    { type: 'em', text: 'em' },
  ])
  assert.deepEqual(parseInline('[docs](https://example.com/x)'), [
    { type: 'link', text: 'docs', href: 'https://example.com/x' },
  ])
})

test('parseMarkdown builds headings, lists, quotes, code and rules', () => {
  const blocks = parseMarkdown([
    '# Title',
    '',
    'A paragraph that',
    'continues here.',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted wisdom',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '---',
  ].join('\n'))

  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Title' })
  assert.deepEqual(blocks[1], { type: 'paragraph', text: 'A paragraph that continues here.' })
  assert.deepEqual(blocks[2], { type: 'list', ordered: false, items: ['one', 'two'] })
  assert.deepEqual(blocks[3], { type: 'list', ordered: true, items: ['first', 'second'] })
  assert.deepEqual(blocks[4], { type: 'quote', text: 'quoted wisdom' })
  assert.deepEqual(blocks[5], { type: 'code', language: 'js', code: 'const a = 1' })
  assert.deepEqual(blocks[6], { type: 'rule' })
})

test('parsePlainText keeps paragraphs and drops blank runs', () => {
  const blocks = parsePlainText('First para\nstill first.\n\n\nSecond para.\n')
  assert.deepEqual(blocks, [
    { type: 'paragraph', text: 'First para\nstill first.' },
    { type: 'paragraph', text: 'Second para.' },
  ])
  // Plain text keeps Markdown syntax literal and splits on blank lines.
  assert.deepEqual(parseTextDocument('# H\n\ntext', false), [
    { type: 'paragraph', text: '# H' },
    { type: 'paragraph', text: 'text' },
  ])
  assert.deepEqual(parseTextDocument('# H\n\ntext', true)[0], { type: 'heading', level: 1, text: 'H' })
})

test('outlineFromBlocks lists the headings with their block index', () => {
  const blocks = parseMarkdown('# One\n\ntext\n\n## Two\n\nmore')
  assert.deepEqual(outlineFromBlocks(blocks), [
    { title: 'One', level: 1, block: 0 },
    { title: 'Two', level: 2, block: 2 },
  ])
})

// ------------------------------------------------------------------- xml

test('decodeEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x4e2d;'), "a & b <c> 'd' 中")
})

test('scanElements tolerates unbalanced markup and ignores script text', () => {
  const elements = scanElements('<div><p>hello <b>world</b><p>again</div><script>var x = 1</script>')
  const paragraphs = findElements(elements, 'p')
  assert.equal(paragraphs.length, 2)
  assert.equal(elementText(paragraphs[0]), 'hello world')
  assert.equal(elementText(paragraphs[1]), 'again')
  assert.equal(elements.some((element) => element.name === 'script' && element.text.includes('var')), false)
})

test('findDescendant and elementText read nested content', () => {
  const elements = scanElements('<package><metadata><dc:title>My Book</dc:title><dc:creator>A</dc:creator></metadata></package>')
  const metadata = findElements(elements, 'metadata')[0]
  assert.equal(elementText(findDescendant([metadata], 'title')), 'My Book')
  assert.equal(elementText(findDescendant([metadata], 'creator')), 'A')
})

test('resolvePath handles relative segments, parents and percent-encoding', () => {
  assert.equal(resolvePath('OEBPS/content.opf', 'chap1.xhtml'), 'OEBPS/chap1.xhtml')
  assert.equal(resolvePath('OEBPS/text/ch1.xhtml', '../images/a%20b.png'), 'OEBPS/images/a b.png')
  assert.equal(resolvePath('OEBPS/content.opf', './images/cover.png'), 'OEBPS/images/cover.png')
  assert.equal(resolvePath('OEBPS/content.opf', 'chap1.xhtml#part2'), 'OEBPS/chap1.xhtml')
  assert.equal(resolvePath('OEBPS/content.opf', 'https://example.com/x.png'), 'https://example.com/x.png')
})

// ------------------------------------------------------------------ epub

test('findPackagePath and parsePackage read the OPF', () => {
  const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`
  assert.equal(findPackagePath(container), 'OEBPS/content.opf')
  assert.equal(findPackagePath('<container/>'), null)

  const opf = `<?xml version="1.0"?>
<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Book</dc:title><dc:creator>Writer</dc:creator>
  <meta name="cover" content="coverimg"/>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
  <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
  <item id="css" href="style.css" media-type="text/css"/>
  <item id="coverimg" href="img/cover.png" media-type="image/png"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="css"/></spine></package>`

  const parsed = parsePackage(opf, 'OEBPS/content.opf')
  assert.equal(parsed.title, 'Book')
  assert.equal(parsed.author, 'Writer')
  assert.equal(parsed.navPath, 'OEBPS/nav.xhtml')
  assert.equal(parsed.coverPath, 'OEBPS/img/cover.png')
  assert.deepEqual(parsed.spinePaths, ['OEBPS/text/c1.xhtml', 'OEBPS/text/c2.xhtml'], 'non-document spine items are skipped')
})

test('parseToc reads EPUB3 nav and EPUB2 NCX', () => {
  const nav = `<html><body><nav epub:type="toc"><ol>
    <li><a href="chap1.xhtml">One</a></li>
    <li><a href="chap2.xhtml">Two</a><ol><li><a href="chap2.xhtml#s1">Two A</a></li></ol></li>
  </ol></nav></body></html>`
  const navEntries = parseToc(nav, 'OEBPS/nav.xhtml')
  assert.deepEqual(navEntries.map((entry) => entry.title), ['One', 'Two', 'Two A'])
  assert.deepEqual(navEntries.map((entry) => entry.path), ['OEBPS/chap1.xhtml', 'OEBPS/chap2.xhtml', 'OEBPS/chap2.xhtml'])
  assert.deepEqual(navEntries.map((entry) => entry.level), [0, 0, 1])

  const ncx = `<ncx><navMap>
    <navPoint><navLabel><text>Alpha</text></navLabel><content src="a.xhtml"/></navPoint>
    <navPoint><navLabel><text>Beta</text></navLabel><content src="b.xhtml"/></navPoint>
  </navMap></ncx>`
  assert.deepEqual(parseToc(ncx, 'OEBPS/toc.ncx').map((entry) => entry.title), ['Alpha', 'Beta'])
})

test('chapterTitleFromHtml falls back to the first heading', () => {
  assert.equal(chapterTitleFromHtml('<html><head><title>Named</title></head><body><h1>H</h1></body></html>'), 'Named')
  assert.equal(chapterTitleFromHtml('<html><body><h1>Heading &amp; more</h1></body></html>'), 'Heading & more')
  assert.equal(chapterTitleFromHtml('<html><body><p>none</p></body></html>'), '')
})

test('mimeFor maps the asset types an EPUB uses', () => {
  assert.equal(mimeFor('a/b.png'), 'image/png')
  assert.equal(mimeFor('a/b.JPG'), 'image/jpeg')
  assert.equal(mimeFor('a/b.svg'), 'image/svg+xml')
  assert.equal(mimeFor('a/b.woff2'), 'font/woff2')
  assert.equal(mimeFor('a/b.xyz'), 'text/plain')
})

test('openEpub reads title, spine order, TOC and chapter markup', async () => {
  const bytes = await createTestEpub({ title: 'Smoke Book', author: 'Tester', chapters: ['Alpha', 'Beta', 'Gamma'] })
  const book = await openEpub(bytes)

  assert.equal(book.title, 'Smoke Book')
  assert.equal(book.author, 'Tester')
  assert.equal(book.chapters.length, 3)
  assert.deepEqual(book.chapters.map((chapter) => chapter.title), ['Alpha', 'Beta', 'Gamma'], 'titles come from the nav document')
  assert.equal(book.chapters[0].path, 'OEBPS/chap1.xhtml')
  assert.match(book.chapters[0].html, /broader framework of knowledge/)
  assert.deepEqual(book.outline.map((item) => item.chapterIndex), [0, 1, 2])
  assert.deepEqual(book.outline.map((item) => item.title), ['Alpha', 'Beta', 'Gamma'])
  assert.equal(book.coverPath, 'OEBPS/images/cover.png')
})
