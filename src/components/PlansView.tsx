import { useMemo, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { motion } from 'motion/react'
import { CalendarClock, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { Plan, PlanDraft, PlanRepeat } from '../types'
import { DateField, TimeField } from './SchedulePicker'

const weekdayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]
const weekdayNames = ['日', '一', '二', '三', '四', '五', '六']

export function planScheduleLabel(plan: Pick<Plan, 'repeat' | 'date' | 'time' | 'weekdays'>) {
  if (plan.repeat === 'daily') return `每天 ${plan.time}`
  if (plan.repeat === 'weekly') {
    const names = [1, 2, 3, 4, 5, 6, 0].filter(day => plan.weekdays?.includes(day)).map(day => weekdayNames[day])
    return `每周${names.join('、')} ${plan.time}`
  }
  if (!plan.date) return plan.time
  const [year, month, day] = plan.date.split('-').map(Number)
  const prefix = year !== new Date().getFullYear() ? `${year}年` : ''
  return `${prefix}${month}月${day}日 ${plan.time}`
}

function nextAt(plan: Plan) {
  const now = Date.now()
  const [hour, minute] = plan.time.split(':').map(Number)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (plan.repeat === 'once') {
    if (!plan.date) return null
    const date = new Date(`${plan.date}T${plan.time}`)
    return Number.isNaN(date.getTime()) ? null : date.getTime()
  }
  if (plan.repeat === 'daily') {
    const date = new Date()
    date.setHours(hour, minute, 0, 0)
    if (date.getTime() < now) date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date()
    date.setDate(date.getDate() + offset)
    date.setHours(hour, minute, 0, 0)
    if (date.getTime() < now) continue
    if (plan.weekdays?.includes(date.getDay())) return date.getTime()
  }
  return null
}

function blankPlan(): PlanDraft {
  return { title: '', note: '', repeat: 'once', date: '', time: '09:00', weekdays: [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: true }
}

function trapDialog(event: KeyboardEvent<HTMLElement>, saving: boolean, onClose: () => void) {
  if (event.key === 'Escape' && !saving) onClose()
  if (event.key !== 'Tab') return
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]'))
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

type PlansViewProps = {
  plans: Plan[]
  onSave: (plan: PlanDraft) => Promise<void>
  onDelete: (plan: Plan) => Promise<void>
}

export function PlansView({ plans, onSave, onDelete }: PlansViewProps) {
  const [editing, setEditing] = useState<PlanDraft | null>(null)
  const [removing, setRemoving] = useState<Plan | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const ordered = useMemo(() => [...plans].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return (nextAt(a) ?? Number.MAX_SAFE_INTEGER) - (nextAt(b) ?? Number.MAX_SAFE_INTEGER)
  }), [plans])
  const enabled = plans.filter(plan => plan.enabled).length

  async function toggle(plan: Plan) {
    setPending(plan.id)
    setError('')
    try {
      await onSave({ id: plan.id, title: plan.title, note: plan.note, repeat: plan.repeat, date: plan.date, time: plan.time, weekdays: plan.weekdays, timezone: plan.timezone, enabled: !plan.enabled })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '计划保存失败，请重试')
    } finally { setPending(null) }
  }

  async function confirmDelete() {
    if (!removing) return
    setPending(removing.id)
    setError('')
    try {
      await onDelete(removing)
      setRemoving(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '计划删除失败，请重试')
    } finally { setPending(null) }
  }

  return <div className="tasks-view plans-view">
    <div className="tasks-heading">
      <div>
        <span className="eyebrow">YOUR WORKSPACE</span>
        <h1>计划与提醒</h1>
      </div>
      <div className="tasks-heading-actions">
        <button type="button" className="button primary" onClick={() => setEditing(blankPlan())}><Plus size={15} />新建计划</button>
        <div className="task-progress"><span>{enabled}<small> / {plans.length}</small></span><p>启用中</p></div>
      </div>
    </div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="关闭错误"><X size={14} /></button></div>}
    {ordered.length > 0 && <div className="plan-list">{ordered.map(plan => <motion.article layout key={plan.id} className={`plan-card${plan.enabled ? '' : ' is-disabled'}`}>
      <div className="plan-card-copy">
        <h2>{plan.title}</h2>
        {plan.note && <p className="plan-note">{plan.note}</p>}
        <p className="plan-schedule"><CalendarClock size={13} />{planScheduleLabel(plan)}</p>
      </div>
      <div className="plan-card-actions">
        <button type="button" role="switch" aria-checked={plan.enabled} aria-label={`${plan.enabled ? '关闭' : '开启'}提醒：${plan.title}`} className={`switch${plan.enabled ? ' checked' : ''}`} disabled={pending === plan.id} onClick={() => { void toggle(plan) }}><span /></button>
        <button type="button" className="icon-button" aria-label={`编辑计划：${plan.title}`} onClick={() => setEditing({ id: plan.id, title: plan.title, note: plan.note || '', repeat: plan.repeat, date: plan.date || '', time: plan.time, weekdays: plan.weekdays || [], timezone: plan.timezone, enabled: plan.enabled })}><Pencil size={15} /></button>
        <button type="button" className="icon-button danger" aria-label={`删除计划：${plan.title}`} onClick={() => setRemoving(plan)}><Trash2 size={15} /></button>
      </div>
    </motion.article>)}</div>}
    {!plans.length && <div className="tasks-empty"><CalendarClock size={32} strokeWidth={1.2} /><h2>还没有计划</h2><p>新建一个计划，并设置提醒时间。可以只提醒一次，也可以每天或按星期重复。</p></div>}
    {editing && <PlanDialog key={editing.id || 'new'} plan={editing} onClose={() => setEditing(null)} onSave={onSave} />}
    {removing && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && pending !== removing.id) setRemoving(null) }}>
      <motion.section initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-plan-title" onKeyDown={event => trapDialog(event, pending === removing.id, () => setRemoving(null))}>
        <header className="modal-header"><h2 id="delete-plan-title">删除计划</h2><button className="icon-button" type="button" aria-label="关闭" onClick={() => setRemoving(null)} disabled={pending === removing.id}><X size={18} /></button></header>
        <p className="field-help">删除“{removing.title}”后不再提醒。已经发出的提醒仍会留在提醒中心。</p>
        <footer className="modal-footer"><button type="button" className="button secondary" disabled={pending === removing.id} onClick={() => setRemoving(null)}>取消</button><button type="button" className="button danger" disabled={pending === removing.id} onClick={() => { void confirmDelete() }}>{pending === removing.id ? '正在删除…' : '确认删除'}</button></footer>
      </motion.section>
    </div>}
  </div>
}

