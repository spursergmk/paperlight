import type { ExpressionCandidate } from '../types'

export async function exploreExpressions(input: {
  mode: 'intent' | 'related'
  intent?: string
  expression?: string
  context?: string
  model: string
}): Promise<ExpressionCandidate[]> {
  const response = await fetch('/api/expression-explore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string; candidates?: unknown }
  if (!response.ok) throw new Error(payload.error || '表达探索失败。')
  if (!Array.isArray(payload.candidates)) return []
  return payload.candidates.flatMap((value): ExpressionCandidate[] => {
    if (!value || typeof value !== 'object') return []
    const candidate = value as Partial<ExpressionCandidate>
    if (typeof candidate.expression !== 'string' || !candidate.expression.trim()) return []
    return [{
      expression: candidate.expression.trim(),
      meaning: typeof candidate.meaning === 'string' ? candidate.meaning : '',
      usageScenario: typeof candidate.usageScenario === 'string' ? candidate.usageScenario : '',
      relation: typeof candidate.relation === 'string' ? candidate.relation : '',
    }]
  })
}
