import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export function Modal({ title, children, onClose, wide = false, className = '', actions }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string; actions?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => (ref.current?.querySelector<HTMLElement>('input,select,textarea,[role="combobox"]') || ref.current?.querySelector<HTMLElement>('button'))?.focus(), 30)
    function key(event: KeyboardEvent) {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== ref.current) return
      if (event.key === 'Escape') { event.stopPropagation(); close.current() }
      if (event.key !== 'Tab') return
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key); previous?.focus() }
  }, [])
  return createPortal(<motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <motion.div className={`modal ${wide ? 'modal-wide' : ''} ${className}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .16 }}>
      <div className="modal-heading"><h2>{title}</h2><div className="modal-heading-tools">{actions}<button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={18} /></button></div></div>
      {children}
    </motion.div>
  </motion.div>, document.body)
}

export function ModalPresence({ children }: { children: ReactNode }) { return <AnimatePresence>{children}</AnimatePresence> }

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button className={`switch ${checked ? 'checked' : ''}`} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
}
