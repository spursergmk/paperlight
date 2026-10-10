import type {
  LanguageQueryBundle, OptionalQueryTask, QueryModuleResult, ReaderAnalysisSource,
} from '../types'

async function postAssistant<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & Partial<T>
  if (!response.ok) throw new Error(payload.error || '阅读助手请求失败。')
  return payload as T
}

export async function queryLanguage(
  term: string,
  context: string,
  isSentence: boolean,
  model: string,
  signal?: AbortSignal,
): Promise<LanguageQueryBundle> {
  const result = await postAssistant<Partial<LanguageQueryBundle>>('/api/query', {
    task: 'default', term, context, isSentence, model,
  }, signal)
  const status = result.status || 'unable_to_determine'
  if (!['resolved', 'ambiguous', 'insufficient_context', 'unable_to_determine'].includes(status)) {
    throw new Error('语言查询返回了无法识别的状态。')
  }
  const modules = Array.isArray(result.modules) ? result.modules.filter((module): module is QueryModuleResult => (
    Boolean(module && typeof module.key === 'string' && typeof module.title === 'string' && typeof module.markdown === 'string')
  )) : []
  return {
    status,
    explanation: typeof result.explanation === 'string' ? result.explanation : '',
    ...(result.sense ? { sense: result.sense } : {}),
    modules,
  }
}

export async function queryOptionalModule(
  task: OptionalQueryTask,
  term: string,
  context: string,
  model: string,
  signal?: AbortSignal,
): Promise<QueryModuleResult> {
  const result = await postAssistant<{ modules?: QueryModuleResult[] }>('/api/query', {
    task, term, context, model,
  }, signal)
  const module = result.modules?.[0]
  if (!module?.markdown) throw new Error('没有收到这个查询模块的结果。')
  return module
}

export async function analyzePassage(
  source: ReaderAnalysisSource,
  instruction: string,
  scopeLabel: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ translation: string; meaning: string }> {
  const result = await postAssistant<Partial<{ translation: string; meaning: string }>>('/api/analysis', { source, instruction, scopeLabel, model }, signal)
  if (typeof result.translation !== 'string' || typeof result.meaning !== 'string') {
    throw new Error('段落分析未分别返回原文直译和意义说明。')
  }
  return { translation: result.translation, meaning: result.meaning }
}
