import { useEffect, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import type { TableEditAction } from '../markdownTable'
import './EditableTable.css'

export type EditableTableProps = {
  children: ReactNode
  sourceLine?: number
  onEdit: (startLine: number, action: TableEditAction) => void
} & Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'onContextMenu'>

type PlusHint =
  | { kind: 'row'; at: number; left: number; top: number }
  | { kind: 'column'; at: number; left: number; top: number }

type MenuState = {
  left: number
  top: number
  rowIndex: number | null
  columnIndex: number
  columnCount: number
}

const EDGE = 10

function bodyRowIndex(row: HTMLTableRowElement) {
  const body = row.parentElement
  if (!body || body.tagName !== 'TBODY') return null
  return [...body.children].indexOf(row)
}

function cellInfo(target: EventTarget | null) {
  const cell = target instanceof Element ? target.closest('th,td') : null
  if (!(cell instanceof HTMLTableCellElement)) return null
  const row = cell.parentElement
  if (!(row instanceof HTMLTableRowElement)) return null
  const table = cell.closest('table')
  if (!(table instanceof HTMLTableElement)) return null
  return {
    cell,
    row,
    table,
    columnIndex: cell.cellIndex,
    columnCount: row.cells.length,
    bodyIndex: bodyRowIndex(row),
    isHeader: cell.tagName === 'TH' || row.parentElement?.tagName === 'THEAD',
  }
}

function cellFromPoint(x: number, y: number, root: HTMLElement) {
  const stack = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : []
  for (const element of stack) {
    if (!(element instanceof Element)) continue
    if (element.closest('.table-plus, .table-context-menu')) continue
    if (!root.contains(element)) continue
    const info = cellInfo(element)
    if (info) return info
  }
  return null
}

function sameHint(left: PlusHint | null, right: PlusHint | null) {
  if (!left || !right) return left === right
  return left.kind === right.kind && left.at === right.at && Math.abs(left.left - right.left) < 1 && Math.abs(left.top - right.top) < 1
}

function clampMenu(left: number, top: number, width: number, height: number) {
  const maxLeft = Math.max(8, window.innerWidth - width - 8)
  const maxTop = Math.max(8, window.innerHeight - height - 8)
  return { left: Math.min(Math.max(8, left), maxLeft), top: Math.min(Math.max(8, top), maxTop) }
}

export function EditableTable({ children, sourceLine, onEdit, className, ...props }: EditableTableProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState<PlusHint | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (!menu) return
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    const onScroll = () => setMenu(null)
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  function edit(action: TableEditAction) {
    if (!sourceLine) return
    onEdit(sourceLine, action)
    setHint(null)
    setMenu(null)
  }

  function updateHint(event: ReactMouseEvent<HTMLDivElement>) {
    if (menu) return
    const wrap = wrapRef.current
    if (!wrap) return
    // Ignore the floating + itself so hovering it doesn't drop the cell target and flicker.
    if (event.target instanceof Element && event.target.closest('.table-plus')) return
    const info = cellFromPoint(event.clientX, event.clientY, wrap) || cellInfo(event.target)
    if (!info) {
      setHint(current => current ? null : current)
      return
    }
    const rect = info.cell.getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    const distTop = event.clientY - rect.top
    const distBottom = rect.bottom - event.clientY
    const distLeft = event.clientX - rect.left
    const distRight = rect.right - event.clientX
    const nearTop = distTop <= EDGE
    const nearBottom = distBottom <= EDGE
    const nearLeft = distLeft <= EDGE
    const nearRight = distRight <= EDGE
    if (!nearTop && !nearBottom && !nearLeft && !nearRight) {
      setHint(current => current ? null : current)
      return
    }

    const horizontal = Math.min(nearTop ? distTop : Infinity, nearBottom ? distBottom : Infinity)
    const vertical = Math.min(nearLeft ? distLeft : Infinity, nearRight ? distRight : Infinity)
    // Hysteresis keeps the same axis while the pointer sits on a corner.
    const preferRow = hint?.kind === 'row'
      ? horizontal <= vertical + 4
      : hint?.kind === 'column'
        ? horizontal + 4 < vertical
        : horizontal <= vertical

    let next: PlusHint | null = null
    if (preferRow && (nearTop || nearBottom)) {
      let at = 0
      if (info.isHeader) at = 0
      else if (info.bodyIndex !== null) at = nearTop ? info.bodyIndex : info.bodyIndex + 1
      else at = info.table.tBodies[0]?.rows.length || 0
      next = {
        kind: 'row',
        at,
        left: rect.left + rect.width / 2 - wrapRect.left,
        top: (nearTop ? rect.top : rect.bottom) - wrapRect.top,
      }
    } else if (nearLeft || nearRight) {
      next = {
        kind: 'column',
        at: nearLeft ? info.columnIndex : info.columnIndex + 1,
        left: (nearLeft ? rect.left : rect.right) - wrapRect.left,
        top: rect.top + rect.height / 2 - wrapRect.top,
      }
    }
    setHint(current => sameHint(current, next) ? current : next)
  }

  function openMenu(event: ReactMouseEvent<HTMLDivElement>) {
    const info = cellInfo(event.target)
    if (!info || !sourceLine) return
    event.preventDefault()
    event.stopPropagation()
    setHint(null)
    setMenu({
      left: event.clientX,
      top: event.clientY,
      rowIndex: info.bodyIndex,
      columnIndex: info.columnIndex,
      columnCount: info.columnCount,
    })
  }

  const menuPos = menu ? clampMenu(menu.left, menu.top, 180, 170) : null

  return <div
    {...props}
    ref={wrapRef}
    className={`editable-table${className ? ` ${className}` : ''}`}
    data-source-line={sourceLine}
    onMouseMove={updateHint}
    onMouseLeave={() => setHint(null)}
    onContextMenu={openMenu}
  >
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
    {hint && sourceLine && <button
      type="button"
      className={`table-plus table-plus-${hint.kind}`}
      style={{ left: hint.left, top: hint.top }}
      aria-label={hint.kind === 'row' ? '新增行' : '新增列'}
      onMouseDown={event => event.preventDefault()}
      onClick={event => {
        event.stopPropagation()
        edit(hint.kind === 'row' ? { type: 'insertRow', at: hint.at } : { type: 'insertColumn', at: hint.at })
      }}
    ><Plus size={14} strokeWidth={2.4} /></button>}
    {menu && menuPos && createPortal(<div
      ref={menuRef}
      className="table-context-menu"
      style={{ left: menuPos.left, top: menuPos.top }}
      role="menu"
    >
      <button type="button" role="menuitem" onClick={() => edit({ type: 'insertRow', at: menu.rowIndex === null ? 0 : menu.rowIndex + 1 })}>插入行</button>
      <button type="button" role="menuitem" onClick={() => edit({ type: 'insertColumn', at: menu.columnIndex + 1 })}>插入列</button>
      <button type="button" role="menuitem" disabled={menu.rowIndex === null} onClick={() => menu.rowIndex !== null && edit({ type: 'deleteRow', index: menu.rowIndex })}>删除当前行</button>
      <button type="button" role="menuitem" disabled={menu.columnCount <= 1} onClick={() => edit({ type: 'deleteColumn', index: menu.columnIndex })}>删除当前列</button>
    </div>, document.body)}
  </div>
}
