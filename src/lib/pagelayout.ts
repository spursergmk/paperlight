// Page geometry for the virtualised reader.
//
// Rendering every page of a 350-page book at once is what makes PDF readers
// feel slow and unstable. Instead the reader lays out light-weight slots with
// the correct height and only mounts the pages around the viewport.

export const PAGE_GAP = 24
export const PAGE_CAPTION = 18

export interface PageBox {
  /** Zero-based page index. */
  index: number
  top: number
  height: number
}

export interface PageLayout {
  boxes: PageBox[]
  totalHeight: number
  pageWidth: number
}

/**
 * @param ratios  width / height per page; a default fills unknown pages
 * @param width   rendered page width in CSS pixels
 */
export function buildLayout(
  ratios: Array<number | undefined>,
  width: number,
  gap = PAGE_GAP,
  caption = PAGE_CAPTION,
): PageLayout {
  const boxes: PageBox[] = []
  let top = 0
  ratios.forEach((ratio, index) => {
    const safeRatio = ratio && ratio > 0.1 && ratio < 10 ? ratio : 0.773
    const height = Math.max(80, Math.round(width / safeRatio)) + caption
    boxes.push({ index, top, height })
    top += height + gap
  })
  return {
    boxes,
    pageWidth: width,
    totalHeight: boxes.length === 0 ? 0 : top - gap,
  }
}

/** 1-based page number whose slot covers the reading anchor of the viewport. */
export function currentPageFromScroll(
  boxes: PageBox[],
  scrollTop: number,
  viewportHeight: number,
  anchor = 0.35,
): number {
  if (boxes.length === 0) return 1
  const probe = scrollTop + Math.min(viewportHeight * anchor, viewportHeight)
  let candidate = 1
  for (const box of boxes) {
    if (box.top <= probe) candidate = box.index + 1
    else break
  }
  return Math.min(boxes.length, Math.max(1, candidate))
}

/** Zero-based inclusive page index range to mount, clamped to the document. */
export function renderWindow(pageCount: number, currentPage: number, overscan = 1): [number, number] {
  if (pageCount <= 0) return [0, -1]
  const index = Math.min(Math.max(currentPage - 1, 0), pageCount - 1)
  return [Math.max(0, index - overscan), Math.min(pageCount - 1, index + overscan)]
}

/** Scroll offset that puts a page's top edge just below the toolbar. */
export function scrollTopForPage(boxes: PageBox[], pageNumber: number, padding = 12): number {
  const box = boxes[Math.min(Math.max(pageNumber, 1), boxes.length) - 1]
  if (!box) return 0
  return Math.max(0, box.top - padding)
}
