import { useMemo, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowUpRight, Check, Circle, CircleDashed, ListTodo, Plus, Trash2, X } from 'lucide-react'
import type { CustomTask, CustomTaskDraft, Task } from '../types'
import { Select } from './Select'

type TasksViewProps = {
  tasks: Task[]
  customTasks: CustomTask[]
  onUpdateTask: (task: Task, patch: Partial<Task>) => Promise<void>
  onNavigate: (task: Task) => void
  onSaveCustom: (task: CustomTaskDraft) => Promise<void>
  onDeleteCustom: (task: CustomTask) => Promise<void>
}

const columns: { status: Task['status']; title: string; icon: typeof Circle }[] = [
  { status: 'todo', title: '待办', icon: Circle },
  { status: 'doing', title: '进行中', icon: CircleDashed },
  { status: 'done', title: '已完成', icon: Check },
]

function trapDialog(event: KeyboardEvent<HTMLElement>, saving: boolean, onClose: () => void) {
  if (event.key === 'Escape' && !saving) onClose()
  if (event.key !== 'Tab') return
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]'))
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

export function TasksView({ tasks, customTasks, onUpdateTask, onNavigate, onSaveCustom, onDeleteCustom }: TasksViewProps) {
  const [tab, setTab] = useState<'custom' | 'notes'>('custom')
  const [editor, setEditor] = useState<CustomTask | 'new' | null>(null)
  const [removing, setRemoving] = useState<CustomTask | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState<Task['status'] | null>(null)
  const [query, setQuery] = useState('')
  const needle = query.toLowerCase()
  const visibleNotes = useMemo(() => tasks.filter(task => `${task.text} ${task.noteTitle}`.toLowerCase().includes(needle)), [tasks, needle])
  const visibleCustom = useMemo(() => customTasks.filter(task => `${task.text} ${task.description || ''}`.toLowerCase().includes(needle)), [customTasks, needle])
  const current = tab === 'notes' ? tasks : customTasks
  const visible = tab === 'notes' ? visibleNotes : visibleCustom
  const completed = current.filter(task => task.status === 'done').length

  async function updateNote(task: Task, patch: Partial<Task>) {
    setPending(task.id)
    setError('')
    try { await onUpdateTask(task, patch) } catch (cause) { setError(cause instanceof Error ? cause.message : '任务更新失败，请重试'); throw cause }
    finally { setPending(null) }
  }

  async function updateCustom(task: CustomTask, status: CustomTask['status']) {
    setPending(task.id)
    setError('')
    try { await onSaveCustom({ id: task.id, text: task.text, description: task.description, status }) } catch (cause) { setError(cause instanceof Error ? cause.message : '任务更新失败，请重试'); throw cause }
    finally { setPending(null) }
  }

  async function confirmDelete() {
    if (!removing) return
    setPending(removing.id)
    setError('')
    try {
      await onDeleteCustom(removing)
      setRemoving(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务删除失败，请重试')
    } finally { setPending(null) }
  }

  function noteCard(task: Task) {
    return <motion.article layout key={`${task.notePath}:${task.id}`} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className={`task-card ${task.status}${pending === task.id ? ' is-pending' : ''}`} draggable={pending === null} onDragStartCapture={event => { event.dataTransfer.setData('application/x-echo-task', `note\n${task.id}\n${task.notePath}`); event.dataTransfer.effectAllowed = 'move' }}>
      <div className="task-card-main">
        <button type="button" className={`task-check ${task.status}`} aria-label={task.status === 'done' ? `重新打开任务：${task.text}` : `完成任务：${task.text}`} disabled={pending === task.id} onClick={() => { void updateNote(task, { status: task.status === 'done' ? 'todo' : 'done' }).catch(() => {}) }}>{task.status === 'done' ? <Check size={13} /> : task.status === 'doing' ? <CircleDashed size={13} /> : null}</button>
        <button type="button" className="task-title" onClick={() => onNavigate(task)}>{task.text || '未命名任务'}</button>
      </div>
      <div className="task-card-meta">
        <button type="button" className="task-origin" onClick={() => onNavigate(task)} title={task.notePath}><ArrowUpRight size={12} />{task.noteTitle}</button>
      </div>
      <Select className="task-status-select" compact aria-label={'任务状态：' + task.text} value={task.status} disabled={pending === task.id} onChange={value => { void updateNote(task, { status: value as Task['status'] }).catch(() => {}) }} options={columns.map(column => ({ value: column.status, label: column.title }))} />
    </motion.article>
  }

  function customCard(task: CustomTask) {
    return <motion.article layout key={task.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className={`task-card ${task.status}${pending === task.id ? ' is-pending' : ''}`} draggable={pending === null} onDragStartCapture={event => { event.dataTransfer.setData('application/x-echo-task', `custom\n${task.id}\n`); event.dataTransfer.effectAllowed = 'move' }}>
      <div className="task-card-main">
        <button type="button" className={`task-check ${task.status}`} aria-label={task.status === 'done' ? `重新打开任务：${task.text}` : `完成任务：${task.text}`} disabled={pending === task.id} onClick={() => { void updateCustom(task, task.status === 'done' ? 'todo' : 'done').catch(() => {}) }}>{task.status === 'done' ? <Check size={13} /> : task.status === 'doing' ? <CircleDashed size={13} /> : null}</button>
        <button type="button" className="task-title" aria-label={`编辑任务：${task.text}`} onClick={() => setEditor(task)}>{task.text || '未命名任务'}</button>
        <button type="button" className="icon-button danger" aria-label={`删除任务：${task.text}`} onClick={() => setRemoving(task)}><Trash2 size={14} /></button>
      </div>
      {task.description && <p className="task-description">{task.description}</p>}
      <Select className="task-status-select" compact aria-label={'任务状态：' + task.text} value={task.status} disabled={pending === task.id} onChange={value => { void updateCustom(task, value as CustomTask['status']).catch(() => {}) }} options={columns.map(column => ({ value: column.status, label: column.title }))} />
    </motion.article>
  }

  return <div className="tasks-view board">
    <div className="tasks-heading">
      <div>
        <span className="eyebrow">YOUR WORKSPACE</span>
        <h1>任务看板</h1>
      </div>
      <div className="task-progress"><span>{completed}<small> / {current.length}</small></span><p>已完成</p></div>
    </div>
    <div className="board-toolbar">
      <div className="board-tabs" role="tablist" aria-label="任务来源">
        <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'active' : ''} onClick={() => setTab('custom')}>自定任务</button>
        <button type="button" role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>笔记任务</button>
      </div>
      {tab === 'custom' && <button type="button" className="button primary" onClick={() => setEditor('new')}><Plus size={15} />新建任务</button>}
    </div>
    {current.length > 0 && <div className="tasks-filter"><ListTodo size={16} /><input type="search" aria-label="搜索任务" placeholder={tab === 'notes' ? '搜索任务或来源笔记…' : '搜索任务…'} value={query} onChange={event => setQuery(event.target.value)} /><span>{visible.length} 个任务</span></div>}
    {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="关闭错误"><X size={14} /></button></div>}
    {current.length === 0 ? <div className="tasks-empty"><ListTodo size={32} strokeWidth={1.2} />{tab === 'notes' ? <><h2>从一条待办开始</h2><p>在任意笔记中输入 <code>- [ ] 任务内容</code>，即可在这里管理。</p></> : <><h2>从一条自定任务开始</h2><p>点击「新建任务」，把要做的事放在看板上。</p></>}</div>
      : visible.length === 0 ? <div className="tasks-empty"><p>没有匹配的任务</p></div>
        : <div className="kanban-board">{columns.map(({ status, title, icon: Icon }) => <section key={status} className={`kanban-column ${status}${dragOver === status ? ' drag-over' : ''}`} aria-label={title} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-echo-task')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(status) } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(null) }} onDrop={event => {
          event.preventDefault(); setDragOver(null)
          const [kind, id, notePath = ''] = event.dataTransfer.getData('application/x-echo-task').split('\n')
          if (tab === 'notes' && kind === 'note') {
            const task = tasks.find(item => item.id === id && item.notePath === notePath)
            if (task && task.status !== status) void updateNote(task, { status }).catch(() => {})
          }
          if (tab === 'custom' && kind === 'custom') {
            const task = customTasks.find(item => item.id === id)
            if (task && task.status !== status) void updateCustom(task, status).catch(() => {})
          }
        }}><div className="kanban-column-heading"><Icon size={15} /><h2>{title}</h2><span>{visible.filter(task => task.status === status).length}</span></div><div className="kanban-cards">{(tab === 'notes' ? visibleNotes : visibleCustom).filter(task => task.status === status).map(task => tab === 'notes' ? noteCard(task as Task) : customCard(task as CustomTask))}{!visible.some(task => task.status === status) && <div className="kanban-empty">{status === 'done' ? '完成的任务会出现在这里' : '拖动任务到这里'}</div>}</div></section>)}</div>}
    {editor && <TaskDialog key={editor === 'new' ? 'new' : editor.id} task={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSave={onSaveCustom} />}
    {removing && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && pending !== removing.id) setRemoving(null) }}>
      <motion.section initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-task-title" onKeyDown={event => trapDialog(event, pending === removing.id, () => setRemoving(null))}>
        <header className="modal-header"><h2 id="delete-task-title">删除任务</h2><button className="icon-button" type="button" aria-label="关闭" onClick={() => setRemoving(null)} disabled={pending === removing.id}><X size={18} /></button></header>
        <p className="field-help">删除“{removing.text}”后无法恢复。</p>
        <footer className="modal-footer"><button type="button" className="button secondary" disabled={pending === removing.id} onClick={() => setRemoving(null)}>取消</button><button type="button" className="button danger" disabled={pending === removing.id} onClick={() => { void confirmDelete() }}>{pending === removing.id ? '正在删除…' : '确认删除'}</button></footer>
      </motion.section>
    </div>}
  </div>
}

