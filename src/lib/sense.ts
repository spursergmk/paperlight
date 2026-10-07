import type { SensePayload, SenseSummary } from '../types'

async function postSense<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/sense', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & Partial<T>
  if (!response.ok) throw new Error(payload.error || '义项查询失败。')
  return payload as T
}

export async function lookupSense(term: string, context: string, model: string): Promise<SensePayload> {
  const result = await postSense<{ sense: SensePayload }>({ task: 'lookup', term, context, model })
  if (!result.sense) throw new Error('未收到义项结果，请重试。')
  return result.sense
}

export async function expandSenses(term: string, model: string): Promise<SenseSummary[]> {
  const result = await postSense<{ senses: SenseSummary[] }>({ task: 'expand', term, model })
  return Array.isArray(result.senses) ? result.senses : []
}

export async function askSense(input: {
  term: string
  sense?: { contextualMeaning: string; definition: string }
  question: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  model: string
}): Promise<string> {
  const result = await postSense<{ answer: string }>({ task: 'ask', ...input })
  return result.answer || '未收到回答，请重试。'
}

// The sentence around the selection is the context used for sense disambiguation.
export function sentenceAround(text: string, index: number, length: number): string {
  if (index < 0) return text.slice(0, 400)
  let start = index
  while (start > 0 && !/[.!?。！？\n]/.test(text[start - 1])) start -= 1
  let end = index + length
  while (end < text.length && !/[.!?。！？\n]/.test(text[end])) end += 1
  if (end < text.length) end += 1
  const sentence = text.slice(start, end).trim()
  if (!sentence) return text.slice(Math.max(0, index - 200), index + length + 200).trim()
  return sentence.length > 700 ? sentence.slice(0, 700) : sentence
}

// A queried term should be a word or short phrase, not a whole selected sentence.
export function termFromSelection(selected: string): string {
  const cleaned = selected.trim().replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, '')
  if (!cleaned) return selected.trim().slice(0, 120)
  const words = cleaned.split(/\s+/)
  return (words.length > 4 ? words.slice(0, 4).join(' ') : cleaned).slice(0, 120)
}
