import { Check, ExternalLink, LoaderCircle, Plus, Save, Sparkles } from 'lucide-react'
import MarkdownPreview from './MarkdownPreview'
import { dictionaryEntryUrl } from '../lib/dictionaries'
import type { LanguageQueryBundle, OptionalQueryTask, QueryModuleResult } from '../types'

export default function QueryModulesPanel({
  term,
  status,
  explanation,
  expandedContextAvailable,
  onRetryExpanded,
  modules,
  optionalLoading,
  onOptionalModule,
  onCancelOptional,
  onSaveModule,
  onSaveDictionaries,
  dictionariesSaved,
  onSaveExpression,
  savedModuleKeys,
  savedExpressionKeys,
}: {
  term: string
  status: 'idle' | LanguageQueryBundle['status']
  explanation: string
  expandedContextAvailable: boolean
  onRetryExpanded: () => void
  modules: QueryModuleResult[]
  optionalLoading: boolean
  onOptionalModule: (task: OptionalQueryTask) => void
  onCancelOptional: () => void
  onSaveModule: (module: QueryModuleResult) => void
  onSaveDictionaries: () => void
  dictionariesSaved: boolean
  onSaveExpression: (expression: NonNullable<QueryModuleResult['expressions']>[number], module: QueryModuleResult) => void
  savedModuleKeys: Set<string>
  savedExpressionKeys: Set<string>
}) {
  return (
    <section className="query-modules" aria-label="模块化语言查询">
      <section className="query-dictionaries" data-module="dictionary">
        <header><div><span className="section-kicker">DICTIONARY</span><h4>经典词典</h4></div>
          <button type="button" className="tiny-icon" title={dictionariesSaved ? '词典入口已保存到 Vault' : '保存这两个词典入口'} onClick={onSaveDictionaries} disabled={dictionariesSaved} data-testid="save-dictionary-links">
            {dictionariesSaved ? <Check size={13} /> : <Save size={13} />}
          </button>
        </header>
        <p>打开官方词典词条；词典内容不会被复制到 Paperlight。</p>
        <div>
          <a href={dictionaryEntryUrl('oxford', term)} target="_blank" rel="noreferrer noopener" data-testid="dictionary-oxford">Oxford Advanced Learner’s <ExternalLink size={11} /></a>
          <a href={dictionaryEntryUrl('collins', term)} target="_blank" rel="noreferrer noopener" data-testid="dictionary-collins">Collins COBUILD <ExternalLink size={11} /></a>
        </div>
      </section>

      {status !== 'idle' && status !== 'resolved' && (
        <div className={`query-resolution ${status}`} role="status" data-testid={`query-status-${status}`}>
          <strong>{status === 'ambiguous' ? '这个词在当前语境中仍有歧义'
            : status === 'insufficient_context' ? '当前上下文不足以可靠判断'
              : '模型暂时无法判断这个语义'}</strong>
          {explanation && <p>{explanation}</p>}
          {status === 'insufficient_context' && (
            <button type="button" className="text-action" disabled={!expandedContextAvailable} onClick={onRetryExpanded} data-testid="query-expanded-context">
              <Sparkles size={12} /> {expandedContextAvailable ? '用更大范围重试一次' : '当前没有更多原文可扩展'}
            </button>
          )}
        </div>
      )}

      {modules.map((module) => (
        <article key={module.key} className="query-module-card" data-module={module.key} data-testid={`query-module-${module.key}`}>
          <header><div><span className="section-kicker">{module.key === 'usage' ? 'USAGE · MODEL KNOWLEDGE' : module.key.toUpperCase()}</span><h4>{module.title}</h4></div>
            <button type="button" className="tiny-icon" title={savedModuleKeys.has(module.key) ? '已存入 Vault' : '保存此模块结果'} onClick={() => onSaveModule(module)} disabled={savedModuleKeys.has(module.key)} data-testid={`save-module-${module.key}`}>
              <Save size={13} />
            </button>
          </header>
          {module.key === 'usage' && <p className="query-module-origin">基于模型语言知识的建议，不是语料库频率统计。</p>}
          {module.markdown && <MarkdownPreview markdown={module.markdown} className="query-module-body" />}
          {module.expressions && module.expressions.length > 0 && (
            <div className="query-expression-list">
              <h5>可收录表达</h5>
              {module.expressions.map((expression, index) => {
                const key = `${module.key}:${expression.expression.toLocaleLowerCase()}`
                return <div className="query-expression-item" key={`${key}-${index}`}>
                  <div><strong>{expression.expression}</strong>{expression.meaning && <span>{expression.meaning}</span>}{expression.usageScenario && <small>{expression.usageScenario}</small>}</div>
                  <button type="button" className="tiny-icon" title="收录到表达池" onClick={() => onSaveExpression(expression, module)} disabled={savedExpressionKeys.has(key)} data-testid={`save-expression-${index}`}>
                    {savedExpressionKeys.has(key) ? <span>已收录</span> : <><Plus size={13} /> 收录</>}
                  </button>
                </div>
              })}
            </div>
          )}
        </article>
      ))}

      <section className="query-optional-modules">
        <header><div><span className="section-kicker">ON DEMAND</span><h4>按需展开</h4></div>
          {optionalLoading && <div className="query-optional-status"><LoaderCircle className="analysis-spinner" size={14} /><button type="button" className="text-action" onClick={onCancelOptional}>停止</button></div>}
        </header>
        <div className="query-optional-buttons">
          <button type="button" onClick={() => onOptionalModule('syntax')} disabled={optionalLoading || !term.trim()}>分析语法</button>
          <button type="button" onClick={() => onOptionalModule('synonyms')} disabled={optionalLoading || !term.trim()}>对比近义词</button>
          <button type="button" onClick={() => onOptionalModule('scenario-pack')} disabled={optionalLoading || !term.trim()}>生成场景表达包</button>
          <button type="button" onClick={() => onOptionalModule('background')} disabled={optionalLoading || !term.trim()}>解释背景知识</button>
        </div>
      </section>
    </section>
  )
}