function TaskDialog({ task, onClose, onSave }: { task: CustomTask | null; onClose: () => void; onSave: (task: CustomTaskDraft) => Promise<void> }) {
  const [text, setText] = useState(task?.text || '')
  const [description, setDescription] = useState(task?.description || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!text.trim()) { setError('请填写任务内容'); return }
    setSaving(true)
    setError('')
    const draft: CustomTaskDraft = { text: text.trim(), description: description.trim(), status: task?.status || 'todo' }
    if (task?.id) draft.id = task.id
    void onSave(draft).then(() => onClose()).catch(cause => setError(cause instanceof Error ? cause.message : '任务保存失败，请重试')).finally(() => setSaving(false))
  }

  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <motion.section initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="modal" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title" onKeyDown={event => trapDialog(event, saving, onClose)}>
      <header className="modal-header"><div><span className="eyebrow">YOUR BOARD</span><h2 id="task-dialog-title">{task ? '编辑任务' : '新建任务'}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={saving}><X size={18} /></button></header>
      <form noValidate onSubmit={submit}>
        <label className="field-label">任务内容<input autoFocus value={text} onChange={event => setText(event.target.value)} disabled={saving} /></label>
        <label className="field-label">描述<textarea value={description} rows={3} onChange={event => setDescription(event.target.value)} disabled={saving} placeholder="可选" /></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <footer className="modal-footer"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving ? '正在保存…' : '保存任务'}</button></footer>
      </form>
    </motion.section>
  </div>
}
