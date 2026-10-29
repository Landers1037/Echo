import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, FileText, Folder, Search, Workflow, X } from 'lucide-react'
import type { NoteSummary, TreeEntry } from '../types'
import { Modal } from './UI'

type Props = {
  tree: TreeEntry[]
  notes: NoteSummary[]
  exclude: string
  kind?: 'note' | 'drawio'
  onSelect: (path: string) => void
  onClose: () => void
}

function collectDrawios(entries: TreeEntry[], result: TreeEntry[] = []) {
  for (const entry of entries) {
    if (entry.type === 'folder') collectDrawios(entry.children || [], result)
    else if (entry.type === 'drawing' && /\.drawio$/i.test(entry.path)) result.push(entry)
  }
  return result
}

function drawioLabel(name: string) {
  return name.replace(/\.drawio$/i, '')
}

export function NotePicker({ tree, notes, exclude, kind = 'note', onSelect, onClose }: Props) {
  const drawio = kind === 'drawio'
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const titles = useMemo(() => new Map(notes.map(note => [note.path, note.title || note.path.replace(/\.md$/i, '')])), [notes])
  const drawings = useMemo(() => collectDrawios(tree), [tree])
  const needle = query.trim().toLowerCase()
  const noteMatches = needle && !drawio ? notes.filter(note => note.path !== exclude && `${note.title} ${note.path}`.toLowerCase().includes(needle)) : []
  const drawingMatches = needle && drawio ? drawings.filter(entry => `${entry.name} ${entry.path}`.toLowerCase().includes(needle)) : []
  const label = (path: string, name: string) => titles.get(path) || name.replace(/\.md$/i, '')
  const renderTree = (entries: TreeEntry[], depth = 0): ReactNode => entries.map(entry => {
    if (entry.type === 'drawing') {
      if (!drawio || !/\.drawio$/i.test(entry.path)) return null
      return <div className="note-row" key={entry.path} style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <button type="button" className="note-link" title={entry.path} onClick={() => onSelect(entry.path)}><Workflow size={15} /><span>{drawioLabel(entry.name)}</span></button>
      </div>
    }
    if (entry.type === 'folder') return <div key={entry.path}>
      <div className="folder-row" style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <button type="button" className="folder-link" aria-expanded={!!expanded[entry.path]} onClick={() => setExpanded(folders => ({ ...folders, [entry.path]: !folders[entry.path] }))}>
          <ChevronRight size={13} className={expanded[entry.path] ? 'rotated' : ''} /><Folder size={15} /><span>{entry.name}</span>
        </button>
      </div>
      {expanded[entry.path] && renderTree(entry.children || [], depth + 1)}
    </div>
    if (drawio || entry.path === exclude) return null
    return <div className="note-row" key={entry.path} style={{ paddingLeft: `${8 + depth * 16}px` }}>
      <button type="button" className="note-link" title={entry.path} onClick={() => onSelect(entry.path)}><FileText size={15} /><span>{label(entry.path, entry.name)}</span></button>
    </div>
  })
  const available = drawio ? drawings.length > 0 : notes.some(note => note.path !== exclude)
  const title = drawio ? '引用 Draw.io' : '引用笔记'
  const emptySearch = drawio ? '没有符合条件的 Draw.io 绘图' : '没有符合条件的笔记'
  const emptyAll = drawio ? '没有可引用的 Draw.io 绘图' : '没有可引用的笔记'
  return <Modal title={title} onClose={onClose}>
    <div className="note-picker">
      <div className="sidebar-search note-picker-search"><Search size={15} /><input aria-label={drawio ? '搜索要引用的 Draw.io 绘图' : '搜索要引用的笔记'} value={query} onChange={event => setQuery(event.target.value)} placeholder={drawio ? '搜索 Draw.io 绘图…' : '搜索笔记…'} />{query && <button type="button" className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={12} /></button>}</div>
      <div className="note-picker-tree">
        {needle ? drawio ? drawingMatches.map(entry => <div className="note-row" key={entry.path}><button type="button" className="note-link" title={entry.path} onClick={() => onSelect(entry.path)}><Workflow size={15} /><span>{drawioLabel(entry.name)}</span></button></div>) : noteMatches.map(note => <div className="note-row" key={note.path}><button type="button" className="note-link" title={note.path} onClick={() => onSelect(note.path)}><FileText size={15} /><span>{note.title || note.path.replace(/\.md$/i, '')}</span></button></div>) : renderTree(tree)}
        {needle && (drawio ? drawingMatches.length === 0 : noteMatches.length === 0) && <p className="field-help">{emptySearch}</p>}
        {!needle && !available && <p className="field-help">{emptyAll}</p>}
      </div>
    </div>
  </Modal>
}
