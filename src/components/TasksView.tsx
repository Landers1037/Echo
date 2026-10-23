import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowUpRight, CalendarClock, CalendarDays, Check, Circle, CircleDashed, Clock3, ListTodo, Repeat2, X } from 'lucide-react'
import type { Task } from '../types'
import { Select } from './Select'

type TasksViewProps = {
  tasks: Task[]
  mode: 'tasks' | 'board'
  onUpdate: (task: Task, patch: Partial<Task>) => Promise<void>
  onNavigate: (task: Task) => void
}

const columns: { status: Task['status']; title: string; icon: typeof Circle }[] = [
  { status: 'todo', title: '待办', icon: Circle },
  { status: 'doing', title: '进行中', icon: CircleDashed },
  { status: 'done', title: '已完成', icon: Check },
]
const repeatLabels = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' }

function localDate(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function dateLabel(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function TasksView({ tasks, mode, onUpdate, onNavigate }: TasksViewProps) {
  const [editing, setEditing] = useState<Task | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState<Task['status'] | null>(null)
  const [query, setQuery] = useState('')
  const visible = useMemo(() => tasks.filter(task => `${task.text} ${task.noteTitle}`.toLowerCase().includes(query.toLowerCase())), [tasks, query])
  const completed = tasks.filter(task => task.status === 'done').length

  async function update(task: Task, patch: Partial<Task>) {
    setPending(task.id)
    setError('')
    try { await onUpdate(task, patch) } catch (cause) { setError(cause instanceof Error ? cause.message : '任务更新失败，请重试'); throw cause }
    finally { setPending(null) }
  }

  function taskCard(task: Task) {
    const overdue = task.status !== 'done' && task.due && new Date(task.due).getTime() < Date.now()
    return <motion.article layout key={`${task.notePath}:${task.id}`} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className={`task-card ${task.status}${pending === task.id ? ' is-pending' : ''}`} draggable={mode === 'board' && pending === null} onDragStartCapture={event => { event.dataTransfer.setData('application/x-echo-task', `${task.notePath}\n${task.id}`); event.dataTransfer.effectAllowed = 'move' }}>
      <div className="task-card-main">
        <button type="button" className={`task-check ${task.status}`} aria-label={task.status === 'done' ? `重新打开任务：${task.text}` : `完成任务：${task.text}`} disabled={pending === task.id} onClick={() => { void update(task, { status: task.status === 'done' ? 'todo' : 'done' }).catch(() => {}) }}>{task.status === 'done' ? <Check size={13} /> : task.status === 'doing' ? <CircleDashed size={13} /> : null}</button>
        <button type="button" className="task-title" onClick={() => onNavigate(task)}>{task.text || '未命名任务'}</button>
        <button type="button" className="icon-button task-schedule" title="设置排期与提醒" aria-label={`设置排期与提醒：${task.text}`} onClick={() => setEditing(task)}><CalendarClock size={15} /></button>
      </div>
      <div className="task-card-meta">
        <button type="button" className="task-origin" onClick={() => onNavigate(task)} title={task.notePath}><ArrowUpRight size={12} />{task.noteTitle}</button>
        {task.due && <span className={overdue ? 'task-date overdue' : 'task-date'}><CalendarDays size={12} />{dateLabel(task.due)}</span>}
        {task.remindAt && <span className="task-reminder" title={`提醒：${dateLabel(task.remindAt)}`}><Clock3 size={12} /></span>}
        {task.repeat && task.repeat !== 'none' && <span className="task-repeat"><Repeat2 size={12} />{repeatLabels[task.repeat]}</span>}
      </div>
      <Select className="task-status-select" compact aria-label={'任务状态：' + task.text} value={task.status} disabled={pending === task.id} onChange={value => { void update(task, { status: value as Task['status'] }).catch(() => {}) }} options={columns.map(column => ({ value: column.status, label: column.title }))} />
    </motion.article>
  }

  return <div className={`tasks-view ${mode}`}>
    <div className="tasks-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h1>{mode === 'board' ? '任务看板' : '所有任务'}</h1><p>把想法变成下一步行动。任务与笔记内容始终同步。</p></div><div className="task-progress"><span>{completed}<small> / {tasks.length}</small></span><p>已完成</p></div></div>
    <div className="tasks-filter"><ListTodo size={16} /><input type="search" aria-label="搜索任务" placeholder="搜索任务或来源笔记…" value={query} onChange={event => setQuery(event.target.value)} /><span>{visible.length} 个任务</span></div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="关闭错误"><X size={14} /></button></div>}
    {mode === 'board' ? <div className="kanban-board">{columns.map(({ status, title, icon: Icon }) => <section key={status} className={`kanban-column ${status}${dragOver === status ? ' drag-over' : ''}`} aria-label={title} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-echo-task')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(status) } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(null) }} onDrop={event => {
      event.preventDefault(); setDragOver(null)
      const [notePath, id] = event.dataTransfer.getData('application/x-echo-task').split('\n')
      const task = tasks.find(item => item.id === id && item.notePath === notePath)
      if (task && task.status !== status) void update(task, { status }).catch(() => {})
    }}><div className="kanban-column-heading"><Icon size={15} /><h2>{title}</h2><span>{visible.filter(task => task.status === status).length}</span></div><div className="kanban-cards">{visible.filter(task => task.status === status).map(taskCard)}{!visible.some(task => task.status === status) && <div className="kanban-empty">{status === 'done' ? '完成的任务会出现在这里' : '拖动任务到这里'}</div>}</div></section>)}</div>
      : <div className="task-list">{visible.map(taskCard)}</div>}
    {!tasks.length && <div className="tasks-empty"><ListTodo size={32} strokeWidth={1.2} /><h2>从一条待办开始</h2><p>在任意笔记中输入 <code>- [ ] 任务内容</code>，即可在这里管理任务与提醒。</p></div>}
    {editing && <ScheduleDialog task={editing} onClose={() => setEditing(null)} onSave={async patch => { await update(editing, patch); setEditing(null) }} />}
  </div>
}

