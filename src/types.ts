export type TranslateMode = 'mock' | 'openai'

export interface TextSelection {
  text: string
  before: string
  after: string
  pageNumber: number
}

export interface SavedNote {
  id: string
  text: string
  translation: string
  pageNumber: number
  note: string
}
