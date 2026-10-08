#!/usr/bin/env node
// Paperlight 的发布助手：改版本号 → 记录更新内容 → 提交 → 打 tag → 推送 GitHub。
//
//   npm run release -- minor "修复笔记列表里的来源链接"
//   npm run release -- major "新增对话空间与 vault 知识挖掘"
//   npm run release -- patch "修正日报时间格式" --no-push
//   npm run release -- keep "把当前 package.json 的版本固定为正式版"   # 首次发布用
//
// 版本规则（见 CHANGELOG.md）：
//   * 整数部分 = 大版本功能变更（1.12.0 → 2.0.0）
//   * 小数部分 = 修复式小更新（1.0.0 → 1.1.0）
//   * 第三位   = 单点热修（1.1.0 → 1.1.1）
//
// 安全规则：绝不提交 .env*（.env.example 除外）、release/、dist/、node_modules/、
// Paperlight.app/ 或任何超过 5 MB 的文件；一旦发现就把暂存区退回并不提交。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_FILE_BYTES = 5 * 1024 * 1024
const CHANGELOG = join(projectRoot, 'CHANGELOG.md')
const PACKAGE_FILES = ['package.json', 'package-lock.json']

const argv = process.argv.slice(2)
// `keep` 不是提升，而是"直接把 package.json 里的版本发出去"（首次定版用）。
const BUMP_KINDS = ['major', 'minor', 'patch', 'keep']
const bump = argv.find((value) => BUMP_KINDS.includes(value)) || 'minor'
const flags = new Set(argv.filter((value) => value.startsWith('--')))
const summary = argv
  .filter((value) => !value.startsWith('--') && !BUMP_KINDS.includes(value))
  .join(' ')
  .trim()
const push = !flags.has('--no-push')
const writeEntry = !flags.has('--no-changelog')
/** `keep`（或 `--keep`）：发布 package.json 里已经写好的版本，不做提升。 */
const keepVersion = bump === 'keep' || flags.has('--keep')

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: options.stdio || 'pipe' }).trim()
}

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

