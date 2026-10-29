import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { BookOpen, Search, Plus, FolderPlus, FileText, ChevronRight, Folder, MoreHorizontal, LayoutGrid, ListTodo, Settings, Trash2, Tags, FolderOpen, X, ArrowUpRight, Box, LoaderCircle, PenTool, LocateFixed, Workflow } from 'lucide-react'
import { motion } from 'motion/react'
import type { NoteSummary, TreeEntry } from '../types'
import { Logo } from './Logo'

type Props = {
  notes: NoteSummary[]; tree: TreeEntry[]; groups: string[]; tags: string[]; active: string; view: string; open: boolean
  revealEntry: { path: string } | null
  search: string; setSearch: (value: string) => void; searchPaths?: string[] | null; group: string | null; setGroup: (value: string | null) => void
  filterTags: string[]; setFilterTags: (value: string[]) => void; selected: string[]; setSelected: (value: string[]) => void
  onSelect: (path: string) => void; onView: (view: 'plans' | 'board') => void; onCreate: () => void; onFolder: () => void; onCreateDrawing: () => void
  onOpenDrawing: (path: string) => void; activeDrawing: string
  onManage: (path: string, type: 'note' | 'folder' | 'drawing') => void; onDraw: () => void; onSettings: () => void; onTrash: () => void; onRepositories: () => void; onCategories: () => void; onClose: () => void
  onOpenDirectory: () => void; openingDirectory: boolean
}

function expandAncestors(path: string, folders: Record<string, boolean>) {
  const next = { ...folders }
  const parts = path.split('/').filter(Boolean)
  for (let depth = 1; depth < parts.length; depth++) next[parts.slice(0, depth).join('/')] = true
  return next
}

