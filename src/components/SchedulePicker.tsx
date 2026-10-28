import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'

const weekLabels = ['一', '二', '三', '四', '五', '六', '日']
const minutePresets = [0, 15, 30, 45]

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function parseISODate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

function formatISO(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseClock(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return { hour: 9, minute: 0 }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return { hour: 9, minute: 0 }
  return { hour, minute }
}

export function DateField({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const selected = parseISODate(value)
  const [cursor, setCursor] = useState(() => selected || new Date())
  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const lead = (new Date(year, month, 1).getDay() + 6) % 7
  const days = new Date(year, month + 1, 0).getDate()
  const today = formatISO(new Date())
  const inView = !!selected && selected.getFullYear() === year && selected.getMonth() === month

  return <div className="month-calendar">
    <div className="month-calendar-bar">
      <button type="button" className="icon-button" aria-label="上个月" disabled={disabled} onClick={() => setCursor(new Date(year, month - 1, 1))}><ChevronLeft size={16} /></button>
      <strong data-testid="calendar-month">{year}年{month + 1}月</strong>
      <button type="button" className="icon-button" aria-label="下个月" disabled={disabled} onClick={() => setCursor(new Date(year, month + 1, 1))}><ChevronRight size={16} /></button>
    </div>
    {selected && !inView && <button type="button" className="month-jump" disabled={disabled} onClick={() => setCursor(new Date(selected.getFullYear(), selected.getMonth(), 1))}>已选 {selected.getMonth() + 1}月{selected.getDate()}日</button>}
    <div className="month-weekdays" aria-hidden="true">{weekLabels.map(label => <span key={label}>{label}</span>)}</div>
    <div className="month-grid" role="group" aria-label="提醒日期">
      {Array.from({ length: lead }, (_, index) => <span key={`empty-${index}`} />)}
      {Array.from({ length: days }, (_, index) => {
        const day = index + 1
        const iso = formatISO(new Date(year, month, day))
        return <button key={iso} type="button" aria-pressed={value === iso} aria-label={`${year}年${month + 1}月${day}日`} className={iso === today ? 'is-today' : ''} disabled={disabled} onClick={() => onChange(iso)}>{day}</button>
      })}
    </div>
  </div>
}

export function TimeField({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { hour, minute } = parseClock(value)
  function commit(nextHour: number, nextMinute: number) {
    onChange(`${pad((nextHour + 24) % 24)}:${pad((nextMinute + 60) % 60)}`)
  }
  function spin(event: KeyboardEvent<HTMLElement>, current: number, max: number, apply: (next: number) => void) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    apply((current + (event.key === 'ArrowUp' ? 1 : max)) % (max + 1))
  }

  return <div className="time-field">
    <div className="time-field-row">
      <div className="time-unit">
        <span aria-hidden="true">时</span>
        <div className="time-stepper">
          <button type="button" className="icon-button" aria-label="减少小时" disabled={disabled} onClick={() => commit(hour - 1, minute)}><Minus size={14} /></button>
          <span role="spinbutton" aria-label="时" aria-valuemin={0} aria-valuemax={23} aria-valuenow={hour} aria-valuetext={`${hour}时`} tabIndex={disabled ? -1 : 0} onKeyDown={event => spin(event, hour, 23, next => commit(next, minute))}>{pad(hour)}</span>
          <button type="button" className="icon-button" aria-label="增加小时" disabled={disabled} onClick={() => commit(hour + 1, minute)}><Plus size={14} /></button>
        </div>
      </div>
      <span className="time-colon" aria-hidden="true">:</span>
      <div className="time-unit">
        <span aria-hidden="true">分</span>
        <div className="time-stepper">
          <button type="button" className="icon-button" aria-label="减少分钟" disabled={disabled} onClick={() => commit(hour, minute - 1)}><Minus size={14} /></button>
          <span role="spinbutton" aria-label="分" aria-valuemin={0} aria-valuemax={59} aria-valuenow={minute} aria-valuetext={`${minute}分`} tabIndex={disabled ? -1 : 0} onKeyDown={event => spin(event, minute, 59, next => commit(hour, next))}>{pad(minute)}</span>
          <button type="button" className="icon-button" aria-label="增加分钟" disabled={disabled} onClick={() => commit(hour, minute + 1)}><Plus size={14} /></button>
        </div>
      </div>
    </div>
    <div className="minute-presets" role="group" aria-label="快捷分钟">{minutePresets.map(preset => <button key={preset} type="button" aria-pressed={minute === preset} aria-label={`${pad(preset)}分`} disabled={disabled} onClick={() => commit(hour, preset)}>{pad(preset)}</button>)}</div>
  </div>
}
