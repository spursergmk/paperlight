// Generates a small, valid, multi-page PDF without any dependency.
// Used by the Electron smoke test to check rendering, virtualisation and
// multi-tab behaviour on a document big enough to matter (120 pages).
//
// Usage: node tests/fixtures/make-pdf.mjs <out.pdf> [pages] [title]

import { writeFileSync } from 'node:fs'

function escapeText(value) {
  return String(value).replace(/[\\()]/g, (match) => `\\${match}`)
}

export function createTestPdf({ pages = 12, title = 'Paperlight Smoke', landscapePages = [] } = {}) {
  const landscape = new Set(landscapePages)
  const fontObjectNumber = 3
  const firstPageObject = 4
  const objects = []

  const pageNumbers = Array.from({ length: pages }, (_, index) => firstPageObject + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pages} >>`
  objects[fontObjectNumber] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  for (let index = 0; index < pages; index += 1) {
    const pageNumber = firstPageObject + index * 2
    const contentNumber = pageNumber + 1
    // A landscape "fold-out" page: mixed MediaBoxes are what makes a reader
    // derive the scale per page instead of from page 1.
    const mediaBox = landscape.has(index + 1) ? '[0 0 792 612]' : '[0 0 612 792]'
    const top = landscape.has(index + 1) ? 520 : 704
    objects[pageNumber] = `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`
    const body = [
      `BT /F1 22 Tf 72 ${top} Td (Paperlight smoke page ${index + 1} of ${pages}) Tj ET`,
      `BT /F1 12 Tf 72 ${top - 40} Td (${escapeText(title)}) Tj ET`,
      `BT /F1 11 Tf 72 ${top - 74} Td (Foucault and liberal political economy: contexts of the book.) Tj ET`,
      `BT /F1 11 Tf 72 ${top - 98} Td (These classifications operate within a broader framework of knowledge.) Tj ET`,
      `BT /F1 11 Tf 72 ${top - 122} Td (Select any English word of this page to try the contextual sense lookup.) Tj ET`,
      `BT /F1 11 Tf 72 ${top - 146} Td (The authors take a stance on language learning.) Tj ET`,
      `0.85 w 72 ${top - 166} m ${landscape.has(index + 1) ? 720 : 540} ${top - 166} l S`,
    ].join('\n')
    objects[contentNumber] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
  }

  const maxObject = firstPageObject + pages * 2 - 1
  const chunks = []
  const offsets = new Array(maxObject + 1).fill(0)
  let cursor = 0
  const push = (text) => {
    chunks.push(text)
    cursor += Buffer.byteLength(text, 'latin1')
  }

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  for (let number = 1; number <= maxObject; number += 1) {
    const body = objects[number]
    if (body === undefined) continue
    offsets[number] = cursor
    push(`${number} 0 obj\n${body}\nendobj\n`)
  }
  const xrefOffset = cursor
  let xref = `xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`
  for (let number = 1; number <= maxObject; number += 1) {
    xref += `${String(offsets[number] ?? 0).padStart(10, '0')} 00000 n \n`
  }
  push(xref)
  push(`trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  return new Uint8Array(Buffer.from(chunks.join(''), 'latin1'))
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('make-pdf.mjs')
if (invokedDirectly) {
  const [, , outPath, pageArg, titleArg] = process.argv
  if (!outPath) {
    console.error('usage: node tests/fixtures/make-pdf.mjs <out.pdf> [pages] [title]')
    process.exit(1)
  }
  writeFileSync(outPath, createTestPdf({ pages: Number(pageArg) || 12, title: titleArg || 'Paperlight Smoke' }))
  console.log(`wrote ${outPath}`)
}
