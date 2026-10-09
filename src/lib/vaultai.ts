// Client for the vault knowledge endpoints of the local AI proxy
// (server/api.mjs): strictly grounded vault chat, complete note writing and
// daily summaries. Like the sense/translate clients, it only ever talks to the
// loopback origin the app is served from.

import type { SensePayload } from '../types'
import {
  GROUNDING_CHARS_PER_FILE, GROUNDING_FILE_LIMIT, GROUNDING_TOTAL_CHARS, excerptForGrounding,
} from './vault.ts'

export interface VaultContextFile {
  path: string
  content: string
}

export interface VaultChatInput {
  question: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  context: VaultContextFile[]
  model: string
}

export interface VaultChatReply {
  answer: string
  grounded: boolean
  sources: string[]
}

export type VaultNoteTask = 'sense' | 'excerpt' | 'topic'

async function postVault<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & Partial<T>
  if (!response.ok) throw new Error(payload.error || 'vault 请求失败。')
  return payload as T
}

export async function askVault(input: VaultChatInput, signal?: AbortSignal): Promise<VaultChatReply> {
  const result = await postVault<Partial<VaultChatReply>>('/api/vault-chat', input, signal)
  return {
    answer: result.answer || '未收到回答，请重试。',
    grounded: result.grounded === true,
    sources: Array.isArray(result.sources) ? result.sources.filter((item): item is string => typeof item === 'string') : [],
  }
}

export async function generateVaultNote(input: {
  task: VaultNoteTask
  term?: string
  sense?: SensePayload | null
  context?: string
  question?: string
  model: string
}, signal?: AbortSignal): Promise<{ title: string; markdown: string }> {
  const result = await postVault<{ note?: { title?: string; markdown?: string } }>('/api/note', input, signal)
  const markdown = result.note?.markdown || ''
  if (!markdown.trim()) throw new Error('未收到笔记内容，请重试。')
  return { title: result.note?.title || input.term || 'Paperlight 笔记', markdown }
}

export async function generateVaultReport(input: {
  date: string
  records: Array<{ kind: string; label: string; body: string; path?: string }>
  findings: VaultContextFile[]
  model: string
}, signal?: AbortSignal): Promise<string> {
  const result = await postVault<{ summary?: string }>('/api/daily-summary', input, signal)
  return (result.summary || '').trim()
}

/**
 * Reads the selected notes and clips them to the grounding budget. The order is
 * the user's selection order, so the most important note keeps its full text.
 */
export async function buildGroundingContext(
  paths: string[],
  readNote: (path: string) => Promise<string>,
): Promise<{ context: VaultContextFile[]; skipped: string[] }> {
  const context: VaultContextFile[] = []
  const skipped: string[] = []
  let total = 0
  for (const path of paths.slice(0, GROUNDING_FILE_LIMIT)) {
    if (total >= GROUNDING_TOTAL_CHARS) {
      skipped.push(path)
      continue
    }
    try {
      const source = await readNote(path)
      const excerpt = excerptForGrounding(source, Math.min(GROUNDING_CHARS_PER_FILE, GROUNDING_TOTAL_CHARS - total))
      if (!excerpt.trim()) {
        skipped.push(path)
        continue
      }
      total += excerpt.length
      context.push({ path, content: excerpt })
    } catch {
      skipped.push(path)
    }
  }
  return { context, skipped }
}
