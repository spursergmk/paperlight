export type LearnerDictionary = 'oxford' | 'collins'

/** Builds direct entry URLs on the dictionaries' official public websites. */
export function dictionaryEntryUrl(dictionary: LearnerDictionary, term: string): string {
  const trimmed = term.trim().replace(/\s+/g, dictionary === 'oxford' ? '_' : '-')
  if (!trimmed) return dictionary === 'oxford'
    ? 'https://www.oxfordlearnersdictionaries.com/definition/english'
    : 'https://www.collinsdictionary.com/dictionary/english'
  const entry = encodeURIComponent(trimmed)
  return dictionary === 'oxford'
    ? `https://www.oxfordlearnersdictionaries.com/definition/english/${entry}`
    : `https://www.collinsdictionary.com/dictionary/english/${entry}`
}
