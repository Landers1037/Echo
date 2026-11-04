import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import './EditorContextMenu.css'

export type EditorContextMenuAction = {
  id: string
  kind?: 'action'
  label: string
  shortcut?: string
  disabled?: boolean
  action: () => void
}

export type EditorContextMenuSubmenu = {
  id: string
  kind: 'submenu'
  label: string
  disabled?: boolean
  children: EditorContextMenuAction[]
}

export type EditorContextMenuSeparator = {
  id: string
  kind: 'separator'
}

export type EditorContextMenuItem = EditorContextMenuAction | EditorContextMenuSubmenu | EditorContextMenuSeparator

export type EditorContextMenuProps = {
  left: number
  top: number
  items: EditorContextMenuItem[]
  onClose: () => void
}

function clampMenu(left: number, top: number, width: number, height: number) {
  const maxLeft = Math.max(8, window.innerWidth - width - 8)
  const maxTop = Math.max(8, window.innerHeight - height - 8)
  return { left: Math.min(Math.max(8, left), maxLeft), top: Math.min(Math.max(8, top), maxTop) }
}

function isAction(item: EditorContextMenuItem): item is EditorContextMenuAction {
  return !item.kind || item.kind === 'action'
}

function isSubmenu(item: EditorContextMenuItem): item is EditorContextMenuSubmenu {
  return item.kind === 'submenu'
}

function focusableItems(items: EditorContextMenuItem[]) {
  return items.filter((item): item is EditorContextMenuAction | EditorContextMenuSubmenu => {
    if (item.kind === 'separator') return false
    return !item.disabled
  })
}

