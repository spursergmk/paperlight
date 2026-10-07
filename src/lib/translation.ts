import type { TextSelection, TranslateMode } from '../types'

const demoTranslations = new Map<string, string>([
  ['the quick brown fox jumps over the lazy dog.', '敏捷的棕色狐狸跃过了懒狗。'],
  ['this paper introduces a simple and effective method.', '本文介绍了一种简单而有效的方法。'],
  ['the results demonstrate a significant improvement.', '结果表明，性能有了显著提升。'],
  ['in this section, we discuss the main findings.', '本节将讨论主要研究发现。'],
])

export interface ApiConfigStatus {
  configured: boolean
  source: 'environment' | 'local-file' | null
  baseUrl: string
  protocol: 'responses' | 'chat-completions'
  csrfNonce: string
}

// Mirrors the server-side rule so the settings panel can preview the protocol
// before saving. The server remains authoritative for the actual request.
export function protocolForBaseUrl(baseUrl: string): 'responses' | 'chat-completions' {
  try {
    return new URL(baseUrl).hostname === 'api.deepseek.com' ? 'chat-completions' : 'responses'
  } catch {
    return 'responses'
  }
}

async function readApiResponse<T>(response: Response): Promise<T> {
  let payload: { error?: string } & Partial<T> = {}
  try {
    payload = await response.json() as { error?: string } & Partial<T>
  } catch {
    if (response.ok) throw new Error('本地服务返回了无法识别的响应。')
  }
  if (!response.ok) throw new Error(payload.error || '本地 API 配置请求失败。')
  return payload as T
}

export async function getApiConfigStatus(): Promise<ApiConfigStatus> {
  const response = await fetch('/api/translation-config', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  return readApiResponse<ApiConfigStatus>(response)
}

export async function saveApiKey(apiKey: string, baseUrl: string, csrfNonce: string): Promise<ApiConfigStatus> {
  const response = await fetch('/api/translation-config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Paperlight-CSRF': csrfNonce,
    },
    body: JSON.stringify({ apiKey, baseUrl }),
  })
  return readApiResponse<ApiConfigStatus>(response)
}

export async function removeApiKey(csrfNonce: string): Promise<ApiConfigStatus> {
  const response = await fetch('/api/translation-config', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Paperlight-CSRF': csrfNonce,
    },
    body: '{}',
  })
  return readApiResponse<ApiConfigStatus>(response)
}

export async function translateSelection(
  selection: TextSelection,
  mode: TranslateMode,
  model: string,
): Promise<string> {
  if (mode === 'mock') {
    await new Promise((resolve) => window.setTimeout(resolve, 380))
    const normalized = selection.text.trim().toLowerCase().replace(/\s+/g, ' ')
    const exact = demoTranslations.get(normalized)
    if (exact) return exact
    return `（模拟译文）${selection.text.trim()}\n\n这是离线演示结果。切换到兼容 API 模式并配置密钥，即可获取实际中文翻译。`
  }

  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: selection.text,
      before: selection.before,
      after: selection.after,
      model,
    }),
  })
  const result = await response.json() as { translation?: string; error?: string }
  if (!response.ok) throw new Error(result.error || '翻译请求失败。')
  return result.translation || '未收到译文，请重试。'
}
