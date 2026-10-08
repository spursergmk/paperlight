// After `electron-builder --mac`, put the built universal bundle at the repo
// root as ./Paperlight.app so `open Paperlight.app` keeps working exactly as
// before, while the distributable DMG/ZIP stay in release/.
//
// A rename is used on purpose: copying an .app rewrites the framework symlinks
// into broken absolute links.

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(projectRoot, 'release')
const target = join(projectRoot, 'Paperlight.app')

if (!existsSync(releaseDir)) {
  console.error('release/ not found — run electron-builder first')
  process.exit(1)
}

const candidates = readdirSync(releaseDir)
  .filter((name) => name.startsWith('mac'))
  .map((name) => join(releaseDir, name, 'Paperlight.app'))
  .filter((path) => existsSync(path))

if (candidates.length === 0) {
  console.warn('no Paperlight.app found under release/ — nothing to expose at the repo root')
  process.exit(0)
}

// Prefer the universal build when both it and a single-arch build exist.
const source = candidates.find((path) => path.includes('universal')) || candidates[0]
rmSync(target, { recursive: true, force: true })
renameSync(source, target)

const artifacts = readdirSync(releaseDir).filter((name) => /\.(dmg|zip|exe|AppImage|deb)$/i.test(name))
console.log(`Paperlight.app → ${target}`)
if (artifacts.length > 0) console.log(`installers    → ${artifacts.join(', ')} (in release/)`)
