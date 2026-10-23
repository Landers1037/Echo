import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import type { CSSProperties, KeyboardEvent } from 'react'
import './Select.css'

type SelectOption = { value: string; label: string; disabled?: boolean }
type SelectProps = {
  id?: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  compact?: boolean
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export function Select({ id, value, options, onChange, disabled = false, compact = false, className = '', ...aria }: SelectProps) {
  const generatedId = useId()
  const triggerId = id || `select-${generatedId}`
  const listId = `${triggerId}-options`
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const selected = options.findIndex(option => option.value === value)
  const expanded = open && !disabled && options.length > 0
  const firstEnabled = options.findIndex(option => !option.disabled)
  const lastEnabled = options.reduce((last, option, index) => option.disabled ? last : index, -1)

  function show(last = false) {
    if (trigger.current?.matches(':disabled')) return
    search.current = { text: '', time: 0 }
    setActive(selected >= 0 && !options[selected].disabled ? selected : last ? lastEnabled : firstEnabled)
    setOpen(true)
  }

  function choose(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    setOpen(false)
    trigger.current?.focus()
    if (option.value !== value) onChange(option.value)
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (event.altKey && expanded && event.key === 'ArrowUp') { setOpen(false); return }
      if (!expanded) { show(event.key === 'ArrowUp'); return }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      for (let step = 1; step <= options.length; step++) {
        const index = (active + direction * step + options.length) % options.length
        if (!options[index].disabled) { setActive(index); break }
      }
      return
    }
    if (expanded && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      setActive(event.key === 'Home' ? firstEnabled : lastEnabled)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (expanded) choose(active)
      else show()
      return
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    const text = `${event.timeStamp - search.current.time < 700 ? search.current.text : ''}${event.key}`.toLocaleLowerCase()
    search.current = { text, time: event.timeStamp }
    const query = [...text].every(character => character === text[0]) ? text[0] : text
    const start = expanded ? active : selected
    for (let step = 1; step <= options.length; step++) {
      const index = (start + step + options.length) % options.length
      if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(query)) {
        setActive(index)
        setOpen(true)
        break
      }
    }
  }

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useLayoutEffect(() => {
    if (!expanded) return
    function place() {
      if (!trigger.current) return
      const rect = trigger.current.getBoundingClientRect()
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft || 0) + 10
      const topEdge = (viewport?.offsetTop || 0) + 10
      const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 20
      const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 20
      const below = bottomEdge - rect.bottom - 6
      const above = rect.top - topEdge - 6
      const up = below < Math.min(menu.current?.scrollHeight || 280, 280) && above > below
      const width = Math.min(Math.max(rect.width, 180), rightEdge - leftEdge)
      setPosition({
        left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)),
        top: up ? rect.top - 6 : rect.bottom + 6,
        width,
        maxHeight: Math.max(0, Math.min(280, up ? above : below)),
        transform: up ? 'translateY(-100%)' : undefined,
      })
    }
    function outside(event: PointerEvent) {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    function scroll(event: Event) {
      if (!menu.current?.contains(event.target as Node)) setOpen(false)
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (trigger.current) observer?.observe(trigger.current)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer?.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [expanded, options.length])
  useEffect(() => {
    if (expanded && active >= 0) menu.current?.children[active]?.scrollIntoView?.({ block: 'nearest' })
  }, [expanded, active])

  return <div className={`select ${compact ? 'select-compact' : ''} ${className}`}>
    <button {...aria} id={triggerId} ref={trigger} type="button" className="select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined} disabled={disabled || !options.length} onKeyDown={keyDown} onBlur={() => setOpen(false)} onClick={() => { if (expanded) setOpen(false); else show() }}>
      <span className="select-value">{options[selected]?.label || '请选择'}</span><ChevronDown className="select-chevron" size={16} aria-hidden="true" />
    </button>
    {expanded && createPortal(<div id={listId} ref={menu} className="select-menu" role="listbox" aria-labelledby={triggerId} style={position} onMouseDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} className={`select-option ${index === active ? 'is-active' : ''} ${option.value === value ? 'is-selected' : ''}`} onPointerMove={() => { if (!option.disabled) setActive(index) }} onClick={() => choose(index)}>
        <span>{option.label}</span><span className="select-check">{option.value === value && <Check size={15} aria-hidden="true" />}</span>
      </div>)}
    </div>, document.body)}
  </div>
}
