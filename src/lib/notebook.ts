import type { ChatMessage, NotebookNote, SenseAtom, SensePayload, SenseRelation } from '../types'

const SENSES_KEY = 'paperlight-senses-v1'
const NOTES_KEY = 'paperlight-notebook-v2'
const COUNTERS_KEY = 'paperlight-note-counters-v1'
const CHAT_KEY = 'paperlight-chat-v1'
const SCHEMA_VERSION = 1

function readJson<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null') as T | null
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota or private mode: keep the in-memory state usable.
  }
}

// Stable identity of a term ↔ sense pair. This is the hard-coded record key.
export function senseAtomId(sense: { lemma: string; partOfSpeech: string; senseId: string }): string {
  return `${sense.lemma}|${sense.partOfSpeech}|${sense.senseId}`.toLowerCase()
}

export function senseKeyOf(sense: SensePayload): string {
  return senseAtomId(sense)
}

export function toAtom(sense: SensePayload, model: string, notesFolder?: string): SenseAtom {
  return {
    id: senseKeyOf(sense),
    term: sense.term,
    lemma: sense.lemma,
    partOfSpeech: sense.partOfSpeech,
    senseId: sense.senseId,
    contextualMeaning: sense.contextualMeaning,
    definition: sense.definition,
    contextSentence: sense.contextSentence,
    examples: Array.isArray(sense.examples) ? sense.examples : [],
    guidance: sense.guidance,
    provider: 'ai',
    model,
    source: 'ai',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ...(notesFolder ? { notesFolder } : {}),
  }
}

export const loadAtoms = (): SenseAtom[] => readJson<SenseAtom[]>(SENSES_KEY, [])
export const saveAtoms = (atoms: SenseAtom[]): void => writeJson(SENSES_KEY, atoms)
export const loadNotes = (): NotebookNote[] => readJson<NotebookNote[]>(NOTES_KEY, [])
export const saveNotes = (notes: NotebookNote[]): void => writeJson(NOTES_KEY, notes)
export const loadChat = (): Record<string, ChatMessage[]> => readJson<Record<string, ChatMessage[]>>(CHAT_KEY, {})
export const saveChat = (chat: Record<string, ChatMessage[]>): void => writeJson(CHAT_KEY, chat)

export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Ordinals are monotonic per local date and are never reused after a deletion.
function nextDailyOrdinal(dateKey: string): number {
  const counters = readJson<Record<string, number>>(COUNTERS_KEY, {})
  const next = (counters[dateKey] || 0) + 1
  counters[dateKey] = next
  writeJson(COUNTERS_KEY, counters)
  return next
}

export function noteLabel(note: NotebookNote): string {
  return `${note.date} 第 ${note.dailyOrdinal} 份笔记`
}

export function createNote(
  body: string,
  senseIds: string[],
  date = new Date(),
  sourceMessageId?: string,
  notesFolder?: string,
): NotebookNote {
  const dateKey = localDateKey(date)
  const dailyOrdinal = nextDailyOrdinal(dateKey)
  return {
    id: `${dateKey}#${dailyOrdinal}-${Math.random().toString(36).slice(2, 8)}`,
    date: dateKey,
    dailyOrdinal,
    body: body.trim(),
    senseIds: Array.from(new Set(senseIds.filter(Boolean))),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(notesFolder ? { notesFolder } : {}),
    createdAt: new Date().toISOString(),
  }
}

// Links shown in the sense card, limited to genuinely strong connections.
export function relateSense(current: SensePayload, atoms: SenseAtom[]): SenseRelation[] {
  const key = senseKeyOf(current)
  const root = (current.guidance?.morphology?.root || '').trim().toLowerCase()
  const currentTerms = new Set([
    ...(current.guidance?.synonyms || []).map((item) => item.term.toLowerCase()),
    ...(current.guidance?.alternatives || []).map((item) => item.term.toLowerCase()),
  ])
  const relations: SenseRelation[] = []

  for (const atom of atoms) {
    if (atom.id === key) continue
    if (atom.lemma.toLowerCase() === current.lemma.toLowerCase()) {
      relations.push({ atom, reason: '同一词的另一个义项' })
      continue
    }
    if (root.length > 2 && (atom.guidance?.morphology?.root || '').trim().toLowerCase() === root) {
      relations.push({ atom, reason: '同词根' })
      continue
    }
    const atomTerms = [
      ...(atom.guidance?.synonyms || []).map((item) => item.term.toLowerCase()),
      ...(atom.guidance?.alternatives || []).map((item) => item.term.toLowerCase()),
    ]
    const shared = atomTerms.filter((term) => currentTerms.has(term))
    if (shared.length) relations.push({ atom, reason: `共享近义表达：${shared.slice(0, 2).join('、')}` })
  }

  return relations.slice(0, 4)
}