function nextVersion(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!match) fail(`package.json 里的版本号不是 x.y.z：${current}`)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function isBlockedPath(file) {
  const normalized = file.replace(/\\/g, '/')
  if (/^(release|dist|node_modules)\//.test(normalized)) return true
  if (normalized === 'Paperlight.app' || normalized.startsWith('Paperlight.app/')) return true
  if (/(^|\/)\.env(\..+)?$/.test(normalized)) return normalized.endsWith('.env.example') ? false : true
  return false
}

function changedFiles() {
  const raw = git(['status', '--porcelain', '--untracked-files=all'])
  if (!raw) return []
  return raw.split('\n').map((line) => {
    const code = line.slice(0, 2).trim()
    let file = line.slice(3).trim()
    if (file.includes(' -> ')) file = file.split(' -> ').pop()
    return { file: file.replace(/^"|"$/g, ''), code }
  })
}

function assertSafe(files) {
  const blocked = files.filter((entry) => isBlockedPath(entry.file))
  if (blocked.length > 0) {
    git(['reset', '-q'])
    fail(`发现不该提交的路径，已退回暂存区：\n  ${blocked.map((entry) => entry.file).join('\n  ')}`)
  }
  const big = files.filter((entry) => {
    try {
      return statSync(join(projectRoot, entry.file)).size > MAX_FILE_BYTES
    } catch {
      return false
    }
  })
  if (big.length > 0) {
    git(['reset', '-q'])
    fail(`发现超过 5 MB 的文件，已退回暂存区：\n  ${big.map((entry) => entry.file).join('\n  ')}`)
  }
}

function updateVersion(version) {
  for (const name of PACKAGE_FILES) {
    const file = join(projectRoot, name)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const updated = name === 'package.json'
      ? text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
      : text
        .replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
        .replace(/(\n  "packages": \{\n    "": \{\n(?:.|\n)*?"version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
    writeFileSync(file, updated)
  }
}

function entryFor(version, date, files) {
  const kind = bump === 'major' ? '新增' : '改进'
  const groups = new Map([
    ['electron/', []], ['server/', []], ['src/components/', []], ['src/lib/', []],
    ['src/', []], ['tests/', []], ['scripts/', []], ['.github/', []], ['', []],
  ])
  for (const entry of files) {
    const prefix = [...groups.keys()].find((key) => key && entry.file.startsWith(key)) || ''
    const label = entry.code === '??' || entry.code === 'A' ? '新增' : entry.code === 'D' ? '删除' : '修改'
    groups.get(prefix).push(`- \`${entry.file}\`（${label}）`)
  }
  const listing = [...groups.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([prefix, items]) => `**${prefix || '根目录'}**\n\n${items.join('\n')}`)
    .join('\n\n')
  return [
    `## [${version}] - ${date}`,
    '',
    `### ${kind}`,
    '',
    summary ? `- ${summary}` : '- （请补充这次改动的内容）',
    '',
    '<details>',
    `<summary>改动文件（${files.length}）</summary>`,
    '',
    listing || '- 无',
    '',
    '</details>',
    '',
  ].join('\n')
}

function prependChangelog(entry) {
  const header = [
    '# 更新记录（CHANGELOG）',
    '',
    'Paperlight 的版本号规则：**整数部分 = 大版本功能变更，小数部分 = 修复式小更新**。',
    '',
    '| 变化 | 版本示例 |',
    '| --- | --- |',
    '| 大功能（新的空间、新的知识管理形态） | 1.0.0 → **2.0.0** |',
    '| 修复与小改进（界面细节、逻辑 bug、文案） | 1.0.0 → **1.1.0** |',
    '| 单点热修 | 1.1.0 → **1.1.1** |',
    '',
    '每次更新：先写清楚改动，然后 `npm run release -- minor "一句话摘要"`（或 `major` / `patch`）——脚本会改版本号、把这次改动写进本文件、提交、打 `vX.Y.Z` 标签并推送 GitHub。',
    '',
  ].join('\n')
  let rest = ''
  if (existsSync(CHANGELOG)) {
    const text = readFileSync(CHANGELOG, 'utf8')
    const index = text.indexOf('## [')
    rest = index >= 0 ? text.slice(index) : text.replace(/^# 更新记录（CHANGELOG）\n(?:.|\n)*?(?=## \[)/, '')
  }
  writeFileSync(CHANGELOG, `${header}\n${entry}\n${rest}`.replace(/\n{3,}/g, '\n\n'))
}

// ------------------------------------------------------------------ main

const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const version = keepVersion ? pkg.version : nextVersion(pkg.version, bump)
const date = new Date().toLocaleDateString('sv-SE')

git(['rev-parse', '--is-inside-work-tree'])
if (git(['tag', '--list', `v${version}`])) fail(`标签 v${version} 已经存在`)

const files = changedFiles()
const meaningful = files.filter((entry) => entry.file !== 'CHANGELOG.md')
if (writeEntry && meaningful.length === 0) fail('工作区没有改动，先改代码再发布')

if (writeEntry && existsSync(CHANGELOG) && readFileSync(CHANGELOG, 'utf8').includes(`## [${version}]`)) {
  fail(`CHANGELOG.md 里已经有 ${version} 一节了`)
}
if (!writeEntry) {
  if (!existsSync(CHANGELOG) || !readFileSync(CHANGELOG, 'utf8').includes(`## [${version}]`)) {
    fail(`--no-changelog 需要 CHANGELOG.md 里已经写好 ## [${version}] 一节`)
  }
}

console.log(`版本：${keepVersion ? `${version}（保持 package.json 里的版本）` : `${pkg.version} → ${version}（${bump}）`}`)
console.log(`改动：${meaningful.length} 个文件${summary ? ` · ${summary}` : ''}`)

updateVersion(version)
if (writeEntry) prependChangelog(entryFor(version, date, meaningful))

git(['add', '-A'])
const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
if (staged.length === 0) fail('没有需要提交的改动')
assertSafe(staged.map((file) => ({ file, code: 'M' })))

const message = `release: v${version}${summary ? ` — ${summary}` : ''}`
git(['commit', '-q', '-m', message])
git(['tag', '-a', `v${version}`, '-m', `Paperlight v${version}${summary ? ` — ${summary}` : ''}`])
console.log(`✓ 已提交并打标签 v${version}`)

if (push) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  git(['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' })
  git(['push', 'origin', `v${version}`], { stdio: 'inherit' })
  console.log(`✓ 已推送 origin/${branch} 与 v${version}`)
} else {
  console.log('（--no-push：没有推送，本地提交与标签已就绪）')
}

console.log(`\n发布完成：v${version}`)
console.log(`CHANGELOG.md 顶部就是这次更新的记录，可继续编辑后再 \`git push\`。`)
