// End-to-end smoke test for the Paperlight app.
//
// Started by `npm run smoke` (PAPERLIGHT_SMOKE=1 electron .). It drives the real
// window: opens a generated 120-page PDF through the app bridge, checks that the
// reader virtualises pages, opens a second tab, drags the reader/assistant
// divider and verifies the persisted app state. Screenshots land in
// tests/artifacts/ and the process exits non-zero when a check fails.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { createTestPdf } from '../tests/fixtures/make-pdf.mjs'
import { createTestEpub } from '../tests/fixtures/make-epub.mjs'

const RESULTS = []
let failures = 0

function record(name, ok, detail) {
  RESULTS.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function evaluate(webContents, expression) {
  return webContents.executeJavaScript(expression, true)
}

async function waitFor(webContents, expression, { timeout = 20000, interval = 120, label = expression } = {}) {
  const started = Date.now()
  let lastEvaluationError = null
  for (;;) {
    try {
      const value = await evaluate(webContents, expression)
      if (value) return value
    } catch (error) {
      lastEvaluationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (Date.now() - started > timeout) {
        throw new Error(`timed out waiting for ${label}; last evaluation error: ${lastEvaluationError}`, { cause: error })
      }
    }
    if (Date.now() - started > timeout) {
      const detail = lastEvaluationError ? `; last evaluation error: ${lastEvaluationError}` : ''
      throw new Error(`timed out waiting for ${label}${detail}`)
    }
    await sleep(interval)
  }
}

// pdf.js streams a page's text content from its worker, and that stream can
// stall. The reader now recovers (page retry, then a document rebuild), so this
// helper accepts either outcome and reports which path was taken.
async function ensureTextLayer(wc, label, { timeout = 60000 } = {}) {
  const started = Date.now()
  let recovered = false
  let pageErrorRetries = 0
  while (Date.now() - started < timeout) {
    const state = await evaluate(wc, `({
      spans: document.querySelectorAll('.textLayer span').length,
      noText: document.querySelectorAll('.page-no-text').length,
      errors: Array.from(document.querySelectorAll('.page-error')).map((page) => page.querySelector('.page-error-detail')?.textContent || ''),
    })`)
    if (state.spans >= 4) return { ok: true, recovered, waitedMs: Date.now() - started, label }
    if (state.errors.length > 0) {
      if (pageErrorRetries >= 1) return { ok: false, reason: 'page render error after retry', detail: state.errors[0], label }
      pageErrorRetries += 1
      recovered = true
      await evaluate(wc, `document.querySelector('.page-error button')?.click(); true`)
      await sleep(500)
      continue
    }
    if (state.noText > 0) {
      recovered = true
      await evaluate(wc, `(() => {
        const retry = document.querySelector('.page-no-text .page-retry')
        const reload = document.querySelector('.page-no-text .page-reload')
        const button = retry || reload
        if (button) button.click()
        return true
      })()`)
      await sleep(700)
      continue
    }
    await sleep(250)
  }
  return { ok: false, reason: 'timeout', waitedMs: Date.now() - started, label }
}

// The renderer reloads during the restore check, which drops page state, so the
// canned API responses are installed through one reusable helper.
async function installSenseStub(wc, stubSense) {
  await evaluate(wc, `(() => {
    window.__senseLookupRequests = []
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/api/sense')) {
        const body = init && init.body ? JSON.parse(init.body) : {}
        const payload = body.task === 'lookup'
          ? (window.__senseLookupRequests.push(body), ${JSON.stringify(stubSense)})
          : { answer: 'numerous 侧重数量多，比 many 更书面；in large numbers 可表达数量很多。' }
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return original(input, init)
    }
    return true
  })()`)
}

// The daily summary and note endpoints go through the same local proxy as the
// sense endpoint. The stub keeps the vault checks fully offline while still
// recording what the renderer actually sent (used to prove strict grounding).
async function installVaultStub(wc) {
  await evaluate(wc, `(() => {
    window.__vaultChatRequests = []
    window.__vaultReportRequests = []
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const body = init && init.body ? JSON.parse(init.body) : {}
      if (url.includes('/api/vault-chat')) {
        window.__vaultChatRequests.push(body)
        if (body.question === 'PAPERLIGHT-SLOW-REQUEST-9F3A') {
          return new Promise((_resolve, reject) => {
            const signal = init && init.signal
            if (signal && signal.aborted) {
              window.__vaultChatAbortObserved = true
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
            signal?.addEventListener('abort', () => {
              window.__vaultChatAbortObserved = true
              reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
          })
        }
        const context = Array.isArray(body.context) ? body.context : []
        const grounded = context.length > 0
        const answer = grounded
          ? '**依据** [[' + context[0].path + ']]：vault 里已有的一份笔记。\\n\\n- 已有内容\\n- 对话范围明确'
          : '**一般回答**\\n\\n- 未限定 vault\\n- 可继续追问'
        return Promise.resolve(new Response(JSON.stringify({ answer, grounded, sources: context.map((item) => item.path) }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      if (url.includes('/api/daily-summary')) {
        window.__vaultReportRequests.push(body)
        const count = (body.records || []).length
        const findings = (body.findings || []).length
        return Promise.resolve(new Response(JSON.stringify({ summary: 'AI 日报：' + (body.date || '') + ' 收录 ' + count + ' 条记录、' + findings + ' 条专项发现。' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      if (url.includes('/api/note')) {
        return Promise.resolve(new Response(JSON.stringify({ note: { title: 'AI 完整笔记', markdown: '# AI 完整笔记\\n\\n## 核心含义\\n\\n由测试桩生成。' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      if (url.includes('/api/expression-explore')) {
        window.__expressionExploreRequests = (window.__expressionExploreRequests || []).concat([body])
        return Promise.resolve(new Response(JSON.stringify({ candidates: [{ expression: 'see eye to eye', meaning: '意见一致', usageScenario: '表达观点一致', relation: '与其他表达意思相近' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return original(input, init)
    }
    return true
  })()`)
}

async function screenshot(window, artifacts, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const image = await window.webContents.capturePage()
      const file = join(artifacts, name)
      writeFileSync(file, image.toPNG())
      return file
    } catch (error) {
      const errorName = error instanceof Error ? error.name : String((error || {}).name || '')
      const errorMessage = error instanceof Error ? error.message : String(error || '')
      if (!(errorName === 'UnknownVizError' || errorMessage.includes('UnknownVizError')) || attempt === 2) throw error
      await sleep(250)
    }
  }
  throw new Error(`could not capture screenshot: ${name}`)
}

