// Paperlight local AI proxy.
//
// This module is the single source of truth for the three loopback-only
// endpoints used by the reader: API-key configuration, contextual sense
// lookup and sentence translation. It is mounted by both entry points:
//
//   * the Vite dev server (see vite.config.ts)
//   * the Electron app's internal HTTP server (see electron/main.mjs)
//
// Keeping one implementation means `npm run dev` in a browser and the packaged
// app behave identically, and the API key never leaves the local process.

import {
  chmodSync, closeSync, createReadStream, existsSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { extname, join, normalize, resolve, sep } from 'node:path'

export const CONFIG_PATH = '/api/translation-config'
export const SENSE_PATH = '/api/sense'
export const TRANSLATE_PATH = '/api/translate'
export const VAULT_CHAT_PATH = '/api/vault-chat'
export const NOTE_PATH = '/api/note'
export const DAILY_SUMMARY_PATH = '/api/daily-summary'
export const DEFAULT_API_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL = 'deepseek-flash'
const ALLOWED_API_HOSTS = new Set(['api.deepseek.com', 'api.openai.com', 'api.zjuailab.club'])
const MAX_CONFIG_BYTES = 2_000
const MAX_TRANSLATION_BYTES = 64_000
const MAX_VAULT_CHAT_BYTES = 512_000
const MAX_NOTE_BYTES = 128_000
const VAULT_CONTEXT_FILES = 8
const VAULT_CONTEXT_PER_FILE = 6_000
const VAULT_CONTEXT_TOTAL = 24_000
const FINDING_FILE_LIMIT = 6
const FINDING_CHARS_PER_FILE = 2_500
const FINDING_TOTAL_CHARS = 12_000

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function localEnvPath(root) {
  return resolve(root, '.env.local')
}

function readLocalSetting(root, name) {
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

function effectiveBaseUrl(root) {
  return process.env.OPENAI_BASE_URL || readLocalSetting(root, 'OPENAI_BASE_URL') || DEFAULT_API_BASE_URL
}

// DeepSeek's official API exposes the OpenAI Chat Completions format
// (POST /chat/completions); it has no Responses endpoint.
function protocolFor(baseUrl) {
  try {
    return new URL(baseUrl).hostname === 'api.deepseek.com' ? 'chat-completions' : 'responses'
  } catch {
    return 'responses'
  }
}

function apiEndpoint(baseUrl) {
  if (protocolFor(baseUrl) === 'chat-completions') return `${baseUrl}/chat/completions`
  return baseUrl.endsWith('/v1') ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new RequestError(400, '请输入 API Base URL。')
  let url
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

function updateLocalConfig(root, apiKey, baseUrl) {
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
  let descriptor
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

async function readJsonBody(req, maxBytes) {
  const contentType = req.headers['content-type'] || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new RequestError(415, '请求必须使用 application/json。')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new RequestError(413, '请求内容过长。')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, '请求格式无效。')
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  res.end(JSON.stringify(payload))
}

function isAllowedLocalRequest(req) {
  const host = req.headers.host || ''
  return /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function parseSenseRequest(value) {
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
        role: entry.role,
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

function senseTaskPrompt(request) {
  if (request.task === 'lookup') {
    return `Disambiguate the selected term from its context and return {"sense":{"term":string,"lemma":string,"partOfSpeech":string,"senseId":short-slug,"contextualMeaning":one-sentence-Simplified-Chinese,"definition":single-sense-English-definition,"contextSentence":string,"examples":[{"text":string,"translation":string,"sourceType":"verified"|"ai_generated","citation":string|null}],"guidance":{"scenarios":[string],"advice":[string],"frequency":string,"alternatives":[{"term":string,"note":string}],"synonyms":[{"term":string,"contrast":string}],"antonyms":[{"term":string,"contrast":string}],"morphology":{"root":string,"prefix":string,"suffix":string,"note":string}}}}. Focus on exactly one contextual sense. Input: ${JSON.stringify({ term: request.term, context: request.context })}`
  }
  if (request.task === 'expand') {
    return `Return {"senses":[{"senseId":short-slug,"partOfSpeech":string,"definition":English-definition,"meaning":Simplified-Chinese-meaning,"isContextual":boolean}]}. Describe only distinct dictionary senses of this term. Do not mix in content unrelated to the term's senses, examples, or general usage advice. Input: ${JSON.stringify({ term: request.term, context: request.context })}`
  }
  return `Answer around the supplied contextual sense to help the user find a good, precise expression. Return {"answer":string} in Simplified Chinese unless the user asks otherwise. Input: ${JSON.stringify({ term: request.term, sense: request.sense, question: request.question, history: request.history })}`
}

// ------------------------------------------------------- vault knowledge API

function parseVaultContext(value) {
  const raw = Array.isArray(value) ? value : []
  const context = []
  let total = 0
  for (const item of raw.slice(0, VAULT_CONTEXT_FILES)) {
    const entry = asRecord(item)
    const path = asString(entry.path).replace(/\\/g, '/').trim().slice(0, 300)
    const content = asString(entry.content).trim()
    if (!path || !content) continue
    const remaining = VAULT_CONTEXT_TOTAL - total
    if (remaining <= 0) break
    const clipped = content.slice(0, Math.min(VAULT_CONTEXT_PER_FILE, remaining))
    total += clipped.length
    context.push({ path, content: clipped })
  }
  return context
}

function parseHistory(value, limit, perMessage) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => {
      const entry = asRecord(item)
      return (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string'
    })
    .slice(-limit)
    .map((item) => {
      const entry = asRecord(item)
      return { role: entry.role, content: asString(entry.content).slice(0, perMessage) }
    })
}

function requestModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseVaultChatRequest(value) {
  const input = asRecord(value)
  const question = asString(input.question).trim()
  if (!question || question.length > 4_000) throw new RequestError(400, '问题必须为 1 到 4,000 个字符。')
  return {
    question,
    history: parseHistory(input.history, 10, 2_000),
    context: parseVaultContext(input.context),
    model: requestModel(input.model),
  }
}

function parseNoteRequest(value) {
  const input = asRecord(value)
  const task = input.task === 'sense' || input.task === 'excerpt' || input.task === 'topic' ? input.task : 'topic'
  const rawSense = input.sense
  const sense = rawSense && typeof rawSense === 'object' && !Array.isArray(rawSense) ? normalizeSensePayload(rawSense) : null
  const request = {
    task,
    term: asString(input.term).trim().slice(0, 120),
    context: asString(input.context).slice(0, 4_000),
    question: asString(input.question).slice(0, 2_000),
    sense,
    model: requestModel(input.model),
  }
  if (task === 'sense' && !sense) throw new RequestError(400, '缺少要整理的义项内容。')
  if (task === 'excerpt' && !request.context.trim()) throw new RequestError(400, '缺少要整理的摘录内容。')
  if (task === 'topic' && !request.question.trim() && !request.term) throw new RequestError(400, '请提供要写笔记的主题。')
  return request
}

function parseDailySummaryRequest(value) {
  const input = asRecord(value)
  const date = asString(input.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError(400, '汇总日期无效。')
  const records = (Array.isArray(input.records) ? input.records : [])
    .slice(0, 80)
    .map((item) => {
      const entry = asRecord(item)
      return {
        kind: asString(entry.kind).slice(0, 20),
        label: asString(entry.label).slice(0, 200),
        body: asString(entry.body).slice(0, 1_200),
        path: asString(entry.path).slice(0, 300),
      }
    })
    .filter((entry) => entry.label)
  // The user's own findings are full notes, so they get their own budget.
  const findings = []
  let findingChars = 0
  for (const item of (Array.isArray(input.findings) ? input.findings : []).slice(0, FINDING_FILE_LIMIT)) {
    const entry = asRecord(item)
    const path = asString(entry.path).replace(/\\/g, '/').trim().slice(0, 300)
    const content = asString(entry.content).trim()
    if (!path || !content || findingChars >= FINDING_TOTAL_CHARS) continue
    const clipped = content.slice(0, Math.min(FINDING_CHARS_PER_FILE, FINDING_TOTAL_CHARS - findingChars))
    findingChars += clipped.length
    findings.push({ path, content: clipped })
  }
  if (records.length === 0 && findings.length === 0) throw new RequestError(400, '这一天还没有可整理的记录。')
  return { date, records, findings, model: requestModel(input.model) }
}

const vaultChatSystemPrompt = `You are Paperlight's vault research assistant. The user keeps a local Markdown knowledge vault.
Answer in Simplified Chinese unless the user writes in another language.
When vault excerpts are supplied you are strictly grounded: use ONLY what the excerpts state, cite the file of every claim inline as [[relative/path]], and never add outside facts, never guess the content of files that were not supplied, and never invent a citation.
If the excerpts do not contain the answer, reply with one short paragraph that starts with "所选 vault 内容没有提供答案" and then list which notes would be needed; do not add a general-knowledge answer in that case.
When no excerpts are supplied, answer as a knowledge-management assistant and state in the first line that the reply is not grounded in the vault.
Keep answers structured Markdown and finish with a section "## 可写入 vault 的要点" containing 1-4 bullet points whenever the answer can become notes.`

function vaultChatPrompt(request) {
  return `Answer the question below. Vault excerpts (the only allowed evidence when present): ${JSON.stringify(request.context)}. Conversation so far: ${JSON.stringify(request.history)}. Question: ${JSON.stringify(request.question)}`
}

const noteSystemPrompt = `You are Paperlight's note writer for a local Markdown vault.
Write one complete, self-contained Markdown note in Simplified Chinese (keep English terms, examples and citations in English).
Start with exactly one "# " title line, then structured "## " sections such as 核心含义, 用法与搭配, 例句, 对比与替代, 记忆点 — include only the sections the material supports.
Return the Markdown note only: no YAML frontmatter, no surrounding code fence, no commentary.`

function notePrompt(request) {
  if (request.task === 'sense') {
    return `Turn this contextual sense record into a complete study note. Sense record: ${JSON.stringify(request.sense)}. Reading context: ${JSON.stringify(request.context)}. Extra instruction from the reader: ${JSON.stringify(request.question)}`
  }
  if (request.task === 'excerpt') {
    return `Turn this excerpt into a complete study note${request.term ? ` about ${JSON.stringify(request.term)}` : ''}. Excerpt: ${JSON.stringify(request.context)}. Reading context: ${JSON.stringify(request.question)}`
  }
  return `Write a complete vault note on this topic: ${JSON.stringify(request.term || request.question)}. Extra instruction: ${JSON.stringify(request.question)}`
}

const dailySummarySystemPrompt = `You are Paperlight's daily report writer for a local Markdown knowledge vault.
Return Markdown only (no YAML frontmatter, no code fences): first a 2-4 sentence overview of the day, then "### 主题脉络" with 2-5 bullets that group and connect the records, then "### 待跟进" with 1-3 bullets naming what is still vague.
Use only the supplied records and findings: never invent notes, senses, files or conclusions that are not in them. Cite a source as [[path]] whenever a bullet comes from one specific record or finding.
"findings" are the user's own conclusions in the enlightenment folder: treat them as the user's own thinking, make sure the report reflects them, and mark where they connect to (or go beyond) the day's records. If a finding contradicts a record, say so instead of smoothing it over. Write in Simplified Chinese; keep English terms in English.`

function dailySummaryPrompt(request) {
  return `Write the report for ${request.date}. Records (JSON): ${JSON.stringify(request.records)}. User findings (JSON): ${JSON.stringify(request.findings)}`
}

// Models sometimes wrap a plain-Markdown answer in a fence or add frontmatter.
function extractMarkdown(text) {
  let value = String(text || '').trim()
  value = value.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
  if (value.startsWith('---\n')) {
    const end = value.indexOf('\n---', 3)
    if (end >= 0) value = value.slice(end + 4).replace(/^\n+/, '')
  }
  return value.trim()
}

function markdownTitle(markdown, fallback) {
  const match = /^#{1,3}\s+(.+)$/m.exec(markdown)
  const title = match ? match[1].replace(/[#*`]/g, '').trim() : ''
  return (title || fallback).slice(0, 120)
}

// Closes a truncated JSON payload: unterminated strings, dangling keys and open braces.
function closeJson(text) {
  let inString = false
  let escaped = false
  const stack = []
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

function extractJsonObject(text) {
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
        return asRecord(JSON.parse(attempt))
      } catch {
        // Try the next repair variant.
      }
    }
  }
  throw new RequestError(502, '模型返回的内容无法解析。')
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function termNoteArray(value, detailKey) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const entry = asRecord(item)
    return { term: asString(entry.term), [detailKey]: asString(entry[detailKey]) }
  })
}

function normalizeSensePayload(value) {
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

function normalizeSenseSummaries(value) {
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

async function callModel({ root, model, systemPrompt, userPrompt }) {
  const key = process.env.OPENAI_API_KEY || readLocalSetting(root, 'OPENAI_API_KEY')
  if (!key) throw new RequestError(503, '尚未配置 API 密钥。请在翻译设置中完成配置。')
  const baseUrl = effectiveBaseUrl(root)
  const protocol = protocolFor(baseUrl)
  const requestBody = protocol === 'chat-completions'
    ? {
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }
    : { model, instructions: systemPrompt, input: userPrompt }
  const response = await fetch(apiEndpoint(baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
    throw new RequestError(response.status, message || '模型请求未成功。')
  }
  const text = protocol === 'chat-completions'
    ? payload.choices?.[0]?.message?.content
    : payload.output_text
  return String(text || '')
}

/**
 * Creates the loopback-only API middleware shared by Vite and Electron.
 *
 * @param {{ root: string, csrfNonce?: string, logger?: Pick<Console, 'warn' | 'error'> }} options
 */
export function createPaperlightApi({ root, csrfNonce = randomBytes(32).toString('base64url'), logger = console }) {
  const configStatus = () => {
    const source = process.env.OPENAI_API_KEY ? 'environment' : readLocalSetting(root, 'OPENAI_API_KEY') ? 'local-file' : null
    const baseUrl = effectiveBaseUrl(root)
    return { configured: source !== null, source, baseUrl, protocol: protocolFor(baseUrl), csrfNonce }
  }

  async function handleConfig(req, res, next) {
    if (!isAllowedLocalRequest(req)) {
      sendJson(res, 403, { error: 'API 配置只允许从本机 Paperlight 访问。' })
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, configStatus())
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
      const input = await readJsonBody(req, MAX_CONFIG_BYTES)
      if (req.method === 'DELETE') {
        const baseUrl = readLocalSetting(root, 'OPENAI_BASE_URL')
        updateLocalConfig(root, undefined, baseUrl)
        sendJson(res, 200, { ...configStatus(), configured: false, source: null })
        return
      }

      const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
      if (apiKey.length < 20 || apiKey.length > 500 || !/^[A-Za-z0-9._-]+$/.test(apiKey)) {
        sendJson(res, 400, { error: '请输入有效的 API 密钥。' })
        return
      }
      const baseUrl = normalizeBaseUrl(input.baseUrl)
      updateLocalConfig(root, apiKey, baseUrl)
      sendJson(res, 200, { ...configStatus(), configured: true, source: 'local-file', baseUrl, protocol: protocolFor(baseUrl) })
    } catch (error) {
      if (error instanceof RequestError) sendJson(res, error.status, { error: error.message })
      else sendJson(res, 500, { error: '无法安全保存 API 配置。' })
    }
  }

  async function handleSense(req, res, next) {
    if (req.method !== 'POST') return next()
    if (!isAllowedLocalRequest(req)) {
      sendJson(res, 403, { error: '义项查询只允许从本机 Paperlight 访问。' })
      return
    }
    try {
      const request = parseSenseRequest(await readJsonBody(req, MAX_TRANSLATION_BYTES))
      const model = request.model || DEFAULT_MODEL
      const modelText = await callModel({
        root,
        model,
        systemPrompt: senseSystemPrompt,
        userPrompt: senseTaskPrompt(request),
      })
      let parsed
      try {
        parsed = extractJsonObject(modelText)
      } catch (error) {
        // Diagnostic only: helps explain unparsable model output. Never contains credentials.
        logger.warn(
          '[paperlight] /api/sense could not parse model output:',
          JSON.stringify({
            length: modelText.length,
            head: modelText.slice(0, 300),
            tail: modelText.slice(-200),
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
      if (error instanceof RequestError) sendJson(res, error.status, { error: error.message })
      else sendJson(res, 500, { error: '义项查询失败。' })
    }
  }

  async function handleTranslate(req, res, next) {
    if (req.method !== 'POST') return next()
    if (!isAllowedLocalRequest(req)) {
      sendJson(res, 403, { error: '翻译只允许从本机 Paperlight 访问。' })
      return
    }
    try {
      const input = await readJsonBody(req, MAX_TRANSLATION_BYTES)
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text || text.length > 12_000) {
        sendJson(res, 400, { error: '请选择不超过 12,000 个字符的文本。' })
        return
      }
      const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : DEFAULT_MODEL
      const instructions = 'You are a careful English-to-Chinese translator. Translate the selected English text into clear, natural Simplified Chinese. Use the surrounding text only to resolve meaning and references. Preserve names, numbers, citations, and technical terms where appropriate. Return only the translation, with no preface or explanation.'
      const context = JSON.stringify({
        preceding_context: typeof input.before === 'string' ? input.before.slice(-700) : '',
        selected_text: text,
        following_context: typeof input.after === 'string' ? input.after.slice(0, 700) : '',
      })
      const translated = (await callModel({ root, model, systemPrompt: instructions, userPrompt: context })).trim()
      sendJson(res, 200, { translation: translated || '未收到译文，请重试。' })
    } catch (error) {
      if (error instanceof RequestError) sendJson(res, error.status, { error: error.message })
      else sendJson(res, 500, { error: '翻译请求失败。' })
    }
  }

  // The vault desk: strictly grounded answers, complete notes and daily summaries.
  async function handleVaultChat(req, res, next) {
    if (req.method !== 'POST') return next()
    if (!isAllowedLocalRequest(req)) {
      sendJson(res, 403, { error: 'vault 对话只允许从本机 Paperlight 访问。' })
      return
    }
    try {
      const request = parseVaultChatRequest(await readJsonBody(req, MAX_VAULT_CHAT_BYTES))
      const model = request.model || DEFAULT_MODEL
      const answer = extractMarkdown(await callModel({
        root,
        model,
        systemPrompt: vaultChatSystemPrompt,
        userPrompt: vaultChatPrompt(request),
      }))
      if (!answer) throw new RequestError(502, '模型没有返回内容，请重试。')
      sendJson(res, 200, {
        answer,
        grounded: request.context.length > 0,
        sources: request.context.map((entry) => entry.path),
      })
    } catch (error) {
      if (error instanceof RequestError) sendJson(res, error.status, { error: error.message })
      else sendJson(res, 500, { error: 'vault 对话失败。' })
    }
  }

  async function handleNote(req, res, next) {
    if (req.method !== 'POST') return next()
    if (!isAllowedLocalRequest(req)) {
      sendJson(res, 403, { error: '笔记生成只允许从本机 Paperlight 访问。' })
      return
    }
    try {
      const request = parseNoteRequest(await readJsonBody(req, MAX_NOTE_BYTES))
      const model = request.model || DEFAULT_MODEL
      const markdown = extractMarkdown(await callModel({
        root,
        model,
        systemPrompt: noteSystemPrompt,
        userPrompt: notePrompt(request),
      }))
      if (!markdown) throw new RequestError(502, '模型没有返回笔记内容，请重试。')
      const fallback = request.term || request.sense?.term || 'Paperlight 笔记'
      sendJson(res, 200, { note: { title: markdownTitle(markdown, fallback), markdown } })
    } catch (error) {
      if (error instanceof RequestError) sendJson(res, error.status, { error: error.message })
      else sendJson(res, 500, { error: '笔记生成失败。' })
    }
  }

  async function handleDailySummary(req, res, next) {
    if (req.method !== 'POST') return next()
    if (!isAllowedLocalRequest(req)) {
      sendJson(res, 403, { error: '日记汇总只允许从本机 Paperlight 访问。' })
      return
    }
    try {
      const request = parseDailySummaryRequest(await readJsonBody(req, MAX_NOTE_BYTES))
      const model = request.model || DEFAULT_MODEL
      const summary = extractMarkdown(await callModel({
        root,
        model,
        systemPrompt: dailySummarySystemPrompt,
        userPrompt: dailySummaryPrompt(request),
      }))
      if (!summary) throw new RequestError(502, '模型没有返回汇总内容，请重试。')
      sendJson(res, 200, { summary })
    } catch (error) {
      if (error instanceof RequestError) sendJson(res, error.status, { error: error.message })
      else sendJson(res, 500, { error: '日记汇总失败。' })
    }
  }

  // Connect-style middleware: mount at the server root.
  const middleware = (req, res, next) => {
    const path = (req.url || '').split('?')[0]
    if (path === CONFIG_PATH) return void handleConfig(req, res, next)
    if (path === SENSE_PATH) return void handleSense(req, res, next)
    if (path === TRANSLATE_PATH) return void handleTranslate(req, res, next)
    if (path === VAULT_CHAT_PATH) return void handleVaultChat(req, res, next)
    if (path === NOTE_PATH) return void handleNote(req, res, next)
    if (path === DAILY_SUMMARY_PATH) return void handleDailySummary(req, res, next)
    return next()
  }

  return { middleware, csrfNonce, configStatus }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.icc': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serves one built asset directory with SPA fallback. Paths are confined to
 * `distDir` both lexically and after resolving symlinks, so a crafted URL (or a
 * symlink planted inside the bundle) cannot read files outside it.
 */
export function createStaticHandler(distDir) {
  const indexFile = join(distDir, 'index.html')
  let realDistDir = resolve(distDir)
  try {
    realDistDir = realpathSync(distDir)
  } catch {
    // The directory may not exist yet; the lexical check below still applies.
  }

  // Returns the real path when it is a regular file inside distDir, else null.
  const confinedFile = (filePath) => {
    let real
    try {
      real = realpathSync(filePath)
    } catch {
      return null
    }
    if (real !== realDistDir && !real.startsWith(realDistDir + sep)) return null
    try {
      return statSync(real).isFile() ? real : null
    } catch {
      return null
    }
  }

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    let pathname
    try {
      pathname = decodeURIComponent((req.url || '/').split('?')[0])
    } catch {
      res.writeHead(400).end('Bad request')
      return
    }
    const candidate = normalize(join(distDir, pathname))
    if (candidate !== distDir && !candidate.startsWith(distDir + sep)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    let filePath = confinedFile(candidate)
    if (!filePath) {
      // Unknown asset paths must not silently become HTML.
      if (extname(pathname)) {
        res.writeHead(404).end('Not found')
        return
      }
      filePath = confinedFile(indexFile)
    }
    if (!filePath) {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      // The bundle ships hashed assets except index.html and pdfjs assets.
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(filePath).pipe(res)
  }
}

export { RequestError, effectiveBaseUrl, protocolFor }
