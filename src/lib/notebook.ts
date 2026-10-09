import type { ChatMessage, NotebookNote, SenseAtom, SensePayload, SenseRelation, SemanticContextInstance, TextSelection } from '../types'

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

function stableContextId(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `ctx-${hash.toString(16).padStart(8, '0')}`
}

export function toAtom(sense: SensePayload, model: string, notesFolder?: string, source?: TextSelection | null): SenseAtom {
  const now = new Date().toISOString()
  const sourcePath = source?.documentPath?.trim()
  const selectedQuote = source?.text.trim() || ''
  const quote = selectedQuote || sense.contextSentence?.trim() || ''
  const extension = sourcePath?.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase()
  const contexts: SemanticContextInstance[] = sourcePath && quote ? [{
    id: stableContextId(`${sourcePath}|${source?.locationLabel || source?.pageNumber || ''}|${quote}`),
    sourceKind: extension === 'pdf' ? 'pdf' : extension === 'epub' ? 'epub' : 'text',
    sourcePath,
    ...(source?.documentName ? { sourceName: source.documentName } : {}),
    ...(source?.locationLabel ? { locationLabel: source.locationLabel } : {}),
    ...(source?.pageNumber ? { pageNumber: source.pageNumber } : {}),
    ...(source?.startOffset !== undefined ? { startOffset: source.startOffset } : {}),
    ...(source?.endOffset !== undefined ? { endOffset: source.endOffset } : {}),
    quote,
    createdAt: now,
  }] : []
  return {
    id: senseKeyOf(sense),
    term: sense.term,
    lemma: sense.lemma,
    partOfSpeech: sense.partOfSpeech,
    senseId: sense.senseId,
    contextualMeaning: sense.contextualMeaning,
    definition: sense.definition,
    contextSentence: selectedQuote || sense.contextSentence,
    examples: Array.isArray(sense.examples) ? sense.examples : [],
    guidance: sense.guidance,
    provider: 'ai',
    model,
    source: 'ai',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    ...(contexts.length ? { contexts } : {}),
    ...(notesFolder ? { notesFolder } : {}),
  }
}

function semanticAnchor(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** A remembered selection is provenance only when it actually contains the queried lexical item. */
export function selectionMatchesSemanticTerm(selectionText: string, terms: string[]): boolean {
  const selected = new Set(semanticAnchor(selectionText).split(/\s+/).filter(Boolean))
  return terms.some((term) => {
    const tokens = semanticAnchor(term).split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every((token) => selected.has(token))
  })
}

/** Different model IDs for the same lemma/POS need a user decision before merging. */
export function possibleSemanticMergeCandidates(incoming: SenseAtom, atoms: SenseAtom[]): SenseAtom[] {
  const lemma = semanticAnchor(incoming.lemma || incoming.term)
  const partOfSpeech = semanticAnchor(incoming.partOfSpeech)
  if (!lemma || !partOfSpeech) return []
  return atoms.filter((atom) => atom.id !== incoming.id
    && !(atom.alternateSemanticIds || []).includes(incoming.id)
    && semanticAnchor(atom.lemma || atom.term) === lemma
    && semanticAnchor(atom.partOfSpeech) === partOfSpeech)
}

/** Resolve an AI/V1 identity after the user has confirmed a semantic merge. */
export function semanticRecordForId(id: string, atoms: SenseAtom[]): SenseAtom | undefined {
  return atoms.find((atom) => atom.id === id || (atom.alternateSemanticIds || []).includes(id))
}

/** User-confirmed merge across model IDs; retain the incoming identity as an alias. */
export function confirmSemanticMerge(existing: SenseAtom, incoming: SenseAtom): SenseAtom {
  const alternateSemanticIds = Array.from(new Set([
    ...(existing.alternateSemanticIds || []),
    ...(incoming.alternateSemanticIds || []),
    ...(incoming.id !== existing.id ? [incoming.id] : []),
  ])).filter((id) => id && id !== existing.id)
  return mergeSemanticAtom(existing, { ...incoming, id: existing.id, alternateSemanticIds })
}

function mergeTextItems<T>(existing: T[], incoming: T[], keyOf: (item: T) => string, limit = 60): T[] {
  const result = [...existing]
  const keys = new Set(existing.map((item) => semanticAnchor(keyOf(item))).filter(Boolean))
  for (const item of incoming) {
    const key = semanticAnchor(keyOf(item))
    if (key && !keys.has(key)) {
      result.push(item)
      keys.add(key)
    }
  }
  return result.slice(0, limit)
}

/** Merge a confirmed same-ID semantic while preserving existing scalar explanations. */
export function mergeSemanticAtom(existing: SenseAtom, incoming: SenseAtom): SenseAtom {
  if (existing.id !== incoming.id) throw new Error('语义身份不同，必须先由用户确认合并目标。')
  const contexts = new Map<string, SemanticContextInstance>()
  for (const context of [...(existing.contexts || []), ...(incoming.contexts || [])]) contexts.set(context.id, context)
  const oldGuidance = existing.guidance
  const newGuidance = incoming.guidance
  const guidance = {
    scenarios: mergeTextItems(oldGuidance?.scenarios || [], newGuidance?.scenarios || [], (item) => item),
    advice: mergeTextItems(oldGuidance?.advice || [], newGuidance?.advice || [], (item) => item),
    frequency: oldGuidance?.frequency || newGuidance?.frequency || '',
    alternatives: mergeTextItems(oldGuidance?.alternatives || [], newGuidance?.alternatives || [], (item) => `${item.term} ${item.note}`),
    synonyms: mergeTextItems(oldGuidance?.synonyms || [], newGuidance?.synonyms || [], (item) => `${item.term} ${item.contrast}`),
    antonyms: mergeTextItems(oldGuidance?.antonyms || [], newGuidance?.antonyms || [], (item) => `${item.term} ${item.contrast}`),
    morphology: {
      root: oldGuidance?.morphology?.root || newGuidance?.morphology?.root || '',
      prefix: oldGuidance?.morphology?.prefix || newGuidance?.morphology?.prefix || '',
      suffix: oldGuidance?.morphology?.suffix || newGuidance?.morphology?.suffix || '',
      note: oldGuidance?.morphology?.note || newGuidance?.morphology?.note || '',
    },
  }
  const examples = mergeTextItems(existing.examples || [], incoming.examples || [], (item) => item.text, 100)
  return {
    ...existing,
    contextualMeaning: existing.contextualMeaning || incoming.contextualMeaning,
    definition: existing.definition || incoming.definition,
    contextSentence: existing.contextSentence || incoming.contextSentence,
    examples,
    guidance,
    contexts: [...contexts.values()].slice(-200),
    alternateSemanticIds: Array.from(new Set([
      ...(existing.alternateSemanticIds || []),
      ...(incoming.alternateSemanticIds || []),
    ])).filter((id) => id && id !== existing.id).slice(-100),
    notesFolder: existing.notesFolder || incoming.notesFolder,
    notePath: existing.notePath || incoming.notePath,
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
      relations.push({ atom, reason: '同一词的另一个语义' })
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
