// Paperlight desktop app (Electron main process).
//
// Responsibilities
//   * own the window / menu / lifecycle
//   * serve the built renderer plus the shared loopback AI proxy on
//     127.0.0.1:4178 (in dev it just loads the Vite dev server instead)
//   * expose the native file-system bridge the reader needs: folder picking,
//     directory listing, PDF reading, recent folders and persistent app state.
//
// The renderer never gets Node access: every capability arrives through the
// narrow preload bridge in electron/preload.cjs.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, session, shell,
} from 'electron'
import { createPaperlightApi, createStaticHandler } from '../server/api.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const distDir = join(projectRoot, 'dist')
const devServerUrl = process.env.PAPERLIGHT_DEV_SERVER_URL || ''
const isSmoke = process.env.PAPERLIGHT_SMOKE === '1'
const isolatedUserDataDir = process.env.PAPERLIGHT_USER_DATA_DIR?.trim()
const DEFAULT_PORT = Number(process.env.PAPERLIGHT_PORT || 4178)
const MAX_DIRECTORY_ENTRIES = 4_000

// The smoke test must never touch the real user's saved workspace.
if (isSmoke) {
  const smokeUserData = join(tmpdir(), 'paperlight-smoke-userdata')
  rmSync(smokeUserData, { recursive: true, force: true })
  app.setPath('userData', smokeUserData)
} else if (isolatedUserDataDir) {
  const resolvedUserData = resolve(isolatedUserDataDir)
  mkdirSync(resolvedUserData, { recursive: true })
  app.setPath('userData', resolvedUserData)
}

// The renderer only ever loads local code and talks to its own origin, so the
// policy can stay strict: no remote scripts, no eval, wasm only for pdf.js.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

let mainWindow = null
let httpServer = null

// ---------------------------------------------------------------- app state

function userDataFile(name) {
  return join(app.getPath('userData'), name)
}

// When the app bundle sits inside the project folder (`./Paperlight.app`), the
// key the user already saved for development lives in `<project>/.env.local`.
// Import it once into the app's own config directory so the packaged app works
// without re-entering the key. Nothing happens when the bundle is moved
// elsewhere, and the project copy is left untouched.
function inheritLocalApiConfig() {
  if (!app.isPackaged) return
  const target = join(app.getPath('userData'), '.env.local')
  if (existsSync(target)) return
  // Walk a couple of levels up from Contents/MacOS so the app works both at
  // <project>/Paperlight.app and one folder deeper (e.g. a build output dir).
  let directory = dirname(app.getPath('exe'))
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, '.env.local')
    if (existsSync(candidate) && looksLikeProjectRoot(directory)) {
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(candidate), { encoding: 'utf8', mode: 0o600 })
        console.log(`[paperlight] imported ${candidate} into the app config directory`)
      } catch (error) {
        console.warn('[paperlight] could not import .env.local:', error instanceof Error ? error.message : error)
      }
      return
    }
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

// Only treat a folder as "the project root" when it really is one. Without this
// an app bundle placed anywhere under a home directory could pick up an
// unrelated .env.local from an ancestor folder (relevant on Windows, where the
// executable is not wrapped in an .app bundle).
function looksLikeProjectRoot(directory) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return manifest && manifest.name === 'paperlight'
  } catch {
    return false
  }
}

function stateFilePath() {
  return userDataFile('paperlight-state.json')
}

