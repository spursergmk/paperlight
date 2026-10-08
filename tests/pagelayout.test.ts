import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_CAPTION, PAGE_GAP, buildLayout, currentPageFromScroll, renderWindow, scrollTopForPage,
} from '../src/lib/pagelayout.ts'

test('buildLayout stacks pages with the caption and gap included', () => {
  const layout = buildLayout([0.773, 0.773], 600, 20, 10)
  const pageHeight = Math.round(600 / 0.773)
  assert.equal(layout.boxes.length, 2)
  assert.equal(layout.boxes[0].top, 0)
  assert.equal(layout.boxes[0].height, pageHeight + 10)
  assert.equal(layout.boxes[1].top, pageHeight + 10 + 20)
  assert.equal(layout.totalHeight, pageHeight + 10 + 20 + pageHeight + 10)
})

test('buildLayout falls back for missing or absurd ratios', () => {
  const layout = buildLayout([undefined, 0, 42], 400)
  assert.equal(layout.boxes.length, 3)
  for (const box of layout.boxes) {
    assert.ok(box.height > 80, 'each placeholder keeps a usable height')
  }
  assert.equal(layout.pageWidth, 400)
})

test('buildLayout uses the shared gap and caption defaults', () => {
  const layout = buildLayout([1], 100)
  assert.equal(layout.boxes[0].height, 100 + PAGE_CAPTION)
  assert.equal(layout.totalHeight, 100 + PAGE_CAPTION)
  assert.equal(PAGE_GAP, 24)
})

test('currentPageFromScroll tracks the page under the reading anchor', () => {
  const boxes = buildLayout([1, 1, 1], 400).boxes
  assert.equal(currentPageFromScroll(boxes, 0, 800), 1)
  assert.equal(currentPageFromScroll(boxes, boxes[1].top + 10, 800), 2)
  assert.equal(currentPageFromScroll(boxes, boxes[2].top + 10, 800), 3)
  assert.equal(currentPageFromScroll(boxes, 999999, 800), 3)
  assert.equal(currentPageFromScroll([], 0, 800), 1)
})

test('renderWindow mounts only the pages around the viewport', () => {
  assert.deepEqual(renderWindow(353, 16, 1), [14, 16])
  assert.deepEqual(renderWindow(353, 1, 1), [0, 1])
  assert.deepEqual(renderWindow(353, 353, 1), [351, 352])
  assert.deepEqual(renderWindow(120, 90, 1), [88, 90])
  assert.deepEqual(renderWindow(0, 1, 1), [0, -1])
  assert.deepEqual(renderWindow(5, 99, 1), [3, 4])
})

test('scrollTopForPage clamps and keeps a small padding', () => {
  const boxes = buildLayout([1, 1, 1], 400).boxes
  assert.equal(scrollTopForPage(boxes, 1, 12), boxes[0].top)
  assert.equal(scrollTopForPage(boxes, 2, 12), boxes[1].top - 12)
  assert.equal(scrollTopForPage(boxes, 99, 12), boxes[2].top - 12)
  assert.equal(scrollTopForPage([], 3, 12), 0)
})
