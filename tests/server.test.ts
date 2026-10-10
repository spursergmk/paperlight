import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createPaperlightApi, createStaticHandler } from '../server/api.mjs'

interface Reply { status: number; body: string; headers: Record<string, string | string[] | undefined> }

function rawRequest(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers: options.headers,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function withServer<T>(run: (port: number, dirs: { dist: string; outside: string }) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), 'paperlight-static-'))
  const dist = join(base, 'dist')
  const outside = join(base, 'outside')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Paperlight</title>')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
  // A symlink planted inside the bundle must not escape it either.
  symlinkSync(join(outside, 'secret.txt'), join(dist, 'link.txt'))

  const api = createPaperlightApi({ root: base })
  const serveStatic = createStaticHandler(dist)
  const server = createServer((req, res) => {
    api.middleware(req, res, () => {
      serveStatic(req, res, () => { res.writeHead(404).end('not found') })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    return await run(port, { dist, outside })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(base, { recursive: true, force: true })
  }
}

test('the static handler serves the bundle and its SPA fallback', async () => {
  await withServer(async (port) => {
    const index = await rawRequest(port, { path: '/' })
    assert.equal(index.status, 200)
    assert.match(index.body, /Paperlight/)
    const asset = await rawRequest(port, { path: '/assets/app.js' })
    assert.equal(asset.status, 200)
    assert.match(asset.headers['content-type'] as string, /javascript/)
    const missing = await rawRequest(port, { path: '/does-not-exist.js' })
    assert.equal(missing.status, 404, 'unknown asset paths must not silently become HTML')
  })
})

test('V3 query modules share one structured response and analysis keeps translation separate', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.OPENAI_API_KEY
  const originalBase = process.env.OPENAI_BASE_URL
  process.env.OPENAI_API_KEY = 'test-only-paperlight-key'
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
  const providerBodies: Array<Record<string, any>> = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, any>
    providerBodies.push(body)
    const prompt = String(body.messages?.[1]?.content || '')
    const content = prompt.includes('Original text:')
      ? JSON.stringify({ translation: '他们终于达成了共识。', meaning: '这句话说明双方经过讨论后意见一致。' })
      : prompt.includes('Compare 2 to 5')
        ? JSON.stringify({ content: 'reach a consensus 更强调协商结果；agree 更宽泛。', expressions: [{ expression: 'reach a consensus', meaning: '达成共识', usageScenario: '正式讨论' }] })
        : prompt.includes('"term":"bank"')
          ? JSON.stringify({
              status: 'ambiguous', explanation: '缺少语境时，bank 可指金融机构或河岸。',
              sense: {
                term: 'bank', lemma: 'bank', partOfSpeech: 'noun', senseId: 'financial-institution',
                contextualMeaning: '银行', definition: 'a financial institution', contextSentence: 'They visited the bank.',
                examples: [], guidance: { scenarios: [], advice: [], frequency: '', alternatives: [], synonyms: [], antonyms: [], morphology: {} },
              },
              syntax: '不应在词语查询中展示句法模块。',
              usage: { summary: '取决于语境。' },
            })
        : JSON.stringify({
            status: 'resolved', explanation: '',
            sense: {
              term: 'consensus', lemma: 'consensus', partOfSpeech: 'noun', senseId: 'shared-opinion',
              contextualMeaning: '共识', definition: 'a generally accepted opinion', contextSentence: 'They reached a consensus.',
              examples: [], guidance: { scenarios: [], advice: [], frequency: '', alternatives: [], synonyms: [], antonyms: [], morphology: {} },
            },
            syntax: 'reached 是谓语，a consensus 是宾语。',
            usage: { summary: '常用于讨论后形成共同意见。', scenarios: ['协商'], collocations: ['reach a consensus'], advice: [], expressions: [{ expression: 'reach a consensus', meaning: '达成共识', usageScenario: '正式讨论' }] },
          })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }) as typeof fetch
  try {
    await withServer(async (port) => {
      const post = (path: string, body: unknown) => rawRequest(port, {
        method: 'POST', path,
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const query = await post('/api/query', {
        task: 'default', term: 'They reached a consensus.', context: 'They reached a consensus after a long discussion.', isSentence: true,
      })
      assert.equal(query.status, 200)
      const queryBody = JSON.parse(query.body)
      assert.equal(queryBody.status, 'resolved')
      assert.equal(queryBody.sense.contextualMeaning, '共识')
      assert.deepEqual(queryBody.modules.map((module: { key: string }) => module.key), ['syntax', 'usage'])
      assert.match(providerBodies[0].messages[1].content, /Do not present language intuition as measured frequency/)

      const word = await post('/api/query', { task: 'default', term: 'consensus', context: 'They reached a consensus.', isSentence: false })
      assert.equal(word.status, 200)
      assert.deepEqual(JSON.parse(word.body).modules.map((module: { key: string }) => module.key), ['usage'])

      const ambiguous = await post('/api/query', { task: 'default', term: 'bank', context: '', isSentence: false })
      assert.equal(ambiguous.status, 200)
      const ambiguousBody = JSON.parse(ambiguous.body)
      assert.equal(ambiguousBody.status, 'ambiguous')
      assert.equal('sense' in ambiguousBody, false, 'an uncertain sense must not be presented as a resolved answer')
      assert.match(ambiguousBody.explanation, /bank/)

      const optional = await post('/api/query', { task: 'synonyms', term: 'reach a consensus', context: 'They reached a consensus.' })
      assert.equal(optional.status, 200)
      assert.equal(JSON.parse(optional.body).modules[0].key, 'synonyms')

      const analysis = await post('/api/analysis', {
        source: { text: 'They finally reached a consensus.', sourceKind: 'pdf', pageNumber: 2, sourceName: 'sample.pdf' },
        instruction: 'Explain the argument', scopeLabel: 'PDF 第 2 页',
      })
      assert.equal(analysis.status, 200)
      assert.deepEqual(JSON.parse(analysis.body), { translation: '他们终于达成了共识。', meaning: '这句话说明双方经过讨论后意见一致。' })
      assert.equal(providerBodies.length, 5)
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalBase
  }
})

test('V3 query and analysis endpoints reject foreign hosts and out-of-scope payloads', async () => {
  await withServer(async (port) => {
    const post = (path: string, body: unknown, host = `127.0.0.1:${port}`) => rawRequest(port, {
      method: 'POST', path,
      headers: { Host: host, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal((await post('/api/query', { task: 'default', term: 'word' }, 'outside.example:80')).status, 403)
    assert.equal((await post('/api/analysis', { source: { text: 'text' } }, 'outside.example:80')).status, 403)
    assert.equal((await post('/api/query', { task: 'default', term: 'word', context: 'x'.repeat(5_001) })).status, 400)
    assert.equal((await post('/api/analysis', { source: { text: 'x'.repeat(20_001) } })).status, 400)
  })
})

test('path traversal cannot leave the bundle', async () => {
  await withServer(async (port) => {
    for (const path of [
      '/../outside/secret.txt',
      '/assets/../../outside/secret.txt',
      '/%2e%2e/outside/secret.txt',
      '/..%2f..%2foutside%2fsecret.txt',
    ]) {
      const reply = await rawRequest(port, { path })
      assert.ok(reply.status === 403 || reply.status === 404, `${path} → ${reply.status}`)
      assert.ok(!reply.body.includes('TOP SECRET'), `${path} leaked the outside file`)
    }
  })
})

test('a symlink inside the bundle cannot serve a file outside it', async () => {
  await withServer(async (port) => {
    const reply = await rawRequest(port, { path: '/link.txt' })
    assert.ok(reply.status === 403 || reply.status === 404, `status ${reply.status}`)
    assert.ok(!reply.body.includes('TOP SECRET'), 'symlink escaped the bundle')
  })
})

test('the vault knowledge endpoints validate input and stay loopback-only', async () => {
  await withServer(async (port) => {
    const loopbackHost = `127.0.0.1:${port}`
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => rawRequest(port, {
      method: 'POST',
      path,
      headers: { Host: loopbackHost, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

    // A foreign Host never reaches the model, whichever vault endpoint is used.
    for (const path of ['/api/vault-chat', '/api/note', '/api/daily-summary']) {
      const foreign = await post(path, { question: 'x' }, { Host: 'evil.example:80' })
      assert.equal(foreign.status, 403, `${path} must reject a non-loopback Host`)
    }

    // Bad input is rejected before any model call (there is no key configured here).
    const emptyQuestion = await post('/api/vault-chat', { question: '   ' })
    assert.equal(emptyQuestion.status, 400)
    assert.match(emptyQuestion.body, /问题/)

    const oversizedQuestion = await post('/api/vault-chat', { question: 'x'.repeat(4_001) })
    assert.equal(oversizedQuestion.status, 400)

    const missingSense = await post('/api/note', { task: 'sense' })
    assert.equal(missingSense.status, 400)

    const emptyDay = await post('/api/daily-summary', { date: '2026-02-14', records: [] })
    assert.equal(emptyDay.status, 400)

    const badDate = await post('/api/daily-summary', { date: '14/02/2026', records: [{ label: 'a' }] })
    assert.equal(badDate.status, 400)

    const recordsOnly = await post('/api/daily-summary', { date: '2026-02-14', records: [{ kind: 'sense', label: 'numerous', body: '众多的' }] })
    assert.equal(recordsOnly.status, 503, 'valid input reaches the model call')

    const findingsOnly = await post('/api/daily-summary', {
      date: '2026-02-14',
      records: [],
      findings: [{ path: 'enlightenment/2026-02-14-x.md', content: '### 观察\n\n名义与实际。' }],
    })
    assert.equal(findingsOnly.status, 503, 'a day with only findings is still worth a report')

    // Valid input reaches the model call, which reports the missing key locally.
    const noKey = await post('/api/vault-chat', { question: 'numerous 怎么用？', context: [{ path: 'a.md', content: 'x' }] })
    assert.equal(noKey.status, 503)
    assert.match(noKey.body, /密钥/)

    const noKeyNote = await post('/api/note', { task: 'topic', term: 'numerous' })
    assert.equal(noKeyNote.status, 503)

    const noKeySummary = await post('/api/daily-summary', { date: '2026-02-14', records: [{ label: 'numerous 义项', body: '众多的' }] })
    assert.equal(noKeySummary.status, 503)
  })
})

test('disconnecting a vault chat aborts the upstream model request', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.OPENAI_API_KEY
  let providerSignal: AbortSignal | undefined
  let providerStarted!: () => void
  let providerStopped!: () => void
  const started = new Promise<void>((resolve) => { providerStarted = resolve })
  const stopped = new Promise<void>((resolve) => { providerStopped = resolve })
  process.env.OPENAI_API_KEY = 'test-only-paperlight-key'
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    providerSignal = init?.signal ?? undefined
    providerStarted()
    return new Promise<Response>((_resolve, reject) => {
      if (providerSignal?.aborted) {
        providerStopped()
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      providerSignal?.addEventListener('abort', () => {
        providerStopped()
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }) as typeof fetch

  try {
    await withServer(async (port) => {
      const req = request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/vault-chat',
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      })
      req.on('error', () => undefined)
      req.end(JSON.stringify({ question: 'wait for the answer', context: [] }))
      await started
      req.destroy()
      await Promise.race([
        stopped,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('upstream abort timed out')), 1500)),
      ])
      assert.equal(providerSignal?.aborted, true)
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
})

test('disconnecting AI generation routes aborts the upstream provider call', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-only-paperlight-key'
  const cases = [
    ['/api/sense', { task: 'lookup', term: 'steady', context: 'a steady pace', model: 'test-model' }],
    ['/api/query', { task: 'default', term: 'steady', context: 'a steady pace', isSentence: false, model: 'test-model' }],
    ['/api/analysis', { source: { text: 'A steady pace.', sourceKind: 'text', pageNumber: 1 }, scopeLabel: '选区', model: 'test-model' }],
    ['/api/translate', { text: 'a steady pace', before: '', after: '', model: 'test-model' }],
    ['/api/expression-explore', { mode: 'intent', intent: '委婉地提出不同意见', model: 'test-model' }],
    ['/api/note', { task: 'topic', term: 'steady', question: 'steady', model: 'test-model' }],
    ['/api/daily-summary', { date: '2026-02-14', records: [{ kind: 'expression', label: 'steady pace', body: '从容的节奏' }], findings: [], model: 'test-model' }],
  ] as const

  try {
    await withServer(async (port) => {
      for (const [path, body] of cases) {
        let providerSignal: AbortSignal | undefined
        let providerStarted!: () => void
        let providerStopped!: () => void
        const started = new Promise<void>((resolve) => { providerStarted = resolve })
        const stopped = new Promise<void>((resolve) => { providerStopped = resolve })
        globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
          providerSignal = init?.signal ?? undefined
          providerStarted()
          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => {
              providerStopped()
              reject(new DOMException('Aborted', 'AbortError'))
            }
            if (providerSignal?.aborted) onAbort()
            else providerSignal?.addEventListener('abort', onAbort, { once: true })
          })
        }) as typeof fetch

        const req = request({
          host: '127.0.0.1', port, method: 'POST', path,
          headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        })
        req.on('error', () => undefined)
        req.end(JSON.stringify(body))
        await started
        req.destroy()
        await Promise.race([
          stopped,
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${path} upstream abort timed out`)), 1500)),
        ])
        assert.equal(providerSignal?.aborted, true, `${path} aborts its provider request`)
      }
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
})

test('expression exploration validates intent and related-expression requests on loopback only', async () => {
  await withServer(async (port) => {
    const host = `127.0.0.1:${port}`
    const requestExplore = (body: unknown, requestHost = host) => rawRequest(port, {
      method: 'POST',
      path: '/api/expression-explore',
      headers: { Host: requestHost, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal((await requestExplore({ mode: 'intent', intent: 'I want to express agreement' }, 'attacker.example:80')).status, 403)
    const noIntent = await requestExplore({ mode: 'intent', intent: '   ' })
    assert.equal(noIntent.status, 400)
    assert.match(noIntent.body, /请输入想表达/)
    const noExpression = await requestExplore({ mode: 'related', expression: '' })
    assert.equal(noExpression.status, 400)
    assert.match(noExpression.body, /请输入一个已有表达/)
  })
})

test('the API only answers loopback requests and needs origin + nonce to write', async () => {
  await withServer(async (port) => {
    const loopbackHost = `127.0.0.1:${port}`

    const status = await rawRequest(port, { path: '/api/translation-config', headers: { Host: loopbackHost } })
    assert.equal(status.status, 200)
    const parsed = JSON.parse(status.body) as { configured: boolean; csrfNonce: string }
    assert.equal(typeof parsed.configured, 'boolean')
    assert.ok(parsed.csrfNonce.length > 10)

    const foreignHost = await rawRequest(port, { path: '/api/translation-config', headers: { Host: 'evil.example:80' } })
    assert.equal(foreignHost.status, 403)

    const write = (headers: Record<string, string>) => rawRequest(port, {
      method: 'PUT',
      path: '/api/translation-config',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '46', ...headers },
      body: JSON.stringify({ apiKey: 'sk-0123456789012345678901', baseUrl: 'https://api.deepseek.com' }),
    })

    assert.equal((await write({ Host: loopbackHost })).status, 403, 'no Origin → rejected')
    assert.equal((await write({ Host: loopbackHost, Origin: 'https://evil.example' })).status, 403, 'cross-site Origin → rejected')
    assert.equal(
      (await write({ Host: loopbackHost, Origin: `http://${loopbackHost}` })).status,
      403,
      'correct Origin without the CSRF nonce → rejected',
    )
    assert.equal(
      (await write({ Host: 'evil.example:80', Origin: `http://${loopbackHost}`, 'X-Paperlight-CSRF': parsed.csrfNonce })).status,
      403,
      'non-loopback Host → rejected',
    )
  })
})
