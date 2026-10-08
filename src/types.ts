export type TranslateMode = 'mock' | 'openai'

export interface TextSelection {
  text: string
  before: string
  after: string
  /** PDF page number, or 1-based chapter number in a reflowed document. */
  pageNumber: number
  /** Human-readable position, e.g. an EPUB chapter title. */
  locationLabel?: string
  documentName?: string
  documentPath?: string
}

export type ExampleSource = 'verified' | 'ai_generated'

export interface SenseExample {
  text: string
  translation: string
  sourceType: ExampleSource
  citation: string | null
}

export interface SenseGuidance {
  scenarios: string[]
  advice: string[]
  frequency: string
  alternatives: Array<{ term: string; note: string }>
  synonyms: Array<{ term: string; contrast: string }>
  antonyms: Array<{ term: string; contrast: string }>
  morphology: { root: string; prefix: string; suffix: string; note: string }
}

// One contextual reading of one term, as returned by the model.
export interface SensePayload {
  term: string
  lemma: string
  partOfSpeech: string
  senseId: string
  contextualMeaning: string
  definition: string
  contextSentence: string
  examples: SenseExample[]
  guidance: SenseGuidance
}

// A dictionary entry summary used by the optional "all senses" expansion.
export interface SenseSummary {
  senseId: string
  partOfSpeech: string
  definition: string
  meaning: string
  isContextual: boolean
}

// The immutable record stored in the notebook: a term ↔ one specific sense.
export interface SenseAtom {
  id: string
  term: string
  lemma: string
  partOfSpeech: string
  senseId: string
  contextualMeaning: string
  definition: string
  contextSentence: string
  examples: SenseExample[]
  guidance: SenseGuidance
  provider: string
  model: string
  source: 'ai'
  schemaVersion: number
  generatedAt: string
  /** Vault-relative folder inside `notes/` this sense belongs to (material mirror). */
  notesFolder?: string
  /** The note file this sense was written to, once it exists in the vault. */
  notePath?: string
}

// A notebook note: "the Nth note of a given date", linked to term ↔ sense atoms.
export interface NotebookNote {
  id: string
  date: string
  dailyOrdinal: number
  body: string
  senseIds: string[]
  sourceMessageId?: string
  createdAt: string
  /** Vault-relative folder inside `notes/` this note belongs to. */
  notesFolder?: string
  /** The note file this record was written to, once it exists in the vault. */
  notePath?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** Vault chat only: whether the answer was strictly grounded in the selection. */
  grounded?: boolean
  /** Vault chat only: the vault-relative paths that grounded this answer. */
  sources?: string[]
  /** Vault chat only: the note written from this answer, when the user saved it. */
  savedPath?: string
}

export interface SenseRelation {
  atom: SenseAtom
  reason: string
}

// --------------------------------------------------------------- workspaces

/** The three top-level desks of the app. */
export type AppSpace = 'reader' | 'notes' | 'chat'

/** How the notes desk shows the active Markdown note. */
export type NoteViewMode = 'edit' | 'preview'

// ------------------------------------------------------------------- vault

/** One entry of the recursive vault listing (paths are relative to the root). */
export interface VaultEntry {
  path: string
  directory: boolean
  size: number
  mtimeMs: number
}

export type VaultNoteKind = 'daily' | 'report' | 'sense' | 'note' | 'chat' | 'inbox' | 'finding'

/**
 * The safe YAML subset Paperlight writes and reads. Values are either a single
 * line or an inline list; anything richer stays part of the note body.
 */
export interface NoteFrontmatter {
  [key: string]: string | string[] | undefined
}

export interface ParsedNote {
  data: NoteFrontmatter
  body: string
}

export interface VaultTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  /** Markdown note, or an original material under `materials/`. */
  kind: 'note' | 'source'
  children: VaultTreeNode[]
  size: number
  mtimeMs: number
}

/** One record rolled into a daily note. */
export interface DailyEntry {
  id: string
  label: string
  body: string
  kind: 'sense' | 'note' | 'file'
  /** Vault-relative path of the note this record points at, when known. */
  path?: string
}

/** One vault-grounded chat thread of the chat desk. */
export interface ChatThread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  /** Vault-relative note paths selected as the strict grounding context. */
  contextPaths: string[]
}
