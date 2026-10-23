import { useMemo, useState } from 'react'
import { ListTree, X } from 'lucide-react'
import { parseNoteHeadings } from '../noteOutline'
import './NoteOutline.css'

export function NoteOutline({ content, onNavigate, onClose }: { content: string; onNavigate: (line: number) => void; onClose: () => void }) {
  const headings = useMemo(() => parseNoteHeadings(content), [content])
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
  return <nav className="note-outline" id="note-outline" aria-label="笔记导航">
    <div className="note-outline-heading"><h2><ListTree size={15} />笔记导航</h2><button className="icon-button" type="button" aria-label="关闭笔记导航" onClick={onClose}><X size={15} /></button></div>
    {headings.length ? <ol className="note-outline-list">{headings.map(heading => <li key={heading.line}>
      <button type="button" className="note-outline-item" data-depth={heading.depth} aria-label={`${heading.depth} 级标题：${heading.title}`} aria-current={selectedLine === heading.line ? 'location' : undefined} title={heading.title} style={{ paddingLeft: 12 + (heading.depth - 1) * 12 }} onClick={() => { setSelectedLine(heading.line); onNavigate(heading.line) }}><span>{heading.title}</span></button>
    </li>)}</ol> : <div className="note-outline-empty"><ListTree size={25} strokeWidth={1.4} /><p>暂无标题</p><small>添加一级至五级标题后，即可在这里快速跳转。</small></div>}
  </nav>
}