export function EditorContextMenu({ left, top, items, onClose }: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left, top })
  const [submenuId, setSubmenuId] = useState<string | null>(null)
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number } | null>(null)
  const [activeId, setActiveId] = useState<string | null>(() => focusableItems(items)[0]?.id ?? null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    setPosition(clampMenu(left, top, rect.width, rect.height))
  }, [left, top, items])

  useLayoutEffect(() => {
    if (!submenuId) {
      setSubmenuPos(null)
      return
    }
    const menu = menuRef.current
    const submenu = submenuRef.current
    const trigger = menu?.querySelector<HTMLElement>(`[data-menu-id="${submenuId}"]`)
    if (!menu || !submenu || !trigger) return
    const triggerRect = trigger.getBoundingClientRect()
    const submenuRect = submenu.getBoundingClientRect()
    const preferRight = triggerRect.right + 4 + submenuRect.width <= window.innerWidth - 8
    const nextLeft = preferRight ? triggerRect.right + 4 : triggerRect.left - submenuRect.width - 4
    setSubmenuPos(clampMenu(nextLeft, triggerRect.top - 5, submenuRect.width, submenuRect.height))
  }, [submenuId])

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || submenuRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (submenuId) setSubmenuId(null)
        else onClose()
      }
    }
    const onScroll = () => onClose()
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, submenuId])

  useEffect(() => {
    menuRef.current?.focus()
  }, [])

  function runAction(item: EditorContextMenuAction) {
    if (item.disabled) return
    item.action()
    onClose()
  }

  function openSubmenu(id: string) {
    setSubmenuId(id)
    setActiveId(id)
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const focusables = focusableItems(items)
    if (!focusables.length) return
    const currentIndex = Math.max(0, focusables.findIndex(item => item.id === activeId))
    const current = focusables[currentIndex]
    const submenu = current && isSubmenu(current) ? current : items.find(item => isSubmenu(item) && item.id === submenuId)

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (submenuId && submenu && isSubmenu(submenu)) {
        const children = submenu.children.filter(item => !item.disabled)
        if (!children.length) return
        const childIndex = children.findIndex(item => item.id === activeId)
        const next = children[(childIndex + 1 + children.length) % children.length]
        setActiveId(next.id)
        return
      }
      const next = focusables[(currentIndex + 1) % focusables.length]
      setActiveId(next.id)
      setSubmenuId(isSubmenu(next) ? next.id : null)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (submenuId && submenu && isSubmenu(submenu)) {
        const children = submenu.children.filter(item => !item.disabled)
        if (!children.length) return
        const childIndex = children.findIndex(item => item.id === activeId)
        const next = children[(childIndex - 1 + children.length) % children.length]
        setActiveId(next.id)
        return
      }
      const next = focusables[(currentIndex - 1 + focusables.length) % focusables.length]
      setActiveId(next.id)
      setSubmenuId(isSubmenu(next) ? next.id : null)
      return
    }

    if (event.key === 'ArrowRight' && current && isSubmenu(current)) {
      event.preventDefault()
      openSubmenu(current.id)
      const first = current.children.find(item => !item.disabled)
      if (first) setActiveId(first.id)
      return
    }

    if (event.key === 'ArrowLeft' && submenuId) {
      event.preventDefault()
      setActiveId(submenuId)
      setSubmenuId(null)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (submenuId && submenu && isSubmenu(submenu)) {
        const child = submenu.children.find(item => item.id === activeId)
        if (child) runAction(child)
        return
      }
      if (current && isSubmenu(current)) {
        openSubmenu(current.id)
        const first = current.children.find(item => !item.disabled)
        if (first) setActiveId(first.id)
        return
      }
      if (current && isAction(current)) runAction(current)
    }
  }

  const openSubmenuItem = items.find((item): item is EditorContextMenuSubmenu => isSubmenu(item) && item.id === submenuId)

  return createPortal(<>
    <div
      ref={menuRef}
      className="editor-context-menu"
      style={{ left: position.left, top: position.top }}
      role="menu"
      tabIndex={-1}
      aria-label="编辑器快捷菜单"
      onKeyDown={onMenuKeyDown}
      onContextMenu={(event: ReactMouseEvent) => event.preventDefault()}
    >
      {items.map(item => {
        if (item.kind === 'separator') return <div key={item.id} className="editor-context-menu-separator" role="separator" />
        if (isSubmenu(item)) {
          return <button
            key={item.id}
            type="button"
            role="menuitem"
            data-menu-id={item.id}
            data-active={activeId === item.id || submenuId === item.id ? 'true' : undefined}
            className="editor-context-menu-item"
            disabled={item.disabled}
            aria-haspopup="menu"
            aria-expanded={submenuId === item.id}
            onMouseEnter={() => { if (!item.disabled) openSubmenu(item.id) }}
            onMouseDown={event => event.preventDefault()}
            onClick={() => { if (!item.disabled) openSubmenu(item.id) }}
          >
            <span className="editor-context-menu-label">{item.label}</span>
            <span className="editor-context-menu-meta"><ChevronRight size={14} strokeWidth={1.8} /></span>
          </button>
        }
        return <button
          key={item.id}
          type="button"
          role="menuitem"
          data-menu-id={item.id}
          data-active={activeId === item.id ? 'true' : undefined}
          className="editor-context-menu-item"
          disabled={item.disabled}
          onMouseEnter={() => { setSubmenuId(null); setActiveId(item.id) }}
          onMouseDown={event => event.preventDefault()}
          onClick={() => runAction(item)}
        >
          <span className="editor-context-menu-label">{item.label}</span>
          {item.shortcut ? <span className="editor-context-menu-meta">{item.shortcut}</span> : null}
        </button>
      })}
    </div>
    {openSubmenuItem && <div
      ref={submenuRef}
      className="editor-context-menu-submenu"
      style={{ left: submenuPos?.left ?? -9999, top: submenuPos?.top ?? -9999, visibility: submenuPos ? 'visible' : 'hidden' }}
      role="menu"
      aria-label={openSubmenuItem.label}
      onContextMenu={(event: ReactMouseEvent) => event.preventDefault()}
    >
      {openSubmenuItem.children.map(child => <button
        key={child.id}
        type="button"
        role="menuitem"
        data-menu-id={child.id}
        data-active={activeId === child.id ? 'true' : undefined}
        className="editor-context-menu-item"
        disabled={child.disabled}
        onMouseEnter={() => setActiveId(child.id)}
        onMouseDown={event => event.preventDefault()}
        onClick={() => runAction(child)}
      >
        <span className="editor-context-menu-label">{child.label}</span>
        {child.shortcut ? <span className="editor-context-menu-meta">{child.shortcut}</span> : null}
      </button>)}
    </div>}
  </>, document.body)
}
