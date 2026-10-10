// Typed access to the Electron preload bridge. Everything degrades gracefully
// when the renderer runs in a plain browser (`npm run dev`).

export interface DirEntry {
  name: string
  path: string
  directory: boolean
  /** 'pdf' | 'text' | 'epub' when the file can be opened, else null. */
  kind: 'pdf' | 'text' | 'epub' | null
  size: number
  mtimeMs: number
}

export interface DirListing {
  path: string
  parent: string
  entries: DirEntry[]
}

export interface QuickRoot {
  label: string
  path: string
}

/** One entry of the vault listing; paths are relative to the vault root. */
export interface VaultListingEntry {
  path: string
  directory: boolean
  size: number
  mtimeMs: number
}

export interface PaperlightBridge {
  isApp: true
  platform: string
  info(): Promise<{ name: string; version: string; platform: string; packaged: boolean; devServer: boolean }>
  state: {
    get(): Promise<Record<string, unknown>>
    set(state: unknown): Promise<{ ok: boolean }>
  }
  fs: {
    pickFolder(): Promise<string | null>
    pickDocuments(): Promise<string[]>
    list(path: string): Promise<DirListing>
    read(path: string): Promise<Uint8Array>
    roots(): Promise<QuickRoot[]>
    reveal(path: string): Promise<boolean>
    stat(path: string): Promise<{ exists: boolean; directory: boolean; size: number; mtimeMs: number }>
    pathForFile(file: File): string
  }
  vault: {
    pick(): Promise<string | null>
    stat(root: string): Promise<{ exists: boolean; directory: boolean; path: string; name: string }>
    tree(root: string): Promise<VaultListingEntry[]>
    read(root: string, relativePath: string): Promise<string>
    write(root: string, relativePath: string, content: string): Promise<{ ok: boolean }>
    mkdir(root: string, relativePath: string): Promise<{ ok: boolean }>
    remove(root: string, relativePath: string): Promise<{ ok: boolean }>
    removeEmptyDirectory(root: string, relativePath: string): Promise<{ ok: boolean }>
    reveal(root: string, relativePath: string): Promise<boolean>
  }
  on: {
    openPaths(callback: (paths: string[]) => void): () => void
    openFolder(callback: (path: string) => void): () => void
    /** The main process hands the renderer a vault folder (menu / CLI / tests). */
    setVault(callback: (root: string) => void): () => void
    command(callback: (command: string) => void): () => void
  }
}

declare global {
  interface Window {
    paperlight?: PaperlightBridge
  }
}

export function getBridge(): PaperlightBridge | null {
  if (typeof window === 'undefined') return null
  return window.paperlight?.isApp ? window.paperlight : null
}

export function isAppRuntime(): boolean {
  return getBridge() !== null
}

export function basename(path: string): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}
