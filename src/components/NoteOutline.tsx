import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { ListTree, X } from 'lucide-react'
import { parseNoteHeadings } from '../noteOutline'
import './NoteOutline.css'

const outlineWidthKey = 'echo:outline-width'
const outlineMinWidth = 180
const outlineMaxWidth = 480
const outlineDefaultWidth = 240

function outlineWidthBounds(parentWidth = 0) {
  const max = parentWidth > 0 ? Math.min(outlineMaxWidth, Math.floor(parentWidth * 0.4)) : outlineMaxWidth
  const min = parentWidth > 0 ? Math.min(outlineMinWidth, max) : outlineMinWidth
  return { min, max }
}

function clampOutlineWidth(value: number, parentWidth = 0) {
  const { min, max } = outlineWidthBounds(parentWidth)
  return Math.round(Math.min(max, Math.max(min, value)))
}

function readOutlineWidth() {
  const stored = localStorage.getItem(outlineWidthKey)
  const value = Number(stored)
  return stored !== null && Number.isFinite(value) ? clampOutlineWidth(value) : outlineDefaultWidth
}

export function NoteOutline({ content, onNavigate, onClose }: { content: string; onNavigate: (line: number) => void; onClose: () => void }) {
  const headings = useMemo(() => parseNoteHeadings(content), [content])
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
  const [width, setWidth] = useState(readOutlineWidth)
  const navRef = useRef<HTMLElement>(null)
  const endDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => endDrag.current?.(), [])
  const parentWidth = () => navRef.current?.parentElement?.clientWidth ?? 0
  const visualWidth = () => navRef.current?.getBoundingClientRect().width || width
  const commit = (next: number) => {
    const value = clampOutlineWidth(next, parentWidth())
    setWidth(value)
    localStorage.setItem(outlineWidthKey, String(value))
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    commit(visualWidth() + (event.key === 'ArrowLeft' ? 16 : -16))
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = visualWidth()
    const limit = parentWidth()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    document.body.classList.add('is-outline-resizing')
    const apply = (clientX: number) => {
      const value = clampOutlineWidth(startWidth + startX - clientX, limit)
      setWidth(value)
      localStorage.setItem(outlineWidthKey, String(value))
    }
    const move = (moveEvent: PointerEvent) => apply(moveEvent.clientX)
    let ended = false
    const stop = () => {
      if (ended) return
      ended = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-outline-resizing')
      endDrag.current = null
    }
    const finish = (endEvent: PointerEvent) => {
      if (ended) return
      apply(endEvent.clientX)
      stop()
    }
    endDrag.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  const bounds = outlineWidthBounds(parentWidth())
  return <nav ref={navRef} className="note-outline" id="note-outline" aria-label="笔记导航" style={{ '--outline-width': `${width}px` } as CSSProperties}>
    <div className="note-outline-resizer" role="separator" aria-orientation="vertical" aria-label="调整笔记导航宽度" aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={width} aria-controls="note-outline" tabIndex={0} onKeyDown={onKeyDown} onPointerDown={onPointerDown} />
    <div className="note-outline-heading"><h2><ListTree size={15} />笔记导航</h2><button className="icon-button" type="button" aria-label="关闭笔记导航" onClick={onClose}><X size={15} /></button></div>
      {headings.length ? <ol className="note-outline-list">{headings.map(heading => <li key={heading.line}>
        <button type="button" className="note-outline-item" data-depth={heading.depth} aria-label={`${heading.depth} 级标题：${heading.title}`} aria-current={selectedLine === heading.line ? 'location' : undefined} title={heading.title} style={{ paddingLeft: 12 + (heading.depth - 1) * 12 }} onClick={() => { setSelectedLine(heading.line); onNavigate(heading.line) }}><span>{heading.title}</span></button>
      </li>)}</ol> : <div className="note-outline-empty"><ListTree size={25} strokeWidth={1.4} /><p>暂无标题</p><small>添加一级至五级标题后，即可在这里快速跳转。</small></div>}
  </nav>
}
