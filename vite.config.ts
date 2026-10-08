import {
  existsSync, readdirSync, readFileSync, statSync,
} from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createPaperlightApi } from './server/api.mjs'

const PDFJS_ASSET_ROUTE = '/pdfjs-assets'
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const

// pdf.js loads CMaps, standard fonts, WASM decoders and ICC profiles as
// separate files at runtime. This plugin exposes them from node_modules in dev
// and copies them into the production bundle.
function pdfjsAssets(root: string): Plugin {
  const source = resolve(root, 'node_modules/pdfjs-dist')
  const contentType = (file: string) => {
    if (file.endsWith('.wasm')) return 'application/wasm'
    if (file.endsWith('.js') || file.endsWith('.txt') || file.endsWith('LICENSE')) return 'text/plain; charset=utf-8'
    return 'application/octet-stream'
  }
  const eachAsset = (visit: (dir: string, name: string, filePath: string) => void) => {
    for (const dir of PDFJS_ASSET_DIRS) {
      const dirPath = resolve(source, dir)
      if (!existsSync(dirPath)) continue
      for (const name of readdirSync(dirPath)) {
        const filePath = resolve(dirPath, name)
        if (statSync(filePath).isFile()) visit(dir, name, filePath)
      }
    }
  }

  return {
    name: 'paperlight-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use(PDFJS_ASSET_ROUTE, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        const requested = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
        const target = resolve(source, requested)
        if (relative(source, target).startsWith('..') || !existsSync(target) || !statSync(target).isFile()) {
          next()
          return
        }
        res.writeHead(200, {
          'Content-Type': contentType(target),
          'Cache-Control': 'no-cache',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(readFileSync(target))
      })
    },
    generateBundle() {
      eachAsset((dir, name, filePath) => {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_ASSET_ROUTE.slice(1)}/${dir}/${name}`,
          source: readFileSync(filePath),
        })
      })
    },
  }
}

// The packaged app sets this policy on its own static server. The dev server
// needs the same header, with the couple of relaxations Vite's client uses.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'paperlight-csp',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', DEV_CSP)
        next()
      })
    },
  }
}

// The AI proxy itself lives in server/api.mjs so the dev server and the
// packaged Electron app share exactly one implementation.
function localApi(root: string): Plugin {
  const api = createPaperlightApi({ root })
  return {
    name: 'paperlight-local-api',
    configureServer(server) {
      server.middlewares.use(api.middleware)
    },
  }
}

export default defineConfig(() => {
  const root = process.cwd()
  return {
    plugins: [react(), pdfjsAssets(root), contentSecurityPolicy(), localApi(root)],
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
    build: { target: 'es2022' },
  }
})
