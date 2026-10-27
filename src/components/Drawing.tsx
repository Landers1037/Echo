import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Eye, LoaderCircle, Pencil, PenLine, X } from 'lucide-react'
import { api, ApiError, json, query } from '../api'
import type { Drawing } from '../types'

type ExcalidrawModule = typeof import('@excalidraw/excalidraw')
type Scene = ReturnType<ExcalidrawModule['restore']>
type ExportFormat = 'svg' | 'png' | 'jpg'

const Excalidraw = lazy(async () => {
  const module = await import('@excalidraw/excalidraw')
  return { default: module.Excalidraw }
})

const libraryRef: { current: Promise<ExcalidrawModule> | null } = { current: null }
function loadLibrary() {
  libraryRef.current ??= import('@excalidraw/excalidraw')
  return libraryRef.current
}

function drawingTitle(path: string) {
  return (path.split('/').pop() || '绘图').replace(/\.excalidraw$/i, '') || '绘图'
}

function decodeDataUrl(value: string) {
  const payload = value.slice(value.indexOf(',') + 1)
  const binary = atob(payload)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

async function readScene(source: string) {
  const content = source.startsWith('data:') ? decodeDataUrl(source) : (await api<Drawing>(`/drawings?path=${query(source)}`)).content
  const parsed = JSON.parse(content) as { elements?: Scene['elements']; appState?: Scene['appState']; files?: Scene['files'] }
  const library = await loadLibrary()
  return library.restore({ elements: parsed.elements || [], appState: parsed.appState, files: parsed.files || {} }, null, null)
}

function sceneSignature(library: ExcalidrawModule, elements: Parameters<ExcalidrawModule['getSceneVersion']>[0], background: string, files: Scene['files']) {
  return `${library.getSceneVersion(elements)}|${background}|${Object.keys(files).sort().join(',')}`
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function DrawingEmbed({ path, alt = '绘图', exporting = false, version = 0, onEdit }: { path: string; alt?: string; exporting?: boolean; version?: number; onEdit?: (path: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [rendering, setRendering] = useState(true)
  const [empty, setEmpty] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setRendering(true)
    setEmpty(false)
    setError('')
    host.current?.replaceChildren()
    void readScene(path).then(async scene => {
      const visible = scene.elements.some(element => !element.isDeleted)
      if (!alive) return
      if (!visible) { setEmpty(true); setRendering(false); return }
      const library = await loadLibrary()
      const svg = await library.exportToSvg({ elements: scene.elements.filter(element => !element.isDeleted), appState: { ...scene.appState, exportBackground: true }, files: scene.files, exportPadding: 16 })
      if (!alive) return
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', alt)
      host.current?.replaceChildren(svg)
      setRendering(false)
    }).catch(() => { if (alive) { setError('绘图无法显示'); setRendering(false) } })
    return () => { alive = false }
  }, [alt, path, version])
  return <div className="drawing-embed">
    <div ref={host} className="drawing-frame" data-rendering={rendering ? 'true' : undefined} />
    {empty && <p className="drawing-empty">空白绘图</p>}
    {error && <p className="drawing-error">{error}</p>}
    {!exporting && onEdit && <button type="button" className="drawing-edit" aria-label="编辑绘图" title="编辑绘图" onClick={() => onEdit(path)}><Pencil size={15} /></button>}
  </div>
}

function CanvasFallback() {
  return <div className="drawing-loading" data-rendering="true"><LoaderCircle className="spin" size={18} /><span>正在打开绘图…</span></div>
}

class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p className="drawing-error">绘图面板无法打开。</p> : this.props.children }
}

