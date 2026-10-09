import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, ChevronRight, CircleHelp, FileText, Link2, Plus, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import type { ExpressionCandidate, ExpressionContext, ExpressionRelationKind, NotebookNote, SenseAtom } from '../types'
import { exploreExpressions } from '../lib/expression-ai'
import { parseNote } from '../lib/vault'
import type { VaultApi } from './useVault'
import SpaceRail from './SpaceRail'

interface SearchHit {
  kind: 'expression' | 'semantic' | 'notebook' | 'note'
  id: string
  title: string
  body: string
  path?: string
}

const RELATION_LABELS: Record<ExpressionRelationKind, string> = {
  variant: '变体',
  alternative: '替代说法',
  similar: '相近表达',
  contrast: '语气对照',
  collocation: '常见搭配',
  used_with: '一起使用',
}

export default function ExpressionSpace({
  vault, semantics, notebookNotes, model, onSwitchSpace, onOpenSemantic, onOpenSource,
}: {
  vault: VaultApi
  semantics: SenseAtom[]
  notebookNotes: NotebookNote[]
  model: string
  onSwitchSpace: (space: import('../types').AppSpace) => void
  onOpenSemantic: (id: string) => void
  onOpenSource: (context: ExpressionContext) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchDone, setSearchDone] = useState(false)
  const [form, setForm] = useState<{ expression: string; meaning: string; note: string } | null>(null)
  const [editForm, setEditForm] = useState<{ expression: string; meaning: string; note: string } | null>(null)
  const [exploreMode, setExploreMode] = useState<'intent' | 'related' | null>(null)
  const [explorePrompt, setExplorePrompt] = useState('')
  const [candidates, setCandidates] = useState<ExpressionCandidate[]>([])
  const [exploring, setExploring] = useState(false)
  const [capturedCandidate, setCapturedCandidate] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [relationTarget, setRelationTarget] = useState('')
  const [relationKind, setRelationKind] = useState<ExpressionRelationKind>('similar')
  const cache = useRef(new Map<string, { signature: string; text: string }>())

  const records = vault.expressions
  const selected = records.find((item) => item.id === selectedId) || records[0] || null
  const normalizedQuery = query.trim().toLocaleLowerCase('en')
  const visibleRecords = useMemo(() => {
    if (!normalizedQuery) return records
    return records.filter((record) => [
      record.expression, record.meaning, record.note,
      ...record.contexts.flatMap((context) => [context.quote || '', context.sourceName || '', context.usageScenario || '']),
    ].join('\n').toLocaleLowerCase('en').includes(normalizedQuery))
  }, [normalizedQuery, records])

  useEffect(() => {
    if (!selectedId && records.length) setSelectedId(records[0]!.id)
    if (selectedId && !records.some((record) => record.id === selectedId)) setSelectedId(records[0]?.id || null)
  }, [records, selectedId])

  useEffect(() => {
    if (!normalizedQuery || !vault.ready) {
      setSearchHits([])
      setSearchError('')
      setSearchDone(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearching(true)
        setSearchError('')
        setSearchDone(false)
        try {
          const hits: SearchHit[] = []
          for (const record of records) {
            if ([record.expression, record.meaning, record.note, ...record.contexts.map((item) => item.quote || '')]
              .join('\n').toLocaleLowerCase('en').includes(normalizedQuery)) {
              hits.push({ kind: 'expression', id: record.id, title: record.expression, body: record.meaning || record.note })
            }
          }
          for (const semantic of semantics) {
            const body = [semantic.contextualMeaning, semantic.definition, semantic.contextSentence,
              ...semantic.examples.map((item) => item.text), ...semantic.guidance.advice].join('\n')
            if ([semantic.term, semantic.lemma, body].join('\n').toLocaleLowerCase('en').includes(normalizedQuery)) {
              hits.push({ kind: 'semantic', id: semantic.id, title: `${semantic.term} · ${semantic.contextualMeaning}`, body })
            }
          }
          for (const note of notebookNotes) {
            if (note.body.toLocaleLowerCase('en').includes(normalizedQuery)) {
              hits.push({ kind: 'notebook', id: note.id, title: `${note.date} 第 ${note.dailyOrdinal} 份笔记`, body: note.body })
            }
          }
          const files = vault.files.filter((file) => /\.(?:md|markdown)$/i.test(file.path))
          let cursor = 0
          let noteHitCount = 0
          const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
            while (!cancelled) {
              const index = cursor++
              const file = files[index]
              if (!file) return
              const signature = `${file.size}:${file.mtimeMs}`
              let text = cache.current.get(file.path)?.signature === signature ? cache.current.get(file.path)!.text : ''
              if (!text) {
                try {
                  text = await vault.readNote(file.path)
                  cache.current.set(file.path, { signature, text })
                } catch { continue }
              }
              if (text.toLocaleLowerCase('en').includes(normalizedQuery)) {
                noteHitCount += 1
                if (noteHitCount <= 100) {
                  const parsed = parseNote(text)
                  const title = typeof parsed.data.title === 'string' ? parsed.data.title : file.path
                  const index = parsed.body.toLocaleLowerCase('en').indexOf(normalizedQuery)
                  const body = parsed.body.slice(Math.max(0, index - 90), Math.min(parsed.body.length, index + 240)).replace(/\s+/g, ' ')
                  hits.push({ kind: 'note', id: file.path, title, body, path: file.path })
                }
              }
            }
          })
          await Promise.all(workers)
          if (cancelled) return
          setSearchHits(hits)
          setSearchDone(true)
          if (noteHitCount > 100) setSearchError(`笔记结果超过 100 条，当前显示前 100 条；表达与语义仍全部检索。`)
        } catch (error) {
          if (!cancelled) setSearchError(error instanceof Error ? error.message : '本地检索失败。')
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [normalizedQuery, records, semantics, notebookNotes, vault.files, vault.ready, vault.readNote])

  const saveManual = async () => {
    if (!form?.expression.trim()) return
    try {
      const record = await vault.captureExpression({ ...form, cognitivePath: 'manual' })
      setSelectedId(record.id)
      setForm(null)
      setNotice('表达已收录到 Vault Markdown。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '表达收录失败。') }
  }

  const saveEdit = async () => {
    if (!selected || !editForm) return
    try {
      await vault.updateExpression(selected.id, editForm)
      setEditForm(null)
      setNotice('表达记录已更新。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '表达更新失败。') }
  }

  const runExplore = async () => {
    if (!exploreMode || !explorePrompt.trim()) return
    setExploring(true)
    setCandidates([])
    setCapturedCandidate([])
    setNotice('')
    try {
      const next = await exploreExpressions({
        mode: exploreMode,
        ...(exploreMode === 'intent' ? { intent: explorePrompt } : { expression: explorePrompt }),
        model,
      })
      setCandidates(next)
      if (!next.length) setNotice('暂时没有候选表达，请换一种问法。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '表达探索失败。') }
    finally { setExploring(false) }
  }

  const saveCandidate = async (candidate: ExpressionCandidate) => {
    try {
      const record = await vault.captureExpression({
        expression: candidate.expression,
        meaning: candidate.meaning,
        cognitivePath: 'exploration',
        context: {
          sourceKind: 'ai_exploration',
          sourceName: 'AI 表达探索',
          generated: true,
          usageScenario: [candidate.usageScenario, candidate.relation].filter(Boolean).join(' · '),
        },
      })
      setCapturedCandidate((current) => [...current, candidate.expression])
      setSelectedId(record.id)
      setNotice('候选已由你确认并收录；记录保留 AI 生成来源。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '候选收录失败。') }
  }

  const saveRelation = async () => {
    if (!selected || !relationTarget) return
    try {
      await vault.relateExpressions(selected.id, relationTarget, relationKind)
      setRelationTarget('')
      setNotice('相关表达已双向关联。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '关联失败。') }
  }

  const removeSelected = async () => {
    if (!selected || !window.confirm(`从表达池删除「${selected.expression}」及其记录的语境？`)) return
    try {
      await vault.deleteExpression(selected.id)
      setSelectedId(null)
      setNotice('表达记录已删除。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '删除失败。') }
  }

  const activateHit = (hit: SearchHit) => {
    if (hit.kind === 'expression') setSelectedId(hit.id)
    else if (hit.kind === 'semantic') onOpenSemantic(hit.id)
    else if (hit.kind === 'note' && hit.path) {
      const recordContext: ExpressionContext = {
        id: `search-${hit.id}`, createdAt: '', sourceKind: hit.path.startsWith('enlightenment/') ? 'enlightenment' : 'note',
        sourcePath: hit.path, sourceName: hit.title,
      }
      onOpenSource(recordContext)
    }
  }

  return (
    <div className="expression-workspace">
      <SpaceRail active="expressions" onSelect={onSwitchSpace} onChooseVault={() => void vault.chooseVault()} vaultName={vault.rootName} />
      <section className="expression-sidebar">
        <header className="expression-head">
          <div><span className="eyebrow">PERSONAL LANGUAGE</span><h1>表达池</h1></div>
          <button className="tiny-icon" type="button" title="重新读取 Vault" onClick={() => void vault.refreshExpressions()}><RefreshCw size={14} /></button>
        </header>
        <p className="expression-intro">从真实材料中识别，或从想表达的意思出发探索。每条表达可以积累多个语境。</p>
        <label className="expression-search"><Search size={14} /><input aria-label="检索表达、语义和笔记" placeholder="检索表达、语义、笔记…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="expression-actions">
          <button type="button" className="primary-button" onClick={() => setForm({ expression: '', meaning: '', note: '' })}><Plus size={14} /> 手动添加</button>
          <button type="button" className="secondary-button" onClick={() => { setExploreMode('intent'); setExplorePrompt(''); setCandidates([]) }}><Sparkles size={14} /> 探索表达</button>
        </div>
        {!vault.ready && <div className="expression-empty"><CircleHelp size={18} /><strong>先选择一个 Vault</strong><span>表达池以普通 Markdown 文件保存，并由你掌控。</span><button type="button" className="primary-button" onClick={() => void vault.chooseVault()}>选择 Vault</button></div>}
        {vault.ready && <div className="expression-list" aria-label="表达列表">
          {!records.length && !vault.expressionsLoading && <div className="expression-empty"><BookOpen size={18} /><strong>还没有表达</strong><span>阅读时选中材料中的表达即可收录，也可以手动添加或探索。</span></div>}
          {visibleRecords.map((record) => (
            <button key={record.id} type="button" className={`expression-list-item${selected?.id === record.id ? ' active' : ''}`} onClick={() => setSelectedId(record.id)}>
              <strong>{record.expression}</strong>
              <span>{record.meaning || record.contexts.find((context) => context.quote)?.quote || '尚未添加解释'}</span>
              <small>{record.contexts.length} 个语境 · {record.cognitivePaths.map((path) => path === 'recognition' ? '识别' : path === 'exploration' ? '探索' : '手动').join(' / ')}</small>
            </button>
          ))}
          {query.trim() && <div className="memory-search-results">
            <h2>统一检索</h2>
            {searching && <span className="mini-spinner" />}
            {searchDone && searchHits.length === 0 && <p>表达、语义、记录本笔记与 Vault Markdown 中没有匹配内容。</p>}
            {searchHits.map((hit, index) => (
              <button type="button" key={`${hit.kind}-${hit.id}-${index}`} onClick={() => activateHit(hit)}>
                <small>{hit.kind === 'expression' ? '表达' : hit.kind === 'semantic' ? '语义' : hit.kind === 'notebook' ? '记录本' : 'Vault 笔记'}</small>
                <strong>{hit.title}</strong><span>{hit.body.slice(0, 180)}</span>
              </button>
            ))}
            {searchError && <p className="panel-error-text">{searchError}</p>}
          </div>}
        </div>}
      </section>

      <main className="expression-main">
        {exploreMode && <section className="expression-explorer">
          <header><div><span className="eyebrow">AI ASSISTED EXPLORATION</span><h2>{exploreMode === 'intent' ? '从表达意图开始' : '围绕已有表达探索'}</h2></div><button type="button" className="subtle-button" onClick={() => setExploreMode(null)}>收起</button></header>
          <div className="expression-mode-switch">
            <button type="button" className={exploreMode === 'intent' ? 'active' : ''} onClick={() => { setExploreMode('intent'); setExplorePrompt(''); setCandidates([]) }}>我想表达某种意思</button>
            <button type="button" className={exploreMode === 'related' ? 'active' : ''} onClick={() => { setExploreMode('related'); setExplorePrompt(selected?.expression || ''); setCandidates([]) }}>从已有表达出发</button>
          </div>
          <div className="expression-explore-input"><input aria-label={exploreMode === 'intent' ? '想表达的意思' : '已有表达'} placeholder={exploreMode === 'intent' ? '例如：委婉地指出一个方案的限制' : '输入一个词组或句式'} value={explorePrompt} onChange={(event) => setExplorePrompt(event.target.value)} /><button type="button" className="primary-button" disabled={exploring || !explorePrompt.trim()} onClick={() => void runExplore()}>{exploring ? <><span className="mini-spinner" /> 探索中…</> : <><Sparkles size={14} /> 获取候选</>}</button></div>
          <p className="expression-source-note">候选是 AI 生成内容，不代表来自真实材料；只有点击「收录」后才会进入表达池。</p>
          {candidates.map((candidate) => <article className="expression-candidate" key={`${candidate.expression}-${candidate.meaning}`}>
            <div><strong>{candidate.expression}</strong><span>{candidate.meaning}</span><small>{[candidate.usageScenario, candidate.relation].filter(Boolean).join(' · ')}</small><em>AI 生成候选</em></div>
            <button type="button" className="secondary-button" disabled={capturedCandidate.includes(candidate.expression)} onClick={() => void saveCandidate(candidate)}>{capturedCandidate.includes(candidate.expression) ? <><Check size={13} /> 已收录</> : '收录'}</button>
          </article>)}
        </section>}

        {form && <section className="expression-editor-card">
          <h2>手动添加表达</h2>
          <label>表达<input autoFocus value={form.expression} onChange={(event) => setForm({ ...form, expression: event.target.value })} placeholder="词组、搭配、句子或句式框架" /></label>
          <label>意思（可选）<textarea value={form.meaning} onChange={(event) => setForm({ ...form, meaning: event.target.value })} rows={2} /></label>
          <label>我的补充（可选）<textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} rows={3} /></label>
          <footer><button type="button" className="subtle-button" onClick={() => setForm(null)}>取消</button><button type="button" className="primary-button" disabled={!form.expression.trim()} onClick={() => void saveManual()}><Check size={14} /> 收录</button></footer>
        </section>}

        {selected ? <>
          <header className="expression-detail-head"><div><span className="eyebrow">{selected.cognitivePaths.map((path) => path === 'recognition' ? '识别' : path === 'exploration' ? '探索' : '手动').join(' · ')}</span><h2>{selected.expression}</h2></div><div className="expression-detail-actions"><button type="button" className="secondary-button" onClick={() => { setExploreMode('related'); setExplorePrompt(selected.expression); setCandidates([]) }}><Sparkles size={14} /> 探索相关表达</button><button type="button" className="tiny-icon" title="编辑表达" onClick={() => setEditForm({ expression: selected.expression, meaning: selected.meaning, note: selected.note })}><FileText size={14} /></button><button type="button" className="tiny-icon danger" title="删除表达" onClick={() => void removeSelected()}><Trash2 size={14} /></button></div></header>
          {editForm && <section className="expression-editor-card compact">
            <label>表达<input value={editForm.expression} onChange={(event) => setEditForm({ ...editForm, expression: event.target.value })} /></label>
            <label>意思<textarea value={editForm.meaning} onChange={(event) => setEditForm({ ...editForm, meaning: event.target.value })} rows={2} /></label>
            <label>我的补充<textarea value={editForm.note} onChange={(event) => setEditForm({ ...editForm, note: event.target.value })} rows={3} /></label>
            <footer><button type="button" className="subtle-button" onClick={() => setEditForm(null)}>取消</button><button type="button" className="primary-button" onClick={() => void saveEdit()}>保存修改</button></footer>
          </section>}
          {selected.meaning && <section className="expression-detail-section"><h3>意思</h3><p>{selected.meaning}</p></section>}
          {selected.note && <section className="expression-detail-section"><h3>我的补充</h3><p>{selected.note}</p></section>}
          <section className="expression-detail-section"><header><h3>使用语境 <small>{selected.contexts.length}</small></h3></header>
            {!selected.contexts.length && <p className="expression-muted">这条表达暂时没有摘录语境。</p>}
            {selected.contexts.map((context) => <article className="expression-context" key={context.id}>
              <div><strong>{context.sourceName || (context.generated ? 'AI 探索候选' : '手动添加')}</strong><small>{[context.locationLabel, context.pageNumber ? `第 ${context.pageNumber} 页/章` : '', context.cognitivePath === 'recognition' ? '识别' : context.cognitivePath === 'exploration' ? '探索' : '手动'].filter(Boolean).join(' · ')}</small></div>
              {context.generated ? <p className="generated-label">AI 生成内容 · 不是原文引文</p> : context.quote ? <blockquote>{context.quote}</blockquote> : <p className="expression-muted">未记录原文摘录。</p>}
              {context.sourcePath && <button type="button" className="text-action" onClick={() => onOpenSource(context)}><BookOpen size={13} /> 打开来源 <ChevronRight size={13} /></button>}
            </article>)}
          </section>
          <section className="expression-detail-section"><header><h3>相关表达</h3></header>
            <div className="expression-related-list">{selected.relations.map((relation) => {
              const target = records.find((record) => record.id === relation.targetId)
              return target ? <button type="button" key={relation.id} onClick={() => setSelectedId(target.id)}><strong>{target.expression}</strong><span>{RELATION_LABELS[relation.kind]}{relation.note ? ` · ${relation.note}` : ''}</span></button> : null
            })}{!selected.relations.some((relation) => records.some((record) => record.id === relation.targetId)) && <p className="expression-muted">还没有关联表达。</p>}</div>
            {records.length > 1 && <div className="expression-relation-create"><select aria-label="选择相关表达" value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)}><option value="">选择一条表达…</option>{records.filter((record) => record.id !== selected.id).map((record) => <option key={record.id} value={record.id}>{record.expression}</option>)}</select><select aria-label="关系类型" value={relationKind} onChange={(event) => setRelationKind(event.target.value as ExpressionRelationKind)}>{Object.entries(RELATION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button type="button" className="subtle-button" disabled={!relationTarget} onClick={() => void saveRelation()}><Link2 size={13} /> 关联</button></div>}
          </section>
          <footer className="expression-record-meta">创建于 {new Date(selected.createdAt).toLocaleString()} · 更新于 {new Date(selected.updatedAt).toLocaleString()}</footer>
        </> : !form && !exploreMode && <div className="expression-welcome"><BookOpen size={32} /><h2>{vault.ready ? '从一个表达开始' : '请先选择 Vault'}</h2><p>{vault.ready ? '阅读真实材料时收录，或输入想表达的意思来探索。每条记录会保留来源和语境。' : '表达池与语义、笔记并列保存为 Vault 中的 Markdown。'}</p>{vault.ready ? <button className="primary-button" type="button" onClick={() => setForm({ expression: '', meaning: '', note: '' })}><Plus size={14} /> 添加第一条表达</button> : <button className="primary-button" type="button" onClick={() => void vault.chooseVault()}>选择 Vault</button>}</div>}
        {notice && <div className="vault-notice" role="status">{notice}</div>}
      </main>
    </div>
  )
}
