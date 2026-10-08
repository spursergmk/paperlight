import type { DirEntry, DirListing, QuickRoot } from './bridge'
// Explicit extension: `node --test` resolves this module with Node's own ESM
// resolver (the app bundle resolves extensionless imports, Node does not).
import { documentKindFor, isOpenablePath } from './documentKind.ts'
// Explicit extension: `node --test` runs this module through Node's own ESM
// resolver (the app bundle resolves extensionless imports, Node does not).
import { basename, getBridge } from './bridge.ts'

// One interface for "the place documents come from". The Electron app uses the
// native bridge; a plain browser dev session falls back to the File System
// Access API, and a final fallback keeps the classic file picker working.

export interface FileSystemPort {
  kind: 'app' | 'browser' | 'none'
  canBrowse: boolean
  pickFolder(): Promise<string | null>
  pickDocuments(): Promise<string[]>
  list(path: string): Promise<DirListing>
  read(path: string): Promise<Uint8Array>
  roots(): Promise<QuickRoot[]>
  reveal(path: string): Promise<boolean>
  stat(path: string): Promise<{ exists: boolean; directory: boolean; size: number; mtimeMs: number }>
  pathForFile(file: File): string
}

type DirectoryHandleLike = {
  name: string
  kind: 'directory'
  entries(): AsyncIterableIterator<[string, DirectoryHandleLike | FileHandleLike]>
  getFileHandle(name: string): Promise<FileHandleLike>
  getDirectoryHandle(name: string): Promise<DirectoryHandleLike>
}

type FileHandleLike = {
  name: string
  kind: 'file'
  getFile(): Promise<File>
}

function pickerApi(): { showDirectoryPicker?: (options?: unknown) => Promise<DirectoryHandleLike> } {
  return window as unknown as { showDirectoryPicker?: (options?: unknown) => Promise<DirectoryHandleLike> }
}

// Loose files (drag & drop, plain file picker) are addressed by a session token
// so the rest of the reader can treat them exactly like files on disk.
function createLooseFiles() {
  const files = new Map<string, File>()
  let counter = 0
  return {
    register(file: File): string {
      const token = `import:${counter += 1}:${file.name}`
      files.set(token, file)
      return token
    },
    get(path: string): File | undefined {
      return files.get(path)
    },
    async read(path: string): Promise<Uint8Array | null> {
      const file = files.get(path)
      if (!file) return null
      return new Uint8Array(await file.arrayBuffer())
    },
    stat(path: string) {
      const file = files.get(path)
      if (!file) return null
      return { exists: true, directory: false, size: file.size, mtimeMs: file.lastModified }
    },
  }
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
}

function appPort(): FileSystemPort {
  const bridge = getBridge()!
  return {
    kind: 'app',
    canBrowse: true,
    pickFolder: () => bridge.fs.pickFolder(),
    pickDocuments: () => bridge.fs.pickDocuments(),
    list: (path) => bridge.fs.list(path),
    read: (path) => bridge.fs.read(path),
    roots: () => bridge.fs.roots(),
    reveal: (path) => bridge.fs.reveal(path),
    stat: (path) => bridge.fs.stat(path),
    pathForFile: (file) => bridge.fs.pathForFile(file),
  }
}

