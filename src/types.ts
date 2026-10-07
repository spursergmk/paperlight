export type TranslateMode = 'mock' | 'openai'

export interface TextSelection {
  text: string
  before: string
  after: string
  pageNumber: number
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
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface SenseRelation {
  atom: SenseAtom
  reason: string
}
