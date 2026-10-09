import type {
  ExpressionCandidate, ExpressionContext, ExpressionCognitivePath, ExpressionRecord,
  ExpressionRelation, ExpressionRelationKind, NoteFrontmatter,
} from '../types'
import { parseNote, slugify, stringifyNote } from './vault.ts'

const EXPRESSION_KIND = 'expression'
const EXPRESSION_META_KEY = 'expressionData'
const EXPRESSION_META_VERSION = 1
const MAX_EXPRESSION_LENGTH = 280
const MAX_CONTEXTS = 200
const MAX_RELATIONS = 200

export function normalizeExpression(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[‐‑‒–—―]/g, '-')
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
    .trim()
}

function hash(value: string): string {
  let result = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i)
    result = Math.imul(result, 0x01000193) >>> 0
  }
  return result.toString(16).padStart(8, '0')
}

export function expressionRecordId(expression: string): string {
  const normalized = normalizeExpression(expression)
  return `${slugify(normalized, 'expression').slice(0, 48)}-${hash(normalized)}`
}

export function expressionRecordPath(record: Pick<ExpressionRecord, 'id'>): string {
  return `expressions/${record.id}.md`
}

function encodeMetadata(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeMetadata(value: string): unknown {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function text(value: unknown, max = 2_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function safePath(value: unknown): string | undefined {
  const path = text(value, 2_000)
  return path && !path.split(/[\\/]/).includes('..') ? path : undefined
}

function cleanContext(value: unknown): ExpressionContext | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<ExpressionContext>
  const validKinds: ExpressionContext['sourceKind'][] = [
    'pdf', 'epub', 'text', 'assistant', 'chat', 'note', 'enlightenment', 'ai_exploration', 'manual',
  ]
  const sourceKind = validKinds.includes(item.sourceKind as ExpressionContext['sourceKind'])
    ? item.sourceKind as ExpressionContext['sourceKind']
    : 'manual'
  const pageNumber = Number.isFinite(item.pageNumber) && Number(item.pageNumber) > 0
    ? Math.floor(Number(item.pageNumber))
    : undefined
  return {
    id: text(item.id, 120) || `context-${hash(`${sourceKind}|${item.sourcePath || ''}|${item.locationLabel || ''}|${item.pageNumber || ''}|${item.quote || ''}`)}`,
    createdAt: text(item.createdAt, 60) || new Date().toISOString(),
    ...(['recognition', 'exploration', 'manual'].includes(String(item.cognitivePath))
      ? { cognitivePath: item.cognitivePath as ExpressionCognitivePath } : {}),
    sourceKind,
    ...(safePath(item.sourcePath) ? { sourcePath: safePath(item.sourcePath) } : {}),
    ...(text(item.sourceName, 300) ? { sourceName: text(item.sourceName, 300) } : {}),
    ...(text(item.locationLabel, 300) ? { locationLabel: text(item.locationLabel, 300) } : {}),
    ...(pageNumber ? { pageNumber } : {}),
    ...(Number.isSafeInteger(item.startOffset) && Number(item.startOffset) >= 0 ? { startOffset: Number(item.startOffset) } : {}),
    ...(Number.isSafeInteger(item.endOffset) && Number(item.endOffset) >= 0 ? { endOffset: Number(item.endOffset) } : {}),
    ...(text(item.quote, 1_200) ? { quote: text(item.quote, 1_200) } : {}),
    ...(text(item.before, 500) ? { before: text(item.before, 500) } : {}),
    ...(text(item.after, 500) ? { after: text(item.after, 500) } : {}),
    ...(item.generated === true ? { generated: true } : {}),
    ...(text(item.usageScenario, 500) ? { usageScenario: text(item.usageScenario, 500) } : {}),
  }
}

function cleanRelation(value: unknown): ExpressionRelation | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<ExpressionRelation>
  const kinds: ExpressionRelationKind[] = ['variant', 'alternative', 'similar', 'contrast', 'collocation', 'used_with']
  if (!kinds.includes(item.kind as ExpressionRelationKind)) return null
  return {
    id: text(item.id, 120) || `relation-${hash(`${item.kind}|${item.note || ''}`)}`,
    targetId: text(item.targetId, 120),
    kind: item.kind as ExpressionRelationKind,
    note: text(item.note, 500),
    source: item.source === 'ai' ? 'ai' : 'user',
    createdAt: text(item.createdAt, 60) || new Date().toISOString(),
  }
}

function cleanRecord(value: unknown): ExpressionRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<ExpressionRecord>
  const expression = text(input.expression, MAX_EXPRESSION_LENGTH)
  const normalizedExpression = normalizeExpression(expression)
  if (!expression || !normalizedExpression) return null
  const paths: ExpressionCognitivePath[] = ['recognition', 'exploration', 'manual']
  return {
    id: text(input.id, 100) || expressionRecordId(expression),
    expression,
    normalizedExpression,
    meaning: text(input.meaning, 2_000),
    note: text(input.note, 8_000),
    cognitivePaths: Array.isArray(input.cognitivePaths)
      ? Array.from(new Set(input.cognitivePaths.filter((item): item is ExpressionCognitivePath => paths.includes(item))))
      : [],
    contexts: (Array.isArray(input.contexts) ? input.contexts : [])
      .map(cleanContext).filter((item): item is ExpressionContext => Boolean(item)).slice(0, MAX_CONTEXTS),
    relations: (Array.isArray(input.relations) ? input.relations : [])
      .map(cleanRelation).filter((item): item is ExpressionRelation => Boolean(item)).slice(0, MAX_RELATIONS),
    createdAt: text(input.createdAt, 60) || new Date().toISOString(),
    updatedAt: text(input.updatedAt, 60) || new Date().toISOString(),
  }
}