function PlanDialog({ plan, onClose, onSave }: { plan: PlanDraft; onClose: () => void; onSave: (plan: PlanDraft) => Promise<void> }) {
  const [title, setTitle] = useState(plan.title)
  const [note, setNote] = useState(plan.note || '')
  const [repeat, setRepeat] = useState<PlanRepeat>(plan.repeat)
  const [date, setDate] = useState(plan.date || '')
  const [time, setTime] = useState(plan.time || '09:00')
  const [weekdays, setWeekdays] = useState<number[]>(plan.weekdays || [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const timezone = plan.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone

  function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (!title.trim()) { setError('请填写计划标题'); return }
    if (!time) { setError('请设置提醒时间'); return }
    if (repeat === 'once' && !date) { setError('请设置提醒日期'); return }
    if (repeat === 'weekly' && weekdays.length === 0) { setError('请至少选择一天'); return }
    setSaving(true)
    const draft: PlanDraft = {
      title: title.trim(),
      note: note.trim(),
      repeat,
      date: repeat === 'once' ? date : '',
      time,
      weekdays: repeat === 'weekly' ? [...weekdays].sort((a, b) => a - b) : [],
      timezone,
      enabled: plan.enabled,
    }
    if (plan.id) draft.id = plan.id
    void onSave(draft).then(() => onClose()).catch(cause => setError(cause instanceof Error ? cause.message : '计划保存失败，请重试')).finally(() => setSaving(false))
  }

  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <motion.section initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="modal schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-dialog-title" onKeyDown={event => trapDialog(event, saving, onClose)}>
      <header className="modal-header"><div><span className="eyebrow">PLAN AHEAD</span><h2 id="plan-dialog-title">{plan.id ? '编辑计划' : '新建计划'}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={saving}><X size={18} /></button></header>
      <form noValidate onSubmit={submit}>
        <label className="field-label">计划标题<input autoFocus value={title} onChange={event => setTitle(event.target.value)} disabled={saving} /></label>
        <label className="field-label">备注<textarea value={note} rows={2} onChange={event => setNote(event.target.value)} disabled={saving} placeholder="可选，补充这个计划的说明" /></label>
        <p className="field-label" id="plan-repeat-label">提醒方式</p>
        <div className="repeat-options" role="group" aria-labelledby="plan-repeat-label">
          {([['once', '指定日期'], ['daily', '每天'], ['weekly', '每周']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={repeat === value} disabled={saving} onClick={() => { setRepeat(value); setError('') }}>{label}</button>)}
        </div>
        {repeat === 'once' && <div className="field-label">提醒日期<DateField value={date} onChange={setDate} disabled={saving} /></div>}
        {repeat === 'weekly' && <div className="field-label">重复的星期<div className="weekday-options" role="group" aria-label="重复的星期">{weekdayOptions.map(day => <button key={day.value} type="button" aria-pressed={weekdays.includes(day.value)} disabled={saving} onClick={() => setWeekdays(days => days.includes(day.value) ? days.filter(item => item !== day.value) : [...days, day.value])}>{day.label}</button>)}</div></div>}
        <div className="field-label">提醒时间<TimeField value={time} onChange={setTime} disabled={saving} /></div>
        <p className="field-hint">使用时区：{timezone}。关闭网页期间的提醒会在再次打开时补上最近一次。</p>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <footer className="modal-footer"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving ? '正在保存…' : '保存计划'}</button></footer>
      </form>
    </motion.section>
  </div>
}