function readState() {
  try {
    const raw = readFileSync(stateFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeState(state) {
  const target = stateFilePath()
  const temp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temp, JSON.stringify(state ?? {}, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, target)
    return true
  } catch (error) {
    try { unlinkSync(temp) } catch { /* ignore */ }
    console.error('[paperlight] could not persist app state', error)
    return false
  }
}

// ------------------------------------------------------------ file system

// Kept in sync with src/lib/documentKind.ts (the renderer's source of truth);
// the smoke test opens one file of each kind through this bridge, so a drift
// between the two lists fails the build.
const DOCUMENT_EXTENSIONS = ['.pdf', '.epub', '.txt', '.text', '.md', '.markdown', '.mdown']
const TEXT_EXTENSIONS = ['.txt', '.text', '.md', '.markdown', '.mdown']
const MAX_PDF_BYTES = 512 * 1024 * 1024
const MAX_TEXT_BYTES = 64 * 1024 * 1024

function documentKindOf(filePath) {
  const lower = extname(filePath).toLowerCase()
  if (lower === '.pdf') return 'pdf'
  if (lower === '.epub') return 'epub'
  return TEXT_EXTENSIONS.includes(lower) ? 'text' : null
}

function isOpenablePath(filePath) {
  return documentKindOf(filePath) !== null
}

function describeEntry(dirent, dirPath) {
  const fullPath = join(dirPath, dirent.name)
  let size = 0
  let mtimeMs = 0
  try {
    const info = statSync(fullPath)
    size = info.size
    mtimeMs = info.mtimeMs
  } catch { /* unreadable entries stay listed */ }
  return {
    name: dirent.name,
    path: fullPath,
    directory: dirent.isDirectory(),
    kind: dirent.isDirectory() ? null : documentKindOf(fullPath),
    size,
    mtimeMs,
  }
}

function listDirectory(dirPath) {
  const target = resolve(dirPath)
  if (!existsSync(target)) throw new Error('文件夹不存在。')
  if (!statSync(target).isDirectory()) throw new Error('这不是一个文件夹。')
  const dirents = readdirSync(target, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue
    if (dirent.isSymbolicLink()) continue
    if (!dirent.isDirectory() && !dirent.isFile()) continue
    entries.push(describeEntry(dirent, target))
    if (entries.length >= MAX_DIRECTORY_ENTRIES) break
  }
  entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
  return { path: target, parent: dirname(target), entries }
}

function readDocumentBytes(filePath) {
  const target = resolve(filePath)
  const kind = documentKindOf(target)
  if (!kind) throw new Error('暂不支持这种文件格式（支持 PDF、EPUB、TXT、Markdown）。')
  const info = statSync(target)
  if (!info.isFile()) throw new Error('这不是一个文件。')
  const limit = kind === 'text' ? MAX_TEXT_BYTES : MAX_PDF_BYTES
  if (info.size > limit) throw new Error('文件过大，无法打开。')
  return new Uint8Array(readFileSync(target))
}

// -------------------------------------------------------------- notes vault

// A vault is just a folder of Markdown files. Every path that arrives from the
// renderer is resolved inside the chosen root and re-checked after symlink
// resolution, so a crafted note path cannot reach the rest of the disk.

const VAULT_MAX_ENTRIES = 4_000
const VAULT_MAX_DEPTH = 12
const VAULT_MAX_NOTE_BYTES = 4 * 1024 * 1024
// Writes stay Markdown-only; the listing also shows the original materials so
// the notes desk can open them in the reading desk.
const VAULT_NOTE_EXTENSIONS = ['.md', '.markdown']
const VAULT_LISTING_EXTENSIONS = [...VAULT_NOTE_EXTENSIONS, '.pdf', '.epub', '.txt', '.text']
const VAULT_SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'release', 'build'])

function vaultRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('尚未选择笔记 vault。')
  const target = resolve(value)
  let info
  try {
    info = statSync(target)
  } catch {
    throw new Error('笔记 vault 不存在，请重新选择文件夹。')
  }
  if (!info.isDirectory()) throw new Error('笔记 vault 必须是一个文件夹。')
  return target
}

function vaultParts(relative) {
  if (typeof relative !== 'string' || !relative.trim()) throw new Error('笔记路径无效。')
  const normalized = relative.replace(/\\/g, '/')
  if (/^([A-Za-z]:|\/)/.test(normalized)) throw new Error('笔记路径不能是绝对路径。')
  const parts = normalized.split('/').filter((part) => part && part !== '.')
  if (parts.length === 0) throw new Error('笔记路径无效。')
  if (parts.some((part) => part === '..')) throw new Error('笔记路径不能离开 vault。')
  if (parts.length > VAULT_MAX_DEPTH) throw new Error('笔记路径层级过深。')
  return parts
}