export function DrawingModal({ path, editing, dark, onClose, onConflict, onError, onRegisterFlush }: { path: string; editing: boolean; dark: boolean; onClose: () => void; onConflict: () => void; onError: (message: string) => void; onRegisterFlush?: (flush: (() => Promise<void>) | null) => void }) {
  const [scene, setScene] = useState<Scene | null>(null)
  const [mode, setMode] = useState(editing)
  const [menu, setMenu] = useState(false)
  const [status, setStatus] = useState('已保存')
  const [loadError, setLoadError] = useState('')
  const apiRef = useRef<import('@excalidraw/excalidraw/types').ExcalidrawImperativeAPI | null>(null)
  const snapshot = useRef<[Parameters<ExcalidrawModule['serializeAsJSON']>[0], Parameters<ExcalidrawModule['serializeAsJSON']>[1], Parameters<ExcalidrawModule['serializeAsJSON']>[2]] | null>(null)
  const revision = useRef('')
  const signature = useRef('')
  const dirty = useRef(false)
  const blocked = useRef(false)
  const timer = useRef<number | null>(null)
  const saving = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)
  const menuRef = useRef<HTMLDivElement>(null)

  async function persist() {
    const current = snapshot.current
    if (!current || blocked.current || !dirty.current) return
    const library = await loadLibrary()
    const content = library.serializeAsJSON(current[0], current[1], current[2], 'local')
    const expected = revision.current
    dirty.current = false
    if (mounted.current) setStatus('保存中')
    try {
      const saved = await api<Drawing>('/drawings', json('PUT', { path, content, revision: expected }))
      if (revision.current === expected) revision.current = saved.revision
      if (mounted.current) setStatus('已保存')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        blocked.current = true
        if (mounted.current) setStatus('版本冲突')
        onConflict()
        return
      }
      dirty.current = true
      if (mounted.current) setStatus('保存失败')
      onError(error instanceof Error ? error.message : '绘图保存失败')
    }
  }

  async function flush() {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
    if (saving.current) await saving.current
    if (!dirty.current || blocked.current) return
    const run = persist()
    saving.current = run
    try { await run } finally { if (saving.current === run) saving.current = null }
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => {
    mounted.current = true
    onRegisterFlush?.(() => flushRef.current())
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      mounted.current = false
      void flushRef.current()
      onRegisterFlush?.(null)
    }
  }, [onRegisterFlush])

  useEffect(() => {
    let alive = true
    setScene(null)
    setLoadError('')
    blocked.current = false
    dirty.current = false
    void api<Drawing>(`/drawings?path=${query(path)}`).then(async drawing => {
      const library = await loadLibrary()
      const parsed = JSON.parse(drawing.content) as { elements?: Scene['elements']; appState?: Scene['appState']; files?: Scene['files'] }
      const restored = library.restore({ elements: parsed.elements || [], appState: parsed.appState, files: parsed.files || {} }, null, null)
      if (!alive) return
      revision.current = drawing.revision
      signature.current = sceneSignature(library, restored.elements, restored.appState.viewBackgroundColor, restored.files)
      setScene(restored)
    }).catch(error => { if (alive) setLoadError(error instanceof Error ? error.message : '绘图无法打开') })
    return () => { alive = false }
  }, [path])

  useEffect(() => {
    if (!menu) return
    function pointer(event: PointerEvent) { if (!menuRef.current?.contains(event.target as Node)) setMenu(false) }
    function key(event: KeyboardEvent) { if (event.key === 'Escape') setMenu(false) }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key) }
  }, [menu])

  function scheduleSave(next: string) {
    if (blocked.current || next === signature.current) return
    signature.current = next
    dirty.current = true
    setStatus('待保存')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { timer.current = null; void flushRef.current() }, 800)
  }

  async function exportImage(format: ExportFormat) {
    const editor = apiRef.current
    if (!editor) return
    setMenu(false)
    try {
      const library = await loadLibrary()
      const elements = editor.getSceneElements()
      const appState = editor.getAppState()
      const files = editor.getFiles()
      const name = drawingTitle(path)
      const background = format === 'jpg' && (!appState.viewBackgroundColor || appState.viewBackgroundColor === 'transparent') ? '#ffffff' : appState.viewBackgroundColor
      if (format === 'svg') {
        const svg = await library.exportToSvg({ elements, appState: { ...appState, exportBackground: true }, files, exportPadding: 16 })
        downloadBlob(new Blob([svg.outerHTML], { type: 'image/svg+xml' }), `${name}.svg`)
        return
      }
      const blob = await library.exportToBlob({ elements, appState: { ...appState, exportBackground: true, viewBackgroundColor: background }, files, mimeType: format === 'jpg' ? 'image/jpeg' : 'image/png', quality: format === 'jpg' ? 0.92 : undefined, exportPadding: 16 })
      downloadBlob(blob, `${name}.${format}`)
    } catch (error) { onError(error instanceof Error ? error.message : '导出失败') }
  }

  async function close() { await flushRef.current(); if (dirty.current) await flushRef.current(); onClose() }
  const title = drawingTitle(path)
  return createPortal(<div className="drawing-modal" role="dialog" aria-modal="true" aria-label="绘图">
    <div className="drawing-modal-bar">
      <div className="drawing-modal-title"><PenLine size={16} /><h2>{title}</h2><span className="drawing-status">{status}</span></div>
      <div className="drawing-modal-actions">
        <button type="button" className={`button ${mode ? 'primary' : ''}`} aria-pressed={mode} onClick={() => setMode(value => !value)}>{mode ? <Eye size={15} /> : <Pencil size={15} />}{mode ? '查看' : '编辑'}</button>
        <div className="drawing-menu" ref={menuRef}>
          <button type="button" className="button" aria-haspopup="menu" aria-expanded={menu} disabled={!scene} onClick={() => setMenu(open => !open)}><Download size={15} />导出</button>
          {menu && <div className="drawing-menu-list" role="menu">
            <button type="button" role="menuitem" onClick={() => void exportImage('svg')}>导出 SVG</button>
            <button type="button" role="menuitem" onClick={() => void exportImage('png')}>导出 PNG</button>
            <button type="button" role="menuitem" onClick={() => void exportImage('jpg')}>导出 JPG</button>
          </div>}
        </div>
        <button type="button" className="icon-button" aria-label="关闭绘图" onClick={() => void close()}><X size={18} /></button>
      </div>
    </div>
    <div className="drawing-stage">
      {loadError ? <p className="drawing-error">{loadError}</p> : scene ? <CanvasBoundary><Suspense fallback={<CanvasFallback />}><Excalidraw excalidrawAPI={editor => { apiRef.current = editor }} initialData={{ elements: scene.elements, appState: scene.appState, files: scene.files }} theme={dark ? 'dark' : 'light'} langCode="zh-CN" viewModeEnabled={!mode} autoFocus detectScroll={false} UIOptions={{ canvasActions: { export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false }       }} onChange={(elements, appState, files) => { snapshot.current = [elements, appState, files]; void loadLibrary().then(library => scheduleSave(sceneSignature(library, elements, appState.viewBackgroundColor, files))) }} /></Suspense></CanvasBoundary> : <CanvasFallback />}
    </div>
  </div>, document.body)
}
