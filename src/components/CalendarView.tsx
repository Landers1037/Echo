import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { NoteSummary } from '../types'
import { MonthYearPicker } from './SchedulePicker'
import './CalendarView.css'

const weekLabels = ['一', '二', '三', '四', '五', '六', '日']

type CalendarNote = { note: NoteSummary; date: Date }

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatISO(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayLabel(year: number, month: number, day: number) {
  return `${year}年${month + 1}月${day}日`
}

function noteDate(note: NoteSummary) {
  const parsed = new Date(note.created || note.modified || '')
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function noteTitle(note: NoteSummary) {
  return note.title || note.path.replace(/\.md$/i, '').split('/').pop() || note.path
}

function noteDirectory(path: string) {
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : '根目录'
}

function formatCreated(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function groupNotes(notes: NoteSummary[]) {
  const groups = new Map<string, CalendarNote[]>()
  for (const note of notes) {
    const date = noteDate(note)
    if (!date) continue
    const key = formatISO(date)
    const list = groups.get(key) || []
    list.push({ note, date })
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.date.getTime() - b.date.getTime() || a.note.path.localeCompare(b.note.path, 'zh-CN'))
  }
  return groups
}

export function CalendarView({ notes, onOpen }: { notes: NoteSummary[]; onOpen: (path: string) => void }) {
  const [cursor, setCursor] = useState(() => new Date())
  const [day, setDay] = useState<string | null>(null)
  const groups = useMemo(() => groupNotes(notes), [notes])
  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const lead = (new Date(year, month, 1).getDay() + 6) % 7
  const days = new Date(year, month + 1, 0).getDate()
  const today = formatISO(new Date())
  const selected = day ? groups.get(day) || [] : []
  const selectedDate = day ? new Date(`${day}T00:00:00`) : null

  if (day && selectedDate && !Number.isNaN(selectedDate.getTime())) {
    const label = dayLabel(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate())
    return <section className="tasks-view calendar-view">
      <button type="button" className="button calendar-back" onClick={() => setDay(null)}><ChevronLeft size={16} />返回日历</button>
      <div className="tasks-heading">
        <div>
          <span className="eyebrow">CALENDAR</span>
          <h1>{label}</h1>
          <p>{selected.length ? `这一天新建了 ${selected.length} 篇笔记` : '这一天没有新建笔记'}</p>
        </div>
      </div>
      <div className="calendar-scroll">
        {selected.length > 0 && <div className="calendar-notes">
          {selected.map(({ note, date }) => <button type="button" className="calendar-note" key={note.path} onClick={() => onOpen(note.path)}>
            <strong>{noteTitle(note)}</strong>
            <span className="calendar-note-field"><small>创建时间</small><time dateTime={note.created || note.modified}>{formatCreated(date)}</time></span>
            <span className="calendar-note-field"><small>字数</small><span>{(note.words ?? 0).toLocaleString('zh-CN')}</span></span>
            <span className="calendar-note-field"><small>所属目录</small><span>{noteDirectory(note.path)}</span></span>
          </button>)}
        </div>}
      </div>
    </section>
  }

  return <section className="tasks-view calendar-view">
    <div className="tasks-heading">
      <div>
        <span className="eyebrow">CALENDAR</span>
        <h1>日历视图</h1>
        <p>按创建日期查看每天新增的笔记。</p>
      </div>
    </div>
    <div className="calendar-scroll">
      <div className="calendar-toolbar">
        <button type="button" className="icon-button" aria-label="上个月" onClick={() => setCursor(new Date(year, month - 1, 1))}><ChevronLeft size={16} /></button>
        <MonthYearPicker year={year} month={month} testId="note-calendar-month" onChange={(nextYear, nextMonth) => setCursor(new Date(nextYear, nextMonth, 1))} />
        <button type="button" className="icon-button" aria-label="下个月" onClick={() => setCursor(new Date(year, month + 1, 1))}><ChevronRight size={16} /></button>
        <button type="button" className="button" onClick={() => setCursor(new Date())}>今天</button>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">{weekLabels.map(label => <span key={label}>{label}</span>)}</div>
      <div className="calendar-grid" role="group" aria-label="笔记日历">
        {Array.from({ length: lead }, (_, index) => <span key={`empty-${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const date = index + 1
          const iso = formatISO(new Date(year, month, date))
          const items = groups.get(iso) || []
          const label = dayLabel(year, month, date)
          const titles = items.map(item => noteTitle(item.note))
          return <button key={iso} type="button" className={`calendar-day${iso === today ? ' is-today' : ''}${items.length ? ' has-notes' : ''}`} aria-label={items.length ? `${label}，新建 ${items.length} 篇` : label} onClick={() => setDay(iso)}>
            <span className="calendar-day-number">{date}</span>
            {items.length > 0 && <small>{items.length} 篇</small>}
            {titles.slice(0, 2).map((title, titleIndex) => <span className="calendar-day-title" key={`${title}-${titleIndex}`}>{title}</span>)}
            {titles.length > 2 && <span className="calendar-day-more">+{titles.length - 2}</span>}
          </button>
        })}
      </div>
    </div>
  </section>
}
