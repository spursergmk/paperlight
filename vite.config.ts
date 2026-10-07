import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const CONFIG_PATH = '/api/translation-config'
const DEFAULT_API_BASE_URL = 'https://api.openai.com'
const ALLOWED_API_HOSTS = new Set(['api.openai.com', 'api.zjuailab.club'])
const MAX_CONFIG_BYTES = 2_000
const MAX_TRANSLATION_BYTES = 64_000

class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function localEnvPath(root: string): string {
  return resolve(root, '.env.local')
}

function readLocalSetting(root: string, name: 'OPENAI_API_KEY' | 'OPENAI_BASE_URL'): string | undefined {
  const envPath = localEnvPath(root)
  try {
    if (lstatSync(envPath).isSymbolicLink()) return undefined
    const contents = readFileSync(envPath, 'utf8')
    const pattern = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm')
    const match = contents.match(pattern)
    return match?.[1]?.replace(/^['"]|['"]$/g, '')
  } catch {
    return undefined
  }
}

function effectiveBaseUrl(root: string): string {
  return process.env.OPENAI_BASE_URL || readLocalSetting(root, 'OPENAI_BASE_URL') || DEFAULT_API_BASE_URL
}

function responsesEndpoint(baseUrl: string): string {
  return baseUrl.endsWith('/v1') ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new RequestError(400, '请输入 API Base URL。')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new RequestError(400, 'API Base URL 格式无效。')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new RequestError(400, 'API Base URL 必须是无账号、查询参数和片段的 HTTPS 地址。')
  }
  if (!ALLOWED_API_HOSTS.has(url.hostname) || url.port) {
    throw new RequestError(400, '当前仅允许 OpenAI 官方地址和 api.zjuailab.club。')
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  if (pathname !== '/' && pathname !== '/v1') {
    throw new RequestError(400, 'API Base URL 只能使用网关根地址或 /v1 路径。')
  }
  return `${url.origin}${pathname === '/' ? '' : pathname}`
}

function updateLocalConfig(root: string, apiKey: string | undefined, baseUrl?: string): void {
  const envPath = localEnvPath(root)
  if (existsSync(envPath) && lstatSync(envPath).isSymbolicLink()) {
    throw new RequestError(409, '出于安全原因，.env.local 不能是符号链接。')
  }

  let contents = ''
  try {
    contents = readFileSync(envPath, 'utf8')
  } catch (error) {
    if (existsSync(envPath)) throw error
  }

  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const hadFinalNewline = contents.endsWith('\n')
  const lines = contents ? contents.split(/\r?\n/) : []
  if (hadFinalNewline) lines.pop()
  const managedLine = /^\s*(?:OPENAI_API_KEY|OPENAI_BASE_URL)\s*=/
  const firstManagedIndex = lines.findIndex((line) => managedLine.test(line))
  const preserved = lines.filter((line) => !managedLine.test(line))
  const insertionIndex = firstManagedIndex >= 0 ? Math.min(firstManagedIndex, preserved.length) : preserved.length
  const managedValues = [
    ...(apiKey ? [`OPENAI_API_KEY=${apiKey}`] : []),
    ...(baseUrl ? [`OPENAI_BASE_URL=${baseUrl}`] : []),
  ]
  preserved.splice(insertionIndex, 0, ...managedValues)
  const nextContents = preserved.length ? `${preserved.join(newline)}${newline}` : ''

  const tempPath = resolve(root, `.env.local.paperlight-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(tempPath, 'wx', 0o600)
    writeSync(descriptor, nextContents, undefined, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(tempPath, envPath)
    chmodSync(envPath, 0o600)
    const directory = openSync(root, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(tempPath) } catch { /* The rename may already have completed. */ }
    throw error
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = req.headers['content-type'] || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new RequestError(415, '请求必须使用 application/json。')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new RequestError(413, '请求内容过长。')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, '请求格式无效。')
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  res.end(JSON.stringify(payload))
}

function isAllowedLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host || ''
  return /^(?:127\.0\.0\.1|localhost):\d+$/.test(host)
}

function translationProxy(root: string): Plugin {
  const csrfNonce = randomBytes(32).toString('base64url')
  return {
    name: 'paperlight-local-translation-proxy',
    configureServer(server) {
      server.middlewares.use(CONFIG_PATH, async (req: IncomingMessage, res: ServerResponse, next) => {
        if (!isAllowedLocalRequest(req)) {
          sendJson(res, 403, { error: 'API 配置只允许从本机 Paperlight 访问。' })
          return
        }
        if (req.method === 'GET') {
          const source = process.env.OPENAI_API_KEY ? 'environment' : readLocalSetting(root, 'OPENAI_API_KEY') ? 'local-file' : null
          sendJson(res, 200, { configured: source !== null, source, baseUrl: effectiveBaseUrl(root), csrfNonce })
          return
        }
        if (req.method !== 'PUT' && req.method !== 'DELETE') return next()

        const expectedOrigin = `http://${req.headers.host}`
        if (req.headers.origin !== expectedOrigin || req.headers['x-paperlight-csrf'] !== csrfNonce) {
          sendJson(res, 403, { error: 'API 配置请求未通过安全校验，请刷新页面后重试。' })
          return
        }
        if (process.env.OPENAI_API_KEY) {
          sendJson(res, 409, { error: '密钥由启动环境提供，不能在页面中覆盖或删除。' })
          return
        }

        try {
          const input = await readJsonBody(req, MAX_CONFIG_BYTES) as { apiKey?: unknown; baseUrl?: unknown }
          if (req.method === 'DELETE') {
            const baseUrl = readLocalSetting(root, 'OPENAI_BASE_URL')
            updateLocalConfig(root, undefined, baseUrl)
            sendJson(res, 200, { configured: false, source: null, baseUrl: effectiveBaseUrl(root), csrfNonce })
            return
          }

          const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
          if (apiKey.length < 20 || apiKey.length > 500 || !/^[A-Za-z0-9._-]+$/.test(apiKey)) {
            sendJson(res, 400, { error: '请输入有效的 API 密钥。' })
            return
          }
          const baseUrl = normalizeBaseUrl(input.baseUrl)
          updateLocalConfig(root, apiKey, baseUrl)
          sendJson(res, 200, { configured: true, source: 'local-file', baseUrl, csrfNonce })
        } catch (error) {
          if (error instanceof RequestError) {
            sendJson(res, error.status, { error: error.message })
          } else {
            sendJson(res, 500, { error: '无法安全保存 API 配置。' })
          }
        }
      })

      server.middlewares.use('/api/translate', async (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.method !== 'POST') return next()

        try {
          const input = await readJsonBody(req, MAX_TRANSLATION_BYTES) as {
            text?: unknown
            before?: unknown
            after?: unknown
            model?: unknown
          }
          const text = typeof input.text === 'string' ? input.text.trim() : ''
          if (!text || text.length > 12_000) {
            sendJson(res, 400, { error: '请选择不超过 12,000 个字符的文本。' })
            return
          }

          const key = process.env.OPENAI_API_KEY || readLocalSetting(root, 'OPENAI_API_KEY')
          if (!key) {
            sendJson(res, 503, { error: '尚未配置 API 密钥。请在翻译设置中完成配置。' })
            return
          }

          const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : 'gpt-5-mini'
          const response = await fetch(responsesEndpoint(effectiveBaseUrl(root)), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              instructions: 'You are a careful English-to-Chinese translator. Translate the selected English text into clear, natural Simplified Chinese. Use the surrounding text only to resolve meaning and references. Preserve names, numbers, citations, and technical terms where appropriate. Return only the translation, with no preface or explanation.',
              input: JSON.stringify({
                preceding_context: typeof input.before === 'string' ? input.before.slice(-700) : '',
                selected_text: text,
                following_context: typeof input.after === 'string' ? input.after.slice(0, 700) : '',
              }),
            }),
          })

          const payload = await response.json() as {
            output_text?: string
            error?: { message?: string }
          }
          if (!response.ok) {
            sendJson(res, response.status, { error: payload.error?.message || '翻译请求未成功。' })
            return
          }
          sendJson(res, 200, { translation: payload.output_text?.trim() || '未收到译文，请重试。' })
        } catch (error) {
          if (error instanceof RequestError) {
            sendJson(res, error.status, { error: error.message })
          } else {
            sendJson(res, 500, { error: '翻译请求失败。' })
          }
        }
      })
    },
  }
}

export default defineConfig(() => {
  const root = process.cwd()
  return {
    plugins: [react(), translationProxy(root)],
    server: { host: '127.0.0.1' },
  }
})
