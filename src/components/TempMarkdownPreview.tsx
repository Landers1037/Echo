import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FileText, ListTree, Maximize2, X } from 'lucide-react'
import { displayedNoteTitle } from '../noteTitle'
import type { TempMarkdownFile } from '../tempMarkdown'
import { MarkdownView } from './MarkdownView'
import { NoteOutline } from './NoteOutline'

type Props = {
  file: TempMarkdownFile
  fontSize: number
  lineNumbers: boolean
  dark: boolean
  strictLineBreaks: boolean
  autoParseLinks: boolean
  animations: boolean
  onClose: () => void
}

function fileFallback(name: string) {
  return name.replace(/\.md$/i, '') || name || '临时预览'
}

export function TempMarkdownPreview({ file, fontSize, lineNumbers, dark, strictLineBreaks, autoParseLinks, animations, onClose }: Props) {
  const fallback = fileFallback(file.name)
  const title = displayedNoteTitle(file.content, fallback) || fallback
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const outlineButton = useRef<HTMLButtonElement>(null)
  const fullscreenButton = useRef<HTMLButtonElement>(null)

  function scrollToHeading(line: number) {
    const heading = previewRef.current?.querySelector<HTMLElement>(`[data-heading-line="${line}"]`)
    heading?.scrollIntoView({ block: 'start', behavior: animations && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' })
    heading?.focus({ preventScroll: true })
  }

  const preview = <MarkdownView content={file.content} notePath={file.name} fontSize={fontSize} lineNumbers={lineNumbers} dark={dark} strictLineBreaks={strictLineBreaks} autoParseLinks={autoParseLinks} />

  return <div className="temp-markdown-preview" role="region" aria-label={`预览 ${file.name}`}>
    <section className="note-heading">
      <div className="note-title-row">
        <h1 className="docx-title"><FileText size={20} /><span>{title}</span></h1>
        <div className="note-title-actions">
          <span className="temp-markdown-badge">临时</span>
          <button type="button" className="icon-button" aria-label="关闭临时预览" title="关闭" onClick={onClose}><X size={18} /></button>
        </div>
      </div>
      <p className="field-help">{file.name} · 临时只读预览（仅保存在浏览器中，关闭标签页后清除）</p>
    </section>
    <div className="mode-bar">
      <button ref={fullscreenButton} type="button" className="outline-toggle" aria-label="全屏预览" onClick={() => setFullscreen(true)}><Maximize2 size={15} />全屏</button>
      <button ref={outlineButton} type="button" className="outline-toggle" aria-label="导航" aria-expanded={outlineOpen} aria-controls="note-outline" onClick={() => setOutlineOpen(open => !open)}><ListTree size={15} />导航</button>
    </div>
    <div className="note-body">
      {outlineOpen && <NoteOutline key={file.id} content={file.content} onNavigate={scrollToHeading} onClose={() => { setOutlineOpen(false); outlineButton.current?.focus() }} />}
      <div className="note-content">
        <div ref={previewRef} className="preview-area">{preview}</div>
      </div>
    </div>
    {fullscreen && <FullscreenMarkdown title={title} onClose={() => { setFullscreen(false); fullscreenButton.current?.focus() }}>{preview}</FullscreenMarkdown>}
  </div>
}

function FullscreenMarkdown({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const node = ref.current
    const onChange = () => { if (!document.fullscreenElement) close.current() }
    document.addEventListener('fullscreenchange', onChange)
    void node?.requestFullscreen?.().catch(() => {})
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement === node) void document.exitFullscreen().catch(() => {})
    }
  }, [])
  return createPortal(<div ref={ref} className="fullscreen-preview" role="region" aria-label="全屏预览">
    <div className="fullscreen-preview-bar"><h2>{title}</h2><button type="button" className="outline-toggle" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => close.current()); else close.current() }}><X size={15} />退出全屏</button></div>
    <div className="preview-area">{children}</div>
  </div>, document.body)
}