export function Sidebar(p: Props) {
  const [tab, setTab] = useState<'directory' | 'groups'>('directory')
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({})
  const [located, setLocated] = useState<{ path: string; token: number } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const canLocate = p.view === 'note' && !!p.active
  useEffect(() => {
    const path = p.revealEntry?.path
    if (!path) return
    setExpandedFolders(folders => expandAncestors(path, folders))
    setTab('directory')
  }, [p.revealEntry])
  useEffect(() => {
    if (!located) return
    const id = window.setTimeout(() => setLocated(current => current?.token === located.token ? null : current), 900)
    return () => window.clearTimeout(id)
  }, [located])
  function locateCurrentNote() {
    if (!canLocate) return
    const path = p.active
    flushSync(() => {
      setExpandedFolders(folders => expandAncestors(path, folders))
      setTab('directory')
      if (p.search) p.setSearch('')
      if (p.group !== null) p.setGroup(null)
      if (p.filterTags.length) p.setFilterTags([])
    })
    const row = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-tree-path]') || [])].find(element => element.dataset.treePath === path)
    if (!row) return
    const reduceMotion = document.documentElement.dataset.animations === 'false' || matchMedia('(prefers-reduced-motion: reduce)').matches
    row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
    setLocated(current => ({ path, token: (current?.token ?? 0) + 1 }))
  }
  const filtered = p.notes.filter(note => (p.group === null || (note.metadata.group || '') === p.group) && p.filterTags.every(tag => note.metadata.tags.includes(tag)) && (!p.search || (p.searchPaths ? p.searchPaths.includes(note.path) : `${note.title} ${note.path}`.toLowerCase().includes(p.search.toLowerCase()))))
  const filtering = p.group !== null || p.filterTags.length > 0 || p.search.length > 0
  const visible = new Set(filtered.map(note => note.path))
  const toggleSelected = (path: string) => p.setSelected(p.selected.includes(path) ? p.selected.filter(value => value !== path) : [...p.selected, path])
  const drawingRow = (entry: TreeEntry, depth = 0) => {
    const drawio = /\.drawio$/i.test(entry.name)
    const Icon = drawio ? Workflow : PenTool
    return <div className={`note-row ${p.activeDrawing === entry.path ? 'active' : ''}`} key={entry.path} style={{ paddingLeft: `${14 + depth * 16}px` }}>
      <span className="drawing-spacer" />
      <button className="note-link" onClick={() => p.onOpenDrawing(entry.path)} title={entry.path}><Icon size={15} /><span>{entry.name.replace(/\.(?:excalidraw|drawio)$/i, '')}</span></button>
      <button className="row-action icon-button" aria-label={`管理绘图 ${entry.path}`} onClick={() => p.onManage(entry.path, 'drawing')}><MoreHorizontal size={15} /></button>
    </div>
  }
  const noteRow = (note: NoteSummary, depth = 0) => <div className={`note-row ${p.active === note.path && p.view === 'note' ? 'active' : ''} ${p.selected.includes(note.path) ? 'is-selected' : ''} ${located?.path === note.path ? `is-located locate-${located.token % 2}` : ''}`} data-tree-path={note.path} key={note.path} style={{ paddingLeft: `${14 + depth * 16}px` }}>
    <input type="checkbox" aria-label={`选择 ${note.title}`} className="note-check" checked={p.selected.includes(note.path)} onChange={() => toggleSelected(note.path)} />
    <button className="note-link" onClick={() => p.onSelect(note.path)} title={note.path}><FileText size={15} /><span>{note.title}</span></button>
    <button className="row-action icon-button" aria-label={`管理 ${note.path}`} onClick={() => p.onManage(note.path, 'note')}><MoreHorizontal size={15} /></button>
  </div>
  const renderTree = (entries: TreeEntry[], depth = 0): React.ReactNode => entries.map(entry => entry.type === 'folder' ? <div key={entry.path}>
    <div className="folder-row" style={{ paddingLeft: `${14 + depth * 16}px` }}><button className="folder-link" onClick={() => setExpandedFolders(folders => ({ ...folders, [entry.path]: !folders[entry.path] }))} aria-expanded={!!expandedFolders[entry.path]}><ChevronRight size={13} className={expandedFolders[entry.path] ? 'rotated' : ''} /><Folder size={15} /><span>{entry.name}</span></button><button className="row-action icon-button" aria-label={`管理文件夹 ${entry.path}`} onClick={() => p.onManage(entry.path, 'folder')}><MoreHorizontal size={15} /></button></div>
    {expandedFolders[entry.path] && renderTree(entry.children || [], depth + 1)}
  </div> : entry.type === 'drawing' ? drawingRow(entry, depth) : visible.has(entry.path) ? noteRow(p.notes.find(note => note.path === entry.path) || { path: entry.path, title: entry.name.replace(/\.md$/i, ''), metadata: { tags: [], group: '' }, modified: '', revision: '' }, depth) : null)
  return <><div className={`sidebar-scrim ${p.open ? 'visible' : ''}`} onClick={p.onClose} />
    <aside id="note-sidebar" className={`sidebar ${p.open ? 'open' : ''}`} inert={!p.open}>
      <div className="brand"><Logo /><div><strong>echo<span>.</span></strong><small>让想法有处安放</small></div><button className="icon-button mobile-close" aria-label="关闭目录" onClick={p.onClose}><X size={18} /></button></div>
      <div className="sidebar-search"><Search size={15} /><input aria-label="搜索笔记" value={p.search} onChange={e => p.setSearch(e.target.value)} placeholder="搜索笔记…" /><kbd>Ctrl K</kbd>{p.search && <button className="icon-button" aria-label="清除搜索" onClick={() => p.setSearch('')}><X size={12} /></button>}</div>
      <button className="new-note" onClick={p.onCreate}><Plus size={17} /><span>新建笔记</span></button>
      <nav className="workspace-nav" aria-label="工作区"><button className={p.view === 'note' ? 'active' : ''} onClick={() => { p.setGroup(null); p.setFilterTags([]); p.setSearch(''); if (p.notes[0]) p.onSelect(p.active || p.notes[0].path) }}><BookOpen size={16} /><span>全部笔记</span><span className="nav-count">{p.notes.length}</span></button><button className={p.view === 'plans' ? 'active' : ''} onClick={() => p.onView('plans')}><ListTodo size={16} /><span>计划与提醒</span></button><button className={p.view === 'board' ? 'active' : ''} onClick={() => p.onView('board')}><LayoutGrid size={16} /><span>任务看板</span></button></nav>
      <div className="sidebar-content"><div className="sidebar-section-heading"><div className="sidebar-tabs"><button className={tab === 'directory' ? 'selected' : ''} onClick={() => { setTab('directory'); p.setGroup(null) }}>目录</button><button className={tab === 'groups' ? 'selected' : ''} onClick={() => setTab('groups')}>分组</button></div><div className="sidebar-heading-actions"><button className="icon-button" aria-label="在目录中定位当前笔记" title={canLocate ? '在目录中定位当前笔记' : '打开笔记后可定位'} disabled={!canLocate} onClick={locateCurrentNote}><LocateFixed size={15} /></button>{tab === 'directory' && <button className="icon-button" aria-label="新建绘图" title="新建绘图" onClick={p.onCreateDrawing}><PenTool size={15} /></button>}<button className="icon-button" aria-label={tab === 'directory' ? '新建文件夹' : '管理分组'} onClick={tab === 'directory' ? p.onFolder : p.onCategories}>{tab === 'directory' ? <FolderPlus size={15} /> : <Plus size={15} />}</button></div></div>
      {filtering && <div className="filter-summary"><span>{filtered.length} 篇笔记</span><button onClick={() => { p.setGroup(null); p.setFilterTags([]); p.setSearch('') }}>清除筛选</button></div>}
      <div className="note-tree" ref={treeRef}>{tab === 'directory' ? filtering ? filtered.map(note => noteRow(note)) : renderTree(p.tree) : <>
        {[...p.groups, ''].map(group => <div className="group-section" key={group}><button className={`group-heading ${p.group === group ? 'selected' : ''}`} onClick={() => p.setGroup(p.group === group ? null : group)}><FolderOpen size={14} /><span>{group || '未分组'}</span><small>{p.notes.filter(note => note.metadata.group === group).length}</small></button>{filtered.filter(note => note.metadata.group === group).map(note => noteRow(note, 1))}</div>)}
      </>}{filtered.length === 0 && <div className="sidebar-empty">{filtering ? '没有符合条件的笔记' : '从第一篇笔记开始吧'}</div>}</div>
      <div className="sidebar-section-heading tags-heading"><span>标签</span><button className="icon-button" aria-label="管理标签" onClick={p.onCategories}><Tags size={14} /></button></div><div className="sidebar-tags">{p.tags.map(tag => <button key={tag} className={`tag-filter ${p.filterTags.includes(tag) ? 'active' : ''}`} onClick={() => p.setFilterTags(p.filterTags.includes(tag) ? p.filterTags.filter(t => t !== tag) : [...p.filterTags, tag])}><span>#</span>{tag}</button>)}{!p.tags.length && <span className="muted tiny">为笔记添加标签，串联灵感。</span>}</div>
      </div>
      <motion.button type="button" className="local-card" aria-label="本地空间：打开笔记库目录" title="在文件浏览器中打开笔记库目录" aria-busy={p.openingDirectory} disabled={p.openingDirectory} onClick={p.onOpenDirectory} initial={{ opacity: 0 }} animate={{ opacity: 1 }}><span className="local-dot" /><span className="local-card-copy"><strong>本地空间</strong><small>{p.openingDirectory ? '正在打开文件浏览器…' : '笔记保存在你的设备上'}</small></span>{p.openingDirectory ? <LoaderCircle size={14} className="spin" /> : <ArrowUpRight size={14} />}</motion.button>
      <div className="sidebar-footer"><button onClick={p.onSettings} title="设置" aria-label="设置"><Settings size={16} /></button><button onClick={p.onDraw} title="Draw.io 绘图" aria-label="Draw.io 绘图"><Workflow size={16} /></button><button onClick={p.onTrash} title="回收站" aria-label="回收站"><Trash2 size={16} /></button><button onClick={p.onRepositories} title="切换仓库" aria-label="切换仓库"><Box size={16} /></button><span className="version">v1.0</span></div>
    </aside></>
}