// File System Access fallback: directory handles live in memory for the session.
function browserPort(): FileSystemPort | null {
  if (typeof window === 'undefined' || typeof pickerApi().showDirectoryPicker !== 'function') return null
  const handles = new Map<string, DirectoryHandleLike>()
  const loose = createLooseFiles()

  const tokenFor = (handle: DirectoryHandleLike, parent: string): string =>
    parent ? `${parent}/${handle.name}` : handle.name

  async function handleFor(path: string): Promise<DirectoryHandleLike> {
    const direct = handles.get(path)
    if (direct) return direct
    const segments = path.split('/')
    const root = handles.get(segments[0])
    if (!root) throw new Error('请重新选择文件夹（浏览器会话不保留授权）。')
    let current = root
    for (const segment of segments.slice(1)) current = await current.getDirectoryHandle(segment)
    handles.set(path, current)
    return current
  }

  return {
    kind: 'browser',
    canBrowse: true,
    async pickFolder() {
      const handle = await pickerApi().showDirectoryPicker!({ mode: 'read' })
      const token = tokenFor(handle, '')
      handles.set(token, handle)
      return token
    },
    async pickDocuments() {
      const files = await new Promise<File[]>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.pdf,.epub,.txt,.md,.markdown'
        input.multiple = true
        input.onchange = () => resolve(Array.from(input.files || []))
        input.click()
      })
      return files.map((file) => loose.register(file))
    },
    async list(path) {
      const handle = await handleFor(path)
      const entries: DirEntry[] = []
      for await (const [name, child] of handle.entries()) {
        if (name.startsWith('.')) continue
        if (child.kind === 'directory') {
          entries.push({ name, path: `${path}/${name}`, directory: true, kind: null, size: 0, mtimeMs: 0 })
        } else {
          const file = await child.getFile()
          entries.push({
            name,
            path: `${path}/${name}`,
            directory: false,
            kind: documentKindFor(name),
            size: file.size,
            mtimeMs: file.lastModified,
          })
        }
      }
      return { path, parent: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', entries: sortEntries(entries) }
    },
    async read(path) {
      const bytes = await loose.read(path)
      if (bytes) return bytes
      const segments = path.split('/')
      const fileName = segments[segments.length - 1]
      const handle = await handleFor(segments.slice(0, -1).join('/') || segments[0])
      const fileHandle = await handle.getFileHandle(fileName)
      const file = await fileHandle.getFile()
      return new Uint8Array(await file.arrayBuffer())
    },
    async roots() {
      return Array.from(handles.entries())
        .filter(([path]) => !path.includes('/'))
        .map(([path, handle]) => ({ label: handle.name, path }))
    },
    async reveal() {
      return false
    },
    async stat(path) {
      const looseStat = loose.stat(path)
      if (looseStat) return looseStat
      try {
        await handleFor(path)
        return { exists: true, directory: true, size: 0, mtimeMs: 0 }
      } catch {
        return { exists: false, directory: false, size: 0, mtimeMs: 0 }
      }
    },
    pathForFile(file) {
      return loose.register(file)
    },
  }
}

// Last-resort fallback (e.g. a browser without the File System Access API):
// drag & drop and the plain file picker still work, folder browsing does not.
function looseFilePort(): FileSystemPort {
  const loose = createLooseFiles()
  return {
    kind: 'none',
    canBrowse: false,
    async pickFolder() { return null },
    async pickDocuments() {
      const files = await new Promise<File[]>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.pdf,.epub,.txt,.md,.markdown'
        input.multiple = true
        input.onchange = () => resolve(Array.from(input.files || []))
        input.click()
      })
      return files.map((file) => loose.register(file))
    },
    async list() { return { path: '', parent: '', entries: [] } },
    async read(path) {
      const bytes = await loose.read(path)
      if (!bytes) throw new Error('当前运行环境无法读取本地文件。')
      return bytes
    },
    async roots() { return [] },
    async reveal() { return false },
    async stat(path) { return loose.stat(path) || { exists: false, directory: false, size: 0, mtimeMs: 0 } },
    pathForFile(file) { return loose.register(file) },
  }
}

const nonePort = looseFilePort()

let cached: FileSystemPort | null = null

export function fileSystem(): FileSystemPort {
  if (cached) return cached
  cached = getBridge() ? appPort() : (browserPort() || nonePort)
  return cached
}

export function displayNameForPath(path: string): string {
  return basename(path)
}

/** True when the reader can open this entry (PDF / EPUB / text / Markdown). */
export function entryIsOpenable(entry: { kind: 'pdf' | 'text' | 'epub' | null; path: string }): boolean {
  return entry.kind !== null || isOpenablePath(entry.path)
}

// Breadcrumbs for both POSIX and Windows paths:
//   /Users/me/Documents → /Users → /Users/me → /Users/me/Documents
//   C:\Users\me         → C: → C:\Users → C:\Users\me
//   \\server\share\dir  → \\server\share → \\server\share\dir
export function crumbsForPath(path: string): Array<{ label: string; path: string }> {
  if (!path) return []
  const separator = path.includes('\\') ? '\\' : '/'
  const isUnc = path.startsWith('\\\\')
  const absolute = !isUnc && path.startsWith(separator)
  const parts = path.split(/[\\/]/).filter(Boolean)

  const crumbs: Array<{ label: string; path: string }> = []
  if (isUnc) {
    if (parts.length === 0) return crumbs
    const root = `${separator}${separator}${parts[0]}${parts.length > 1 ? `${separator}${parts[1]}` : ''}`
    crumbs.push({ label: parts[0], path: root })
    let current = root
    for (const part of parts.slice(2)) {
      current = `${current}${separator}${part}`
      crumbs.push({ label: part, path: current })
    }
    return crumbs
  }

  let current = ''
  parts.forEach((part, index) => {
    current = index === 0
      ? (absolute ? `${separator}${part}` : part)
      : `${current}${separator}${part}`
    crumbs.push({ label: part, path: current })
  })
  return crumbs
}
