import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

// pdf.js ships its CMaps, standard fonts, WASM decoders (JPEG 2000, JBIG2, QCMS)
// and ICC profiles as separate files. Without these URLs, scanned or
// exotic-encoding PDFs render as blank pages with only a console warning.
const assetBase = `${import.meta.env.BASE_URL}pdfjs-assets/`

// The legacy build is transpiled and polyfilled (e.g. it provides
// Map.prototype.getOrInsertComputed, which Safari still lacks and which the
// modern build assumes).
export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const { GlobalWorkerOptions, getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  GlobalWorkerOptions.workerSrc = workerUrl
  const loadingTask = getDocument({
    data,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
  })
  return loadingTask.promise
}