function vaultTarget(rootValue, relative) {
  const root = vaultRoot(rootValue)
  const parts = vaultParts(relative)
  const target = resolve(root, ...parts)
  if (target !== root && !target.startsWith(root + sep)) throw new Error('笔记路径不能离开 vault。')

  // Resolve the deepest existing ancestor: a symlinked folder inside the vault
  // must not become a way out of it.
  const realRoot = realpathSync(root)
  let probe = target
  for (let depth = 0; depth <= VAULT_MAX_DEPTH + 2; depth += 1) {
    let info = null
    try {
      // lstat sees a dangling symlink; existsSync would treat it as absent.
      info = lstatSync(probe)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
    if (info) {
      let realProbe
      try {
        realProbe = realpathSync(probe)
      } catch (error) {
        if (info.isSymbolicLink()) throw new Error('笔记路径包含无法解析的符号链接。')
        throw error
      }
      if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
        throw new Error('笔记路径不能离开 vault。')
      }
      break
    }
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  return { root, target, relative: parts.join('/') }
}

// The whole vault is listed once and cached by the renderer: it builds the tree
// from this flat list, exactly like the folder explorer does.
function listVaultEntries(rootValue) {
  const root = vaultRoot(rootValue)
  const entries = []
  const walk = (directory, prefix, depth) => {
    if (depth > VAULT_MAX_DEPTH || entries.length >= VAULT_MAX_ENTRIES) return
    let dirents
    try {
      dirents = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (entries.length >= VAULT_MAX_ENTRIES) return
      if (dirent.name.startsWith('.') || dirent.isSymbolicLink()) continue
      const child = prefix ? `${prefix}/${dirent.name}` : dirent.name
      const fullPath = join(directory, dirent.name)
      if (dirent.isDirectory()) {
        entries.push({ path: child, directory: true, size: 0, mtimeMs: 0 })
        if (!VAULT_SKIP_DIRECTORIES.has(dirent.name)) walk(fullPath, child, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      if (!VAULT_LISTING_EXTENSIONS.includes(extname(dirent.name).toLowerCase())) continue
      let size = 0
      let mtimeMs = 0
      try {
        const info = statSync(fullPath)
        size = info.size
        mtimeMs = info.mtimeMs
      } catch { /* unreadable notes stay listed */ }
      entries.push({ path: child, directory: false, size, mtimeMs })
    }
  }
  walk(root, '', 0)
  return entries
}

function readVaultNote(rootValue, relative) {
  const { target } = vaultTarget(rootValue, relative)
  const info = statSync(target)
  if (!info.isFile()) throw new Error('这不是一个笔记文件。')
  if (info.size > VAULT_MAX_NOTE_BYTES) throw new Error('笔记过大，无法打开。')
  return readFileSync(target, 'utf8')
}

function writeVaultNote(rootValue, relative, content) {
  if (typeof content !== 'string') throw new Error('笔记内容无效。')
  const { target } = vaultTarget(rootValue, relative)
  if (!VAULT_NOTE_EXTENSIONS.includes(extname(target).toLowerCase())) throw new Error('笔记必须以 .md 结尾。')
  if (Buffer.byteLength(content, 'utf8') > VAULT_MAX_NOTE_BYTES) throw new Error('笔记过大，无法保存。')
  mkdirSync(dirname(target), { recursive: true })
  // Write to a sibling file and rename: a crash mid-save must never truncate a note.
  const temp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf8' })
    renameSync(temp, target)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw error
  }
  return { ok: true }
}

function removeVaultEntry(rootValue, relative) {
  const { root, target } = vaultTarget(rootValue, relative)
  if (target === root) throw new Error('不能删除 vault 根目录。')
  if (!existsSync(target)) return { ok: true }
  rmSync(target, { recursive: true, force: true })
  return { ok: true }
}

function quickAccessRoots() {
  const roots = []
  const push = (label, path) => {
    if (!path) return
    if (roots.some((item) => item.path === path)) return
    if (!existsSync(path)) return
    roots.push({ label, path })
  }
  push('主目录', homedir())
  push('桌面', join(homedir(), 'Desktop'))
  push('文稿', join(homedir(), 'Documents'))
  push('下载', join(homedir(), 'Downloads'))
  push('项目', projectRoot)
  if (existsSync('/Volumes')) {
    for (const name of readdirSync('/Volumes')) push(name, join('/Volumes', name))
  }
  return roots
}

// ------------------------------------------------------------ local server

function startServer() {
  return new Promise((resolvePromise, reject) => {
    // The smoke run must never use the developer's real API key: give it an
    // empty config directory so an unstubbed request fails locally instead of
    // reaching a paid endpoint.
    const configRoot = isSmoke
      ? join(app.getPath('userData'), 'config')
      : (app.isPackaged ? app.getPath('userData') : projectRoot)
    const api = createPaperlightApi({ root: configRoot })
    const serveStatic = createStaticHandler(distDir)
    const server = createServer((req, res) => {
      api.middleware(req, res, () => {
        serveStatic(req, res, () => {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Not found')
        })
      })
    })
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' && server.port !== 0) {
        // Another Paperlight instance owns the default port: fall back to any
        // free port. Renderer state is stored on disk, so the origin may change.
        server.listen(0, '127.0.0.1')
        return
      }
      reject(error)
    })
    server.on('listening', () => {
      httpServer = server
      const address = server.address()
      resolvePromise(`http://127.0.0.1:${address.port}`)
    })
    server.listen(DEFAULT_PORT, '127.0.0.1')
  })
}

