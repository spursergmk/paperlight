// The vault file port.
//
// In the Electron app every operation goes through the narrow preload bridge
// (`window.paperlight.vault.*`), which confines each path to the chosen root.
// A plain browser dev session has no such bridge, so it falls back to a
// virtual, localStorage-backed vault: the notes desk stays fully usable for
// debugging, and nothing about the app target depends on it.

import type { VaultEntry } from '../types'
// Explicit extensions: `node --test` resolves these modules with Node's own
// ESM resolver (the app bundle resolves extensionless imports).
import { getBridge } from './bridge.ts'
import { isSafeVaultPath, normalizeVaultPath, vaultBasename, vaultDirname, vaultJoin } from './vault.ts'

export interface VaultPort {
  kind: 'app' | 'browser'
  canWrite: boolean
  pick(): Promise<string | null>
  stat(root: string): Promise<{ exists: boolean; directory: boolean; name: string }>
  tree(root: string): Promise<VaultEntry[]>
  read(root: string, path: string): Promise<string>
  write(root: string, path: string, content: string): Promise<void>
  mkdir(root: string, path: string): Promise<void>
  remove(root: string, path: string): Promise<void>
  removeEmptyDirectory(root: string, path: string): Promise<void>
  reveal(root: string, path: string): Promise<boolean>
}

function assertSafe(path: string): string {
  if (!isSafeVaultPath(path)) throw new Error('笔记路径不能离开 vault。')
  const normalized = normalizeVaultPath(path)
  if (!normalized) throw new Error('笔记路径无效。')
  return normalized
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    // Electron prefixes IPC failures with the channel name; keep the readable tail.
    return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
  }
  return fallback
}

function appPort(): VaultPort {
  const bridge = getBridge()!
  return {
    kind: 'app',
    canWrite: true,
    pick: () => bridge.vault.pick(),
    async stat(root) {
      const info = await bridge.vault.stat(root)
      return { exists: info.exists, directory: info.directory, name: info.name }
    },
    tree: (root) => bridge.vault.tree(root),
    read: (root, path) => bridge.vault.read(root, assertSafe(path)),
    async write(root, path, content) {
      const result = await bridge.vault.write(root, assertSafe(path), content)
      if (result && result.ok === false) throw new Error('笔记保存失败。')
    },
    async mkdir(root, path) {
      await bridge.vault.mkdir(root, assertSafe(path))
    },
    async remove(root, path) {
      await bridge.vault.remove(root, assertSafe(path))
    },
    async removeEmptyDirectory(root, path) {
      const result = await bridge.vault.removeEmptyDirectory(root, assertSafe(path))
      if (!result.ok) throw new Error('目录仍有内容。')
    },
    reveal: (root, path) => bridge.vault.reveal(root, assertSafe(path)),
  }
}

// ------------------------------------------------------- browser dev fallback

const VIRTUAL_KEY = 'paperlight-vault-dev-v1'
const VIRTUAL_ROOT = 'browser:vault'

interface VirtualVault {
  name: string
  files: Record<string, { content: string; updatedAt: number }>
}

function seedVault(): VirtualVault {
  const now = Date.now()
  return {
    name: 'Paperlight Vault（浏览器调试）',
    files: {
      'Paperlight/Inbox/欢迎.md': {
        content: [
          '# 欢迎使用笔记空间',
          '',
          '当前运行在浏览器调试模式，vault 是一个虚拟文件夹：笔记保存在浏览器存储里，',
          '不会写入磁盘。用 `npm run app` 打开桌面 app 后，就可以选择真实的文件夹作为 vault。',
          '',
          '## 可以做什么',
          '',
          '- 在阅读助手里把语义、表达和 AI 笔记存进 vault',
          '- 每天打开笔记空间时自动整理当天的日记汇总',
          '- 在对话空间里选中 vault 内容，让回答严格限定在这些笔记上',
        ].join('\n'),
        updatedAt: now,
      },
    },
  }
}

function readVirtual(): VirtualVault {
  try {
    const raw = localStorage.getItem(VIRTUAL_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as VirtualVault
      if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
        return { name: typeof parsed.name === 'string' ? parsed.name : 'Paperlight Vault', files: parsed.files }
      }
    }
  } catch {
    // Private mode or corrupted storage: start from the seed.
  }
  const seeded = seedVault()
  writeVirtual(seeded)
  return seeded
}

