// Narrow bridge between the renderer and the Electron main process.
// Everything the reader can do to the file system or the OS goes through here.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('paperlight', {
  isApp: true,
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  state: {
    get: () => ipcRenderer.invoke('state:get'),
    set: (state) => ipcRenderer.invoke('state:set', state),
  },
  fs: {
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    pickPdfs: () => ipcRenderer.invoke('dialog:pick-pdfs'),
    list: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),
    read: (filePath) => ipcRenderer.invoke('fs:read', filePath),
    roots: () => ipcRenderer.invoke('fs:roots'),
    reveal: (filePath) => ipcRenderer.invoke('fs:reveal', filePath),
    stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || ''
      } catch {
        return ''
      }
    },
  },
  vault: {
    pick: () => ipcRenderer.invoke('vault:pick'),
    stat: (root) => ipcRenderer.invoke('vault:stat', root),
    tree: (root) => ipcRenderer.invoke('vault:tree', root),
    read: (root, relativePath) => ipcRenderer.invoke('vault:read', root, relativePath),
    write: (root, relativePath, content) => ipcRenderer.invoke('vault:write', root, relativePath, content),
    mkdir: (root, relativePath) => ipcRenderer.invoke('vault:mkdir', root, relativePath),
    remove: (root, relativePath) => ipcRenderer.invoke('vault:remove', root, relativePath),
    reveal: (root, relativePath) => ipcRenderer.invoke('vault:reveal', root, relativePath),
  },
  on: {
    openPaths: (callback) => subscribe('app:open-paths', callback),
    openFolder: (callback) => subscribe('app:open-folder', callback),
    setVault: (callback) => subscribe('app:set-vault', callback),
    command: (callback) => subscribe('app:command', callback),
  },
})