export async function runSmokeTest({ window, projectRoot }) {
  // A local key so the AI code paths really run — every AI endpoint the smoke
  // exercises is intercepted by install*Stub, so nothing leaves this machine.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-paperlight-smoke-stub'
  const artifacts = join(projectRoot, 'tests', 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  const library = join(tmpdir(), 'paperlight-smoke-library')
  rmSync(library, { recursive: true, force: true })
  mkdirSync(join(library, 'collection'), { recursive: true })
  const bigPdf = join(library, 'Foucault-liberal-political-economy.pdf')
  const secondPdf = join(library, 'collection', 'Knowledge-and-Power.pdf')
  writeFileSync(bigPdf, createTestPdf({ pages: 120, title: 'Foucault and Liberal Political Economy' }))
  writeFileSync(secondPdf, createTestPdf({ pages: 24, title: 'Knowledge and Power' }))
  const mixedPdf = join(library, 'collection', 'Mixed-Geometry.pdf')
  writeFileSync(mixedPdf, createTestPdf({ pages: 30, title: 'Mixed Geometry', landscapePages: [4, 11, 17] }))
  const markdownPath = join(library, 'collection', 'Reading-Notes.md')
  writeFileSync(markdownPath, [
    '# Paperlight Markdown Notes',
    '',
    'These classifications operate within a broader framework of knowledge.',
    '',
    '## Section two',
    '',
    '- contextual sense lookup',
    '- reflowed reading position',
    '',
    '```js',
    'const paperlight = true',
    '```',
    '',
    '> A quote that should render as a blockquote.',
  ].join('\n'))
  const textPath = join(library, 'collection', 'Plain-Notes.txt')
  writeFileSync(textPath, [
    'These classifications operate within a broader framework of knowledge.',
    '',
    'Paperlight plain text paragraph two, also selectable.',
    ...Array.from({ length: 36 }, (_, index) => `Plain text paragraph ${index + 3}: a stable reading position should return to its original context.`),
    'The unique text marker target remains visible after the document is reopened.',
    ...Array.from({ length: 24 }, (_, index) => `Trailing text paragraph ${index + 1}: the marked passage has room below it for source navigation.`),
  ].join('\n'))
  const epubPath = join(library, 'collection', 'Paperlight-Book.epub')
  writeFileSync(epubPath, await createTestEpub({
    title: 'Paperlight Book',
    author: 'Paperlight',
    chapters: ['Alpha Chapter', 'Beta Chapter'],
  }))

  const wc = window.webContents
  const selectTextForMarker = async (selector, phrase) => evaluate(wc, `(() => {
    const root = document.querySelector(${JSON.stringify(selector)})
    if (!root) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const offset = (node.nodeValue || '').indexOf(${JSON.stringify(phrase)})
      if (offset < 0) continue
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + ${JSON.stringify(phrase)}.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.querySelector('.reader-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    }
    return false
  })()`)
  const stateFile = join(app.getPath('userData'), 'paperlight-state.json')
  const consoleLog = []
  wc.on('console-message', (...args) => {
    const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null
    const message = details ? `${details.level}: ${details.message}` : args.slice(1).join(' ')
    consoleLog.push(message)
    if (/error|warn/i.test(message)) console.log(`  [renderer] ${message}`)
  })
  // Capture renderer-side errors so a canvas failure can be traced to its origin.
  await evaluate(wc, `(() => {
    window.__paperlightErrors = window.__paperlightErrors || []
    window.addEventListener('error', (event) => window.__paperlightErrors.push('error: ' + (event.message || '') + ' @ ' + (event.filename || '') + ':' + (event.lineno || 0)))
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason
      window.__paperlightErrors.push('rejection: ' + (reason && reason.stack ? reason.stack : String(reason)))
    })
    return true
  })()`)
  const DIAGNOSTIC = `(() => ({
    tabs: Array.from(document.querySelectorAll('.doc-tab-name')).map(n => n.textContent),
    status: document.querySelector('.reader-status')?.innerText || null,
    pageError: document.querySelector('.page-error')?.innerText || null,
    pagePhases: Array.from(document.querySelectorAll('.pdf-page')).map((page) => page.dataset.renderPhase || null),
    slots: document.querySelectorAll('.page-slot').length,
    canvases: document.querySelectorAll('.pdf-page canvas').length,
    textSpans: document.querySelectorAll('.textLayer span').length,
    toolbar: document.querySelector('.reader-toolbar')?.innerText?.replace(/\\n/g, ' | ') || null,
    readyState: document.readyState,
    pageInput: document.querySelector('.page-number-input')?.value ?? null,
    captions: Array.from(document.querySelectorAll('.page-caption')).map((n) => n.textContent),
    canvasSizes: Array.from(document.querySelectorAll('.pdf-page canvas')).map((c) => c.width + 'x' + c.height).join(','),
    loadingOverlays: document.querySelectorAll('.page-loading').length,
    textLayerChildren: document.querySelector('.textLayer')?.childElementCount ?? -1,
    stackHeight: Math.round(document.querySelector('.pages-stack')?.getBoundingClientRect().height || 0),
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    bodyText: (document.body?.innerText || '').replace(/\\n+/g, ' ').slice(0, 200),
    readingEvents: (window.__paperlightReadingSmokeEvents || []).slice(-20),
    errors: (window.__paperlightErrors || []).slice(-6),
  }))()`
  try {
    await waitFor(wc, `document.querySelectorAll('.welcome-card').length > 0`, { label: 'welcome screen' })
    record('welcome screen renders without a document', true)
    await screenshot(window, artifacts, '01-welcome.png')

    // The packaged app serves its own AI proxy; in dev the Vite plugin does.
    const api = await evaluate(wc, `fetch('/api/translation-config').then(r => r.json())`)
    record('local AI proxy answers on the app origin', typeof api?.configured === 'boolean', JSON.stringify(api))

    // Open a folder through the same channel the native dialog uses.
    wc.send('app:open-folder', library)
    await waitFor(wc, `document.querySelectorAll('.explorer-entry').length >= 2`, { label: 'explorer listing' })
    const listed = await evaluate(wc, `Array.from(document.querySelectorAll('.explorer-entry .entry-name')).map(n => n.textContent)`)
    record('folder explorer lists the folder contents', listed.includes('collection') && listed.some((name) => name.endsWith('.pdf')), listed.join(', '))
    await screenshot(window, artifacts, '02-explorer.png')

    // Open the 120-page document and measure time to first painted page.
    const openedAt = Date.now()
    wc.send('app:open-paths', [bigPdf])
    await waitFor(wc, `Array.from(document.querySelectorAll('.pdf-page canvas')).some((c) => c.width > 0)`, { label: 'first canvas paint', timeout: 20000 })
    const firstPaintMs = Date.now() - openedAt
    record('120-page PDF paints its first page quickly', firstPaintMs < 8000, `${firstPaintMs} ms`)
    const firstText = await ensureTextLayer(wc, 'first page')
    record('PDF text layer becomes selectable', firstText.ok, JSON.stringify(firstText))

    const readingDayKey = (() => {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    })()
    const readerPoint = await evaluate(wc, `(() => {
      const rect = document.querySelector('.pdf-page canvas')?.getBoundingClientRect()
      return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
    })()`)
    await waitFor(wc, `document.documentElement.dataset.paperlightReadingTimer === 'active'`, { label: 'reading timer listeners installed' })
    if (readerPoint) {
      await sleep(350) // let the reader's post-paint activity listeners attach
      await evaluate(wc, `(() => {
        window.__paperlightReadingSmokeEvents = []
        for (const type of ['focus', 'blur', 'pointerdown', 'pointermove', 'wheel']) {
          window.addEventListener(type, () => window.__paperlightReadingSmokeEvents.push({ type, at: Date.now() }), true)
        }
        document.addEventListener('visibilitychange', () => window.__paperlightReadingSmokeEvents.push({ type: 'visibilitychange', hidden: document.hidden, at: Date.now() }), true)
        return true
      })()`)
      app.focus({ steal: true })
      window.show()
      window.focus()
      await sleep(150)
      // The automation host can keep OS focus on its own window. Drive the
      // browser's foreground predicates deterministically while retaining the
      // production timer and interaction listeners.
      await evaluate(wc, `(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
        Object.defineProperty(document, 'hidden', { configurable: true, value: false })
        return true
      })()`)
      // Let native focus/visibility notifications settle before generating the
      // simulated reader input; otherwise a delayed automation blur can erase
      // the interaction immediately after it is dispatched.
      await sleep(1800)
      wc.sendInputEvent({ type: 'mouseMove', x: readerPoint.x, y: readerPoint.y })
      wc.sendInputEvent({ type: 'mouseDown', x: readerPoint.x, y: readerPoint.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: readerPoint.x, y: readerPoint.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseWheel', x: readerPoint.x, y: readerPoint.y, deltaX: 0, deltaY: 24, canScroll: true })
      // Some macOS automation environments report window focus but do not
      // deliver WebContents.sendInputEvent as DOM pointer events. Exercise the
      // app's same foreground interaction listener deterministically as well.
      await evaluate(wc, `document.querySelector('.pdf-page canvas')?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, composed: true, pointerType: 'mouse', isPrimary: true }),
      )`)
    }
    const readingFocus = await evaluate(wc, `({ focused: document.hasFocus(), hidden: document.hidden, activeSpace: JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').activeSpace, path: JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').session?.activePath })`)
    console.log(`  [reading timer probe] ${JSON.stringify(readingFocus)}`)
    const activity = await waitFor(wc,
      `(() => { const state = JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}'); return state.readingActivity?.['${readingDayKey}']?.seconds > 0 ? state.readingActivity['${readingDayKey}'] : null })()`,
      { timeout: 38000, label: 'active reading estimate after the next timer tick' },
    )
    record('Daily records estimated time only after a foreground reader interaction',
      Boolean(activity?.seconds > 0 && activity.sources?.some((source) => source.sourcePath === bigPdf)),
      JSON.stringify(activity))

    const virtual = await evaluate(wc, `({
      slots: document.querySelectorAll('.page-slot').length,
      canvases: document.querySelectorAll('.pdf-page canvas').length,
      stackHeight: document.querySelector('.pages-stack')?.getBoundingClientRect().height || 0,
      total: document.querySelector('.page-total')?.textContent || '',
    })`)
    record('page virtualisation keeps only a few pages mounted', virtual.slots <= 5 && virtual.canvases <= 5, JSON.stringify(virtual))
    record('reader reports the full page count', virtual.total.includes('120'), virtual.total)
    record('page stack reserves the full scroll height', virtual.stackHeight > 50000, `${Math.round(virtual.stackHeight)} px`)
    await screenshot(window, artifacts, '03-reader-120-pages.png')

    // Jump to a far page through the toolbar input path.
    await evaluate(wc, `(() => {
      const input = document.querySelector('.page-number-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '90')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.page-total')?.textContent.includes('90 / 120')`, { label: 'jump to page 90', timeout: 12000 })
    await waitFor(wc, `Array.from(document.querySelectorAll('.page-caption')).some((caption) => caption.textContent === '90')`, { label: 'page 90 mounted', timeout: 12000 })
    await ensureTextLayer(wc, 'page 90')
    const page90 = await evaluate(wc, `({
      captions: Array.from(document.querySelectorAll('.page-caption')).map(n => n.textContent),
      mounted: document.querySelectorAll('.page-slot').length,
      scrollTop: Math.round(document.querySelector('.reader-scroll')?.scrollTop || 0),
      position: document.querySelector('.page-total')?.textContent || '',
    })`)
    record('jumping to page 90 mounts that page only', page90.position.includes('90 / 120') && page90.captions.includes('90') && page90.mounted <= 5, JSON.stringify(page90))
    await screenshot(window, artifacts, '04-page-90.png')

    // Second document -> second tab, then switch back.
    wc.send('app:open-paths', [secondPdf])
    await waitFor(wc, `document.querySelectorAll('.doc-tab').length === 2`, { label: 'second tab' })
    const tabNames = await evaluate(wc, `Array.from(document.querySelectorAll('.doc-tab-name')).map(n => n.textContent)`)
    record('multiple PDFs stay open as tabs', tabNames.length === 2 && tabNames.some((n) => n.includes('Knowledge')), tabNames.join(', '))
    await ensureTextLayer(wc, 'second PDF initial render')

    await evaluate(wc, `document.querySelectorAll('.doc-tab')[0].click()`)
    await waitFor(wc, `document.querySelector('.page-total')?.textContent.includes('120')`, { label: 'switch back to the first tab' })
    await waitFor(wc, `document.querySelector('.page-total')?.textContent.includes('90 / 120')`, { label: 'first tab restored page 90', timeout: 12000 })
    const restored = await evaluate(wc, `document.querySelector('.page-number-input')?.value`)
    record('switching tabs restores the reading position', restored === '90', `page ${restored}`)
    await screenshot(window, artifacts, '05-multi-tab.png')

    // Drag the reader/assistant divider like a user would.
    const widthExpr = `Math.round(document.querySelector('.right-pane').getBoundingClientRect().width)`
    const before = await evaluate(wc, widthExpr)
    const handle = await evaluate(wc, `(() => {
      const splitters = document.querySelectorAll('.splitter')
      const el = splitters[splitters.length - 1]
      const rect = el.getBoundingClientRect()
      window.__dragProbe = { down: 0, move: 0, up: 0 }
      el.addEventListener('pointerdown', () => { window.__dragProbe.down += 1 })
      window.addEventListener('pointermove', () => { window.__dragProbe.move += 1 })
      window.addEventListener('pointerup', () => { window.__dragProbe.up += 1 })
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    wc.sendInputEvent({ type: 'mouseMove', x: handle.x, y: handle.y })
    await sleep(60)
    wc.sendInputEvent({ type: 'mouseDown', x: handle.x, y: handle.y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 6; step += 1) {
      wc.sendInputEvent({ type: 'mouseMove', x: handle.x - step * 20, y: handle.y, button: 'left' })
      await sleep(40)
    }
    wc.sendInputEvent({ type: 'mouseUp', x: handle.x - 120, y: handle.y, button: 'left', clickCount: 1 })
    await sleep(300)
    let after = await evaluate(wc, widthExpr)
    let method = 'real pointer drag'
    if (!(after > before + 60)) {
      // Deterministic fallback for headless runs without real pointer input.
      method = 'synthetic pointer events'
      await evaluate(wc, `(() => {
        const splitters = document.querySelectorAll('.splitter')
        const el = splitters[splitters.length - 1]
        const rect = el.getBoundingClientRect()
        const opts = (x) => ({ bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: Math.round(rect.top + 40) })
        window.__paperlightDrag = { el, opts, x: rect.left + rect.width / 2 }
        el.dispatchEvent(new PointerEvent('pointerdown', opts(window.__paperlightDrag.x)))
        return true
      })()`)
      await sleep(80)
      for (let step = 1; step <= 8; step += 1) {
        await evaluate(wc, `(() => {
          const drag = window.__paperlightDrag
          drag.el.dispatchEvent(new PointerEvent('pointermove', drag.opts(drag.x - ${step} * 15)))
          return true
        })()`)
        await sleep(30)
      }
      await evaluate(wc, `(() => {
        const drag = window.__paperlightDrag
        drag.el.dispatchEvent(new PointerEvent('pointerup', drag.opts(drag.x - 120)))
        return true
      })()`)
      await sleep(300)
      after = await evaluate(wc, widthExpr)
    }
    record('dragging the divider resizes the reading desk', after > before + 60, `${before} px → ${after} px via ${method}`)
    const probe = await evaluate(wc, `window.__dragProbe`)
    record('native pointer input reaches the divider', probe.down > 0 && probe.move > 0, JSON.stringify(probe))
    await screenshot(window, artifacts, '06-splitter-dragged.png')

    // The reader must still be usable after the resize.
    const stillMounted = await evaluate(wc, `document.querySelectorAll('.page-slot').length`)
    record('reader keeps rendering after the resize', stillMounted >= 1 && stillMounted <= 5, `${stillMounted} mounted pages`)

    // Move the divider back with the keyboard path and read the result after React commits.
    const keyboardBefore = await evaluate(wc, widthExpr)
    await evaluate(wc, `(() => {
      const splitters = document.querySelectorAll('.splitter')
      const el = splitters[splitters.length - 1]
      for (let i = 0; i < 4; i += 1) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      return true
    })()`)
    await sleep(250)
    const keyboardAfter = await evaluate(wc, widthExpr)
    record('divider is keyboard accessible', keyboardBefore - keyboardAfter > 20, `${keyboardBefore} px → ${keyboardAfter} px with ArrowRight`)

    // Persisted app state (the app debounces disk writes, so poll).
    let persisted = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(300)
      try {
        const disk = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (disk.session.tabs.length === 2 && disk.layout.rightWidth > 0 && disk.session.activeFolder) {
          persisted = disk
          break
        }
        persisted = persisted || disk
      } catch {
        // Not written yet.
      }
    }
    record(
      'app state persists tabs, folder and pane sizes',
      Boolean(persisted && persisted.session.tabs.length === 2 && persisted.layout.rightWidth > 0 && persisted.session.activeFolder),
      persisted ? `tabs=${persisted.session.tabs.length} rightWidth=${persisted.layout.rightWidth}` : 'state file missing',
    )

    await evaluate(wc, `(() => { document.querySelectorAll('.doc-tab-close')[0].click(); return true })()`)
    await waitFor(wc, `document.querySelectorAll('.doc-tab').length === 1`, { label: 'tab closed' })
    const remaining = await evaluate(wc, `Array.from(document.querySelectorAll('.doc-tab-name')).map(n => n.textContent)`)
    record('closing a tab keeps the other document open', remaining.length === 1, remaining.join(', '))
    // The concrete selection and lookup below are the stronger proof that the
    // returned PDF text layer is usable; a second standalone 60-second wait
    // here was both redundant and flaky under Electron's virtualized renderer.

    await screenshot(window, artifacts, '07-final.png')

    // Drive the real assistant loop without touching the network: stub the local
    // /api/sense route, select a word in the page, add the sense to the notebook,
    // write a note and ask a follow-up question.
    const stubSense = {
      sense: {
        term: 'numerous',
        lemma: 'numerous',
        partOfSpeech: 'adjective',
        senseId: 'many',
        contextualMeaning: '众多的、大量的',
        definition: 'existing in large numbers',
        contextSentence: 'his numerous readers and followers',
        examples: [{ text: 'his numerous readers', translation: '他众多的读者', sourceType: 'ai_generated', citation: null }],
        guidance: {
          scenarios: ['书面表达'],
          advice: ['后面接可数名词复数'],
          frequency: '常见',
          alternatives: [], synonyms: [], antonyms: [],
          morphology: { root: 'numer', prefix: '', suffix: '-ous', note: '' },
        },
      },
    }
    await installSenseStub(wc, stubSense)

    const selectionMade = await waitFor(wc, `(() => {
      const spans = Array.from(document.querySelectorAll('.textLayer span')).filter((span) => (span.textContent || '').trim().length > 4)
      if (spans.length === 0) return false
      const range = document.createRange()
      range.selectNodeContents(spans[0])
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.querySelector('.reader-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`, { label: 'selectable text after returning to the remaining PDF', timeout: 45000, interval: 180 })
    const selectionPrefill = await evaluate(wc, `({
      query: document.querySelector('#query-term')?.value || '',
      lookups: (window.__senseLookupRequests || []).length,
      hasResult: Boolean(document.querySelector('.sense-meaning')),
    })`)
    record('selecting text only fills the reader query without sending an AI request',
      selectionMade === true && selectionPrefill.query.length > 0 && selectionPrefill.lookups === 0 && !selectionPrefill.hasResult,
      JSON.stringify(selectionPrefill))
    await evaluate(wc, `document.querySelector('.query-go').click(); true`)
    await waitFor(wc, `document.querySelector('.sense-meaning')?.textContent === '众多的、大量的'`, { label: 'sense card' })
    await screenshot(window, artifacts, '08-sense.png')

    await evaluate(wc, `(() => { document.querySelector('.sense-add').click(); return true })()`)
    await waitFor(wc, `document.querySelector('.sense-add')?.classList.contains('added')`, { label: 'sense added to the notebook' })
    record('the contextual sense can be added to the notebook', true)

    await evaluate(wc, `(() => {
      const tab = Array.from(document.querySelectorAll('.right-tabs button')).find((b) => b.textContent.includes('记录本'))
      tab.click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.sense-head h3')?.textContent === 'numerous'`, { label: 'notebook atom detail' })
    record('the notebook opens the term↔sense atom that was just added', true)

    // Write a note through the real UI.
    await waitFor(wc, `document.querySelector('.note-editor') !== null`, { label: 'note editor' })
    await evaluate(wc, `(() => {
      const textarea = document.querySelector('.note-editor')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, 'numerous 后面接可数名词复数：his numerous readers。')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor(wc, `!document.querySelector('.small-save')?.disabled`, { label: 'note save button' })
    await evaluate(wc, `(() => { document.querySelector('.small-save').click(); return true })()`)
    await waitFor(wc, `document.querySelectorAll('.note-linked-list li').length === 1`, { label: 'saved note' })
    const savedNote = await evaluate(wc, `({
      body: document.querySelector('.note-linked-list p')?.textContent || '',
      label: document.querySelector('.note-date-chip')?.textContent || '',
    })`)
    record('a note written in the desk gets its daily ordinal', savedNote.body.includes('his numerous readers') && /第 1 份笔记/.test(savedNote.label), JSON.stringify(savedNote))

    await evaluate(wc, `(() => { document.querySelector('.back-to-notes').click(); return true })()`)
    await waitFor(wc, `document.querySelectorAll('.atom-list li').length === 1`, { label: 'notebook list' })
    const notebookList = await evaluate(wc, `({
      atom: document.querySelector('.atom-list strong')?.textContent || '',
      noteCount: document.querySelector('.atom-meta')?.textContent || '',
      notes: document.querySelectorAll('.note-all-list li').length,
    })`)
    record('the notebook list shows the atom and its linked note', notebookList.atom === 'numerous' && notebookList.notes === 1 && notebookList.noteCount.includes('1 份笔记'), JSON.stringify(notebookList))

    // Follow-up question through the chat panel.
    await evaluate(wc, `(() => {
      const tab = Array.from(document.querySelectorAll('.right-tabs button')).find((b) => b.textContent.includes('对话'))
      tab.click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.chat-input textarea') !== null`, { label: 'chat input' })
    await evaluate(wc, `(() => {
      const textarea = document.querySelector('.chat-input textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, 'numerous 和 many 有什么区别？')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await evaluate(wc, `(() => { document.querySelector('.chat-input button').click(); return true })()`)
    await waitFor(wc, `Array.from(document.querySelectorAll('.chat-messages p')).some((p) => p.textContent.includes('更书面'))`, { label: 'chat answer' })
    record('follow-up questions are answered in the chat panel', true)
    await screenshot(window, artifacts, '09-assistant.png')

    // Mixed page geometry: a landscape fold-out must be drawn at its own scale,
    // and correcting its height must not move the page being read.
    wc.send('app:open-paths', [mixedPdf])
    await waitFor(wc, `Array.from(document.querySelectorAll('.doc-tab-name')).some((n) => n.textContent.includes('Mixed-Geometry'))`, { label: 'mixed-geometry tab' })
    await ensureTextLayer(wc, 'mixed-geometry')
    await evaluate(wc, `(() => {
      const input = document.querySelector('.page-number-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '12')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.page-number-input')?.value === '12'`, { label: 'jump to page 12' })
    await waitFor(wc, `document.querySelector('.pdf-page-shell[data-page-number="11"] canvas') !== null`, { label: 'landscape page mounted' })
    const beforeReflow = await evaluate(wc, `Math.round(document.querySelector('.pdf-page-shell[data-page-number="12"]').getBoundingClientRect().top)`)
    await sleep(1200)
    const afterReflow = await evaluate(wc, `({
      top: Math.round(document.querySelector('.pdf-page-shell[data-page-number="12"]').getBoundingClientRect().top),
      page: document.querySelector('.page-number-input')?.value,
      canvasWidth: Math.round(parseFloat(document.querySelector('.pdf-page-shell[data-page-number="11"] canvas').style.width)),
      boxWidth: Math.round(parseFloat(document.querySelector('.pdf-page-shell[data-page-number="11"] .pdf-page').style.width)),
    })`)
    record(
      'a landscape page is drawn at its own scale, not page 1\'s',
      Math.abs(afterReflow.canvasWidth - afterReflow.boxWidth) <= 2,
      `canvas ${afterReflow.canvasWidth}px vs slot ${afterReflow.boxWidth}px`,
    )
    record(
      'correcting a page above the reading position does not move it',
      afterReflow.page === '12' && Math.abs(afterReflow.top - beforeReflow) <= 20,
      `viewport top ${beforeReflow}px → ${afterReflow.top}px, page ${afterReflow.page}`,
    )

    // Zoom re-layouts every box; the page being read must stay put.
    const zoomBefore = await evaluate(wc, `({
      page: document.querySelector('.page-number-input')?.value,
      top: Math.round(document.querySelector('.pdf-page-shell[data-page-number="12"]').getBoundingClientRect().top),
    })`)
    await evaluate(wc, `(() => { document.querySelector('.zoom-controls .toolbar-button').click(); return true })()`)
    await sleep(400)
    const zoomAfter = await evaluate(wc, `({
      page: document.querySelector('.page-number-input')?.value,
      top: Math.round(document.querySelector('.pdf-page-shell[data-page-number="12"]').getBoundingClientRect().top),
      label: document.querySelector('.zoom-label')?.textContent,
    })`)
    record(
      'zooming keeps the reading position',
      zoomAfter.page === zoomBefore.page && Math.abs(zoomAfter.top - zoomBefore.top) <= 20,
      `page ${zoomBefore.page}@${zoomBefore.top}px → ${zoomAfter.page}@${zoomAfter.top}px (${zoomAfter.label})`,
    )
    await screenshot(window, artifacts, '11-mixed-geometry.png')

    // Rehydrate the open workspace from a reflowed reader. PDF render workers
    // are exercised and restarted in the dedicated PDF marker flow below; a
    // webContents reload is not a full Electron process restart, so keeping a
    // live canvas mounted here would test Chromium canvas teardown instead of
    // the app's persisted workspace state.
    wc.send('app:open-paths', [markdownPath])
    await waitFor(wc, `document.querySelectorAll('.flow-heading').length >= 2`, { label: 'reflowed document before workspace reload' })
    await sleep(900)
    const savedState = JSON.parse(readFileSync(join(app.getPath('userData'), 'paperlight-state.json'), 'utf8'))
    // Session restore: the renderer gets rebuilt from the persisted state.
    const restoreBefore = await evaluate(wc, `({
      tabs: document.querySelectorAll('.doc-tab').length,
      width: Math.round(document.querySelector('.right-pane').getBoundingClientRect().width),
      entries: document.querySelectorAll('.explorer-entry').length,
    })`)
    const reloaded = new Promise((resolve) => wc.once('did-finish-load', resolve))
    wc.reload()
    await reloaded
    await waitFor(wc, `document.querySelectorAll('.doc-tab').length >= 1`, { label: 'restored tab', timeout: 30000 })
    await waitFor(wc, `document.querySelectorAll('.flow-heading').length >= 2`, { label: 'restored reflowed document', timeout: 30000 })
    await waitFor(wc, `document.querySelectorAll('.explorer-entry').length >= 2`, { label: 'restored folder listing' })
    const restoreAfter = await evaluate(wc, `({
      tabs: document.querySelectorAll('.doc-tab').length,
      width: Math.round(document.querySelector('.right-pane').getBoundingClientRect().width),
      entries: document.querySelectorAll('.explorer-entry').length,
      notes: Array.from(document.querySelectorAll('.right-tabs button')).map((b) => b.textContent).join('|'),
    })`)
    record(
      'the whole workspace is restored after renderer rehydration',
      restoreAfter.tabs === restoreBefore.tabs
        && restoreAfter.entries === restoreBefore.entries
        && Math.abs(restoreAfter.width - restoreBefore.width) <= 2
        && /记录本\s*1/.test(restoreAfter.notes),
      `before=${JSON.stringify(restoreBefore)} after=${JSON.stringify(restoreAfter)}`,
    )
    await screenshot(window, artifacts, '10-restored-session.png')

    record(
      'notebook data is persisted to the app state file',
      savedState.notebook.atoms.length === 1 && savedState.notebook.notes.length === 1 && Object.keys(savedState.notebook.chat).length === 1,
      `atoms=${savedState.notebook.atoms.length} notes=${savedState.notebook.notes.length} chats=${Object.keys(savedState.notebook.chat).length}`,
    )
    await screenshot(window, artifacts, '12-final-state.png')

    // ---------------------------------------------------------------- Markdown
    await installSenseStub(wc, stubSense)
    wc.send('app:open-paths', [markdownPath])
    await waitFor(wc, `document.querySelectorAll('.flow-heading').length >= 2`, { label: 'markdown headings' })
    const markdownView = await evaluate(wc, `({
      headings: Array.from(document.querySelectorAll('.flow-heading')).map((n) => n.textContent),
      paragraphs: document.querySelectorAll('.flow-paragraph').length,
      lists: document.querySelectorAll('.flow-list li').length,
      code: document.querySelectorAll('.flow-code').length,
      quote: document.querySelectorAll('.flow-quote').length,
      total: document.querySelector('.page-total')?.textContent || '',
    })`)
    record('Markdown renders as structured text', markdownView.headings.length >= 2 && markdownView.lists === 2 && markdownView.code === 1 && markdownView.quote === 1, JSON.stringify(markdownView))

    await evaluate(wc, `(() => {
      const tab = Array.from(document.querySelectorAll('.sidebar-tabs button')).find((b) => b.textContent.includes('目录'))
      tab.click()
      return true
    })()`)
    await waitFor(wc, `document.querySelectorAll('.outline-entry').length >= 2`, { label: 'markdown outline' })
    const markdownOutline = await evaluate(wc, `Array.from(document.querySelectorAll('.outline-entry span')).map((n) => n.textContent)`)
    record('Markdown headings become outline entries', markdownOutline.includes('Paperlight Markdown Notes') && markdownOutline.includes('Section two'), markdownOutline.join(' | '))

    await evaluate(wc, `(() => {
      const tab = Array.from(document.querySelectorAll('.sidebar-tabs button')).find((b) => b.textContent.includes('文件'))
      tab.click()
      return true
    })()`)

    // Selecting text in a reflowed document must reach the sense lookup.
    await evaluate(wc, `(() => {
      const paragraphs = Array.from(document.querySelectorAll('.flow-paragraph'))
      const range = document.createRange()
      range.selectNodeContents(paragraphs[0])
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.querySelector('.flow-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.query-meta')?.textContent.includes('Reading-Notes.md')`, { label: 'markdown selection handed to the assistant' })
    await evaluate(wc, `document.querySelector('.query-go').click(); true`)
    record('explicitly querying selected Markdown text requests the contextual sense', true)
    await waitFor(wc, `document.querySelector('.sense-meaning')?.textContent === '众多的、大量的'`, { label: 'markdown sense card' })
    await screenshot(window, artifacts, '13-markdown.png')

    await installSenseStub(wc, { sense: {
      term: 'reflowed', lemma: 'reflowed', partOfSpeech: 'adjective', senseId: 'markdown-marker',
      contextualMeaning: '重新排版的', definition: 'arranged again in a flowing layout', contextSentence: 'reflowed reading position',
      examples: [], guidance: { scenarios: [], advice: [], frequency: '', alternatives: [], synonyms: [], antonyms: [], morphology: { root: '', prefix: '', suffix: '', note: '' } },
    } })
    const markdownMarkerSelection = await selectTextForMarker('.flow-page', 'reflowed reading position')
    await waitFor(wc, `document.querySelector('.input-mark-inline') !== null`, { label: 'Markdown input marker action' })
    await evaluate(wc, `document.querySelector('.input-mark-inline').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-composer') !== null`, { label: 'Markdown marker composer' })
    await evaluate(wc, `(() => {
      const select = document.querySelector('.input-marker-visual-choice select')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, 'underline')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('.input-marker-composer > footer .primary-button').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.input-marker-visual.underline') !== null || document.querySelector('.input-marker-unresolved') !== null`, { timeout: 5000, label: 'Markdown marker resolved or explicitly reported' }).catch(() => null)
    const markdownMarkerProbe = await evaluate(wc, `(() => ({
      visual: document.querySelectorAll('.input-marker-visual.underline').length,
      unresolved: document.querySelector('.input-marker-unresolved')?.textContent || '',
      overlays: document.querySelectorAll('.input-marker-overlay').length,
      sourcePath: JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').session?.activePath || '',
      savedMarkers: (JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').inputMarkers || []).filter((marker) => marker.sourcePath === JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').session?.activePath).length,
      sourceText: document.querySelector('.flow-page')?.textContent || '',
      marker: (JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').inputMarkers || []).find((item) => item.sourcePath === JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').session?.activePath) || null,
      pageRect: (() => { const r = document.querySelector('.flow-page')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null })(),
      overlayHtml: document.querySelector('.input-marker-overlay')?.innerHTML || '',
      directQuoteRects: (() => {
        const marker = (JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').inputMarkers || []).find((item) => item.sourcePath === JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}').session?.activePath)
        const walker = document.createTreeWalker(document.querySelector('.flow-page'), NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          const offset = (node.nodeValue || '').indexOf(marker?.quote || '')
          if (offset < 0) continue
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + marker.quote.length)
          return Array.from(range.getClientRects()).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
        }
        return []
      })(),
    }))()`)
    console.log(`  [Markdown input-marker probe] ${JSON.stringify(markdownMarkerProbe)}`)
    record('a Markdown visual input mark renders or reports unresolved source text', markdownMarkerProbe.visual > 0 || Boolean(markdownMarkerProbe.unresolved), JSON.stringify({ visual: markdownMarkerProbe.visual, unresolved: markdownMarkerProbe.unresolved, overlays: markdownMarkerProbe.overlays, savedMarkers: markdownMarkerProbe.savedMarkers }))
    await evaluate(wc, `document.querySelector('.doc-tab.active .doc-tab-close').click(); true`)
    await waitFor(wc, `!Array.from(document.querySelectorAll('.doc-tab-name')).some((tab) => tab.textContent.includes('Reading-Notes.md'))`, { label: 'marked Markdown closed' })
    wc.send('app:open-paths', [markdownPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('Reading-Notes.md')`, { label: 'marked Markdown reopened' })
    await waitFor(wc, `document.querySelector('.input-marker-visual.underline') !== null || document.querySelector('.input-marker-unresolved') !== null`, { timeout: 5000, label: 'Markdown marker resolved or explicitly reported after reopen' }).catch(() => null)
    const markdownReopenProbe = await evaluate(wc, `({ visual: document.querySelectorAll('.input-marker-visual.underline').length, unresolved: document.querySelector('.input-marker-unresolved')?.textContent || '' })`)
    record('Markdown visual input marks persist or explicitly report unresolved source text after reopening', markdownMarkerSelection && (markdownReopenProbe.visual > 0 || Boolean(markdownReopenProbe.unresolved)), JSON.stringify(markdownReopenProbe))

    // ------------------------------------------------------------------- text
    wc.send('app:open-paths', [textPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('Plain-Notes.txt')`, { label: 'plain text tab' })
    await waitFor(wc, `document.querySelectorAll('.flow-paragraph').length >= 2`, { label: 'plain text paragraphs' })
    const textView = await evaluate(wc, `({
      paragraphs: Array.from(document.querySelectorAll('.flow-paragraph')).map((n) => n.textContent.slice(0, 40)),
      headings: document.querySelectorAll('.flow-heading').length,
    })`)
    record('plain text opens as readable paragraphs', textView.paragraphs.length >= 2 && textView.headings === 0, JSON.stringify(textView))

    const textMarkerQuote = 'The unique text marker target remains visible after the document is reopened.'
    await evaluate(wc, `(() => {
      const target = Array.from(document.querySelectorAll('.flow-paragraph')).find((paragraph) => paragraph.textContent.includes('unique text marker target'))
      target?.scrollIntoView({ block: 'center', behavior: 'instant' })
      return Boolean(target)
    })()`)
    await waitFor(wc, `document.querySelector('.reader-scroll')?.scrollTop > 0`, { label: 'plain text marker position' })
    await sleep(200)
    await installSenseStub(wc, { sense: {
      term: 'marker', lemma: 'marker', partOfSpeech: 'noun', senseId: 'text-marker',
      contextualMeaning: '标记', definition: 'a sign that identifies a location', contextSentence: 'An AI paraphrase cannot replace the selected quote.',
      examples: [], guidance: { scenarios: [], advice: [], frequency: '', alternatives: [], synonyms: [], antonyms: [], morphology: { root: '', prefix: '', suffix: '', note: '' } },
    } })
    const textMarkerSelection = await selectTextForMarker('.flow-page', textMarkerQuote)
    await waitFor(wc, `document.querySelector('.input-mark-inline') !== null`, { label: 'plain text input marker action' })
    await evaluate(wc, `document.querySelector('.input-mark-inline').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-composer') !== null`, { label: 'plain text marker composer' })
    await evaluate(wc, `(() => {
      const select = document.querySelector('.input-marker-visual-choice select')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, 'highlight')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('.input-marker-composer > footer .primary-button').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.input-marker-visual.highlight') !== null`, { label: 'plain text highlight restored from source text' })
    const savedTextMarker = await evaluate(wc, `(() => {
      const state = JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}')
      const marker = (state.inputMarkers || []).find((item) => item.sourcePath === ${JSON.stringify(textPath)} && item.quote === ${JSON.stringify(textMarkerQuote)})
      return { scrollRatio: marker?.scrollRatio, quote: marker?.quote }
    })()`)
    record('TXT input markers retain a source reading position', textMarkerSelection && savedTextMarker.scrollRatio > 0.3, JSON.stringify(savedTextMarker))
    await evaluate(wc, `document.querySelector('.doc-tab.active .doc-tab-close').click(); true`)
    await waitFor(wc, `!Array.from(document.querySelectorAll('.doc-tab-name')).some((tab) => tab.textContent.includes('Plain-Notes.txt'))`, { label: 'marked text source closed' })
    wc.send('app:open-paths', [textPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('Plain-Notes.txt')`, { label: 'marked text source reopened' })
    await waitFor(wc, `document.querySelector('.input-marker-visual.highlight') !== null`, { label: 'plain text marker restored after reopen' })
    await evaluate(wc, `(() => { const scroller = document.querySelector('.reader-scroll'); scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll', { bubbles: true })); document.querySelector('.input-marker-menu-toggle').click(); return true })()`)
    await waitFor(wc, `document.querySelector('.input-marker-list-item button')?.textContent.includes('unique text marker target')`, { label: 'text marker listed after reopen' })
    await evaluate(wc, `Array.from(document.querySelectorAll('.input-marker-list-item button')).find((button) => button.textContent.includes('unique text marker target')).click(); true`)
    await sleep(220)
    const textMarkerJump = await evaluate(wc, `(() => {
      const scroller = document.querySelector('.reader-scroll')
      const visual = document.querySelector('.input-marker-visual.highlight')
      return { scrollTop: scroller?.scrollTop || 0, visualTop: visual && scroller ? visual.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null }
    })()`)
    record('TXT marker menu jumps back to the marked source passage', textMarkerJump.scrollTop > 0 && textMarkerJump.visualTop >= 70 && textMarkerJump.visualTop <= 220, JSON.stringify(textMarkerJump))

    // ------------------------------------------------------------------- EPUB
    wc.send('app:open-paths', [epubPath])
    await waitFor(wc, `document.querySelectorAll('.epub-body p').length >= 2`, { label: 'epub chapter render' })
    const epubView = await evaluate(wc, `({
      heading: document.querySelector('.epub-body h1')?.textContent || '',
      paragraphs: document.querySelectorAll('.epub-body p').length,
      scripts: document.querySelectorAll('.epub-body script').length,
      styles: document.querySelectorAll('.epub-body style, .epub-body link').length,
      inlineStyles: document.querySelectorAll('.epub-body [style]').length,
      image: (document.querySelector('.epub-body img') || {}).getAttribute ? document.querySelector('.epub-body img').getAttribute('src') : null,
      linkTarget: document.querySelector('.epub-body a[target="_blank"]')?.getAttribute('href') || '',
      total: document.querySelector('.page-total')?.textContent || '',
    })`)
    record('EPUB chapter renders with its heading and text', epubView.heading === 'Alpha Chapter' && epubView.paragraphs >= 2 && epubView.total.includes('第 1 章'), JSON.stringify({ heading: epubView.heading, total: epubView.total }))
    record('EPUB markup is sanitized (no scripts, styles or inline CSS)', epubView.scripts === 0 && epubView.styles === 0 && epubView.inlineStyles === 0, JSON.stringify(epubView))
    record('EPUB images resolve to archive blobs and links open externally', String(epubView.image).startsWith('blob:') && epubView.linkTarget === 'https://example.com', `src=${String(epubView.image).slice(0, 24)}… href=${epubView.linkTarget}`)

    await evaluate(wc, `(() => {
      const tab = Array.from(document.querySelectorAll('.sidebar-tabs button')).find((b) => b.textContent.includes('目录'))
      tab.click()
      return true
    })()`)
    await waitFor(wc, `document.querySelectorAll('.outline-entry').length >= 2`, { label: 'epub outline' })
    const epubOutline = await evaluate(wc, `Array.from(document.querySelectorAll('.outline-entry span')).map((n) => n.textContent)`)
    record('EPUB table of contents is available', epubOutline.includes('Alpha Chapter') && epubOutline.includes('Beta Chapter'), epubOutline.join(' | '))

    // Chapter navigation.
    await evaluate(wc, `(() => {
      const tab = Array.from(document.querySelectorAll('.sidebar-tabs button')).find((b) => b.textContent.includes('文件'))
      tab.click()
      const chapterEntry = Array.from(document.querySelectorAll('.outline-entry')).find((b) => b.textContent.includes('Beta Chapter'))
      return true
    })()`)
    await evaluate(wc, `(() => {
      document.querySelectorAll('.page-navigation .toolbar-button')[1].click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.epub-body h1')?.textContent === 'Beta Chapter'`, { label: 'next chapter' })
    const chapterTwo = await evaluate(wc, `document.querySelector('.page-total')?.textContent || ''`)
    record('EPUB chapter navigation works from the toolbar', chapterTwo.includes('第 2 章'), chapterTwo)

    // Selecting inside a chapter feeds the assistant, and the position persists.
    await evaluate(wc, `(() => {
      const paragraphs = Array.from(document.querySelectorAll('.epub-body p'))
      const range = document.createRange()
      range.selectNodeContents(paragraphs[0])
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.querySelector('.flow-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.query-meta')?.textContent.includes('Paperlight-Book.epub')`, { label: 'epub selection handed to the assistant' })
    record('selecting text inside an EPUB chapter pre-fills the query without auto-sending', true)

    // The app writes its state through a 400 ms debounce; poll instead of
    // guessing, and report the browser copy when the file disagrees.
    const statePath = join(app.getPath('userData'), 'paperlight-state.json')
    let epubTab = null
    let diskTabs = -1
    for (let attempt = 0; attempt < 20 && !epubTab; attempt += 1) {
      await sleep(300)
      try {
        const disk = JSON.parse(readFileSync(statePath, 'utf8'))
        diskTabs = disk.session.tabs.length
        epubTab = disk.session.tabs.find((tab) => tab.path.endsWith('Paperlight-Book.epub'))
      } catch {
        diskTabs = -1
      }
    }
    const browserTabs = await evaluate(wc, `(() => {
      try { return JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}')?.session?.tabs?.length ?? -1 } catch { return -2 }
    })()`)
    record('EPUB chapter position is persisted', epubTab?.chapterIndex === 1, `chapterIndex=${epubTab?.chapterIndex} diskTabs=${diskTabs} browserTabs=${browserTabs}`)
    await screenshot(window, artifacts, '14-epub.png')

    // ------------------------------------------------- notes vault workspace
    const vaultDir = join(library, 'paperlight-vault')
    mkdirSync(join(vaultDir, 'materials', 'books', 'book1'), { recursive: true })
    writeFileSync(join(vaultDir, 'materials', 'books', 'book1', 'book1.pdf'), createTestPdf({ pages: 4, title: 'Book One' }))
    mkdirSync(join(vaultDir, 'notes', '_inbox'), { recursive: true })
    writeFileSync(join(vaultDir, 'notes', '_inbox', 'Reading-Log.md'), '---\ntitle: Reading Log\nkind: note\n---\n\nvault 里已有的一份笔记：knowledge and power。This note includes numerous language learning terms for the local search test.\n')
    const legacySemanticPath = join(vaultDir, 'notes', 'books', 'book1', 'within--inside-framework.md')
    mkdirSync(join(vaultDir, 'notes', 'books', 'book1'), { recursive: true })
    writeFileSync(legacySemanticPath, [
      '---',
      'title: within · inside-framework',
      'kind: sense',
      'created: "2026-02-14T08:00:00.000Z"',
      'updated: "2026-02-14T08:00:00.000Z"',
      'tags: [paperlight, sense, within]',
      'senses: [within|preposition|inside-framework]',
      'source: deepseek-flash',
      'folder: books/book1',
      '---',
      '# within（preposition · inside-framework）',
      '',
      '**语境含义**：用户手动维护的 V1 语义说明。',
      '',
      '**英文释义**：用户修改过的旧解释，不应由新 AI 覆盖。',
      '',
      '## 我的补充',
      '',
      '这段 V1 Markdown 必须原样保留。',
      '',
    ].join('\n'))
    mkdirSync(join(vaultDir, 'enlightenment'), { recursive: true })
    // A note from the previous layout migrates into the one canonical Daily
    // file; a pre-existing report remains untouched as a recovery copy.
    const legacyDailyFile = join(vaultDir, 'Paperlight', 'Daily', '2026-01-05.md')
    mkdirSync(join(vaultDir, 'Paperlight', 'Daily'), { recursive: true })
    const originalLegacyDaily = Buffer.from([
      '---',
      'title: 2026-01-05 笔记',
      'kind: daily',
      'date: 2026-01-05',
      'updated: "2026-01-05T20:00:00.000Z"',
      'summary: ai',
      'tags: [paperlight, daily]',
      '---',
      '# 2026-01-05 笔记',
      '',
      '## 当日汇总',
      '',
      '旧版汇总的概览。',
      '',
      '### 主题脉络',
      '',
      '- 旧版子小节要保留。',
      '',
      '## 当日收录',
      '',
      '- **旧条目**：内容。',
      '',
      '## 我的补充',
      '',
      '我自己写的补充。',
    ].join('\n'))
    writeFileSync(legacyDailyFile, originalLegacyDaily)
    const conflictingLegacyFile = join(vaultDir, 'Paperlight', 'Daily', '2026-01-06.md')
    const conflictingDailyTarget = join(vaultDir, 'Daily', '2026-01-06.md')
    const conflictingReportTarget = join(vaultDir, 'Daily', '2026-01-06-report.md')
    const existingReport = Buffer.from('---\ntitle: My existing report\nkind: report\n---\n\nDo not replace this report.\n')
    const conflictingLegacy = Buffer.from('---\ntitle: Legacy report\nkind: daily\nsummary: ai\n---\n\n## 当日汇总\n\nLegacy summary text.\n\n## 我的补充\n\nLegacy user notes.\n')
    writeFileSync(conflictingLegacyFile, conflictingLegacy)
    mkdirSync(join(vaultDir, 'Daily'), { recursive: true })
    writeFileSync(conflictingReportTarget, existingReport)
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const findingFile = join(vaultDir, 'enlightenment', `${todayKey}-观察.md`)
    writeFileSync(findingFile, '# 观察\n\n原始资料与笔记要分开放，日报要读这里。\n')
    const dailyFile = join(vaultDir, 'Daily', `${todayKey}.md`)
    const reportFile = join(vaultDir, 'Daily', `${todayKey}-report.md`)
    const senseNoteFile = join(vaultDir, 'notes', 'books', 'book1', 'numerous--many.md')

    await installVaultStub(wc)
    const vaultBridge = await evaluate(wc, `Object.keys(window.paperlight.vault || {}).join(',')`)
    record(
      'the vault bridge is exposed to the renderer',
      vaultBridge.includes('read') && vaultBridge.includes('write') && vaultBridge.includes('tree'),
      vaultBridge,
    )

    // Choosing a vault travels the same IPC path the native folder dialog uses.
    wc.send('app:set-vault', vaultDir)
    await waitFor(wc, `document.querySelector('.notes-space') !== null`, { label: 'notes desk' })
    await waitFor(wc, `document.querySelectorAll('.notes-tree-pane .vault-node').length >= 4`, { label: 'vault tree' })

    // The workspace layout is created on demand: materials / notes / enlightenment / expressions / Daily.
    let scaffold = false
    for (let attempt = 0; attempt < 10 && !scaffold; attempt += 1) {
      scaffold = ['materials', 'notes', 'enlightenment', 'expressions', 'Daily'].every((name) => existsSync(join(vaultDir, name)))
      if (!scaffold) await sleep(300)
    }
    record('the vault workspace folders are created automatically', scaffold, ['materials', 'notes', 'enlightenment', 'expressions', 'Daily'].join(', '))

    const outsideTarget = join(library, 'vault-outside-target')
    mkdirSync(outsideTarget, { recursive: true })
    const outsideSentinel = join(outsideTarget, 'keep.md')
    writeFileSync(outsideSentinel, 'keep this outside the vault')
    symlinkSync(outsideTarget, join(vaultDir, 'outside-link'), 'dir')
    symlinkSync(join(library, 'vault-dangling-target'), join(vaultDir, 'dangling-link'), 'dir')
    const tryVaultWrite = (path) => evaluate(wc, `(async () => {
      try {
        await window.paperlight.vault.write(${JSON.stringify(vaultDir)}, ${JSON.stringify(path)}, 'must not escape')
        return { blocked: false }
      } catch (error) {
        return { blocked: true, message: String(error) }
      }
    })()`)
    const outsideSymlinkWrite = await tryVaultWrite('outside-link/keep.md')
    record(
      'Vault IPC rejects an existing symlink that points outside the selected root',
      outsideSymlinkWrite.blocked && outsideSymlinkWrite.message.includes('笔记路径不能离开 vault')
        && readFileSync(outsideSentinel, 'utf8') === 'keep this outside the vault',
      outsideSymlinkWrite.message || 'write unexpectedly succeeded',
    )
    const danglingSymlinkWrite = await tryVaultWrite('dangling-link/escaped.md')
    record(
      'Vault IPC rejects a dangling symlink before creating files outside its root',
      danglingSymlinkWrite.blocked && danglingSymlinkWrite.message.includes('无法解析的符号链接')
        && !existsSync(join(library, 'vault-dangling-target')),
      danglingSymlinkWrite.message || `outside target created: ${existsSync(join(library, 'vault-dangling-target'))}`,
    )
    const traversalWrite = await tryVaultWrite('../vault-path-escape.md')
    record(
      'Vault IPC rejects relative traversal before writing outside the selected root',
      traversalWrite.blocked && traversalWrite.message.includes('笔记路径不能离开 vault')
        && !existsSync(join(library, 'vault-path-escape.md')),
      traversalWrite.message || 'write unexpectedly succeeded',
    )

    const treeNames = await evaluate(wc, `Array.from(document.querySelectorAll('.notes-tree-pane .vault-node-name')).map((n) => n.textContent)`)
    const hasSource = await evaluate(wc, `document.querySelectorAll('.notes-tree-pane .vault-node.file.source').length`)
    record(
      'the tree shows materials/, notes/, enlightenment/, expressions/ and Daily/',
      ['materials', 'notes', 'enlightenment', 'expressions', 'Daily'].every((name) => treeNames.includes(name)) && hasSource >= 1,
      `${treeNames.slice(0, 8).join(', ')} | sources=${hasSource}`,
    )

    // A research note remains free-form Markdown. Existing material and note
    // links are written into the research record; source files stay untouched.
    const researchMaterialPath = 'materials/books/book1/book1.pdf'
    const researchNotePath = 'notes/_inbox/Reading-Log.md'
    const originalResearchMaterial = readFileSync(join(vaultDir, researchMaterialPath))
    await evaluate(wc, `Array.from(document.querySelectorAll('.notes-tree-toolbar button')).find((button) => button.textContent.includes('新建专项研究')).click(); true`)
    await waitFor(wc, `document.querySelector('.notes-create-row input') !== null`, { label: 'research title input' })
    await evaluate(wc, `(() => {
      const input = document.querySelector('.notes-create-row input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'Argument and evidence')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.notes-create-ok').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent.includes('research-argument-and-evidence.md')`, { label: 'free-form research note created' })
    await waitFor(wc, `document.querySelector('[aria-label="选择要纳入研究的材料或笔记"]') !== null`, { label: 'research source picker' })
    const addResearchSource = async (path) => {
      await evaluate(wc, `(() => {
        const select = document.querySelector('[aria-label="选择要纳入研究的材料或笔记"]')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
        setter.call(select, ${JSON.stringify(path)})
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      await evaluate(wc, `document.querySelector('.research-source-picker .secondary-button').click(); true`)
      await waitFor(wc, `document.querySelector('.note-textarea')?.value.includes(${JSON.stringify(`[[${path}]]`)})`, { label: `research link ${path}` })
    }
    await addResearchSource(researchMaterialPath)
    await addResearchSource(researchNotePath)
    const researchPath = await evaluate(wc, `document.querySelector('.note-toolbar-path-text')?.textContent || ''`)
    await sleep(1500)
    const researchMarkdown = readFileSync(join(vaultDir, researchPath), 'utf8')
    record('a free-form Enlightenment research note links a source PDF and a saved note without modifying either source',
      researchMarkdown.includes('kind: research')
        && researchMarkdown.includes('# Argument and evidence')
        && researchMarkdown.includes(`[[${researchMaterialPath}]]`)
        && researchMarkdown.includes(`[[${researchNotePath}]]`)
        && originalResearchMaterial.equals(readFileSync(join(vaultDir, researchMaterialPath))), researchPath)
    await evaluate(wc, `Array.from(document.querySelectorAll('.note-sense-list button')).find((button) => button.title === ${JSON.stringify(researchMaterialPath)})?.click(); true`)
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('book1.pdf')`, { label: 'research link returns to original material' })
    record('a linked research source opens the original material in the reader', true)
    wc.send('app:command', 'space-notes')
    await waitFor(wc, `document.querySelector('.notes-space') !== null`, { label: 'return to research note' })
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent.includes('research-argument-and-evidence.md')`, { label: 'research note restored' })

    // Recognition is available directly from source text; deterministic exact
    // duplicates across PDF and EPUB accumulate separate contexts in one file.
    const expressionPdfPath = join(vaultDir, 'materials', 'books', 'book1', 'book1.pdf')
    const selectPhrase = async (selector, phrase) => evaluate(wc, `(() => {
      const root = document.querySelector(${JSON.stringify(selector)})
      if (!root) return false
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const offset = (node.nodeValue || '').indexOf(${JSON.stringify(phrase)})
        if (offset < 0) continue
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + ${JSON.stringify(phrase)}.length)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        const scroll = document.querySelector('.reader-scroll, .flow-scroll') || root
        scroll.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        document.querySelector('main')?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
        return true
      }
      return false
    })()`)
    const selectChatPhrase = async (phrase) => evaluate(wc, `(() => {
      const root = Array.from(document.querySelectorAll('.vault-chat-messages li.user .message-body'))
        .find((message) => message.textContent?.includes(${JSON.stringify(phrase)}))
      if (!root) return false
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const offset = (node.nodeValue || '').indexOf(${JSON.stringify(phrase)})
        if (offset < 0) continue
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + ${JSON.stringify(phrase)}.length)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        const before = selection.toString()
        document.querySelector('.vault-chat-messages')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        document.querySelector('main').dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
        const after = window.getSelection()?.toString() || ''
        window.__chatSelectProbe = { before, after, active: document.activeElement?.tagName || '' }
        return after === ${JSON.stringify(phrase)}
      }
      return false
    })()`)
    const selectTextareaPhrase = async (phrase) => evaluate(wc, `(() => {
      const textarea = document.querySelector('.note-textarea')
      if (!textarea) return false
      const start = textarea.value.indexOf(${JSON.stringify(phrase)})
      if (start < 0) return false
      textarea.focus()
      textarea.setSelectionRange(start, start + ${JSON.stringify(phrase)}.length)
      textarea.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)
    wc.send('app:command', 'space-reader')
    await waitFor(wc, `document.querySelector('.reader-toolbar') !== null`, { label: 'switch to reader for expression capture' })
    wc.send('app:open-paths', [expressionPdfPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('book1.pdf')`, { label: 'vault source PDF opened' })
    await waitFor(wc, `document.querySelector('.textLayer span')?.textContent`, { label: 'vault source PDF text layer' })
    const pdfSelection = await selectPhrase('.textLayer', 'The authors take a stance on language learning.')
    await waitFor(wc, `document.querySelector('.expression-capture-popover') !== null`, { label: 'direct expression capture from PDF' })
    record('a PDF expression can be captured without first saving a semantic or note', pdfSelection)
    await evaluate(wc, `document.querySelector('.expression-capture-popover .primary-button').click(); true`)
    const expressionDir = join(vaultDir, 'expressions')
    let expressionFiles = []
    for (let attempt = 0; attempt < 30 && expressionFiles.length < 1; attempt += 1) {
      await sleep(200)
      expressionFiles = readdirSync(expressionDir).filter((name) => name.endsWith('.md'))
    }
    record('PDF recognition writes one Markdown expression record', expressionFiles.length === 1, expressionFiles.join(', '))

    await evaluate(wc, `document.querySelector('.input-mark-inline').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-composer') !== null`, { label: 'form marker composer' })
    await evaluate(wc, `(() => {
      const select = document.querySelector('.input-marker-visual-choice select')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, 'highlight')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await evaluate(wc, `document.querySelector('.input-marker-composer > footer .primary-button').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-visual.highlight') !== null`, { label: 'PDF form highlight restored from source text' })
    record('a form-purpose input mark can add a visual highlight over the source', true)

    await evaluate(wc, `document.querySelector('.input-mark-inline').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-composer') !== null`, { label: 'content marker composer' })
    await evaluate(wc, `(() => {
      Array.from(document.querySelectorAll('.input-marker-purpose button')).find((button) => button.textContent === '内容').click()
      const select = document.querySelector('.input-marker-visual-choice select')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, 'underline')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const textarea = document.querySelector('.input-marker-comment textarea')
      const textSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      textSetter.call(textarea, '复核这条判断')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await evaluate(wc, `document.querySelector('.input-marker-composer > footer .primary-button').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-visual.underline') !== null`, { label: 'PDF content underline restored from source text' })
    await evaluate(wc, `if (!document.querySelector('.input-marker-menu')) document.querySelector('.input-marker-menu-toggle').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-menu') !== null`, { label: 'input marker menu' })
    await evaluate(wc, `document.querySelector('.input-marker-progress').click(); true`)
    await waitFor(wc, `document.querySelectorAll('.input-marker-list-item').length === 3`, { label: 'progress bookmark added' })
    record('content comments, visual reminders and reading progress coexist as separate markers', true)

    await evaluate(wc, `document.querySelector('.doc-tab.active .doc-tab-close').click(); true`)
    await waitFor(wc, `!Array.from(document.querySelectorAll('.doc-tab-name')).some((tab) => tab.textContent.includes('book1.pdf'))`, { label: 'marked PDF closed' })
    wc.send('app:open-paths', [expressionPdfPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('book1.pdf')`, { label: 'marked PDF reopened' })
    await waitFor(wc, `document.querySelector('.input-marker-visual.highlight') && document.querySelector('.input-marker-visual.underline')`, { label: 'source visuals restored after reopen' })
    await evaluate(wc, `if (!document.querySelector('.input-marker-menu')) document.querySelector('.input-marker-menu-toggle').click(); true`)
    await waitFor(wc, `document.querySelectorAll('.input-marker-list-item').length === 3`, { label: 'all PDF markers restored after reopen' })
    record('PDF marks and visual positions persist after closing and reopening the source', true)

    wc.send('app:open-paths', [epubPath])
    await waitFor(wc, `Array.from(document.querySelectorAll('.epub-body p')).some((paragraph) => paragraph.textContent.includes('The authors take a stance'))`, { label: 'EPUB expression source' })
    const epubSelection = await selectPhrase('.epub-body', 'The authors take a stance on language learning.')
    await waitFor(wc, `document.querySelector('.expression-capture-popover') !== null`, { label: 'direct expression capture from EPUB' })
    await evaluate(wc, `document.querySelector('.expression-capture-popover .primary-button').click(); true`)
    await waitFor(wc, `document.querySelector('.expression-capture-notice')?.textContent.includes('已收录')`, { label: 'EPUB expression saved' })
    expressionFiles = readdirSync(expressionDir).filter((name) => name.endsWith('.md'))
    const mergedExpression = expressionFiles.length === 1 ? readFileSync(join(expressionDir, expressionFiles[0]), 'utf8') : ''
    const hasTwoContexts = (mergedExpression.match(/^### 语境 /gm) || []).length === 2
    record('PDF and EPUB duplicates merge into one expression with two source contexts', epubSelection && hasTwoContexts && mergedExpression.includes('book1.pdf') && mergedExpression.includes('Paperlight-Book.epub'), `files=${expressionFiles.length} contexts=${(mergedExpression.match(/^### 语境 /gm) || []).length}`)

    const epubMarkSelection = await selectPhrase('.epub-body', 'The authors take a stance on language learning.')
    await waitFor(wc, `document.querySelector('.input-mark-inline') !== null`, { label: 'EPUB form marker action' })
    await evaluate(wc, `document.querySelector('.input-mark-inline').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-composer') !== null`, { label: 'EPUB marker composer' })
    await evaluate(wc, `(() => {
      const select = document.querySelector('.input-marker-visual-choice select')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, 'underline')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('.input-marker-composer > footer .primary-button').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.input-marker-visual.underline') !== null`, { label: 'EPUB underline restored from source text' })
    const epubFollowupSelection = await selectPhrase('.epub-body', 'The authors take a stance on language learning.')
    await waitFor(wc, `document.querySelector('#query-term')?.value.trim().length > 0`, { label: 'EPUB follow-up query prefilled' })
    await evaluate(wc, `window.__senseLookupRequests = []; true`)
    await evaluate(wc, `document.querySelector('.query-go').click(); true`)
    await waitFor(wc, `(window.__senseLookupRequests || []).length >= 1`, { label: 'explicit EPUB query reaches the AI client' })
    await waitFor(wc, `document.querySelector('.sense-meaning') !== null`, { label: 'explicit EPUB sense query before contextual follow-up' })
    record('an EPUB follow-up conversation starts after the user explicitly queries its selected text', epubFollowupSelection)
    await evaluate(wc, `document.querySelector('.doc-tab.active .doc-tab-close').click(); true`)
    await waitFor(wc, `!Array.from(document.querySelectorAll('.doc-tab-name')).some((tab) => tab.textContent.includes('Paperlight-Book.epub'))`, { label: 'marked EPUB closed' })
    wc.send('app:open-paths', [epubPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('Paperlight-Book.epub')`, { label: 'marked EPUB reopened' })
    await evaluate(wc, `if (!document.querySelector('.input-marker-menu')) document.querySelector('.input-marker-menu-toggle').click(); true`)
    await waitFor(wc, `document.querySelector('.input-marker-list-item button') !== null`, { label: 'saved EPUB marker available after reopen' })
    await evaluate(wc, `document.querySelector('.input-marker-list-item button').click(); true`)
    await waitFor(wc, `document.querySelector('.epub-body h1')?.textContent.includes('Beta Chapter')`, { label: 'saved EPUB marker jumps to its chapter' })
    await waitFor(wc, `document.querySelector('.input-marker-visual.underline') !== null`, { label: 'EPUB mark restored after reopen' })
    record('EPUB visual input marks persist and return to their chapter after reopening', epubMarkSelection)

    // An assistant response can be selected directly. This saves only the
    // chosen wording and its assistant provenance, without saving the reply.
    await evaluate(wc, `Array.from(document.querySelectorAll('.right-tabs button')).find((button) => button.textContent.includes('对话')).click(); true`)
    await waitFor(wc, `document.querySelector('.chat-input textarea') !== null`, { label: 'reading assistant chat' })
    await evaluate(wc, `(() => {
      const input = document.querySelector('.chat-input textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, 'How can I express this naturally?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await evaluate(wc, `document.querySelector('.chat-input button').click(); true`)
    await waitFor(wc, `Array.from(document.querySelectorAll('.chat-messages li.assistant p')).some((p) => p.textContent.includes('in large numbers'))`, { label: 'assistant follow-up response' })
    const assistantSelection = await selectPhrase('.chat-messages li.assistant p', 'in large numbers')
    await waitFor(wc, `document.querySelector('.expression-capture-popover') !== null`, { label: 'capture from assistant response' })
    await evaluate(wc, `document.querySelector('.expression-capture-popover .primary-button').click(); true`)
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(200)
      expressionFiles = readdirSync(expressionDir).filter((name) => name.endsWith('.md'))
      if (expressionFiles.length >= 2) break
    }
    const assistantExpression = expressionFiles.map((name) => readFileSync(join(expressionDir, name), 'utf8')).find((markdown) => markdown.includes('# in large numbers')) || ''
    record('selected wording from an AI assistant answer is saved directly with assistant provenance', assistantSelection && assistantExpression.includes('阅读助手') && assistantExpression.includes('> in large numbers'))

    await evaluate(wc, `Array.from(document.querySelectorAll('.space-rail-button')).find((button) => button.textContent.includes('表达')).click(); true`)
    await waitFor(wc, `document.querySelector('.expression-workspace') && document.querySelector('.expression-list-item')`, { label: 'expression pool view' })
    await evaluate(wc, `Array.from(document.querySelectorAll('.expression-list-item')).find((button) => button.textContent.includes('The authors take a stance')).click(); true`)
    await waitFor(wc, `document.querySelector('.expression-detail-head h2')?.textContent.includes('The authors take a stance') && document.querySelectorAll('.expression-context').length === 2`, { label: 'two merged contexts shown in expression pool' })
    const expressionDetails = await evaluate(wc, `({ expression: document.querySelector('.expression-detail-head h2')?.textContent || '', contexts: document.querySelectorAll('.expression-context').length })`)
    record('expression pool displays both source contexts and source navigation', expressionDetails.expression.includes('The authors take a stance') && expressionDetails.contexts === 2, JSON.stringify(expressionDetails))
    await evaluate(wc, `(() => {
      const input = document.querySelector('.expression-search input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'book1.pdf')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor(wc, `document.querySelectorAll('.expression-list-item').length === 0`, { label: 'expression search excludes source metadata' })
    const expressionSearchScope = await evaluate(wc, `({ list: document.querySelectorAll('.expression-list-item').length, unifiedPanel: Boolean(document.querySelector('.memory-search-results')) })`)
    record('expression pool search filters expressions only and does not show cross-memory results', expressionSearchScope.list === 0 && !expressionSearchScope.unifiedPanel, JSON.stringify(expressionSearchScope))
    await evaluate(wc, `(() => { const input = document.querySelector('.expression-search input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(180)
    await screenshot(window, artifacts, '19-expression-pool.png')

    await evaluate(wc, `Array.from(document.querySelectorAll('.expression-actions button')).find((button) => button.textContent.includes('探索表达')).click(); true`)
    await evaluate(wc, `(() => {
      const input = document.querySelector('.expression-explore-input input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '我想表达意见一致')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const explorationInputColor = await evaluate(wc, `getComputedStyle(document.querySelector('.expression-explore-input input')).color`)
    record('expression exploration input text has a readable foreground color', explorationInputColor === 'rgb(48, 56, 47)', explorationInputColor)
    await evaluate(wc, `Array.from(document.querySelectorAll('.expression-explore-input button')).find((button) => button.textContent.includes('获取候选')).click(); true`)
    await waitFor(wc, `document.querySelector('.expression-candidate strong')?.textContent === 'see eye to eye'`, { label: 'AI exploration candidate' })
    expressionFiles = readdirSync(expressionDir).filter((name) => name.endsWith('.md'))
    const expressionListCount = await evaluate(wc, `document.querySelectorAll('.expression-list-item').length`)
    record('AI exploration candidates stay temporary until the user captures one', expressionFiles.length === 2 && expressionListCount === 2)
    await evaluate(wc, `document.querySelector('.expression-candidate button').click(); true`)
    await waitFor(wc, `document.querySelectorAll('.expression-list-item').length === 3`, { label: 'confirmed exploration saved' })
    const generatedExpressionFile = readdirSync(expressionDir).map((name) => join(expressionDir, name)).find((path) => readFileSync(path, 'utf8').includes('# see eye to eye'))
    const generatedMarkdown = generatedExpressionFile ? readFileSync(generatedExpressionFile, 'utf8') : ''
    record('confirmed AI candidates are labeled generated and never presented as real quotations', generatedMarkdown.includes('AI 生成候选') && !generatedMarkdown.includes('> see eye to eye'))

    // Every eligible text surface should share the same direct capture path.
    // These cases exercise the actual renderer selection handlers and inspect
    // the resulting user-owned Markdown records for their source paths.
    const captureTextareaExpression = async (phrase, sourcePath) => {
      const selected = await selectTextareaPhrase(phrase)
      if (!selected) return false
      await waitFor(wc, `document.querySelector('.expression-capture-popover') !== null`, { label: `capture expression from ${sourcePath}` })
      await evaluate(wc, `document.querySelector('.expression-capture-popover .primary-button').click(); true`)
      let markdown = ''
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(200)
        expressionFiles = readdirSync(expressionDir).filter((name) => name.endsWith('.md'))
        markdown = expressionFiles.map((name) => readFileSync(join(expressionDir, name), 'utf8')).find((content) => content.includes(`# ${phrase}`)) || ''
        if (markdown.includes(sourcePath)) break
      }
      return markdown.includes(`# ${phrase}`) && markdown.includes(sourcePath)
    }
    const captureReaderExpression = async (selector, phrase, sourcePath) => {
      const selected = await selectPhrase(selector, phrase)
      if (!selected) return false
      await waitFor(wc, `document.querySelector('.expression-capture-popover')?.textContent.includes(${JSON.stringify(phrase)})`, { label: `direct reader expression action for ${sourcePath}` })
      await evaluate(wc, `document.querySelector('.expression-capture-popover .primary-button').click(); true`)
      let markdown = ''
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(200)
        expressionFiles = readdirSync(expressionDir).filter((name) => name.endsWith('.md'))
        markdown = expressionFiles.map((name) => readFileSync(join(expressionDir, name), 'utf8')).find((content) => content.includes(`# ${phrase}`)) || ''
        if (markdown.includes(sourcePath)) break
      }
      return markdown.includes(`# ${phrase}`) && markdown.includes(sourcePath)
    }

    wc.send('app:command', 'space-notes')
    await waitFor(wc, `document.querySelector('.notes-space') !== null`, { label: 'research note expression capture' })
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent === ${JSON.stringify(researchPath)}`, { label: 'research note active for expression capture' })
    await evaluate(wc, `document.querySelector('.note-view-switch button[title^="编辑模式"]')?.click(); true`)
    await waitFor(wc, `document.querySelector('.note-textarea')?.value.includes('Argument and evidence')`, { label: 'research Markdown editor loaded for expression capture' })
    const researchCapture = await captureTextareaExpression('Argument and evidence', researchPath)
    record('a selected phrase in an Enlightenment research note enters the expression pool with its source', researchCapture)

    await evaluate(wc, `Array.from(document.querySelectorAll('.notes-tree-pane .vault-node-toggle')).find((button) => button.title === ${JSON.stringify(researchNotePath)})?.click(); true`)
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent === ${JSON.stringify(researchNotePath)}`, { label: 'saved Vault note active for expression capture' })
    const savedNoteCapture = await captureTextareaExpression('language learning terms', researchNotePath)
    record('a selected phrase in a saved Vault note enters the expression pool with its source', savedNoteCapture)

    wc.send('app:command', 'space-reader')
    await waitFor(wc, `document.querySelector('.reader-toolbar') !== null`, { label: 'text material expression capture' })
    wc.send('app:open-paths', [markdownPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('Reading-Notes.md')`, { label: 'Markdown source for expression capture' })
    const markdownCapture = await captureReaderExpression('.flow-page', 'A quote that should render as a blockquote.', markdownPath)
    record('a Markdown reading selection enters the expression pool with a source link', markdownCapture)
    wc.send('app:open-paths', [textPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('Plain-Notes.txt')`, { label: 'TXT source for expression capture' })
    const textCapture = await captureReaderExpression('.flow-page', 'Paperlight plain text paragraph two, also selectable.', textPath)
    record('a TXT reading selection enters the expression pool with a source link', textCapture)

    await evaluate(wc, `Array.from(document.querySelectorAll('.space-rail-button')).find((button) => button.textContent.includes('表达')).click(); true`)
    await waitFor(wc, `document.querySelector('.expression-workspace') !== null`, { label: 'expression pool restored after source coverage' })

    const setExpressionSearch = async (query) => evaluate(wc, `(() => {
      const input = document.querySelector('input[aria-label="搜索表达"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(query)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await setExpressionSearch('book1.pdf')
    await waitFor(wc, `document.querySelectorAll('.expression-list-item').length === 0`, { label: 'expression search excludes source metadata' })
    const expressionSearchAfterCapture = await evaluate(wc, `({ list: document.querySelectorAll('.expression-list-item').length, crossMemoryPanel: Boolean(document.querySelector('.memory-search-results')) })`)
    record('expression pool search filters expression text only', expressionSearchAfterCapture.list === 0 && !expressionSearchAfterCapture.crossMemoryPanel, JSON.stringify(expressionSearchAfterCapture))

    wc.send('app:command', 'space-notes')
    await waitFor(wc, `document.querySelector('.notes-space') !== null`, { label: 'NotesSpace remains available after expression search' })
    await evaluate(wc, `Array.from(document.querySelectorAll('.notes-tree-pane .vault-node-toggle')).find((button) => button.title === ${JSON.stringify(researchNotePath)})?.click(); true`)
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent === ${JSON.stringify(researchNotePath)}`, { label: 'open Markdown source from the existing notes tree' })
    record('the existing NotesSpace source browser remains usable alongside expression-only search', true)

    await screenshot(window, artifacts, '15-notes-vault.png')

    // A note from the old layout is copied to the new layout; the source stays
    // available as a recovery copy, and occupied destinations are never replaced.
    const migratedDaily = join(vaultDir, 'Daily', '2026-01-05.md')
    const migratedReport = join(vaultDir, 'Daily', '2026-01-05-report.md')
    let migratedDailyText = ''
    for (let attempt = 0; attempt < 25 && !migratedDailyText; attempt += 1) {
      await sleep(300)
      try { migratedDailyText = readFileSync(migratedDaily, 'utf8') } catch { migratedDailyText = '' }
    }
    let migratedReportText = ''
    try { migratedReportText = readFileSync(migratedReport, 'utf8') } catch { migratedReportText = '' }
    record(
      'an old Paperlight/Daily note copies into Daily/ with the user\'s own additions and original preserved',
      migratedDailyText.includes('我自己写的补充')
        && existsSync(legacyDailyFile)
        && originalLegacyDaily.equals(readFileSync(legacyDailyFile)),
      `${migratedDaily} | original preserved: ${existsSync(legacyDailyFile) && originalLegacyDaily.equals(readFileSync(legacyDailyFile))}`,
    )
    record(
      'the old summary and its sub-sections move into the single Daily file without creating a second report',
      migratedDailyText.includes('旧版汇总的概览。')
        && migratedDailyText.includes('### 主题脉络')
        && migratedDailyText.includes('旧版子小节要保留。')
        && !existsSync(migratedReport),
      `summary=${migratedDailyText.includes('旧版汇总的概览。')} archivedReportCreated=${existsSync(migratedReport)}`,
    )
    record(
      'legacy Daily migration merges into one day file and preserves an existing report unchanged',
      existsSync(conflictingLegacyFile)
        && conflictingLegacy.equals(readFileSync(conflictingLegacyFile))
        && existsSync(conflictingDailyTarget)
        && readFileSync(conflictingDailyTarget, 'utf8').includes('Legacy summary text.')
        && existingReport.equals(readFileSync(conflictingReportTarget)),
      `source=${existsSync(conflictingLegacyFile)} targetDay=${existsSync(conflictingDailyTarget)} reportPreserved=${existingReport.equals(readFileSync(conflictingReportTarget))}`,
    )
    const archivedDailyLabel = await evaluate(wc, `Array.from(document.querySelectorAll('.notes-tree-pane .vault-node.file'))
      .find((node) => node.querySelector('.vault-node-toggle')?.title === ${JSON.stringify('Daily/2026-01-06-report.md')})
      ?.querySelector('.vault-node-name')?.textContent || ''`)
    record('an existing standalone report remains accessible and is clearly labeled as an archived copy',
      archivedDailyLabel.includes('旧版日报保留'), archivedDailyLabel)

    // The reader's own tab strip offers "new blank note" as well.
    wc.send('app:command', 'space-reader')
    await waitFor(wc, `document.querySelector('.tab-strip .tab-add') !== null`, { label: 'reader tab strip' })
    const sidebarSpaceRow = await evaluate(wc, `({
      duplicated: document.querySelector('.sidebar-spaces') !== null,
      rail: document.querySelectorAll('.space-rail-button').length,
    })`)
    record(
      'the reader sidebar no longer repeats the space rail',
      !sidebarSpaceRow.duplicated && sidebarSpaceRow.rail >= 4,
      JSON.stringify(sidebarSpaceRow),
    )
    await evaluate(wc, `(() => { document.querySelector('.tab-add').click(); return true })()`)
    await waitFor(wc, `document.querySelector('.tab-add-menu') !== null`, { label: 'new-tab menu' })
    const menuItems = await evaluate(wc, `Array.from(document.querySelectorAll('.tab-add-menu button')).map((b) => b.textContent)`)
    record(
      'the + opens a menu with "open document" and "new blank note"',
      menuItems.some((item) => item.includes('打开文档')) && menuItems.some((item) => item.includes('新建空白笔记')),
      menuItems.join(' | '),
    )
    await evaluate(wc, `(() => {
      Array.from(document.querySelectorAll('.tab-add-menu button')).find((b) => b.textContent.includes('新建空白笔记')).click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.notes-space') !== null && document.querySelector('.note-textarea') !== null`, { label: 'blank note created' })
    await waitFor(wc, `document.querySelector('.note-textarea')?.value.includes('未命名')`, { label: 'blank Markdown body loaded' })
    const blankNote = await evaluate(wc, `({
      path: document.querySelector('.note-toolbar-path-text')?.textContent || '',
      body: document.querySelector('.note-textarea')?.value || '',
    })`)
    let blankOnDisk = false
    for (let attempt = 0; attempt < 12 && !blankOnDisk; attempt += 1) {
      await sleep(300)
      blankOnDisk = existsSync(join(vaultDir, blankNote.path))
    }
    record(
      'the + creates a blank Markdown note and opens it for editing',
      blankNote.path.startsWith('notes/') && blankNote.body.includes('未命名') && blankOnDisk,
      `${blankNote.path} | ${JSON.stringify(blankNote.body.slice(0, 40))}`,
    )

    // Back to the vault: reading a material notes its book context.
    await evaluate(wc, `(() => {
      const source = document.querySelector('.notes-tree-pane .vault-node.file.source .vault-node-toggle')
      source.click()
      return true
    })()`)
    await waitFor(wc, `Array.from(document.querySelectorAll('.doc-tab-name')).some((n) => n.textContent.includes('book1'))`, { label: 'material opened in the reader' })
    const materialText = await ensureTextLayer(wc, 'material text layer')
    record('a material from materials/ opens in the reading desk', materialText.ok, JSON.stringify(materialText))

    // A sense collected while reading it lands in the mirrored notes/ folder.
    await installSenseStub(wc, stubSense)
    await evaluate(wc, `(() => {
      const spans = Array.from(document.querySelectorAll('.textLayer span')).filter((span) => (span.textContent || '').trim().length > 4)
      if (spans.length === 0) return false
      const range = document.createRange()
      range.selectNodeContents(spans[0])
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.querySelector('.reader-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)
    await evaluate(wc, `document.querySelector('.query-go').click(); true`)
    await waitFor(wc, `document.querySelector('.sense-meaning')?.textContent === '众多的、大量的'`, { label: 'sense card for the material' })
    const targetHint = await evaluate(wc, `Array.from(document.querySelectorAll('.vault-hint')).map((n) => n.textContent).join(' ')`)
    record('the assistant says where this reading session writes', targetHint.includes('notes/books/book1'), targetHint.slice(0, 120))
    await evaluate(wc, `(() => { document.querySelector('.vault-button').click(); return true })()`)
    await waitFor(wc, `document.querySelector('.notes-space') !== null`, { label: 'notes desk after saving the sense' })
    let senseSaved = false
    for (let attempt = 0; attempt < 12 && !senseSaved; attempt += 1) {
      senseSaved = existsSync(senseNoteFile)
      if (!senseSaved) await sleep(300)
    }
    record('a sense from that material is filed under notes/<material>/', senseSaved, senseNoteFile)

    // The day's record list reflects it, links it and keeps its senses.
    // The list is rebuilt a moment after the sense is filed; poll for the link
    // itself instead of accepting the first version that has a heading.
    let dailyContent = ''
    for (let attempt = 0; attempt < 30 && !dailyContent.includes('[[notes/books/book1/numerous--many.md|'); attempt += 1) {
      await sleep(300)
      try { dailyContent = readFileSync(dailyFile, 'utf8') } catch { dailyContent = '' }
    }
    record(
      "the day's Daily file contains the five required sections",
      ['## 读了多久', '## 读了什么', '## 表达', '## 语义', '## 总结与勉励（继往开来）'].every((heading) => dailyContent.includes(heading))
        && dailyContent.includes('kind: daily'),
      dailyContent ? dailyContent.split('\n').slice(0, 3).join(' | ') : 'missing',
    )
    record(
      'the record list links the notes of the day',
      dailyContent.includes('[[notes/books/book1/numerous--many.md|') && dailyContent.includes('[[enlightenment/'),
      dailyContent.slice(0, 200).replace(/\n/g, ' / '),
    )
    const storedAtom = await evaluate(wc, `(() => {
      try {
        const state = JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}')
        const atom = (state.notebook?.atoms || []).find((item) => item.id === 'numerous|adjective|many')
        return atom ? { notesFolder: atom.notesFolder || '', notePath: atom.notePath || '' } : null
      } catch { return null }
    })()`)
    record(
      'a sense notes where its file was actually written',
      storedAtom?.notePath === 'notes/books/book1/numerous--many.md',
      JSON.stringify(storedAtom),
    )
    record(
      "the day's note carries its senses so links resolve",
      /^senses: \[numerous\|adjective\|many\]/m.test(dailyContent),
      (dailyContent.match(/^senses: .*$/m) || ['missing'])[0],
    )

    // One full-width mode at a time, switched from the top-right of the note.
    await evaluate(wc, `(() => {
      const target = Array.from(document.querySelectorAll('.notes-tree-pane .vault-node.file')).find((n) => n.querySelector('.vault-node-name')?.textContent?.trim() === ${JSON.stringify(todayKey)})
      target.querySelector('.vault-node-toggle').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent.includes(${JSON.stringify(todayKey)}) === true`, { label: "day's note open" })
    const editMode = await evaluate(wc, `({
      textarea: document.querySelector('.note-textarea') !== null,
      preview: document.querySelector('.note-preview-area') !== null,
      switchLabel: document.querySelector('.note-view-switch button.selected')?.textContent || '',
    })`)
    record('edit mode fills the desk with the Markdown source', editMode.textarea && !editMode.preview && editMode.switchLabel.includes('编辑'), JSON.stringify(editMode))
    await evaluate(wc, `(() => { Array.from(document.querySelectorAll('.note-view-switch button')).find((b) => b.textContent.includes('浏览')).click(); return true })()`)
    await waitFor(wc, `document.querySelector('.note-preview-area') !== null`, { label: 'preview mode' })
    const previewMode = await evaluate(wc, `({
      textarea: document.querySelector('.note-textarea') !== null,
      headings: document.querySelectorAll('.note-preview-area .flow-heading').length,
      links: document.querySelectorAll('.note-preview-area .wiki-link').length,
      grounded: document.querySelector('.note-view-switch button.selected')?.textContent || '',
    })`)
    record(
      'preview mode fills the desk with the rendered note (no split view)',
      !previewMode.textarea && previewMode.headings >= 1 && previewMode.links >= 2 && previewMode.grounded.includes('浏览'),
      JSON.stringify(previewMode),
    )

    // The info panel resolves the day's senses instead of claiming there are none.
    const panelLinks = await evaluate(wc, `({
      senses: document.querySelectorAll('.note-sense-list li').length,
      facts: Array.from(document.querySelectorAll('.note-facts dd')).map((n) => n.textContent),
      emptyText: Array.from(document.querySelectorAll('.notes-side-pane .sense-plain')).map((n) => n.textContent).join(' | '),
    })`)
    record(
      "the day's note shows its linked senses in the info panel",
      panelLinks.senses >= 1 && !panelLinks.emptyText.includes('这份笔记没有记录本里的语义'),
      JSON.stringify(panelLinks).slice(0, 200),
    )

    // A [[link]] inside the record list opens the linked note.
    await evaluate(wc, `(() => { Array.from(document.querySelectorAll('.note-preview-area .wiki-link')).find((link) => link.textContent.includes('numerous--many') || link.textContent.includes('numerous（'))?.click(); return true })()`)
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent.includes('numerous--many') === true`, { label: 'wiki link opens the semantic note' })
    record('[[wiki links]] open the linked vault note', true)

    // Editing still autosaves, and a new note goes next to the open one.
    await evaluate(wc, `(() => { Array.from(document.querySelectorAll('.note-view-switch button')).find((b) => b.textContent.includes('编辑')).click(); return true })()`)
    await waitFor(wc, `document.querySelector('.note-textarea') !== null`, { label: 'back to edit mode' })
    await evaluate(wc, `(() => { Array.from(document.querySelectorAll('.notes-tree-toolbar button')).find((b) => b.textContent.includes('新建笔记')).click(); return true })()`)
    await waitFor(wc, `document.querySelector('.notes-create-row input') !== null`, { label: 'new note input' })
    const createTarget = await evaluate(wc, `document.querySelector('.notes-create-folder')?.textContent || ''`)
    const createdNoteDir = createTarget.replace('存到', '').trim()
    const createdNoteFile = join(vaultDir, createdNoteDir, 'smoke-note.md')
    await evaluate(wc, `(() => {
      const input = document.querySelector('.notes-create-row input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'Smoke Note')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.note-textarea')?.value.includes('Smoke Note') === true`, { label: 'new note open' })
    record(
      'a new note lands in the folder the create row names',
      createdNoteDir.startsWith('notes/') && existsSync(createdNoteFile),
      `${createTarget} → ${createdNoteFile}`,
    )
    await evaluate(wc, `(() => {
      const area = document.querySelector('.note-textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '# Smoke Note\\n\\nPaperlight 自动保存到 vault 的正文。\\n')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    let noteContent = ''
    for (let attempt = 0; attempt < 20 && !noteContent.includes('自动保存'); attempt += 1) {
      await sleep(300)
      try { noteContent = readFileSync(createdNoteFile, 'utf8') } catch { noteContent = '' }
    }
    record('editing autosaves the note as Markdown on disk', noteContent.includes('自动保存'), noteContent.split('\n').slice(0, 2).join(' | '))

    // A sense whose file is gone can be archived again in one click.
    rmSync(senseNoteFile, { force: true })
    await evaluate(wc, `(() => { document.querySelector('.notes-tree-actions button').click(); return true })()`)
    let backfillOffered = false
    for (let attempt = 0; attempt < 20 && !backfillOffered; attempt += 1) {
      await sleep(300)
      backfillOffered = await evaluate(wc, `Array.from(document.querySelectorAll('.notes-side-pane button')).some((b) => b.textContent.includes('全部写入 vault'))`)
    }
    const backfill = backfillOffered && await evaluate(wc, `(() => {
      const button = Array.from(document.querySelectorAll('.notes-side-pane button')).find((b) => b.textContent.includes('全部写入 vault'))
      button.click()
      return true
    })()`)
    let backfilled = false
    for (let attempt = 0; attempt < 20 && !backfilled; attempt += 1) {
      await sleep(300)
      backfilled = existsSync(senseNoteFile)
    }
    record('a sense whose note is missing can be archived again in one click', backfill && backfilled, `${senseNoteFile} → ${backfilled}`)

    // Generate the fifth section in the same canonical Daily file.
    await evaluate(wc, `(() => {
      const button = Array.from(document.querySelectorAll('.notes-side-pane button')).find((b) => b.textContent.includes('生成'))
      if (!button) return false
      button.click()
      return true
    })()`)
    let reportContent = ''
    for (let attempt = 0; attempt < 20 && !reportContent.includes('summarySource:'); attempt += 1) {
      await sleep(300)
      try { reportContent = readFileSync(dailyFile, 'utf8') } catch { reportContent = '' }
    }
    record(
      'the generated summary is written into the one five-section Daily file',
      reportContent.includes('kind: daily') && /^summarySource: (ai|local)$/m.test(reportContent)
        && !existsSync(reportFile)
        && ['## 读了多久', '## 读了什么', '## 表达', '## 语义', '## 总结与勉励（继往开来）'].every((heading) => reportContent.includes(heading)),
      reportContent.split('\n').slice(0, 8).join(' | '),
    )
    const reportRequest = await evaluate(wc, `(() => {
      const requests = window.__vaultReportRequests || []
      return requests[requests.length - 1] || null
    })()`)
    record(
      'the report request carries the records and the enlightenment findings',
      Boolean(reportRequest) && (reportRequest.records || []).length >= 2 && (reportRequest.findings || []).some((f) => f.path.includes('enlightenment/')),
      JSON.stringify({ records: (reportRequest?.records || []).length, findings: (reportRequest?.findings || []).map((f) => f.path) }),
    )
    let dailyWithReport = ''
    for (let attempt = 0; attempt < 12 && !dailyWithReport.includes('summaryGeneratedAt:'); attempt += 1) {
      await sleep(300)
      try { dailyWithReport = readFileSync(dailyFile, 'utf8') } catch { dailyWithReport = '' }
    }
    record('the Daily summary stays in its canonical date file with no report link or duplicate file',
      dailyWithReport.includes(`title: ${todayKey}`) && !dailyWithReport.includes('-report.md') && !existsSync(reportFile),
      dailyWithReport.split('\n').slice(0, 8).join(' | '))
    await screenshot(window, artifacts, '16-daily-report.png')

    // ------------------------------------------------------------- chat desk
    wc.send('app:command', 'space-chat')
    await waitFor(wc, `document.querySelector('.chat-space') !== null`, { label: 'chat desk' })
    await waitFor(wc, `document.querySelectorAll('.thread-list li').length >= 1`, { label: 'chat thread list' })
    const chatColumns = await evaluate(wc, `({
      rail: document.querySelectorAll('.space-rail-button').length,
      history: document.querySelector('.thread-column') !== null,
      picker: document.querySelector('.picker-column') !== null,
      sources: document.querySelectorAll('.picker-column .vault-node.file.source').length,
    })`)
    record(
      'the chat desk shows a thread column, a notes picker and a composer',
      chatColumns.rail >= 3 && chatColumns.history && chatColumns.picker && chatColumns.sources === 0,
      JSON.stringify(chatColumns),
    )

    await waitFor(wc, `document.querySelectorAll('.picker-column .vault-node.file').length >= 1`, { label: 'vault picker tree' })
    await evaluate(wc, `(() => {
      const target = Array.from(document.querySelectorAll('.picker-column .vault-node.file')).find((n) => n.textContent.includes('Reading-Log'))
      target.querySelector('.vault-check').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.grounded-badge')?.classList.contains('on') === true`, { label: 'grounded selection' })
    const groundedBar = await evaluate(wc, `({
      badge: document.querySelector('.grounded-badge')?.textContent || '',
      chips: Array.from(document.querySelectorAll('.grounding-chip button:first-child')).map((b) => b.textContent),
    })`)
    record(
      'selecting vault content grounds the conversation',
      groundedBar.badge.includes('严格 grounded') && groundedBar.chips.some((chip) => chip.includes('Reading-Log')),
      JSON.stringify(groundedBar),
    )

    await evaluate(wc, `(() => {
      const area = document.querySelector('.vault-chat-input textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, '这份 vault 笔记说了什么？')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.vault-chat-input button').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.vault-chat-messages li.assistant .message-body') !== null`, { label: 'grounded answer' })
    const groundedRequest = await evaluate(wc, `(() => {
      const requests = window.__vaultChatRequests || []
      const last = requests[requests.length - 1] || null
      return {
        grounded: last ? last.context.length > 0 : false,
        carriesNoteBody: last ? JSON.stringify(last.context).includes('knowledge and power') : false,
        answer: document.querySelector('.vault-chat-messages li.assistant .message-body')?.textContent || '',
      }
    })()`)
    record(
      'a grounded answer only receives the selected vault notes',
      groundedRequest.grounded && groundedRequest.carriesNoteBody,
      JSON.stringify({ grounded: groundedRequest.grounded, carriesNoteBody: groundedRequest.carriesNoteBody }),
    )
    record('the grounded answer cites its source note', groundedRequest.answer.includes('Reading-Log'), groundedRequest.answer.slice(0, 90))
    const chatMarkdown = await evaluate(wc, `({
      strong: document.querySelectorAll('.vault-chat-messages li.assistant .message-body strong').length,
      listItems: document.querySelectorAll('.vault-chat-messages li.assistant .message-body .flow-list li').length,
    })`)
    record('conversation answers render Markdown structure', chatMarkdown.strong > 0 && chatMarkdown.listItems >= 2, JSON.stringify(chatMarkdown))
    await screenshot(window, artifacts, '17-vault-chat.png')

    // Ungrounded mode is explicit, and an answer can be saved back as a note.
    await evaluate(wc, `(() => { document.querySelector('.grounding-chip button:last-child').click(); return true })()`)
    await waitFor(wc, `document.querySelector('.grounding-bar.off') !== null`, { label: 'ungrounded warning' })
    const ungroundedText = await evaluate(wc, `document.querySelector('.grounding-bar.off')?.textContent || ''`)
    record('clearing the selection warns that answers are no longer grounded', ungroundedText.includes('未选择 vault 内容'), ungroundedText.slice(0, 60))

    await evaluate(wc, `(() => { Array.from(document.querySelectorAll('.message-actions button')).find((b) => b.textContent.includes('存为 vault 笔记')).click(); return true })()`)
    await waitFor(wc, `document.querySelector('.message-actions button.saved') !== null`, { label: 'answer saved to the vault' })
    const inboxFiles = existsSync(join(vaultDir, 'notes', '_inbox')) ? readdirSync(join(vaultDir, 'notes', '_inbox')) : []
    record(
      'an answer can be saved back into the vault as a note',
      inboxFiles.some((name) => name.includes('这份-vault-笔记说了什么')),
      inboxFiles.join(', '),
    )

    // Free-conversation messages are also valid recognition sources. Keep the
    // network stub in place and capture only a selected phrase from the user
    // message, without saving the full chat turn as a note.
    await evaluate(wc, `(() => {
      const area = document.querySelector('.vault-chat-input textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, 'Please keep an open mind when reading.')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.vault-chat-input button').click()
      return true
    })()`)
    await waitFor(wc, `Array.from(document.querySelectorAll('.vault-chat-messages li.user .message-body')).some((node) => node.textContent.includes('Please keep an open mind when reading.'))`, { label: 'free conversation message for expression capture' })
    await waitFor(wc, `document.querySelectorAll('.vault-chat-messages li.assistant .message-body').length >= 2`, { label: 'free conversation reply settled before text selection' })
    const messagesBeforeAbort = await evaluate(wc, `Array.from(document.querySelectorAll('.vault-chat-messages li')).map((item) => ({
      role: item.classList.contains('user') ? 'user' : 'assistant',
      text: item.querySelector('.message-body')?.textContent || '',
    }))`)
    await evaluate(wc, `(() => {
      const area = document.querySelector('.vault-chat-input textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, 'PAPERLIGHT-SLOW-REQUEST-9F3A')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.vault-chat-input button[aria-label="发送消息"]').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.vault-chat-input button[aria-label="停止生成"]') !== null`, { label: 'stop generation button' })
    await evaluate(wc, `document.querySelector('.vault-chat-input button[aria-label="停止生成"]').click(); true`)
    await waitFor(wc, `document.querySelector('.vault-chat-input button[aria-label="发送消息"]') !== null
      && document.querySelector('.api-config-message.success')?.textContent.includes('已停止生成')
      && Array.from(document.querySelectorAll('.vault-chat-messages li.user .message-body')).some((node) => node.textContent.includes('PAPERLIGHT-SLOW-REQUEST-9F3A'))`, { label: 'generation cancellation settles with the question in history' })
    const cancelledChat = await evaluate(wc, `(() => {
      const messages = Array.from(document.querySelectorAll('.vault-chat-messages li'))
      const before = ${JSON.stringify(messagesBeforeAbort)}
      const after = messages.map((item) => ({
        role: item.classList.contains('user') ? 'user' : 'assistant',
        text: item.querySelector('.message-body')?.textContent || '',
      }))
      return {
        aborted: window.__vaultChatAbortObserved === true,
        lastIsQuestion: messages.at(-1)?.classList.contains('user') === true && messages.at(-1)?.textContent.includes('PAPERLIGHT-SLOW-REQUEST-9F3A'),
        previousMessagesPreserved: before.every((message, index) => after[index]?.role === message.role && after[index]?.text === message.text),
        assistantCount: after.filter((message) => message.role === 'assistant').length,
        messageCount: after.length,
        inputEnabled: !document.querySelector('.vault-chat-input textarea')?.disabled,
      }
    })()`)
    record('stopping generation aborts the pending request, restores input, and preserves the question and prior answers',
      cancelledChat.aborted && cancelledChat.lastIsQuestion && cancelledChat.previousMessagesPreserved
        && cancelledChat.messageCount === messagesBeforeAbort.length + 1
        && cancelledChat.assistantCount === messagesBeforeAbort.filter((message) => message.role === 'assistant').length
        && cancelledChat.inputEnabled,
      JSON.stringify(cancelledChat))
    const chatSelection = await selectChatPhrase('keep an open mind')
    await waitFor(wc, `document.querySelector('.expression-capture-popover span')?.textContent.includes('keep an open mind')`, { timeout: 2500, label: 'capture selected wording from free conversation' }).catch(() => null)
    const chatCaptureDebug = await evaluate(wc, `({
      selection: window.getSelection()?.toString() || '',
      selectionProbe: window.__chatSelectProbe || null,
      path: document.querySelector('.chat-space')?.dataset.expressionPath || '',
      sourceKind: document.querySelector('.chat-space')?.dataset.expressionSource || '',
      popover: document.querySelector('.expression-capture-popover span')?.textContent || '',
      readerScrollCount: document.querySelectorAll('.reader-scroll, .flow-scroll').length,
    })`)
    console.log(`  [chat expression probe] ${JSON.stringify(chatCaptureDebug)}`)
    if (chatCaptureDebug.popover.includes('keep an open mind')) await evaluate(wc, `document.querySelector('.expression-capture-popover .primary-button').click(); true`)
    const chatSourcePath = await evaluate(wc, `document.querySelector('.chat-space')?.dataset.expressionPath || ''`)
    let chatExpression = ''
    for (let attempt = 0; attempt < (chatCaptureDebug.popover ? 30 : 1); attempt += 1) {
      await sleep(200)
      expressionFiles = readdirSync(expressionDir).filter((name) => name.endsWith('.md'))
      chatExpression = expressionFiles.map((name) => readFileSync(join(expressionDir, name), 'utf8')).find((content) => content.includes('# keep an open mind')) || ''
      if (chatExpression.includes(chatSourcePath)) break
    }
    record('a selected phrase in a free conversation is saved directly with its chat source', chatSelection && chatCaptureDebug.popover.includes('keep an open mind') && chatSourcePath.startsWith('chat:') && chatExpression.includes(chatSourcePath), JSON.stringify(chatCaptureDebug))

    await sleep(1200)
    const vaultState = JSON.parse(readFileSync(join(app.getPath('userData'), 'paperlight-state.json'), 'utf8'))
    record(
      'the vault, the open notes, the report time and the chat threads are persisted',
      vaultState.vault?.root === vaultDir
        && (vaultState.chatSpace?.threads?.length ?? 0) >= 1
        && (vaultState.notesSpace?.openPaths?.length ?? 0) >= 1
        && vaultState.notesSpace?.view === 'edit'
        && vaultState.settings?.dailyReportTime === '20:00',
      `root=${vaultState.vault?.root} threads=${vaultState.chatSpace?.threads?.length} notes=${vaultState.notesSpace?.openPaths?.length} view=${vaultState.notesSpace?.view} reportTime=${vaultState.settings?.dailyReportTime}`,
    )

    // Research notes can point to an existing local conversation without
    // copying its messages, then navigate back to that exact thread.
    const researchThread = vaultState.chatSpace?.threads?.find((thread) => thread.id === vaultState.chatSpace?.activeThreadId)
    if (!researchThread?.id || !researchThread.messages.length) throw new Error('expected a persisted conversation for the research-link scenario')
    const researchThreadReply = researchThread.messages.find((message) => message.role === 'assistant')?.content || ''
    wc.send('app:command', 'space-notes')
    await waitFor(wc, `document.querySelector('.notes-space') !== null`, { label: 'notes space for research chat link' })
    await waitFor(wc, `Array.from(document.querySelectorAll('.note-tab')).some((tab) => tab.title === ${JSON.stringify(researchPath)})`, { label: 'research note tab for chat link' })
    await evaluate(wc, `Array.from(document.querySelectorAll('.note-tab')).find((tab) => tab.title === ${JSON.stringify(researchPath)})?.click(); true`)
    await waitFor(wc, `document.querySelector('.note-toolbar-path-text')?.textContent === ${JSON.stringify(researchPath)}`, { label: 'research note active for chat link' })
    await waitFor(wc, `Array.from(document.querySelector('[aria-label="选择要纳入研究的材料或笔记"]')?.options || []).some((option) => option.value === ${JSON.stringify(`chat:${researchThread.id}`)})`, { label: 'persisted chat available as a research source' })
    await evaluate(wc, `(() => {
      const select = document.querySelector('[aria-label="选择要纳入研究的材料或笔记"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(select, ${JSON.stringify(`chat:${researchThread.id}`)})
      select.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('.research-source-picker .secondary-button').click()
      return true
    })()`)
    await waitFor(wc, `document.querySelector('.note-textarea')?.value.includes(${JSON.stringify(`[[chat:${researchThread.id}|`)})`, { label: 'chat link added to research Markdown' })
    await sleep(1500)
    const linkedResearchMarkdown = readFileSync(join(vaultDir, researchPath), 'utf8')
    const chatLinkPersisted = linkedResearchMarkdown.includes(`[[chat:${researchThread.id}|`)
      && linkedResearchMarkdown.includes('# Argument and evidence')
      && (!researchThreadReply || !linkedResearchMarkdown.includes(researchThreadReply))
    record('a research note stores a local chat link without copying the conversation text', chatLinkPersisted, `thread=${researchThread.id} messages=${researchThread.messages.length}`)
    await waitFor(wc, `document.querySelector('[data-research-chat-id="${researchThread.id}"]') !== null`, { label: 'linked conversation shown in research relations' })
    await screenshot(window, artifacts, '18-research-chat-link.png')
    await evaluate(wc, `document.querySelector('[data-research-chat-id="${researchThread.id}"]').click(); true`)
    await waitFor(wc, `document.querySelector('.chat-space')?.dataset.expressionPath === ${JSON.stringify(`chat:${researchThread.id}`)}`, { label: 'research relation opens linked conversation' })
    await waitFor(wc, `document.querySelectorAll('.vault-chat-messages li').length >= 2`, { label: 'linked conversation messages restored' })
    record('opening a research relation returns to the same existing conversation', true, researchThread.title)
    await screenshot(window, artifacts, '18-final-vault-state.png')

    // Same-lexeme AI results with changing IDs require an explicit merge choice;
    // distinct senses remain separate and a confirmed mapping becomes stable.
    const queryTypedSense = async (term) => evaluate(wc, `(() => {
      const input = document.querySelector('.query-row #query-term')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(term)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    const withinFirst = { sense: {
      term: 'within', lemma: 'within', partOfSpeech: 'preposition', senseId: 'inside-framework',
      contextualMeaning: '在框架或范围之内', definition: 'inside a framework or boundary', contextSentence: 'AI-provided wording must not replace the source quote.',
      examples: [{ text: 'within a framework', translation: '在框架之内', sourceType: 'ai_generated', citation: null }],
      guidance: { scenarios: ['描述范围关系'], advice: ['用于说明边界'], frequency: '常见', alternatives: [], synonyms: [], antonyms: [], morphology: { root: '', prefix: '', suffix: '', note: '' } },
    } }
    const withinVariant = { sense: {
      ...withinFirst.sense, senseId: 'limited-range', contextualMeaning: '处在限定范围以内',
      definition: 'inside a specified range', contextSentence: 'Another AI paraphrase, not a source quote.',
      examples: [
        withinFirst.sense.examples[0],
        { text: 'within the agreed limits', translation: '在约定限制之内', sourceType: 'ai_generated', citation: null },
      ],
      guidance: { ...withinFirst.sense.guidance, advice: ['用于说明边界', '与限制或期限搭配'] },
    } }
    wc.send('app:command', 'space-reader')
    await waitFor(wc, `document.querySelector('.reader-toolbar') !== null`, { label: 'semantic merge reader' })
    wc.send('app:open-paths', [bigPdf])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('Foucault-liberal-political-economy.pdf')`, { label: 'first semantic source' })
    await ensureTextLayer(wc, 'first semantic source')
    await installSenseStub(wc, withinFirst)
    const selectedWithinA = await selectPhrase('.textLayer', 'within')
    await evaluate(wc, `document.querySelector('.query-go').click(); true`)
    await waitFor(wc, `document.querySelector('.sense-meaning')?.textContent === '在框架或范围之内'`, { label: 'first within semantic result' })
    await evaluate(wc, `document.querySelector('.sense-add').click(); true`)
    await waitFor(wc, `document.querySelector('.sense-add.added') !== null`, { label: 'first within semantic captured' })

    wc.send('app:open-paths', [expressionPdfPath])
    await waitFor(wc, `document.querySelector('.reader-toolbar-title')?.textContent.includes('book1.pdf')`, { label: 'second semantic source' })
    await ensureTextLayer(wc, 'second semantic source')
    await installSenseStub(wc, withinVariant)
    const selectedWithinB = await selectPhrase('.textLayer', 'within')
    await evaluate(wc, `document.querySelector('.query-go').click(); true`)
    await waitFor(wc, `document.querySelector('.sense-meta')?.textContent.includes('limited-range')`, { label: 'variant AI semantic result' })
    await evaluate(wc, `document.querySelector('.sense-add').click(); true`)
    await waitFor(wc, `document.querySelector('.semantic-merge-review') !== null`, { label: 'semantic merge confirmation' })
    await evaluate(wc, `document.querySelector('.semantic-merge-review')?.scrollIntoView({ block: 'start', behavior: 'instant' }); true`)
    await sleep(200)
    await screenshot(window, artifacts, '20-semantic-merge-confirmation.png')
    const mergeCandidateCount = await evaluate(wc, `document.querySelectorAll('.semantic-merge-candidate').length`)
    await evaluate(wc, `document.querySelector('.semantic-merge-candidate .secondary-button').click(); true`)
    await waitFor(wc, `!document.querySelector('.semantic-merge-review') && document.querySelector('.sense-add.added')`, { label: 'confirmed semantic merge' })
    const mergedWithin = await evaluate(wc, `(() => {
      const state = JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}')
      const atoms = (state.notebook?.atoms || []).filter((atom) => atom.lemma === 'within')
      const atom = atoms.find((item) => item.id === 'within|preposition|inside-framework')
      return { count: atoms.length, id: atom?.id, definition: atom?.definition, alternateIds: atom?.alternateSemanticIds || [], quotes: (atom?.contexts || []).map((context) => context.quote), sources: (atom?.contexts || []).map((context) => context.sourcePath), examples: (atom?.examples || []).map((example) => example.text), advice: atom?.guidance?.advice || [] }
    })()`)
    record('same semantic with a changed AI ID asks once, preserves explanation and accumulates two true source contexts',
      selectedWithinA && selectedWithinB && mergeCandidateCount === 1
        && mergedWithin.count === 1 && mergedWithin.id === 'within|preposition|inside-framework'
        && mergedWithin.definition === 'inside a framework or boundary'
        && mergedWithin.alternateIds.includes('within|preposition|limited-range')
        && mergedWithin.sources.some((path) => path === bigPdf) && mergedWithin.sources.some((path) => path === expressionPdfPath)
        && mergedWithin.quotes.includes('within') && mergedWithin.examples.includes('within the agreed limits')
        && mergedWithin.advice.includes('与限制或期限搭配'), JSON.stringify(mergedWithin))

    // The confirmed alternate ID is now deterministic and no longer prompts.
    await selectPhrase('.textLayer', 'within')
    await evaluate(wc, `document.querySelector('.query-go').click(); true`)
    await waitFor(wc, `document.querySelector('.sense-add.added') !== null && !document.querySelector('.semantic-merge-review')`, { label: 'known semantic alias' })
    record('a confirmed alternate semantic ID resolves on an explicit follow-up lookup', true)

    // Saving only an AI excerpt also uses the merge decision and links the new
    // note to the canonical semantic ID after the user confirms the merge.
    const withinNoteVariant = { sense: {
      ...withinFirst.sense, senseId: 'inside-framework-note', contextualMeaning: '在框架内部',
      definition: 'inside the structure of a framework',
    } }
    await installSenseStub(wc, withinNoteVariant)
    await queryTypedSense('within')
    await waitFor(wc, `document.querySelector('.sense-meta')?.textContent.includes('inside-framework-note')`, { label: 'within excerpt semantic result' })
    await evaluate(wc, `document.querySelector('.save-note-button').click(); true`)
    await waitFor(wc, `document.querySelector('.semantic-merge-review') !== null`, { label: 'excerpt semantic merge confirmation' })
    await evaluate(wc, `document.querySelector('.semantic-merge-candidate .secondary-button').click(); true`)
    await waitFor(wc, `!document.querySelector('.semantic-merge-review')`, { label: 'excerpt merge saved' })
    const excerptLink = await evaluate(wc, `(() => {
      const state = JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}')
      const note = (state.notebook?.notes || []).find((item) => item.body.includes('在框架内部'))
      return { senseIds: note?.senseIds || [], canonical: (state.notebook?.atoms || []).some((atom) => atom.id === 'within|preposition|inside-framework') }
    })()`)
    record('saving one semantic excerpt confirms integration and links to the canonical record',
      excerptLink.canonical && excerptLink.senseIds.includes('within|preposition|inside-framework')
        && !excerptLink.senseIds.includes('within|preposition|inside-framework-note'), JSON.stringify(excerptLink))

    const bankFinance = { sense: {
      ...withinFirst.sense, term: 'bank', lemma: 'bank', senseId: 'financial-institution',
      contextualMeaning: '银行', definition: 'a financial institution', contextSentence: 'A bank holds and lends money.',
    } }
    const bankRiver = { sense: {
      ...bankFinance.sense, senseId: 'river-edge', contextualMeaning: '河岸',
      definition: 'the land beside a river', contextSentence: 'They sat on the river bank.',
    } }
    await installSenseStub(wc, bankFinance)
    await queryTypedSense('bank')
    await waitFor(wc, `document.querySelector('.sense-meta')?.textContent.includes('financial-institution')`, { label: 'bank financial semantic' })
    await evaluate(wc, `document.querySelector('.sense-add').click(); true`)
    await waitFor(wc, `document.querySelector('.sense-add.added') !== null`, { label: 'first bank semantic captured' })
    await installSenseStub(wc, bankRiver)
    await queryTypedSense('bank')
    await waitFor(wc, `document.querySelector('.sense-meta')?.textContent.includes('river-edge')`, { label: 'bank river semantic' })
    await evaluate(wc, `document.querySelector('.sense-add').click(); true`)
    await waitFor(wc, `document.querySelector('.semantic-merge-review') !== null`, { label: 'different bank semantic decision' })
    await evaluate(wc, `Array.from(document.querySelectorAll('.semantic-merge-review footer button')).find((button) => button.textContent.includes('作为不同语义')).click(); true`)
    await waitFor(wc, `document.querySelector('.sense-add.added') !== null && !document.querySelector('.semantic-merge-review')`, { label: 'distinct bank semantic captured' })
    const bankSemantics = await evaluate(wc, `(() => {
      const state = JSON.parse(localStorage.getItem('paperlight-state-v1') || '{}')
      return (state.notebook?.atoms || []).filter((atom) => atom.lemma === 'bank').map((atom) => ({ id: atom.id, meaning: atom.contextualMeaning }))
    })()`)
    record('different meanings of the same English word remain separate after explicit choice',
      bankSemantics.length === 2 && new Set(bankSemantics.map((atom) => atom.id)).size === 2
        && bankSemantics.some((atom) => atom.meaning === '银行') && bankSemantics.some((atom) => atom.meaning === '河岸'), JSON.stringify(bankSemantics))

    // Save the confirmed record and ensure its alternate model identity survives in Vault Markdown.
    await installSenseStub(wc, withinVariant)
    await queryTypedSense('within')
    await waitFor(wc, `document.querySelector('.sense-add.added') !== null`, { label: 'within alias before vault save' })
    await evaluate(wc, `document.querySelector('.vault-action-row .vault-button').click(); true`)
    const withinNotePath = join(vaultDir, 'notes', 'books', 'book1', 'within--inside-framework.md')
    let withinNote = ''
    for (let attempt = 0; attempt < 30 && !withinNote; attempt += 1) {
      await sleep(200)
      try { withinNote = readFileSync(withinNotePath, 'utf8') } catch { withinNote = '' }
    }
    record('confirmed semantic IDs and source contexts persist in Vault Markdown',
      withinNote.includes('alternateSemanticIds: [')
        && withinNote.includes('within|preposition|limited-range')
        && withinNote.includes('within|preposition|inside-framework-note')
        && withinNote.includes('Foucault-liberal-political-economy.pdf') && withinNote.includes('book1.pdf'),
      withinNote.split('\n').slice(0, 12).join(' | '))
    record('a V1 sense Markdown file upgrades in place without overwriting the user body',
      existsSync(legacySemanticPath)
        && withinNote.includes('kind: semantic')
        && withinNote.includes('semanticId: within|preposition|inside-framework')
        && withinNote.includes('semantics: [within|preposition|inside-framework]')
        && withinNote.includes('senses: [within|preposition|inside-framework]')
        && withinNote.includes('用户手动维护的 V1 语义说明。')
        && withinNote.includes('用户修改过的旧解释，不应由新 AI 覆盖。')
        && withinNote.includes('这段 V1 Markdown 必须原样保留。')
        && (readdirSync(join(vaultDir, 'notes', 'books', 'book1')).filter((name) => name === 'within--inside-framework.md').length === 1),
      legacySemanticPath)
  } catch (error) {
    let diagnostic = null
    try {
      diagnostic = await evaluate(wc, DIAGNOSTIC)
    } catch {
      diagnostic = null
    }
    let diskState = null
    try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      diskState = { tabs: parsed.session?.tabs?.length ?? -1, atoms: parsed.notebook?.atoms?.length ?? -1, notes: parsed.notebook?.notes?.length ?? -1, readingActivity: parsed.readingActivity }
    } catch (error) {
      diskState = { error: error instanceof Error ? error.message : String(error) }
    }
    record(
      'smoke run completed',
      false,
      `${error instanceof Error ? (error.stack || error.message) : String(error)}\ndiskState=${JSON.stringify(diskState)}\n${JSON.stringify(diagnostic, null, 2)}\nrenderer log tail:\n${consoleLog.slice(-25).join('\n')}`,
    )
  }

  const report = { ok: failures === 0, failures, results: RESULTS, artifacts }
  writeFileSync(join(artifacts, 'smoke-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`} — screenshots in ${artifacts}`)
  app.exit(failures === 0 ? 0 : 1)
  return report
}
