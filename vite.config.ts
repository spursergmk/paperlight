import {
  chmodSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, openSync,
  readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { relative, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const CONFIG_PATH = '/api/translation-config'
const DEFAULT_API_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
const ALLOWED_API_HOSTS = new Set(['api.deepseek.com', 'api.openai.com', 'api.zjuailab.club'])
const MAX_CONFIG_BYTES = 2_000
const MAX_TRANSLATION_BYTES = 64_000
const PDFJS_ASSET_ROUTE = '/pdfjs-assets'
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const

function pdfjsAssets(root: string): Plugin {
  const source = resolve(root, 'node_modules/pdfjs-dist')
  const contentType = (file: string) => {
    if (file.endsWith('.wasm')) return 'application/wasm'
    if (file.endsWith('.js') || file.endsWith('.txt') || file.endsWith('LICENSE')) return 'text/plain; charset=utf-8'
    return 'application/octet-stream'
  }
  const eachAsset = (visit: (dir: string, name: string, filePath: string) => void) => {
    for (const dir of PDFJS_ASSET_DIRS) {
      const dirPath = resolve(source, dir)
      if (!existsSync(dirPath)) continue
      for (const name of readdirSync(dirPath)) {
        const filePath = resolve(dirPath, name)
        if (statSync(filePath).isFile()) visit(dir, name, filePath)
      }
    }
  }

  return {
    name: 'paperlight-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use(PDFJS_ASSET_ROUTE, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const requested = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
        const target = resolve(source, requested)
        if (relative(source, target).startsWith('..') || !existsSync(target) || !statSync(target).isFile()) {
          next()
          return
        }
        res.writeHead(200, {
          'Content-Type': contentType(target),
          'Cache-Control': 'no-cache',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        createReadStream(target).pipe(res)
      })
    },
    generateBundle() {
      eachAsset((dir, name, filePath) => {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_ASSET_ROUTE.slice(1)}/${dir}/${name}`,
          source: readFileSync(filePath),
        })
      })
    },
  }
}


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

type ApiProtocol = 'responses' | 'chat-completions'

// DeepSeek's official API exposes the OpenAI Chat Completions format
// (POST /chat/completions); it has no Responses endpoint.
function protocolFor(baseUrl: string): ApiProtocol {
  try {
    return new URL(baseUrl).hostname === 'api.deepseek.com' ? 'chat-completions' : 'responses'
  } catch {
    return 'responses'
  }
}

function apiEndpoint(baseUrl: string): string {
  if (protocolFor(baseUrl) === 'chat-completions') return `${baseUrl}/chat/completions`
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
  return /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)
}

type SenseTask = 'lookup' | 'expand' | 'ask'
type JsonRecord = Record<string, unknown>

interface SenseRequest {
  task: SenseTask
  term: string
  context: string
  sense: { contextualMeaning: string; definition: string }
  question: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  model?: string
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseSenseRequest(value: unknown): SenseRequest {
  const input = asRecord(value)
  if (input.task !== 'lookup' && input.task !== 'expand' && input.task !== 'ask') {
    throw new RequestError(400, '无效的义项查询任务。')
  }
  const term = asString(input.term).trim()
  if (!term || term.length > 120) throw new RequestError(400, '查询词语必须为 1 到 120 个字符。')
  const question = asString(input.question).trim()
  if (input.task === 'ask' && (!question || question.length > 2_000)) {
    throw new RequestError(400, '追问内容必须为 1 到 2,000 个字符。')
  }
  const sense = asRecord(input.sense)
  const rawHistory = Array.isArray(input.history) ? input.history : []
  const history = rawHistory
    .filter((item) => {
      const entry = asRecord(item)
      return (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string'
    })
    .slice(-8)
    .map((item) => {
      const entry = asRecord(item)
      return {
        role: entry.role as 'user' | 'assistant',
        content: asString(entry.content).slice(0, 1_200),
      }
    })
  return {
    task: input.task,
    term,
    context: asString(input.context).slice(0, 1_200),
    sense: {
      contextualMeaning: asString(sense.contextualMeaning).slice(0, 1_200),
      definition: asString(sense.definition).slice(0, 1_200),
    },
    question: question.slice(0, 2_000),
    history,
    model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined,
  }
}

const senseSystemPrompt = `You are Paperlight's English lexical sense assistant. Return exactly one JSON object and no markdown or commentary. Only mark an example sourceType as "verified" when it comes from a widely known, independently verifiable work or source, and citation includes a non-empty work title plus author/year or a URL. If uncertain, use "ai_generated" with citation null. Never invent or guess a citation. Explanations should help a Chinese learner choose accurate, natural expression.`

function senseTaskPrompt(request: SenseRequest): string {
  if (request.task === 'lookup') {
    return `Disambiguate the selected term from its context and return {"sense":{"term":string,"lemma":string,"partOfSpeech":string,"senseId":short-slug,"contextualMeaning":one-sentence-Simplified-Chinese,"definition":single-sense-English-definition,"contextSentence":string,"examples":[{"text":string,"translation":string,"sourceType":"verified"|"ai_generated","citation":string|null}],"guidance":{"scenarios":[string],"advice":[string],"frequency":string,"alternatives":[{"term":string,"note":string}],"synonyms":[{"term":string,"contrast":string}],"antonyms":[{"term":string,"contrast":string}],"morphology":{"root":string,"prefix":string,"suffix":string,"note":string}}}}. Focus on exactly one contextual sense. Input: ${JSON.stringify({ term: request.term, context: request.context })}`
  }
  if (request.task === 'expand') {
    return `Return {"senses":[{"senseId":short-slug,"partOfSpeech":string,"definition":English-definition,"meaning":Simplified-Chinese-meaning,"isContextual":boolean}]}. Describe only distinct dictionary senses of this term. Do not mix in content unrelated to the term's senses, examples, or general usage advice. Input: ${JSON.stringify({ term: request.term, context: request.context })}`
  }
  return `Answer around the supplied contextual sense to help the user find a good, precise expression. Return {"answer":string} in Simplified Chinese unless the user asks otherwise. Input: ${JSON.stringify({ term: request.term, sense: request.sense, question: request.question, history: request.history })}`
}

// Closes a truncated JSON payload: unterminated strings, dangling keys and open braces.
function closeJson(text: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') stack.pop()
  }
  let repaired = text
  if (inString) repaired += '"'
  repaired = repaired.replace(/,\s*$/, '').replace(/:\s*$/, ': null')
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    repaired += stack[index] === '{' ? '}' : ']'
  }
  return repaired
}

function extractJsonObject(text: string): JsonRecord {
  const withoutFence = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  const start = withoutFence.indexOf('{')
  if (start < 0) throw new RequestError(502, '模型返回的内容无法解析。')

  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let index = start; index < withoutFence.length; index += 1) {
    const character = withoutFence[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) { end = index; break }
    }
  }

  const candidates = end >= 0
    ? [withoutFence.slice(start, end + 1)]
    : [closeJson(withoutFence.slice(start))]

  for (const candidate of candidates) {
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        return asRecord(JSON.parse(attempt) as unknown)
      } catch {
        // Try the next repair variant.
      }
    }
  }
  throw new RequestError(502, '模型返回的内容无法解析。')
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function termNoteArray(value: unknown, detailKey: 'note' | 'contrast'): Array<Record<string, string>> {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const entry = asRecord(item)
    return { term: asString(entry.term), [detailKey]: asString(entry[detailKey]) }
  })
}

