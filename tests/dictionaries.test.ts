import assert from 'node:assert/strict'
import test from 'node:test'
import { dictionaryEntryUrl } from '../src/lib/dictionaries.ts'

test('dictionary entry links stay on the official Oxford and Collins sites', () => {
  assert.equal(
    dictionaryEntryUrl('oxford', 'look after'),
    'https://www.oxfordlearnersdictionaries.com/definition/english/look_after',
  )
  assert.equal(
    dictionaryEntryUrl('collins', 'look after'),
    'https://www.collinsdictionary.com/dictionary/english/look-after',
  )
})

test('empty dictionary queries open the official dictionary search pages', () => {
  assert.equal(dictionaryEntryUrl('oxford', '  '), 'https://www.oxfordlearnersdictionaries.com/definition/english')
  assert.equal(dictionaryEntryUrl('collins', ''), 'https://www.collinsdictionary.com/dictionary/english')
})
