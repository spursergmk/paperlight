import { useMemo, type ReactNode } from 'react'
import { BookOpenCheck, Library, LoaderCircle, RotateCcw, Save, Search, Square } from 'lucide-react'
import type { ExistingLanguageMatch, ReaderAnalysisResult, TextSelection } from '../types'

function markedOriginal(text: string, matches: ExistingLanguageMatch[]) {
  if (!matches.length) return text
  const ordered = [...matches].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const pieces: ReactNode[] = []
  let cursor = 0
  ordered.forEach((match, index) => {
    if (match.start < cursor || match.end <= match.start) return
    if (match.start > cursor) pieces.push(text.slice(cursor, match.start))
    pieces.push(<mark key={`${match.start}-${index}`} className={`analysis-memory-match ${match.kind}`} title={`${match.kind === 'semantic' ? '已学语义' : '表达池'}：${match.meaning}`}>{text.slice(match.start, match.end)}</mark>)
    cursor = match.end
  })
  if (cursor < text.length) pieces.push(text.slice(cursor))
  return pieces
}

export default function AnalysisPanel({
  readerSelection,
  selection,
  result,
  instruction,
  loading,
  error,
  matches,
  onInstructionChange,
  onAnalyzeSelection,
  onAnalyzeCurrent,
  onRunInstruction,
  onCancel,
  onSourceSelection,
  onStartNestedQuery,
  onIdentifyMemory,
  onSave,
  saving,
  saved,
  onRetry,
  currentScopeLabel,
  canAnalyzeCurrent,
}: {
  readerSelection: TextSelection | null
  selection: TextSelection | null
  result: ReaderAnalysisResult | null
  instruction: string
  loading: boolean
  error: string
  matches: ExistingLanguageMatch[]
  onInstructionChange: (value: string) => void
  onAnalyzeSelection: () => void
  onAnalyzeCurrent: () => void
  onRunInstruction: () => void
  onCancel: () => void
  onSourceSelection: () => void
  onStartNestedQuery: () => void
  onIdentifyMemory: () => void
  onSave: () => void
  saving: boolean
  saved: boolean
  onRetry: () => void
  currentScopeLabel: string
  canAnalyzeCurrent: boolean
}) {
  const original = result?.source.text || ''
  const renderedOriginal = useMemo(() => markedOriginal(original, matches), [matches, original])
  return (
    <div className="analysis-panel" data-testid="analysis-panel">
      <section className="analysis-command-card">
        <div className="analysis-command-title">
          <BookOpenCheck size={15} />
          <div><strong>内容分析</strong><span>只分析当前可读取到的原文范围</span></div>
        </div>
        <div className="analysis-command-actions">
          <button type="button" className="secondary-button" disabled={!readerSelection || loading} onClick={onAnalyzeSelection} data-testid="analysis-selected-button">
            分析选区
          </button>
          <button type="button" className="secondary-button" disabled={!canAnalyzeCurrent || loading} onClick={onAnalyzeCurrent} data-testid="analysis-current-button">
            分析{currentScopeLabel}
          </button>
        </div>
        <label className="field-label" htmlFor="analysis-instruction">分析指令</label>
        <textarea
          id="analysis-instruction"
          className="analysis-instruction"
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          placeholder="例如：分析当前段落、总结选定内容、解释这段论证"
          rows={2}
          disabled={loading}
        />
        <div className="analysis-instruction-actions">
          {loading
            ? <button type="button" className="text-action" onClick={onCancel}><Square size={12} /> 停止分析</button>
            : <button type="button" className="primary-button" disabled={!canAnalyzeCurrent && !selection} onClick={onRunInstruction} data-testid="analysis-run-button">按指令分析</button>}
          <span>支持“当前段落”、PDF 页、EPUB 章节或指定文本范围；仅分析实际读取到的内容。</span>
        </div>
      </section>

      {loading && <div className="loading-copy"><LoaderCircle size={14} className="analysis-spinner" /> 正在翻译并分析原文…</div>}
      {error && !loading && <div className="analysis-error"><p>{error}</p><button type="button" className="text-action" onClick={onRetry}><RotateCcw size={12} /> 重试</button></div>}

      {result ? (
        <div className="analysis-result" data-analysis-id={result.id}>
          <section className="analysis-section analysis-source-section">
            <header><div><span className="section-kicker">SOURCE · {result.scopeLabel}</span><h3>完整原文</h3></div>
              <div className="analysis-source-actions">
                <button type="button" className="tiny-icon" title="识别本地语义库和表达池中的已有内容" onClick={onIdentifyMemory} data-testid="analysis-identify-button"><Library size={14} /></button>
                <button type="button" className="tiny-icon" title={saved ? '已保存到 Vault' : '保存完整分析'} onClick={onSave} disabled={saving || saved} data-testid="analysis-save-button">{saved ? <BookOpenCheck size={14} /> : <Save size={14} />}</button>
              </div>
            </header>
            <div className="analysis-original" data-testid="analysis-original" onMouseUp={onSourceSelection} onKeyUp={(event) => { if (event.key.startsWith('Arrow') || event.key === 'Shift') onSourceSelection() }} tabIndex={0}>
              {renderedOriginal}
            </div>
            <div className="analysis-source-footer">
              {matches.length > 0 && <span>{matches.length} 处本地积累 · 黄色为语义，蓝色为表达</span>}
              {selection?.text && <span className="analysis-selected-text">已选：{selection.text.slice(0, 100)}</span>}
              {selection?.text && <button type="button" className="text-action" onClick={onStartNestedQuery} data-testid="analysis-query-selection"><Search size={12} /> 将所选内容用于查询</button>}
            </div>
          </section>
          <section className="analysis-section">
            <span className="section-kicker">TRANSLATION</span><h3>段落直译</h3>
            <div className="analysis-prose" data-testid="analysis-translation">{result.translation}</div>
          </section>
          <section className="analysis-section">
            <span className="section-kicker">MEANING</span><h3>意义分析</h3>
            <div className="analysis-prose" data-testid="analysis-meaning">{result.meaning}</div>
          </section>
        </div>
      ) : (
        <div className="analysis-empty">
          <BookOpenCheck size={19} />
          <strong>分析会保留原文、直译和意义</strong>
          <span>{readerSelection ? `当前选区：${readerSelection.text.slice(0, 120)}` : '先选中内容，或分析当前阅读位置。'}</span>
        </div>
      )}
    </div>
  )
}