function normalizeSensePayload(value: unknown): JsonRecord {
  const sense = asRecord(value)
  const guidance = asRecord(sense.guidance)
  const morphology = asRecord(guidance.morphology)
  const examples = Array.isArray(sense.examples) ? sense.examples.map((item) => {
    const example = asRecord(item)
    const citation = asString(example.citation).trim()
    const verified = example.sourceType === 'verified' && citation.length > 0
    return {
      text: asString(example.text),
      translation: asString(example.translation),
      sourceType: verified ? 'verified' : 'ai_generated',
      citation: verified ? citation : null,
    }
  }) : []
  return {
    term: asString(sense.term),
    lemma: asString(sense.lemma),
    partOfSpeech: asString(sense.partOfSpeech),
    senseId: asString(sense.senseId),
    contextualMeaning: asString(sense.contextualMeaning),
    definition: asString(sense.definition),
    contextSentence: asString(sense.contextSentence),
    examples,
    guidance: {
      scenarios: stringArray(guidance.scenarios),
      advice: stringArray(guidance.advice),
      frequency: asString(guidance.frequency),
      alternatives: termNoteArray(guidance.alternatives, 'note'),
      synonyms: termNoteArray(guidance.synonyms, 'contrast'),
      antonyms: termNoteArray(guidance.antonyms, 'contrast'),
      morphology: {
        root: asString(morphology.root),
        prefix: asString(morphology.prefix),
        suffix: asString(morphology.suffix),
        note: asString(morphology.note),
      },
    },
  }
}

