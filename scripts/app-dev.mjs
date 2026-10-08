// Development launcher: starts the Vite dev server and then the Electron app
// pointed at it, so `npm run app:dev` behaves exactly like the packaged app
// (same window, same preload bridge, live reload for the renderer).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const electronBin = join(projectRoot, 'node_modules', '.bin', 'electron')
const port = Number(process.env.PAPERLIGHT_DEV_PORT || 5173)
const url = `http://127.0.0.1:${port}`

if (!existsSync(viteBin)) {
  console.error('vite is not installed. Run `npm install` first.')
  process.exit(1)
}

const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: projectRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
})

let electron = null

function waitForPort(deadlineMs = 30000) {
  const started = Date.now()
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolvePromise()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started > deadlineMs) reject(new Error(`Vite did not start on ${url}`))
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

function shutdown(code = 0) {
  if (electron && !electron.killed) electron.kill()
  if (!vite.killed) vite.kill()
  process.exit(code)
}

vite.on('exit', (code) => {
  if (!electron) {
    console.error(`Vite exited early with code ${code}`)
    process.exit(code ?? 1)
  }
})

try {
  await waitForPort()
  console.log(`→ Vite ready at ${url}, launching Paperlight…`)
  electron = spawn(electronBin, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, PAPERLIGHT_DEV_SERVER_URL: url },
  })
  electron.on('exit', (code) => shutdown(code ?? 0))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  shutdown(1)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
