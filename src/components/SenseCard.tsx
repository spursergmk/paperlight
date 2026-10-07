import { Bookmark, BookmarkCheck, GitBranch } from 'lucide-react'
import type { SensePayload, SenseRelation } from '../types'

interface SenseCardProps {
  sense: SensePayload
  model: string
  compact?: boolean
  added?: boolean
  relations?: SenseRelation[]
  onAdd?: () => void
  onJumpToAtom?: (id: string) => void
}

function PairList({ title, items }: { title: string; items: Array<{ term: string; note?: string; contrast?: string }> }) {
  if (!items || items.length === 0) return null
  return (
    <section className="sense-block">
      <h4>{title}</h4>
      <ul className="sense-pairs">
        {items.map((item, index) => (
          <li key={`${item.term}-${index}`}>
            <strong>{item.term}</strong>
            <span>{item.note || item.contrast}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TextList({ title, items }: { title: string; items?: string[] }) {
  const list = (items || []).filter((item) => item && item.trim())
  if (list.length === 0) return null
  return (
    <section className="sense-block">
      <h4>{title}</h4>
      <ul className="sense-list">
        {list.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </section>
  )
}

export default function SenseCard({
  sense, model, compact = false, added = false, relations = [], onAdd, onJumpToAtom,
}: SenseCardProps) {
  const guidance = sense.guidance
  const morphology = guidance?.morphology
  const hasMorphology = Boolean(morphology && (morphology.root || morphology.prefix || morphology.suffix || morphology.note))

  return (
    <article className={`sense-card${compact ? ' compact' : ''}`}>
      <header className="sense-head">
        <div className="sense-head-main">
          <h3>{sense.term}</h3>
          <span className="sense-meta">
            {sense.lemma && sense.lemma.toLowerCase() !== sense.term.toLowerCase() ? `${sense.lemma} · ` : ''}
            {sense.partOfSpeech} · {sense.senseId}
          </span>
        </div>
        {onAdd && (
          <button
            className={`sense-add${added ? ' added' : ''}`}
            type="button"
            onClick={onAdd}
            disabled={added}
            title={added ? '这条词语-含义已在记录本中' : '把这条词语-含义对应关系加入记录本'}
          >
            {added ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
            {added ? '已加入' : '加入记录本'}
          </button>
        )}
      </header>

      <p className="sense-meaning">{sense.contextualMeaning}</p>
      {sense.definition && <p className="sense-definition">{sense.definition}</p>}
      {sense.contextSentence && <p className="sense-context">“{sense.contextSentence}”</p>}

      {sense.examples && sense.examples.length > 0 && (
        <section className="sense-block">
          <h4>例句</h4>
          <ul className="sense-examples">
            {sense.examples.map((example, index) => (
              <li key={index}>
                <p className="example-text">{example.text}</p>
                {example.translation && <p className="example-translation">{example.translation}</p>}
                <span className={`example-source ${example.sourceType}`}>
                  {example.sourceType === 'verified' ? `出处：${example.citation}` : 'AI 生成例句'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!compact && guidance && (
        <>
          <TextList title="使用场景" items={guidance.scenarios} />
          <TextList title="使用建议" items={guidance.advice} />
          {guidance.frequency && (
            <section className="sense-block">
              <h4>使用频率</h4>
              <p className="sense-plain">{guidance.frequency}</p>
            </section>
          )}
          <PairList title="替代表达" items={guidance.alternatives || []} />
          <PairList title="近义词对比" items={guidance.synonyms || []} />
          <PairList title="反义词对比" items={guidance.antonyms || []} />
          {hasMorphology && (
            <section className="sense-block">
              <h4>词根词缀</h4>
              <div className="sense-morphology">
                {morphology?.prefix && <span><em>前缀</em>{morphology.prefix}</span>}
                {morphology?.root && <span><em>词根</em>{morphology.root}</span>}
                {morphology?.suffix && <span><em>后缀</em>{morphology.suffix}</span>}
              </div>
              {morphology?.note && <p className="sense-plain">{morphology.note}</p>}
            </section>
          )}
        </>
      )}

      {relations.length > 0 && (
        <section className="sense-block">
          <h4><GitBranch size={11} /> 与记录本的联系</h4>
          <ul className="sense-relations">
            {relations.map((relation) => (
              <li key={relation.atom.id}>
                <button type="button" onClick={() => onJumpToAtom?.(relation.atom.id)}>
                  {relation.atom.term} · {relation.atom.contextualMeaning}
                </button>
                <span>{relation.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!compact && <footer className="sense-foot">义项、例句与建议由 {model} 生成 · AI 输出，请自行核对</footer>}
    </article>
  )
}