// ---------------------------------------------------------------- IPC bridge

// Dialogs must not be given a destroyed parent window.
function liveWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    devServer: Boolean(devServerUrl),
  }))

  ipcMain.handle('state:get', () => readState())
  ipcMain.handle('state:set', (_event, state) => ({ ok: writeState(state) }))

  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog(liveWindow(), {
      title: '选择一个文件夹',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '打开文件夹',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:pick-pdfs', async () => {
    const result = await dialog.showOpenDialog(liveWindow(), {
      title: '打开 PDF',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有支持的文档', extensions: DOCUMENT_EXTENSIONS.map((extension) => extension.slice(1)) },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'EPUB', extensions: ['epub'] },
        { name: '文本 / Markdown', extensions: ['txt', 'md', 'markdown'] },
      ],
      buttonLabel: '打开',
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('fs:list', (_event, dirPath) => listDirectory(dirPath))
  ipcMain.handle('fs:read', (_event, filePath) => readDocumentBytes(filePath))
  ipcMain.handle('fs:roots', () => quickAccessRoots())
  ipcMain.handle('fs:reveal', (_event, filePath) => {
    shell.showItemInFolder(resolve(filePath))
    return true
  })
  ipcMain.handle('fs:stat', (_event, filePath) => {
    try {
      const info = statSync(resolve(filePath))
      return { exists: true, directory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return { exists: false, directory: false, size: 0, mtimeMs: 0 }
    }
  })

  // ------------------------------------------------------------ notes vault

  ipcMain.handle('vault:pick', async () => {
    const result = await dialog.showOpenDialog(liveWindow(), {
      title: '选择笔记 vault（一个装 Markdown 笔记的文件夹）',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用这个文件夹',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('vault:stat', (_event, rootValue) => {
    try {
      const root = vaultRoot(rootValue)
      return { exists: true, directory: true, path: root, name: basename(root) }
    } catch {
      return { exists: false, directory: false, path: '', name: '' }
    }
  })

  ipcMain.handle('vault:tree', (_event, rootValue) => listVaultEntries(rootValue))
  ipcMain.handle('vault:read', (_event, rootValue, relative) => readVaultNote(rootValue, relative))
  ipcMain.handle('vault:write', (_event, rootValue, relative, content) => writeVaultNote(rootValue, relative, content))

  ipcMain.handle('vault:mkdir', (_event, rootValue, relative) => {
    const { target } = vaultTarget(rootValue, relative)
    mkdirSync(target, { recursive: true })
    return { ok: true }
  })

  ipcMain.handle('vault:remove', (_event, rootValue, relative) => removeVaultEntry(rootValue, relative))

  ipcMain.handle('vault:reveal', (_event, rootValue, relative) => {
    const { target } = vaultTarget(rootValue, relative)
    const info = statSync(target)
    if (info.isDirectory()) void shell.openPath(target)
    else shell.showItemInFolder(target)
    return true
  })
}

// ------------------------------------------------------------------ window

const pendingOpenPaths = []

function openablePathsFromArgv(argv) {
  return argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith('-'))
    .map((arg) => resolve(arg))
    .filter((arg) => isOpenablePath(arg) && existsSync(arg))
}

// Sends to the renderer only when there is a live window. On macOS the app
// outlives its window, so Finder double-clicks and second-instance events can
// arrive while `mainWindow` is gone.
function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  mainWindow.webContents.send(channel, payload)
  return true
}

function sendOpenPaths(paths) {
  const list = paths.filter((item) => item && isOpenablePath(item))
  if (list.length === 0) return
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingOpenPaths.push(...list)
    return
  }
  sendToRenderer('app:open-paths', list)
  mainWindow.show()
  mainWindow.focus()
}

function flushPendingOpenPaths() {
  if (pendingOpenPaths.length === 0 || !mainWindow || mainWindow.isDestroyed()) return
  const list = pendingOpenPaths.splice(0, pendingOpenPaths.length)
  sendToRenderer('app:open-paths', list)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(liveWindow(), {
              title: '打开 PDF',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: '所有支持的文档', extensions: DOCUMENT_EXTENSIONS.map((extension) => extension.slice(1)) }],
            })
            if (!result.canceled) sendOpenPaths(result.filePaths)
          },
        },
        {
          label: '打开文件夹…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(liveWindow(), {
              title: '选择一个文件夹',
              properties: ['openDirectory', 'createDirectory'],
            })
            if (!result.canceled) {
              sendToRenderer('app:open-folder', result.filePaths[0])
            }
          },
        },
        {
          label: '关闭当前标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToRenderer('app:command', 'close-tab'),
        },
        { type: 'separator' },
        {
          label: '打开笔记 vault…',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => sendToRenderer('app:command', 'pick-vault'),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '阅读空间', accelerator: 'CmdOrCtrl+Alt+1', click: () => sendToRenderer('app:command', 'space-reader') },
        { label: '笔记空间', accelerator: 'CmdOrCtrl+Alt+2', click: () => sendToRenderer('app:command', 'space-notes') },
        { label: '对话空间', accelerator: 'CmdOrCtrl+Alt+3', click: () => sendToRenderer('app:command', 'space-chat') },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => sendToRenderer('app:command', 'zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => sendToRenderer('app:command', 'zoom-out') },
        { label: '适合宽度', accelerator: 'CmdOrCtrl+0', click: () => sendToRenderer('app:command', 'zoom-fit') },
        { type: 'separator' },
        { label: '下一页', accelerator: 'CmdOrCtrl+Down', click: () => sendToRenderer('app:command', 'next-page') },
        { label: '上一页', accelerator: 'CmdOrCtrl+Up', click: () => sendToRenderer('app:command', 'prev-page') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'reload', label: '重新载入界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Paperlight',
    backgroundColor: '#f6f5f2',
    // macOS gets an inset title bar (the renderer draws the drag region);
    // Windows and Linux keep their native frame.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  // macOS keeps the app running after the window closes; drop the reference so
  // later open-file / second-instance events create a fresh window instead of
  // touching a destroyed one.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('did-finish-load', () => {
    flushPendingOpenPaths()
  })

  // The renderer is local; nothing should navigate away or spawn windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('http://127.0.0.1:')
    if (!allowed) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  const target = devServerUrl || (await startServer())
  await mainWindow.loadURL(target)
  return mainWindow
}

// ------------------------------------------------------------------- boot

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    sendOpenPaths(openablePathsFromArgv(argv))
  })

  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    sendOpenPaths([resolve(filePath)])
  })

  app.whenReady().then(async () => {
    app.setName('Paperlight')
    // Windows groups taskbar entries and notifications by this id.
    if (process.platform === 'win32') app.setAppUserModelId('com.paperlight.reader')
    inheritLocalApiConfig()
    if (!devServerUrl) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
          },
        })
      })
    }
    registerIpc()
    buildMenu()
    const startPaths = openablePathsFromArgv(process.argv)
    if (startPaths.length > 0) pendingOpenPaths.push(...startPaths)
    await createWindow()
    if (isSmoke) {
      try {
        // The smoke harness lives outside the packaged bundle on purpose.
        const { runSmokeTest } = await import('./smoke.mjs')
        await runSmokeTest({ window: mainWindow, projectRoot })
      } catch (error) {
        console.error('[paperlight] smoke test could not run:', error)
        app.exit(1)
      }
    }
  })

  app.on('window-all-closed', () => {
    httpServer?.close()
    if (process.platform !== 'darwin' || isSmoke) app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
}
