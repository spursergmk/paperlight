import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const { GlobalWorkerOptions, getDocument } = await import('pdfjs-dist')
  GlobalWorkerOptions.workerSrc = workerUrl
  const loadingTask = getDocument({ data })
  return loadingTask.promise
}
