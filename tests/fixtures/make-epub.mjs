// Builds a minimal but valid EPUB (2/3 hybrid) for tests and the smoke run.
// Layout: mimetype, META-INF/container.xml, OEBPS/content.opf, a nav document and
// one XHTML file per chapter (with an inline image in the first chapter).

import JSZip from 'jszip'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

export async function createTestEpub({
  title = 'Test Book',
  author = 'Test Author',
  chapters = ['First Chapter', 'Second Chapter'],
} = {}) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)

  const items = chapters.map((_, index) => `<item id="chap${index + 1}" href="chap${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')
  const spine = chapters.map((_, index) => `<itemref idref="chap${index + 1}"/>`).join('\n    ')

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:identifier id="bookid">urn:uuid:paperlight-test</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    ${items}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`)

  const links = chapters
    .map((name, index) => `        <li><a href="chap${index + 1}.xhtml">${name}</a></li>`)
    .join('\n')
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
${links}
      </ol>
    </nav>
  </body>
</html>`)

  chapters.forEach((name, index) => {
    zip.file(`OEBPS/chap${index + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${name}</title><link rel="stylesheet" href="style.css"/><style>p{color:red}</style></head>
  <body>
    <h1>${name}</h1>
    <p>These classifications operate within a broader framework of knowledge.</p>
    <p>Paperlight smoke chapter ${index + 1} of ${chapters.length} for sense lookup.</p>
    <p>The authors take a stance on language learning.</p>
    ${index === 0 ? '<p><img src="images/cover.png" alt="cover"/></p><p><a href="https://example.com">external link</a></p>' : ''}
    <script>window.evil = true</script>
  </body>
</html>`)
  })

  zip.file('OEBPS/style.css', 'body { background: black; }')
  zip.file('OEBPS/images/cover.png', PNG_1PX)

  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))
}
