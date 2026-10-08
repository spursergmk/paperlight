import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename } from '../src/lib/bridge.ts'
import { crumbsForPath } from '../src/lib/fsaccess.ts'

// The reader is packaged for macOS, Windows and Linux, so path handling must not
// assume POSIX separators.

test('basename handles POSIX and Windows separators', () => {
  assert.equal(basename('/Users/me/Documents/book.pdf'), 'book.pdf')
  assert.equal(basename('C:\\Users\\me\\Documents\\book.pdf'), 'book.pdf')
  assert.equal(basename('C:\\Users\\me\\Documents\\'), 'Documents')
  assert.equal(basename('book.pdf'), 'book.pdf')
  assert.equal(basename(''), '')
})

test('crumbsForPath builds POSIX breadcrumbs', () => {
  assert.deepEqual(crumbsForPath('/Users/me/Documents'), [
    { label: 'Users', path: '/Users' },
    { label: 'me', path: '/Users/me' },
    { label: 'Documents', path: '/Users/me/Documents' },
  ])
})

test('crumbsForPath builds Windows drive breadcrumbs', () => {
  assert.deepEqual(crumbsForPath('C:\\Users\\me\\Documents'), [
    { label: 'C:', path: 'C:' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'me', path: 'C:\\Users\\me' },
    { label: 'Documents', path: 'C:\\Users\\me\\Documents' },
  ])
})

test('crumbsForPath keeps UNC share roots intact', () => {
  assert.deepEqual(crumbsForPath('\\\\server\\share\\papers'), [
    { label: 'server', path: '\\\\server\\share' },
    { label: 'papers', path: '\\\\server\\share\\papers' },
  ])
  assert.deepEqual(crumbsForPath('\\\\server'), [{ label: 'server', path: '\\\\server' }])
})

test('crumbsForPath keeps browser folder tokens relative', () => {
  assert.deepEqual(crumbsForPath('MyFolder/sub'), [
    { label: 'MyFolder', path: 'MyFolder' },
    { label: 'sub', path: 'MyFolder/sub' },
  ])
  assert.deepEqual(crumbsForPath(''), [])
})