function normalizeSenseSummaries(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const sense = asRecord(item)
    return {
      senseId: asString(sense.senseId),
      partOfSpeech: asString(sense.partOfSpeech),
      definition: asString(sense.definition),
      meaning: asString(sense.meaning),
      isContextual: sense.isContextual === true,
    }
  })
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
          sendJson(res, 200, { configured: source !== null, source, baseUrl: effectiveBaseUrl(root), protocol: protocolFor(effectiveBaseUrl(root)), csrfNonce })
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
            sendJson(res, 200, { configured: false, source: null, baseUrl: effectiveBaseUrl(root), protocol: protocolFor(effectiveBaseUrl(root)), csrfNonce })
            return
          }

          const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
          if (apiKey.length < 20 || apiKey.length > 500 || !/^[A-Za-z0-9._-]+$/.test(apiKey)) {
            sendJson(res, 400, { error: '请输入有效的 API 密钥。' })
            return
          }
          const baseUrl = normalizeBaseUrl(input.baseUrl)
          updateLocalConfig(root, apiKey, baseUrl)
          sendJson(res, 200, { configured: true, source: 'local-file', baseUrl, protocol: protocolFor(baseUrl), csrfNonce })
        } catch (error) {
          if (error instanceof RequestError) {
            sendJson(res, error.status, { error: error.message })
          } else {
            sendJson(res, 500, { error: '无法安全保存 API 配置。' })
          }
        }
      })

      server.middlewares.use('/api/sense', async (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.method !== 'POST') return next()
        if (!isAllowedLocalRequest(req)) {
          sendJson(res, 403, { error: '义项查询只允许从本机 Paperlight 访问。' })
          return
        }

        try {
          const request = parseSenseRequest(await readJsonBody(req, MAX_TRANSLATION_BYTES))
          const key = process.env.OPENAI_API_KEY || readLocalSetting(root, 'OPENAI_API_KEY')
          if (!key) {
            sendJson(res, 503, { error: '尚未配置 API 密钥。请在翻译设置中完成配置。' })
            return
          }

          const baseUrl = effectiveBaseUrl(root)
          const protocol = protocolFor(baseUrl)
          const model = request.model || DEFAULT_MODEL
          const prompt = senseTaskPrompt(request)
          const requestBody = protocol === 'chat-completions'
            ? {
                model,
                stream: false,
                messages: [
                  { role: 'system', content: senseSystemPrompt },
                  { role: 'user', content: prompt },
                ],
              }
            : { model, instructions: senseSystemPrompt, input: prompt }
          const response = await fetch(apiEndpoint(baseUrl), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          })
          const payload = await response.json() as {
            output_text?: string
            choices?: Array<{ message?: { content?: string } }>
            error?: { message?: string }
          }
          if (!response.ok) {
            sendJson(res, response.status, { error: payload.error?.message || '义项查询请求未成功。' })
            return
          }
          const modelText = protocol === 'chat-completions'
            ? payload.choices?.[0]?.message?.content
            : payload.output_text
          let parsed: JsonRecord
          try {
            parsed = extractJsonObject(modelText || '')
          } catch (error) {
            // Diagnostic only: helps explain unparsable model output. Never contains credentials.
            console.warn(
              '[paperlight] /api/sense could not parse model output:',
              JSON.stringify({
                length: String(modelText || '').length,
                head: String(modelText || '').slice(0, 300),
                tail: String(modelText || '').slice(-200),
              }),
            )
            throw error
          }
          if (request.task === 'lookup') {
            if (!parsed.sense || typeof parsed.sense !== 'object' || Array.isArray(parsed.sense)) {
              throw new RequestError(502, '模型返回的内容无法解析。')
            }
            sendJson(res, 200, { sense: normalizeSensePayload(parsed.sense) })
          } else if (request.task === 'expand') {
            if (!Array.isArray(parsed.senses)) throw new RequestError(502, '模型返回的内容无法解析。')
            sendJson(res, 200, { senses: normalizeSenseSummaries(parsed.senses) })
          } else {
            if (typeof parsed.answer !== 'string') throw new RequestError(502, '模型返回的内容无法解析。')
            sendJson(res, 200, { answer: parsed.answer })
          }
        } catch (error) {
          if (error instanceof RequestError) {
            sendJson(res, error.status, { error: error.message })
          } else {
            sendJson(res, 500, { error: '义项查询失败。' })
          }
        }
      })

      server.middlewares.use('/api/translate', async (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.method !== 'POST') return next()
        if (!isAllowedLocalRequest(req)) {
          sendJson(res, 403, { error: '翻译只允许从本机 Paperlight 访问。' })
          return
        }

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

          const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : DEFAULT_MODEL
          const baseUrl = effectiveBaseUrl(root)
          const protocol = protocolFor(baseUrl)
          const instructions = 'You are a careful English-to-Chinese translator. Translate the selected English text into clear, natural Simplified Chinese. Use the surrounding text only to resolve meaning and references. Preserve names, numbers, citations, and technical terms where appropriate. Return only the translation, with no preface or explanation.'
          const context = JSON.stringify({
            preceding_context: typeof input.before === 'string' ? input.before.slice(-700) : '',
            selected_text: text,
            following_context: typeof input.after === 'string' ? input.after.slice(0, 700) : '',
          })
          const requestBody = protocol === 'chat-completions'
            ? {
                model,
                stream: false,
                messages: [
                  { role: 'system', content: instructions },
                  { role: 'user', content: context },
                ],
              }
            : { model, instructions, input: context }

          const response = await fetch(apiEndpoint(baseUrl), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          })

          const payload = await response.json() as {
            output_text?: string
            choices?: Array<{ message?: { content?: string } }>
            error?: { message?: string }
          }
          if (!response.ok) {
            sendJson(res, response.status, { error: payload.error?.message || '翻译请求未成功。' })
            return
          }
          const translated = (protocol === 'chat-completions'
            ? payload.choices?.[0]?.message?.content
            : payload.output_text)?.trim()
          sendJson(res, 200, { translation: translated || '未收到译文，请重试。' })
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
    plugins: [react(), pdfjsAssets(root), translationProxy(root)],
    server: { host: '127.0.0.1' },
  }
})
