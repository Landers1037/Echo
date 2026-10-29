import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, FileText, Folder, Search, X } from 'lucide-react'
import type { NoteSummary, TreeEntry } from '../types'
import { Modal } from './UI'

type Props = {
  tree: TreeEntry[]
  notes: NoteSummary[]
  exclude: string
  onSelect: (path: string) => void
  onClose: () => void
}

export function NotePicker({ tree, notes, exclude, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const titles = useMemo(() => new Map(notes.map(note => [note.path, note.title || note.path.replace(/\.md$/i, '')])), [notes])
  const needle = query.trim().toLowerCase()
  const matches = needle ? notes.filter(note => note.path !== exclude && `${note.title} ${note.path}`.toLowerCase().includes(needle)) : []
  const label = (path: string, name: string) => titles.get(path) || name.replace(/\.md$/i, '')
  const renderTree = (entries: TreeEntry[], depth = 0): ReactNode => entries.map(entry => {
    if (entry.type === 'drawing') return null
    if (entry.type === 'folder') return <div key={entry.path}>
      <div className="folder-row" style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <button type="button" className="folder-link" aria-expanded={!!expanded[entry.path]} onClick={() => setExpanded(folders => ({ ...folders, [entry.path]: !folders[entry.path] }))}>
          <ChevronRight size={13} className={expanded[entry.path] ? 'rotated' : ''} /><Folder size={15} /><span>{entry.name}</span>
        </button>
      </div>
      {expanded[entry.path] && renderTree(entry.children || [], depth + 1)}
    </div>
    if (entry.path === exclude) return null
    return <div className="note-row" key={entry.path} style={{ paddingLeft: `${8 + depth * 16}px` }}>
      <button type="button" className="note-link" title={entry.path} onClick={() => onSelect(entry.path)}><FileText size={15} /><span>{label(entry.path, entry.name)}</span></button>
    </div>
  })
  const available = notes.some(note => note.path !== exclude)
  return <Modal title="引用笔记" onClose={onClose}>
    <div className="note-picker">
      <div className="sidebar-search note-picker-search"><Search size={15} /><input aria-label="搜索要引用的笔记" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索笔记…" />{query && <button type="button" className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={12} /></button>}</div>
      <div className="note-picker-tree">
        {needle ? matches.map(note => <div className="note-row" key={note.path}><button type="button" className="note-link" title={note.path} onClick={() => onSelect(note.path)}><FileText size={15} /><span>{note.title || note.path.replace(/\.md$/i, '')}</span></button></div>) : renderTree(tree)}
        {needle && matches.length === 0 && <p className="field-help">没有符合条件的笔记</p>}
        {!needle && !available && <p className="field-help">没有可引用的笔记</p>}
      </div>
    </div>
  </Modal>
}
