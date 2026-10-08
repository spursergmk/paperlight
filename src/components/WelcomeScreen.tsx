import { BookOpen, Clock, FileText, FolderOpen, Languages, StickyNote, Columns3 } from 'lucide-react'
import type { RecentFile } from '../lib/persist'

export default function WelcomeScreen({
  onOpenFiles,
  onOpenFolder,
  canBrowse,
  recents,
  onOpenRecent,
}: {
  onOpenFiles: () => void
  onOpenFolder: () => void
  canBrowse: boolean
  recents: RecentFile[]
  onOpenRecent: (path: string) => void
}) {
  return (
    <div className="reader-scroll welcome-scroll">
      <div className="welcome-card">
        <div className="welcome-art">
          <div className="art-shadow" />
          <div className="art-page art-page-back"><i /><i /><i /></div>
          <div className="art-page art-page-front">
            <div className="art-page-kicker">READ · UNDERSTAND</div>
            <div className="art-page-title">Ideas travel<br />through words.</div>
            <div className="art-page-line" />
            <div className="art-page-text">A little help, right where<br />you need it.</div>
            <div className="art-page-mark"><Languages size={21} /></div>
          </div>
          <div className="art-translate"><span>selected text</span><div>Ideas travel through words.</div><b>思想借由文字传递。</b></div>
          <span className="art-sparkle sparkle-one">✳</span><span className="art-sparkle sparkle-two">✦</span>
        </div>
        <span className="eyebrow">PAPERLIGHT APP</span>
        <h1>打开文件夹，<br /><em>像 IDE 一样读书。</em></h1>
        <p className="welcome-copy">
          左侧直接浏览本机文件夹，双击 PDF / EPUB / TXT / Markdown 即开一个新标签页；<br />
          阅读、查询、追问与笔记之间，随时拖动分界线调整空间。
        </p>
        <div className="welcome-actions">
          <button className="primary-button" onClick={onOpenFolder} disabled={!canBrowse}>
            <FolderOpen size={17} /> 打开文件夹 <span>⌘⇧O</span>
          </button>
          <button className="secondary-button" onClick={onOpenFiles}>
            <FileText size={16} /> 打开文档 <span>⌘O</span>
          </button>
        </div>
        {!canBrowse && <div className="drop-hint">当前运行环境无法浏览文件夹，请使用“打开文档”</div>}

        {recents.length > 0 && (
          <div className="welcome-recents">
            <span className="places-title"><Clock size={11} /> 最近打开</span>
            <div className="welcome-recent-list">
              {recents.slice(0, 5).map((file) => (
                <button key={file.path} type="button" className="welcome-recent" title={file.path} onClick={() => onOpenRecent(file.path)}>
                  <FileText size={13} /><span>{file.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="welcome-divider" />
        <div className="feature-row">
          <div><span><Columns3 size={15} /></span><b>自由分栏</b><small>拖动分界线调整</small></div>
          <div><span><Languages size={15} /></span><b>随选随译</b><small>保留原文上下文</small></div>
          <div><span><StickyNote size={15} /></span><b>摘录笔记</b><small>本地自动保存</small></div>
          <div><span><BookOpen size={15} /></span><b>多格式</b><small>PDF · EPUB · 文本</small></div>
        </div>
      </div>
    </div>
  )
}
