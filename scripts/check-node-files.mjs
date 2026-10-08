// Parses every plain-JavaScript file in the repo with Node itself.
//
// `tsc -b` only type-checks the TypeScript sources, and Vite only bundles the
// renderer, so a syntax error in the Electron main process, the preload script,
// the shared API module or a build script would otherwise surface only when the
// app is started (or, worse, when a packaged build is opened by someone else).

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', 'tests', 'build', '.package'])
const EXTENSIONS = ['.mjs', '.cjs', '.js']

function collect(directory, found = []) {
  for (const name of readdirSync(directory)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(directory, name)
    if (statSync(full).isDirectory()) collect(full, found)
    else if (EXTENSIONS.some((extension) => name.endsWith(extension))) found.push(full)
  }
  return found
}

const files = collect(projectRoot).sort()
const failures = []

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    const output = error.stderr ? error.stderr.toString() : String(error)
    failures.push(`${file.replace(projectRoot, '.')}\n${output.trim().split('\n').slice(0, 4).join('\n')}`)
  }
}

if (failures.length > 0) {
  console.error(`syntax check failed for ${failures.length} file(s):\n`)
  console.error(failures.join('\n\n'))
  process.exit(1)
}

console.log(`syntax ok — ${files.length} JavaScript files parsed by Node`)
