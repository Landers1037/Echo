import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import './NoteTabs.css'

function noteName(path: string) {
  return path.split('/').pop()?.replace(/\.md$/i, '') || path
}

export function NoteTabs({ tabs, active, dirty, onSelect, onClose }: { tabs: string[]; active: string; dirty: boolean; onSelect: (path: string) => void; onClose: (path: string) => void }) {
  const activeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const node = activeRef.current
    if (!node || typeof node.scrollIntoView !== 'function') return
    try { node.scrollIntoView({ inline: 'nearest', block: 'nearest' }) } catch { /* jsdom has no layout */ }
  }, [active])
  return <div className="note-tabs" role="tablist" aria-label="已打开的笔记">
    {tabs.map(path => {
      const name = noteName(path)
      const selected = path === active
      return <div key={path} role="presentation" className={`note-tab${selected ? ' active' : ''}${selected && dirty ? ' dirty' : ''}`} onMouseDown={event => { if (event.button === 1) event.preventDefault() }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(path) } }}>
        <button ref={selected ? activeRef : undefined} type="button" role="tab" aria-selected={selected} title={path} onClick={() => onSelect(path)}>{name}</button>
        {selected && dirty && <span className="note-tab-dirty" aria-hidden="true" />}
        <button type="button" className="note-tab-close" aria-label={`关闭 ${name}`} onClick={() => onClose(path)}><X size={12} /></button>
      </div>
    })}
  </div>
}