export function createExpressionRecord(input: {
  expression: string
  meaning?: string
  note?: string
  cognitivePath?: ExpressionCognitivePath
  context?: Partial<ExpressionContext>
  now?: string
}): ExpressionRecord {
  const expression = text(input.expression, MAX_EXPRESSION_LENGTH)
  const normalizedExpression = normalizeExpression(expression)
  if (!normalizedExpression) throw new Error('请输入要收录的英语表达。')
  if (!/[\p{L}\p{N}]/u.test(expression)) throw new Error('表达至少需要包含一个字母或数字。')
  const now = input.now || new Date().toISOString()
  const cognitivePath = input.cognitivePath || 'manual'
  const context = input.context ? cleanContext({ ...input.context, cognitivePath, createdAt: input.context.createdAt || now }) : null
  return {
    id: expressionRecordId(expression),
    expression,
    normalizedExpression,
    meaning: text(input.meaning, 2_000),
    note: text(input.note, 8_000),
    cognitivePaths: [cognitivePath],
    contexts: context ? [context] : [],
    relations: [],
    createdAt: now,
    updatedAt: now,
  }
}

function sameContext(a: ExpressionContext, b: ExpressionContext): boolean {
  return a.id === b.id || (
    a.sourceKind === b.sourceKind
    && a.sourcePath === b.sourcePath
    && a.pageNumber === b.pageNumber
    && a.locationLabel === b.locationLabel
    && a.quote === b.quote
    && a.generated === b.generated
  )
}

/** Merge only identical normalized forms; near variants remain separate records. */
export function mergeExpressionRecord(existing: ExpressionRecord, incoming: ExpressionRecord): ExpressionRecord {
  if (existing.normalizedExpression !== incoming.normalizedExpression) {
    throw new Error('只有完全相同的规范化表达才能自动整合。')
  }
  const contexts = [...existing.contexts]
  for (const context of incoming.contexts) {
    if (!contexts.some((item) => sameContext(item, context)) && contexts.length < MAX_CONTEXTS) contexts.push(context)
  }
  const relations = [...existing.relations]
  for (const relation of incoming.relations) {
    if (!relations.some((item) => item.id === relation.id) && relations.length < MAX_RELATIONS) relations.push(relation)
  }
  return {
    ...existing,
    cognitivePaths: Array.from(new Set([...existing.cognitivePaths, ...incoming.cognitivePaths])),
    meaning: existing.meaning || incoming.meaning,
    note: existing.note || incoming.note,
    contexts,
    relations,
    updatedAt: incoming.updatedAt,
  }
}

