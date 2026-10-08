import { useMemo, useState } from 'react'
import { ChevronLeft, Library, Link2, Plus, Trash2 } from 'lucide-react'
import SenseCard from './SenseCard'
import { noteLabel } from '../lib/notebook'
import type { NotebookNote, SenseAtom } from '../types'

interface NotebookPanelProps {
  atoms: SenseAtom[]
  notes: NotebookNote[]
  activeAtomId: string | null
  model: string
  vaultReady: boolean
  vaultRootName: string
  onSelectAtom: (id: string | null) => void
  onDeleteAtom: (id: string) => void
  onAddNote: (body: string) => void
  onDeleteNote: (id: string) => void
  onSaveToVault: (note: NotebookNote) => void
  onOpenNotesSpace: () => void
}

export default function NotebookPanel({
  atoms, notes, activeAtomId, model, vaultReady, vaultRootName,
  onSelectAtom, onDeleteAtom, onAddNote, onDeleteNote, onSaveToVault, onOpenNotesSpace,
}: NotebookPanelProps) {
  const [draft, setDraft] = useState('')
  const activeAtom = atoms.find((atom) => atom.id === activeAtomId) || null
  const notesForActive = useMemo(
    () => (activeAtom ? notes.filter((note) => note.senseIds.includes(activeAtom.id)) : []),
    [activeAtom, notes],
  )
  const noteCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const note of notes) {
      for (const senseId of note.senseIds) counts.set(senseId, (counts.get(senseId) || 0) + 1)
    }
    return counts
  }, [notes])

  if (activeAtom) {
    return (
      <div className="notebook-panel">
        <button className="back-to-notes" type="button" onClick={() => onSelectAtom(null)}>
          <ChevronLeft size={14} /> 全部词语-含义
        </button>
        <SenseCard sense={activeAtom} model={activeAtom.model || model} compact relations={[]} />

        <section className="sense-block">
          <h4>相关笔记（{notesForActive.length}）</h4>
          {notesForActive.length === 0 && <p className="sense-plain">还没有关联笔记。</p>}
          <ul className="note-linked-list">
            {notesForActive.map((note) => (
              <li key={note.id}>
                <span className="note-date-chip">{noteLabel(note)}</span>
                <p>{note.body}</p>
                <div className="note-linked-actions">
                  <button type="button" title={vaultReady ? `写入 ${vaultRootName}` : '先在笔记空间里选择 vault'} onClick={() => onSaveToVault(note)}>
                    <Library size={11} /> 存入 vault
                  </button>
                  <button type="button" title="删除这份笔记" onClick={() => onDeleteNote(note.id)}><Trash2 size={12} /></button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="sense-block">
          <h4><Plus size={11} /> 添加笔记</h4>
          <textarea
            className="note-editor"
            value={draft}
            placeholder="写下你的想法，会自动编号为“某日期第 N 份笔记”，并链接到这条词语-含义…"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="note-actions">
            <button
              className="small-save"
              type="button"
              disabled={!draft.trim()}
              onClick={() => { onAddNote(draft); setDraft('') }}
            >
              保存笔记
            </button>
          </div>
        </section>

        <button className="notebook-remove-atom" type="button" onClick={() => onDeleteAtom(activeAtom.id)}>
          <Trash2 size={12} /> 从记录本移除这条词语-含义
        </button>
      </div>
    )
  }

  return (
    <div className="notebook-panel">
      <section className="sense-block">
        <h4>词语-含义（{atoms.length}）</h4>
        {atoms.length === 0 && <p className="sense-plain">还没有记录。查询义项后点击“加入记录本”。</p>}
        <ul className="atom-list">
          {atoms.map((atom) => (
            <li key={atom.id}>
              <button type="button" onClick={() => onSelectAtom(atom.id)}>
                <strong>{atom.term}</strong>
                <span className="atom-sense">{atom.contextualMeaning}</span>
                <span className="atom-meta">{atom.partOfSpeech} · {atom.senseId}{noteCount.get(atom.id) ? ` · ${noteCount.get(atom.id)} 份笔记` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="sense-block">
        <h4>
          <Link2 size={11} /> 笔记（{notes.length}）
          <button type="button" className="note-open-space" onClick={onOpenNotesSpace} title={`在笔记空间里管理 ${vaultRootName}`}>笔记空间</button>
        </h4>
        {notes.length === 0 && <p className="sense-plain">对话或义项卡中都能把内容存成笔记。</p>}
        <ul className="note-all-list">
          {notes.map((note) => (
            <li key={note.id}>
              <div className="note-head">
                <span className="note-date-chip">{noteLabel(note)}</span>
                <span className="note-head-actions">
                  <button type="button" title={vaultReady ? `写入 ${vaultRootName}` : '先在笔记空间里选择 vault'} onClick={() => onSaveToVault(note)}><Library size={12} /></button>
                  <button type="button" title="删除这份笔记" onClick={() => onDeleteNote(note.id)}><Trash2 size={12} /></button>
                </span>
              </div>
              <p>{note.body}</p>
              {note.senseIds.length > 0 && (
                <div className="note-links">
                  {note.senseIds.map((senseId) => {
                    const atom = atoms.find((item) => item.id === senseId)
                    return atom ? (
                      <button key={senseId} type="button" onClick={() => onSelectAtom(atom.id)}>
                        → {atom.term} · {atom.contextualMeaning}
                      </button>
                    ) : (
                      <span key={senseId} className="note-link-missing">→ 未入记录本的义项</span>
                    )
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