function ScheduleDialog({ task, onClose, onSave }: { task: Task; onClose: () => void; onSave: (patch: Partial<Task>) => Promise<void> }) {
  const [due, setDue] = useState(localDate(task.due))
  const [remindAt, setRemindAt] = useState(localDate(task.remindAt))
  const [repeat, setRepeat] = useState<Task['repeat']>(task.repeat || 'none')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !saving) onClose() }}><motion.section initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="modal schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-title" onKeyDown={event => {
    if (event.key === 'Escape' && !saving) onClose()
    if (event.key === 'Tab') {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'))
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <header className="modal-header"><div><span className="eyebrow">PLAN AHEAD</span><h2 id="schedule-title">排期与提醒</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
    <p className="schedule-task-name">{task.text}</p>
    <form onSubmit={event => { event.preventDefault(); setError(''); if (repeat !== 'none' && !due) { setError('重复任务需要设置截止时间'); return }; setSaving(true); void onSave({ due: due ? new Date(due).toISOString() : '', remindAt: remindAt ? new Date(remindAt).toISOString() : '', repeat, timezone: task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(cause => setError(cause instanceof Error ? cause.message : '保存失败')).finally(() => setSaving(false)) }}>
      <label className="field-label">截止时间<input autoFocus type="datetime-local" value={due} onChange={event => setDue(event.target.value)} /></label>
      <label className="field-label">提醒时间<input type="datetime-local" value={remindAt} onChange={event => setRemindAt(event.target.value)} /></label>
      <label className="field-label" htmlFor="task-repeat">重复规则</label><Select id="task-repeat" value={repeat || 'none'} onChange={value => setRepeat(value as Task['repeat'])} disabled={saving} options={Object.entries(repeatLabels).map(([value, label]) => ({ value, label }))} />
      <p className="field-hint">使用时区：{task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}。网页关闭期间的提醒会在再次打开时汇总显示。</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving ? '正在保存…' : '保存安排'}</button></footer>
    </form>
  </motion.section></div>
}
