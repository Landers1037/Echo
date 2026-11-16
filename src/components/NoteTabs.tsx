import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { isTempMarkdownPath } from '../tempMarkdown'
import './NoteTabs.css'

function noteName(path: string) {
  return path.split('/').pop()?.replace(/\.(?:md|docx|pptx|xlsx|html|htm)$/i, '') || path
}

export function NoteTabs({ tabs, active, dirty, onSelect, onClose, getTabLabel, getTabTitle }: { tabs: string[]; active: string; dirty: boolean; onSelect: (path: string) => void; onClose: (path: string) => void; getTabLabel?: (path: string) => string | undefined; getTabTitle?: (path: string) => string | undefined }) {
  const activeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const node = activeRef.current
    if (!node || typeof node.scrollIntoView !== 'function') return
    try { node.scrollIntoView({ inline: 'nearest', block: 'nearest' }) } catch { /* jsdom has no layout */ }
  }, [active])
  return <div className="note-tabs" role="tablist" aria-label="已打开的笔记">
    {tabs.map(path => {
      const name = getTabLabel?.(path) || noteName(path)
      const selected = path === active
      const temporary = isTempMarkdownPath(path)
      return <div key={path} role="presentation" className={`note-tab${temporary ? ' temporary' : ''}${selected ? ' active' : ''}${selected && dirty ? ' dirty' : ''}`} onMouseDown={event => { if (event.button === 1) event.preventDefault() }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(path) } }}>
        <button ref={selected ? activeRef : undefined} type="button" role="tab" aria-selected={selected} title={getTabTitle?.(path) || path} onClick={() => onSelect(path)}>{name}</button>
        {selected && dirty && <span className="note-tab-dirty" aria-hidden="true" />}
        <button type="button" className="note-tab-close" aria-label={`关闭 ${name}`} onClick={() => onClose(path)}><X size={12} /></button>
      </div>
    })}
  </div>
}