function writeVirtual(vault: VirtualVault): void {
  try {
    localStorage.setItem(VIRTUAL_KEY, JSON.stringify(vault))
  } catch {
    // Quota: keep serving the in-memory copy for this session.
  }
}

function browserPort(): VaultPort {
  let cache: VirtualVault | null = null
  const vault = () => {
    cache = cache || readVirtual()
    return cache
  }
  const persist = () => { if (cache) writeVirtual(cache) }

  return {
    kind: 'browser',
    canWrite: true,
    async pick() {
      cache = readVirtual()
      return VIRTUAL_ROOT
    },
    async stat(root) {
      if (root !== VIRTUAL_ROOT) return { exists: false, directory: false, name: '' }
      return { exists: true, directory: true, name: vault().name }
    },
    async tree(root) {
      if (root !== VIRTUAL_ROOT) return []
      const entries: VaultEntry[] = []
      const directories = new Set<string>()
      for (const [path, file] of Object.entries(vault().files)) {
        const normalized = normalizeVaultPath(path)
        if (!normalized) continue
        let parent = vaultDirname(normalized)
        while (parent && !directories.has(parent)) {
          directories.add(parent)
          entries.push({ path: parent, directory: true, size: 0, mtimeMs: 0 })
          parent = vaultDirname(parent)
        }
        entries.push({
          path: normalized,
          directory: false,
          size: file.content.length,
          mtimeMs: file.updatedAt || 0,
        })
      }
      return entries
    },
    async read(root, path) {
      if (root !== VIRTUAL_ROOT) throw new Error('这个浏览器会话里没有打开 vault。')
      const file = vault().files[assertSafe(path)]
      if (!file) throw new Error('笔记不存在。')
      return file.content
    },
    async write(root, path, content) {
      if (root !== VIRTUAL_ROOT) throw new Error('这个浏览器会话里没有打开 vault。')
      const current = vault()
      current.files[assertSafe(path)] = { content: String(content), updatedAt: Date.now() }
      persist()
    },
    async mkdir(root, path) {
      if (root !== VIRTUAL_ROOT) throw new Error('这个浏览器会话里没有打开 vault。')
      // Folders only exist through the notes they contain in this fallback.
      assertSafe(path)
    },
    async remove(root, path) {
      if (root !== VIRTUAL_ROOT) throw new Error('这个浏览器会话里没有打开 vault。')
      const current = vault()
      const target = assertSafe(path)
      let removed = false
      for (const key of Object.keys(current.files)) {
        if (key === target || key.startsWith(`${target}/`)) {
          delete current.files[key]
          removed = true
        }
      }
      if (removed) persist()
    },
    async removeEmptyDirectory(root, path) {
      if (root !== VIRTUAL_ROOT) throw new Error('这个浏览器会话里没有打开 vault。')
      const target = assertSafe(path)
      if (Object.keys(vault().files).some((key) => key.startsWith(`${target}/`))) throw new Error('目录仍有内容。')
    },
    async reveal() {
      return false
    },
  }
}

let cached: VaultPort | null = null

export function vaultFileSystem(): VaultPort {
  if (cached) return cached
  try {
    cached = getBridge() ? appPort() : browserPort()
  } catch {
    cached = browserPort()
  }
  return cached
}

export function vaultErrorText(error: unknown, fallback = 'vault 操作失败。'): string {
  return messageOf(error, fallback)
}

/** Used by the notes desk header and the tree root label. */
export function vaultDisplayName(root: string | null): string {
  if (!root) return '未选择 vault'
  if (root === VIRTUAL_ROOT) return '虚拟 vault（浏览器调试）'
  return vaultBasename(root) || root
}

export function isVirtualVault(root: string | null): boolean {
  return root === VIRTUAL_ROOT
}

export { VIRTUAL_ROOT }

/** Joins a folder and a note name the same way the vault tree does. */
export function notePathIn(folder: string, name: string): string {
  return vaultJoin(folder, name)
}
