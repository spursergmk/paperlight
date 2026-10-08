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
