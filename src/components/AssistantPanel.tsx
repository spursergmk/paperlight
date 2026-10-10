import {
  Bookmark, BookOpen, Check, ChevronDown, FilePlus2, Languages, Library, Maximize2, Minimize2, Sparkles, Square,
  StickyNote, X,
} from 'lucide-react'
import SenseCard from './SenseCard'
import NotebookPanel from './NotebookPanel'
import ChatPanel from './ChatPanel'
import AnalysisPanel from './AnalysisPanel'
import QueryModulesPanel from './QueryModulesPanel'
import type {
  ChatMessage, ExistingLanguageMatch, LanguageQueryBundle, NotebookNote, OptionalQueryTask, QueryModuleResult,
  ReaderAnalysisResult, SenseAtom, SensePayload, SenseSummary, TextSelection,
} from '../types'
import type { SenseRelation } from '../types'

export type AssistantTab = 'sense' | 'notebook' | 'chat'
export type AssistantMode = 'query' | 'analysis'

export default function AssistantPanel({
  mode,
  onMode,
  analysisResult,
  analysisSelection,
  analysisInstruction,
  analysisLoading,
  analysisError,
  analysisMatches,
  onAnalysisInstruction,
  onAnalyzeSelection,
  onAnalyzeCurrent,
  onRunAnalysisInstruction,
  onCancelAnalysis,
  onAnalysisSourceSelection,
  onStartNestedQuery,
  onIdentifyMemory,
  onSaveAnalysis,
  analysisSaving,
  analysisSaved,
  onRetryAnalysis,
  analysisScopeLabel,
  canAnalyzeCurrent,
  nestedAnalysis,
  onReturnToAnalysis,
  queryStatus,
  queryExplanation,
  expandedContextAvailable,
  onRetryExpandedContext,
  queryModules,
  optionalModuleLoading,
  onOptionalModule,
  onCancelOptionalModule,
  onSaveQueryModule,
  onSaveDictionaryLinks,
  dictionaryLinksSaved,
  onSaveQueryExpression,
  savedQueryModuleKeys,
  savedQueryExpressionKeys,
  tab,
  onTab,
  wide,
  onToggleWide,
  onCollapse,
  queryTerm,
  onQueryTerm,
  onQuery,
  onCancelQuery,
  sense,
  senseLoading,
  senseError,
  allSenses,
  expanding,
  onExpand,
  onCancelExpand,
  translation,
  translationLoading,
  translationError,
  onTranslate,
  onCancelTranslation,
  selection,
  senseInNotebook,
  semanticMergeCandidates,
  relations,
  onAddSense,
  onConfirmSemanticMerge,
  onKeepSeparateSemantic,
  onCancelSemanticMerge,
  model,
  onJumpToAtom,
  atoms,
  notes,
  activeAtomId,
  onSelectAtom,
  onDeleteAtom,
  onAddNote,
  onDeleteNote,
  chatMessages,
  savedMessageIds,
  chatSending,
  onCancelChat,
  chatError,
  onSend,
  onSaveExcerpt,
  onSaveReaderMessage,
  onOpenSavedReaderAnswer,
  readerAnswerSavedPath,
  onSaveReaderAnswer,
  onSaveSense,
  onRetrySense,
  vaultReady,
  vaultRootName,
  vaultBusy,
  vaultMessage,
  onOpenNotesSpace,
  onSaveSenseToVault,
  onGenerateCompleteNote,
  completeNoteGenerating,
  onCancelCompleteNote,
  onSaveNoteToVault,
  vaultTarget,
}: {
  mode: AssistantMode
  onMode: (mode: AssistantMode) => void
  analysisResult: ReaderAnalysisResult | null
  analysisSelection: TextSelection | null
  analysisInstruction: string
  analysisLoading: boolean
  analysisError: string
  analysisMatches: ExistingLanguageMatch[]
  onAnalysisInstruction: (value: string) => void
  onAnalyzeSelection: () => void
  onAnalyzeCurrent: () => void
  onRunAnalysisInstruction: () => void
  onCancelAnalysis: () => void
  onAnalysisSourceSelection: () => void
  onStartNestedQuery: () => void
  onIdentifyMemory: () => void
  onSaveAnalysis: () => void
  analysisSaving: boolean
  analysisSaved: boolean
  onRetryAnalysis: () => void
  analysisScopeLabel: string
  canAnalyzeCurrent: boolean
  nestedAnalysis: boolean
  onReturnToAnalysis: () => void
  queryStatus: 'idle' | LanguageQueryBundle['status']
  queryExplanation: string
  expandedContextAvailable: boolean
  onRetryExpandedContext: () => void
  queryModules: QueryModuleResult[]
  optionalModuleLoading: boolean
  onOptionalModule: (task: OptionalQueryTask) => void
  onCancelOptionalModule: () => void
  onSaveQueryModule: (module: QueryModuleResult) => void
  onSaveDictionaryLinks: () => void
  dictionaryLinksSaved: boolean
  onSaveQueryExpression: (expression: NonNullable<QueryModuleResult['expressions']>[number], module: QueryModuleResult) => void
  savedQueryModuleKeys: Set<string>
  savedQueryExpressionKeys: Set<string>
  tab: AssistantTab
  onTab: (tab: AssistantTab) => void
  wide: boolean
  onToggleWide: () => void
  onCollapse: () => void
  queryTerm: string
  onQueryTerm: (value: string) => void
  onQuery: () => void
  onCancelQuery: () => void
  sense: SensePayload | null
  senseLoading: boolean
  senseError: string
  allSenses: SenseSummary[] | null
  expanding: boolean
  onExpand: () => void
  onCancelExpand: () => void
  translation: string
  translationLoading: boolean
  translationError: string
  onTranslate: () => void
  onCancelTranslation: () => void
  selection: TextSelection | null
  senseInNotebook: boolean
  semanticMergeCandidates: SenseAtom[]
  relations: SenseRelation[]
  onAddSense: () => void
  onConfirmSemanticMerge: (semanticId: string) => void
  onKeepSeparateSemantic: () => void
  onCancelSemanticMerge: () => void
  model: string
  onJumpToAtom: (id: string) => void
  atoms: SenseAtom[]
  notes: NotebookNote[]
  activeAtomId: string | null
  onSelectAtom: (id: string | null) => void
  onDeleteAtom: (id: string) => void
  onAddNote: (body: string) => void
  onDeleteNote: (id: string) => void
  chatMessages: ChatMessage[]
  savedMessageIds: Set<string>
  chatSending: boolean
  onCancelChat: () => void
  chatError: string
  onSend: (question: string) => void
  onSaveExcerpt: (message: ChatMessage) => void
  onSaveReaderMessage: (message: ChatMessage) => void
  onOpenSavedReaderAnswer: (path: string) => void
  readerAnswerSavedPath: string | null
  onSaveReaderAnswer: () => void
  onSaveSense: () => void
  onRetrySense: () => void
  vaultReady: boolean
  vaultRootName: string
  vaultBusy: boolean
  vaultMessage: { kind: 'success' | 'error'; text: string } | null
  onOpenNotesSpace: () => void
  onSaveSenseToVault: () => void
  onGenerateCompleteNote: () => void
  completeNoteGenerating: boolean
  onCancelCompleteNote: () => void
  onSaveNoteToVault: (note: NotebookNote) => void
  /** Vault folder the reading session writes to, e.g. `notes/books/book1`. */
  vaultTarget: string
}) {
  return (
    <aside className="right-sidebar" data-expression-source="assistant" data-expression-name="阅读助手">
      <div className="right-heading">
        <div>
          <span className="right-kicker">READING DESK</span>
          <h2>阅读助手</h2>
        </div>
        <div className="right-heading-actions">
          <button type="button" className="tiny-icon" title={`打开笔记空间（${vaultRootName}）`} onClick={onOpenNotesSpace}>
            <Library size={14} />
          </button>
          <button
            type="button"
            className="tiny-icon"
            title={wide ? '恢复助手宽度' : '加宽助手（给查询、追问、笔记更多空间）'}
            onClick={onToggleWide}
          >
            {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" className="tiny-icon" title="收起侧栏" onClick={onCollapse}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="assistant-activity-switch" role="tablist" aria-label="阅读助手活动">
        <button type="button" className={mode === 'query' ? 'selected' : ''} onClick={() => onMode('query')} data-testid="assistant-mode-query"><Languages size={13} /> 语言查询</button>
        <button type="button" className={mode === 'analysis' ? 'selected' : ''} onClick={() => onMode('analysis')} data-testid="assistant-mode-analysis"><BookOpen size={13} /> 内容分析</button>
      </div>

      {mode === 'analysis' ? (
        <AnalysisPanel
          readerSelection={selection}
          selection={analysisSelection}
          result={analysisResult}
          instruction={analysisInstruction}
          loading={analysisLoading}
          error={analysisError}
          matches={analysisMatches}
          onInstructionChange={onAnalysisInstruction}
          onAnalyzeSelection={onAnalyzeSelection}
          onAnalyzeCurrent={onAnalyzeCurrent}
          onRunInstruction={onRunAnalysisInstruction}
          onCancel={onCancelAnalysis}
          onSourceSelection={onAnalysisSourceSelection}
          onStartNestedQuery={onStartNestedQuery}
          onIdentifyMemory={onIdentifyMemory}
          onSave={onSaveAnalysis}
          saving={analysisSaving}
          saved={analysisSaved}
          onRetry={onRetryAnalysis}
          currentScopeLabel={analysisScopeLabel}
          canAnalyzeCurrent={canAnalyzeCurrent}
        />
      ) : <>
      <div className="right-tabs">
        <button type="button" className={tab === 'sense' ? 'selected' : ''} onClick={() => onTab('sense')}><Languages size={14} /> 语义</button>
        <button type="button" className={tab === 'notebook' ? 'selected' : ''} onClick={() => onTab('notebook')}>
          <StickyNote size={14} /> 记录本{atoms.length > 0 && <span className="notes-count">{atoms.length}</span>}
        </button>
        <button type="button" className={tab === 'chat' ? 'selected' : ''} onClick={() => onTab('chat')}>
          <BookOpen size={14} /> 对话{chatMessages.length > 0 && <span className="notes-count">{chatMessages.length}</span>}
        </button>
      </div>

      {tab === 'sense' && (
        <div className="translation-panel">
          {nestedAnalysis && <button type="button" className="analysis-return-button" onClick={onReturnToAnalysis} data-testid="analysis-return-button">← 返回段落分析</button>}
          <div className="query-row">
            <label className="field-label" htmlFor="query-term">查询内容（可键盘修改）</label>
            <div className="query-input-wrap">
              <input
                id="query-term"
                className="text-field"
                value={queryTerm}
                spellCheck={false}
                placeholder="如 within"
                onChange={(event) => onQueryTerm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onQuery()
                }}
              />
              <button
                type="button"
                className="query-go"
                disabled={senseLoading || !queryTerm.trim()}
                onClick={onQuery}
              >
                查询
              </button>
            </div>
            {selection && <span className="query-meta">来自「{selection.documentName || '当前文档'}」{selection.locationLabel || `第 ${selection.pageNumber} 页/章`} 的选区 · 点击查询或按 Enter 开始</span>}
            {selection?.contextText && <span className="query-context-meta">默认上下文包含选中行上下各 5 个原文单位；不受屏幕视觉换行影响。</span>}
          </div>

          {senseLoading && <div className="loading-copy"><span className="mini-spinner" /> 正在一次整理语境语义、句法与用法… <button type="button" className="text-action" aria-label="停止语义查询" onClick={onCancelQuery}><Square size={12} /> 停止</button></div>}

          {senseError && !senseLoading && (
            <div className="panel-error">
              <p>{senseError}</p>
              <button className="text-action" type="button" onClick={onRetrySense}>重试</button>
            </div>
          )}

          {sense && !senseLoading && (
            <>
              {semanticMergeCandidates.length > 0 && (
                <section className="semantic-merge-review" aria-label="确认语义整合" role="group">
                  <h4>这个词已有语义记录</h4>
                  <p>本次结果的 AI 标识不同。选择一个已有语义来积累新语境，或保留为不同语义；已有解释不会被覆盖。</p>
                  <div className="semantic-merge-options">
                    {semanticMergeCandidates.map((candidate) => (
                      <article className="semantic-merge-candidate" key={candidate.id}>
                        <div>
                          <strong>{candidate.contextualMeaning}</strong>
                          <span>{candidate.partOfSpeech} · {candidate.senseId}</span>
                          <p>{candidate.definition}</p>
                        </div>
                        <button type="button" className="secondary-button" onClick={() => onConfirmSemanticMerge(candidate.id)}>合并语境</button>
                      </article>
                    ))}
                  </div>
                  <footer>
                    <button type="button" className="text-action" onClick={onKeepSeparateSemantic}>作为不同语义收录</button>
                    <button type="button" className="text-action" onClick={onCancelSemanticMerge}>取消</button>
                  </footer>
                </section>
              )}

              <SenseCard
                sense={sense}
                model={model}
                showGuidance={false}
                added={senseInNotebook}
                relations={relations}
                onAdd={onAddSense}
                onJumpToAtom={onJumpToAtom}
              />

              <div className="sense-actions">
                <button className="text-action" type="button" onClick={expanding ? onCancelExpand : onExpand}>
                  {expanding ? <><Square size={12} /> 停止获取</> : allSenses ? '重新获取全部语义' : '查看这个词的其他语义'}
                </button>
                <button className="text-action" type="button" onClick={() => onTab('chat')}>继续和 Agent 对话</button>
              </div>

              {allSenses && allSenses.length > 0 && (
                <section className="sense-block all-senses">
                  <h4>{sense.lemma} 的其他语义（{allSenses.length}）</h4>
                  <ul className="all-sense-list">
                    {allSenses.map((item) => (
                      <li key={item.senseId} className={item.isContextual ? 'current' : ''}>
                        <strong>{item.partOfSpeech} · {item.senseId}{item.isContextual ? '（当前上下文）' : ''}</strong>
                        <p>{item.meaning}</p>
                        <span>{item.definition}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="sense-plain">以上语义同样由 AI 生成，不是授权词典内容，请自行核对。</p>
                </section>
              )}

              <details className="context-details">
                <summary>整句翻译参考 <ChevronDown size={13} /></summary>
                {translationLoading ? <div className="loading-copy"><span className="mini-spinner" /> 正在翻译… <button type="button" className="text-action" aria-label="停止翻译" onClick={onCancelTranslation}><Square size={12} /> 停止</button></div>
                  : translationError ? <p className="panel-error-text">{translationError}</p>
                    : translation ? <p>{translation}</p>
                      : selection ? <button className="text-action" type="button" onClick={onTranslate}>翻译选中内容</button>
                        : <p className="sense-plain">先在正文中选中文字。</p>}
              </details>

              <button className="save-note-button" type="button" onClick={onSaveSense}>
                <Bookmark size={15} /> 把这条语义存成笔记
              </button>

              <div className="vault-action-row">
                <button
                  className="vault-button"
                  type="button"
                  disabled={vaultBusy || (!readerAnswerSavedPath && !vaultReady)}
                  title={readerAnswerSavedPath ? `打开已保存的完整回答：${readerAnswerSavedPath}` : '把当前阅读助手的完整初次回答保存到 notes/inbox'}
                  onClick={() => readerAnswerSavedPath ? onOpenSavedReaderAnswer(readerAnswerSavedPath) : onSaveReaderAnswer()}
                >
                  {readerAnswerSavedPath ? <Check size={13} /> : <FilePlus2 size={13} />}
                  {readerAnswerSavedPath ? '已存完整回答 · 打开' : '完整回答存入 inbox'}
                </button>
                <button
                  className="vault-button"
                  type="button"
                  disabled={vaultBusy}
                  title={vaultReady ? `把这条语义写成 Markdown 存进 ${vaultRootName}` : '先在笔记空间里选择 vault 文件夹'}
                  onClick={onSaveSenseToVault}
                >
                  <Library size={13} /> 语义存入 vault
                </button>
                <button
                  className="vault-button"
                  type="button"
                  disabled={vaultBusy || !vaultReady}
                  title="让 AI 把这条语义写成一份结构完整的学习笔记，存进 vault"
                  onClick={onGenerateCompleteNote}
                >
                  <Sparkles size={13} /> 生成 AI 完整笔记
                </button>
              </div>
              {vaultBusy && <p className="loading-copy"><span className="mini-spinner" /> {completeNoteGenerating ? '正在生成完整笔记…' : '正在写入 vault…'} {completeNoteGenerating && <button type="button" className="text-action" aria-label="停止笔记生成" onClick={onCancelCompleteNote}><Square size={12} /> 停止</button>}</p>}
              {vaultMessage && <p className={`api-config-message ${vaultMessage.kind}`} role="status">{vaultMessage.text}</p>}
              {!vaultReady && <p className="vault-hint">还没有选择笔记 vault：点右上角 <Library size={11} /> 进入笔记空间选择文件夹。</p>}
              {vaultReady && <p className="vault-hint"><Library size={11} /> 这条阅读会话的语义与笔记会存到 <code>{vaultTarget}/</code></p>}
            </>
          )}

          {queryTerm.trim() && <QueryModulesPanel
            term={queryTerm}
            status={queryStatus}
            explanation={queryExplanation}
            expandedContextAvailable={expandedContextAvailable}
            onRetryExpanded={onRetryExpandedContext}
            modules={queryModules}
            optionalLoading={optionalModuleLoading}
            onOptionalModule={onOptionalModule}
            onCancelOptional={onCancelOptionalModule}
            onSaveModule={onSaveQueryModule}
            onSaveDictionaries={onSaveDictionaryLinks}
            dictionariesSaved={dictionaryLinksSaved}
            onSaveExpression={onSaveQueryExpression}
            savedModuleKeys={savedQueryModuleKeys}
            savedExpressionKeys={savedQueryExpressionKeys}
          />}

          {!sense && !senseLoading && !senseError && (
            <div className="translation-empty">
              <div><Languages size={20} /></div>
              <strong>选中一个词</strong>
              <span>会结合上下文给出准确的语义、例句、<br />使用建议与词根词缀分析。</span>
            </div>
          )}
        </div>
      )}

      {tab === 'notebook' && <NotebookPanel
        atoms={atoms}
        notes={notes}
        activeAtomId={activeAtomId}
        model={model}
        vaultReady={vaultReady}
        vaultRootName={vaultRootName}
        onSelectAtom={onSelectAtom}
        onDeleteAtom={onDeleteAtom}
        onAddNote={onAddNote}
        onDeleteNote={onDeleteNote}
        onSaveToVault={onSaveNoteToVault}
        onOpenNotesSpace={onOpenNotesSpace}
      />}

      {tab === 'chat' && <ChatPanel
        sense={sense}
        model={model}
        messages={chatMessages}
        sending={chatSending}
        onCancel={onCancelChat}
        error={chatError}
        savedMessageIds={savedMessageIds}
        onSend={onSend}
        onSaveExcerpt={onSaveExcerpt}
        onSaveReaderMessage={onSaveReaderMessage}
        onOpenSavedAnswer={onOpenSavedReaderAnswer}
        vaultReady={vaultReady}
        vaultBusy={vaultBusy}
        onOpenNotebook={() => onTab('notebook')}
      />}
      </>}
    </aside>
  )
}
