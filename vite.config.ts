import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function readLocalKey(root: string): string | undefined {
  const envPath = resolve(root, '.env.local')
  try {
    const contents = readFileSync(envPath, 'utf8')
    const match = contents.match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/m)
    return match?.[1]?.replace(/^['"]|['"]$/g, '')
  } catch {
    return undefined
  }
}

function translationProxy(root: string): Plugin {
  return {
    name: 'paperlight-local-translation-proxy',
    configureServer(server) {
      server.middlewares.use('/api/translate', async (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.method !== 'POST') return next()

        try {
          const chunks: Buffer[] = []
          let bytes = 0
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bytes += buffer.length
            if (bytes > 64_000) {
              res.writeHead(413, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: '请求内容过长。' }))
              return
            }
            chunks.push(buffer)
          }

          const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            text?: unknown
            before?: unknown
            after?: unknown
            model?: unknown
          }
          const text = typeof input.text === 'string' ? input.text.trim() : ''
          if (!text || text.length > 12_000) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: '请选择不超过 12,000 个字符的文本。' }))
            return
          }

          const key = process.env.OPENAI_API_KEY || readLocalKey(root)
          if (!key) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: '未找到 API 密钥。请在项目根目录的 .env.local 中设置 OPENAI_API_KEY。' }))
            return
          }

          const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : 'gpt-5-mini'
          const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              instructions: 'You are a careful English-to-Chinese translator. Translate the selected English text into clear, natural Simplified Chinese. Use the surrounding text only to resolve meaning and references. Preserve names, numbers, citations, and technical terms where appropriate. Return only the translation, with no preface or explanation.',
              input: JSON.stringify({
                preceding_context: typeof input.before === 'string' ? input.before.slice(-700) : '',
                selected_text: text,
                following_context: typeof input.after === 'string' ? input.after.slice(0, 700) : '',
              }),
            }),
          })

          const payload = await response.json() as {
            output_text?: string
            error?: { message?: string }
          }
          if (!response.ok) {
            res.writeHead(response.status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: payload.error?.message || '翻译请求未成功。' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ translation: payload.output_text?.trim() || '未收到译文，请重试。' }))
        } catch (error) {
          const message = error instanceof Error ? error.message : '翻译请求失败。'
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: message }))
        }
      })
    },
  }
}

export default defineConfig(() => {
  const root = process.cwd()
  return {
    plugins: [react(), translationProxy(root)],
    server: { host: '127.0.0.1' },
  }
})