function renderContext(context: ExpressionContext, index: number): string[] {
  const title = context.sourceName || context.sourcePath || (context.generated ? 'AI 探索候选' : '手动添加')
  const location = [context.locationLabel, context.pageNumber ? `第 ${context.pageNumber} 页/章` : '']
    .filter(Boolean).join(' · ')
  const lines = [`### 语境 ${index + 1} · ${title}`, '']
  if (location) lines.push(location, '')
  if (context.quote && !context.generated) lines.push(`> ${context.quote.replace(/\n/g, '\n> ')}`, '')
  if (context.generated) lines.push('> AI 生成候选；此条不是原文摘录。', '')
  if (context.usageScenario) lines.push(`使用场景：${context.usageScenario}`, '')
  if (context.sourcePath) lines.push(`来源路径：${context.sourcePath}`, '')
  return lines
}

export function expressionRecordMarkdown(record: ExpressionRecord): string {
  const clean = cleanRecord(record)
  if (!clean) throw new Error('表达记录无效。')
  const body: string[] = [`# ${clean.expression}`, '']
  if (clean.meaning) body.push('## 意思', '', clean.meaning, '')
  if (clean.note) body.push('## 我的补充', '', clean.note, '')
  body.push('## 使用语境', '')
  if (!clean.contexts.length) body.push('- 暂无来源语境；这是一条独立表达。', '')
  else clean.contexts.forEach((context, index) => body.push(...renderContext(context, index)))
  if (clean.relations.length) {
    body.push('## 相关表达', '')
    for (const relation of clean.relations) body.push(`- [[${relation.targetId}]] · ${relation.kind}${relation.note ? `：${relation.note}` : ''}`)
    body.push('')
  }
  const metadata = encodeMetadata({ version: EXPRESSION_META_VERSION, record: clean })
  const frontmatter: NoteFrontmatter = {
    title: clean.expression,
    kind: EXPRESSION_KIND,
    id: clean.id,
    normalizedExpression: clean.normalizedExpression,
    cognitivePaths: clean.cognitivePaths,
    created: clean.createdAt,
    updated: clean.updatedAt,
    tags: ['paperlight', 'expression'],
    [EXPRESSION_META_KEY]: metadata,
  }
  return stringifyNote(frontmatter, body.join('\n'))
}

export function parseExpressionRecord(source: string): ExpressionRecord | null {
  const parsed = parseNote(source)
  if (parsed.data.kind !== EXPRESSION_KIND) return null
  const encoded = parsed.data[EXPRESSION_META_KEY]
  if (typeof encoded === 'string' && encoded.length < 1_500_000) {
    try {
      const payload = decodeMetadata(encoded) as { version?: number; record?: unknown }
      const record = cleanRecord(payload?.record)
      if (payload?.version === EXPRESSION_META_VERSION && record) return record
    } catch {
      // Hand-edited or interrupted metadata degrades to the visible Markdown title.
    }
  }
  const heading = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const expression = text(parsed.data.title, MAX_EXPRESSION_LENGTH) || text(heading, MAX_EXPRESSION_LENGTH)
  if (!expression) return null
  return createExpressionRecord({
    expression,
    cognitivePath: 'manual',
    now: text(parsed.data.created, 60) || new Date().toISOString(),
  })
}

export function makeExpressionContext(input: Omit<ExpressionContext, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ExpressionContext {
  const provisional = cleanContext(input)
  if (!provisional) throw new Error('表达来源无效。')
  if (provisional.generated) {
    provisional.quote = undefined
    provisional.before = undefined
    provisional.after = undefined
  }
  return provisional
}

export function isExpressionCandidate(value: unknown): value is ExpressionCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ExpressionCandidate>
  return Boolean(text(candidate.expression, MAX_EXPRESSION_LENGTH))
}
