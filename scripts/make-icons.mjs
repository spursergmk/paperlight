// Builds the app icon set electron-builder needs from one source image:
//   build/icon.icns  macOS
//   build/icon.ico   Windows
//   build/icon.png   Linux (also the source)
//
// No image library is required: macOS `sips`/`iconutil` do the resizing and the
// .ico container is a small, well-defined header plus PNG payloads (Windows
// Vista and later read PNG-compressed entries natively).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(projectRoot, 'build')
const source = join(buildDir, 'icon.png')
const iconsetDir = join(buildDir, 'icon.iconset')
const icnsPath = join(buildDir, 'icon.icns')
const icoPath = join(buildDir, 'icon.ico')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

if (!existsSync(source)) {
  console.error(`missing ${source} — the 1024×1024 source icon is required`)
  process.exit(1)
}

// The generated build/icon.icns and build/icon.ico are committed, so this script
// only has to run when the source icon changes — and only on macOS, because it
// uses sips/iconutil.
if (process.platform !== 'darwin') {
  console.log('icon generation uses macOS sips/iconutil; the committed build/icon.* are used as-is')
  process.exit(0)
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'ignore' })
}

function resizePng(size, outPath) {
  run('sips', ['-z', String(size), String(size), source, '--out', outPath])
}

// ---------------------------------------------------------------- macOS .icns

function buildIcns() {
  rmSync(iconsetDir, { recursive: true, force: true })
  mkdirSync(iconsetDir, { recursive: true })
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    resizePng(size, join(iconsetDir, `icon_${size}x${size}.png`))
  }
  run('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath])
  rmSync(iconsetDir, { recursive: true, force: true })
  return icnsPath
}

// -------------------------------------------------------------- Windows .ico

function buildIco() {
  const tmp = join(buildDir, 'icon.ico.tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  const images = ICO_SIZES.map((size) => {
    const file = join(tmp, `icon-${size}.png`)
    resizePng(size, file)
    return { size, data: readFileSync(file) }
  })

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach((image, index) => {
    const entry = index * 16
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry) // 0 means 256
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1)
    directory.writeUInt8(0, entry + 2) // palette size
    directory.writeUInt8(0, entry + 3) // reserved
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.data.length
  })

  writeFileSync(icoPath, Buffer.concat([header, directory, ...images.map((image) => image.data)]))
  rmSync(tmp, { recursive: true, force: true })
  return icoPath
}

console.log(`icns → ${buildIcns()}`)
console.log(`ico  → ${buildIco()} (${ICO_SIZES.join(', ')} px)`)
