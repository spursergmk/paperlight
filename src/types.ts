export type TranslateMode = 'mock' | 'openai'

export interface TextSelection {
  text: string
  before: string
  after: string
  /** PDF page number, or 1-based chapter number in a reflowed document. */
  pageNumber: number
  startOffset?: number
  endOffset?: number
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

/** Canonical V2 name; the SensePayload alias keeps the V1 lookup contract. */
export type SemanticPayload = SensePayload

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
  /** Additional real reading instances; older V1 records have only contextSentence. */
  contexts?: SemanticContextInstance[]
  /** User-confirmed alternate V1/AI IDs that resolve to this semantic record. */
  alternateSemanticIds?: string[]
}

/** Canonical V2 name; V1 storage records are read without rewriting their identity. */
export type SemanticRecord = SenseAtom

/** A source-linked instance of a semantic record. */
export interface SemanticContextInstance {
  id: string
  sourceKind?: 'pdf' | 'epub' | 'text'
  sourcePath?: string
  sourceName?: string
  locationLabel?: string
  pageNumber?: number
  startOffset?: number
  endOffset?: number
  quote: string
  createdAt: string
}

/** Estimated active-reading time and sources for one local calendar day. */
export interface ReadingActivitySource {
  sourcePath: string
  sourceName: string
  seconds: number
  lastReadAt: string
}

export interface ReadingActivityDay {
  seconds: number
  sources: ReadingActivitySource[]
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

/** How the learner encountered or pursued an expression. */
export type ExpressionCognitivePath = 'recognition' | 'exploration' | 'manual'
export type ExpressionSourceKind = 'pdf' | 'epub' | 'text' | 'assistant' | 'chat' | 'note' | 'enlightenment' | 'ai_exploration' | 'manual'

/** Provenance for one independent occurrence or generated candidate. */
export interface ExpressionContext {
  id: string
  createdAt: string
  cognitivePath?: ExpressionCognitivePath
  sourceKind: ExpressionSourceKind
  sourcePath?: string
  sourceName?: string
  locationLabel?: string
  pageNumber?: number
  /** Text offset within a stable page/chapter view, used with quote/context verification. */
  startOffset?: number
  endOffset?: number
  quote?: string
  before?: string
  after?: string
  /** AI candidates remain explicitly marked as generated, with no fake quotation. */
  generated?: boolean
  usageScenario?: string
}

export type InputMarkerPurpose = 'progress' | 'form' | 'content'
export type InputMarkerVisualStyle = 'highlight' | 'underline'

/** A non-destructive location attached to a source document or conversation. */
export interface InputMarker {
  id: string
  sourcePath: string
  sourceKind: ExpressionSourceKind
  purpose: InputMarkerPurpose
  visualStyle?: InputMarkerVisualStyle
  quote?: string
  before?: string
  after?: string
  pageNumber?: number
  locationLabel?: string
  startOffset?: number
  endOffset?: number
  scrollRatio?: number
  comment: string
  createdAt: string
}

export type ExpressionRelationKind = 'variant' | 'alternative' | 'similar' | 'contrast' | 'collocation' | 'used_with'

export interface ExpressionRelation {
  id: string
  targetId: string
  kind: ExpressionRelationKind
  note: string
  source: 'user' | 'ai'
  createdAt: string
}

/** One intentionally mastered language form, independent of semantic records. */
export interface ExpressionRecord {
  id: string
  expression: string
  normalizedExpression: string
  meaning: string
  note: string
  cognitivePaths: ExpressionCognitivePath[]
  contexts: ExpressionContext[]
  relations: ExpressionRelation[]
  createdAt: string
  updatedAt: string
}

export interface ExpressionCandidate {
  expression: string
  meaning: string
  usageScenario: string
  relation: string
}

// --------------------------------------------------------------- workspaces

/** The three top-level desks of the app. */
export type AppSpace = 'reader' | 'notes' | 'expressions' | 'chat'

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

export type VaultNoteKind = 'daily' | 'report' | 'sense' | 'semantic' | 'expression' | 'note' | 'chat' | 'inbox' | 'finding' | 'research'

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
  kind: 'sense' | 'semantic' | 'expression' | 'note' | 'file'
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
