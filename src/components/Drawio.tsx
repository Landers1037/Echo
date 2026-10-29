import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, LoaderCircle, Pencil, Workflow, X } from 'lucide-react'
import { api, ApiError, json, query } from '../api'
import type { Drawing } from '../types'

type DrawioMessage = { event?: string; xml?: string; data?: string; format?: string }
type GraphViewerApi = { createViewerForElement: (element: HTMLElement) => void }

function drawioBase() {
  return `${window.location.origin}/drawio`
}

function configureDrawioViewer() {
  const base = drawioBase()
  const values: Record<string, string> = {
    DRAWIO_BASE_URL: base,
    DRAWIO_LIGHTBOX_URL: base,
    DRAWIO_VIEWER_URL: `${base}/js/viewer-static.min.js`,
    STYLE_PATH: `${base}/styles`,
    SHAPES_PATH: `${base}/shapes`,
    STENCIL_PATH: `${base}/stencils`,
    IMAGE_PATH: `${base}/images`,
    GRAPH_IMAGE_PATH: `${base}/img`,
    mxBasePath: `${base}/mxgraph/`,
    mxImageBasePath: `${base}/mxgraph/images`,
    RESOURCES_PATH: `${base}/resources`,
    RESOURCE_BASE: `${base}/resources/dia`,
    DRAW_MATH_URL: `${base}/math4/es5`,
    PROXY_URL: `${base}/proxy`,
    EXPORT_URL: `${base}/export`,
  }
  const target = window as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(values)) {
    if (target[key] == null || target[key] === '') target[key] = value
  }
  if (target.mxLanguage == null) target.mxLanguage = 'zh'
}

let viewerPromise: Promise<void> | null = null
function loadDrawioViewer() {
  configureDrawioViewer()
  const viewer = (window as unknown as { GraphViewer?: GraphViewerApi }).GraphViewer
  if (viewer?.createViewerForElement) return Promise.resolve()
  viewerPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/drawio/js/viewer-static.min.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => { viewerPromise = null; reject(new Error('绘图查看器无法加载')) }
    document.head.append(script)
  })
  return viewerPromise
}

function drawingTitle(path: string) {
  return (path.split('/').pop() || '绘图').replace(/\.drawio$/i, '') || '绘图'
}

function decodeDataUrl(value: string) {
  const comma = value.indexOf(',')
  const meta = value.slice(0, Math.max(comma, 0))
  const payload = value.slice(comma + 1)
  if (/;base64/i.test(meta)) {
    const binary = atob(payload)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  return decodeURIComponent(payload)
}

async function readDrawio(source: string) {
  if (source.startsWith('data:')) return decodeDataUrl(source)
  return (await api<Drawing>(`/drawings?path=${query(source)}`)).content
}

function drawioIsEmpty(xml: string) {
  const diagrams = xml.match(/<diagram\b[^>]*>[\s\S]*?<\/diagram>/gi) || []
  if (!diagrams.length) return !/<mxCell\b/i.test(xml)
  return diagrams.every(block => {
    const inner = block.replace(/<\/?diagram\b[^>]*>/gi, '').trim()
    if (!inner) return true
    if (!inner.startsWith('<')) return false
    return !/\b(?:vertex|edge)="1"/.test(inner)
  })
}

function parseMessage(data: unknown): DrawioMessage | null {
  if (typeof data === 'string') {
    try { return JSON.parse(data) as DrawioMessage } catch { return null }
  }
  if (data && typeof data === 'object') return data as DrawioMessage
  return null
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

function drawioUrl(ui: string) {
  const params = new URLSearchParams({
    embed: '1', proto: 'json', spin: '1', lang: 'zh', stealth: '1', pwa: '0', offline: '1',
    noSaveBtn: '1', noExitBtn: '1', saveAndExit: '0', ui,
  })
  return `/drawio/index.html?${params}`
}

export function DrawioEmbed({ path, alt = '绘图', exporting = false, version = 0, onEdit }: { path: string; alt?: string; exporting?: boolean; version?: number; onEdit?: (path: string) => void }) {
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
    void readDrawio(path).then(async xml => {
      if (!alive) return
      if (drawioIsEmpty(xml)) { setEmpty(true); setRendering(false); return }
      await loadDrawioViewer()
      if (!alive || !host.current) return
      const holder = document.createElement('div')
      holder.className = 'mxgraph'
      holder.setAttribute('data-mxgraph', JSON.stringify({ highlight: '#72967b', nav: false, resize: true, toolbar: 'zoom', xml, 'max-width': '100%' }))
      host.current.replaceChildren(holder)
      const viewer = (window as unknown as { GraphViewer?: GraphViewerApi }).GraphViewer
      if (!viewer?.createViewerForElement) throw new Error('绘图查看器无法显示')
      viewer.createViewerForElement(holder)
      const started = Date.now()
      while (alive && Date.now() - started < 12000) {
        if (holder.querySelector('svg')) { setRendering(false); return }
        await new Promise(resolve => window.setTimeout(resolve, 40))
      }
      if (alive) { setError('绘图无法显示'); setRendering(false) }
    }).catch(reason => { if (alive) { setError(reason instanceof Error ? reason.message : '绘图无法显示'); setRendering(false) } })
    return () => { alive = false }
  }, [path, version])
  return <div className="drawing-embed">
    <div ref={host} className="drawing-frame" data-rendering={rendering ? 'true' : undefined} aria-label={alt} />
    {empty && <p className="drawing-empty">空白绘图</p>}
    {error && <p className="drawing-error">{error}</p>}
    {!exporting && onEdit && <button type="button" className="drawing-edit" aria-label="编辑绘图" title="编辑绘图" onClick={() => onEdit(path)}><Pencil size={15} /></button>}
  </div>
}

export function DrawioModal({ path, dark, onClose, onConflict, onError, onRegisterFlush }: { path: string; dark: boolean; onClose: () => void; onConflict: () => void; onError: (message: string) => void; onRegisterFlush?: (flush: (() => Promise<void>) | null) => void }) {
  const [status, setStatus] = useState('已保存')
  const [loadError, setLoadError] = useState('')
  const [menu, setMenu] = useState(false)
  const [ready, setReady] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const ui = useRef(dark ? 'dark' : 'kennedy')
  const xmlRef = useRef('')
  const pendingXml = useRef('')
  const revision = useRef('')
  const signature = useRef('')
  const initialized = useRef(false)
  const dirty = useRef(false)
  const blocked = useRef(false)
  const timer = useRef<number | null>(null)
  const saving = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)
  const menuRef = useRef<HTMLDivElement>(null)
  const exportWait = useRef<((message: DrawioMessage) => void) | null>(null)

  function post(message: unknown) {
    frameRef.current?.contentWindow?.postMessage(JSON.stringify(message), window.location.origin)
  }
  function sendLoad() {
    if (!initialized.current || !xmlRef.current) return
    post({ action: 'load', xml: xmlRef.current, autosave: 1, title: drawingTitle(path) })
    setReady(true)
  }

  async function persist() {
    const content = pendingXml.current
    if (!content || blocked.current || !dirty.current) return
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

  function scheduleSave(xml: string) {
    if (blocked.current || xml === signature.current) return
    signature.current = xml
    pendingXml.current = xml
    dirty.current = true
    setStatus('待保存')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { timer.current = null; void flushRef.current() }, 800)
  }
  const onMessage = useRef<(event: MessageEvent) => void>(() => {})
  onMessage.current = event => {
    if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return
    const message = parseMessage(event.data)
    if (!message?.event) return
    if (message.event === 'configure') post({ action: 'configure', config: {} })
    else if (message.event === 'init') { initialized.current = true; sendLoad() }
    else if ((message.event === 'autosave' || message.event === 'save') && typeof message.xml === 'string') scheduleSave(message.xml)
    else if (message.event === 'export') exportWait.current?.(message)
  }

  useLayoutEffect(() => {
    const listener = (event: MessageEvent) => onMessage.current(event)
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [])

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
    setLoadError('')
    setReady(false)
    blocked.current = false
    dirty.current = false
    initialized.current = false
    xmlRef.current = ''
    void api<Drawing>(`/drawings?path=${query(path)}`).then(drawing => {
      if (!alive) return
      revision.current = drawing.revision
      xmlRef.current = drawing.content
      signature.current = drawing.content
      sendLoad()
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

  async function exportImage(format: 'svg' | 'png') {
    const frame = frameRef.current?.contentWindow
    if (!frame) return
    setMenu(false)
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const timeout = window.setTimeout(() => { exportWait.current = null; reject(new Error('导出超时')) }, 20000)
        exportWait.current = message => {
          window.clearTimeout(timeout)
          exportWait.current = null
          if (typeof message.data === 'string' && message.data) resolve(message.data)
          else reject(new Error('导出失败'))
        }
        post({ action: 'export', format })
      })
      const name = drawingTitle(path)
      if (format === 'svg' && data.trimStart().startsWith('<')) downloadBlob(new Blob([data], { type: 'image/svg+xml' }), `${name}.svg`)
      else {
        const blob = data.startsWith('data:') ? await (await fetch(data)).blob() : new Blob([data], { type: format === 'svg' ? 'image/svg+xml' : 'image/png' })
        downloadBlob(blob, `${name}.${format}`)
      }
    } catch (error) { onError(error instanceof Error ? error.message : '导出失败') }
  }

  async function close() { await flushRef.current(); if (dirty.current) await flushRef.current(); onClose() }
  const title = drawingTitle(path)
  return createPortal(<div className="drawing-modal" role="dialog" aria-modal="true" aria-label="绘图">
    <div className="drawing-modal-bar">
      <div className="drawing-modal-title"><Workflow size={16} /><h2>{title}</h2><span className="drawing-status">{status}</span></div>
      <div className="drawing-modal-actions">
        <div className="drawing-menu" ref={menuRef}>
          <button type="button" className="button" aria-haspopup="menu" aria-expanded={menu} disabled={!ready} onClick={() => setMenu(open => !open)}><Download size={15} />导出</button>
          {menu && <div className="drawing-menu-list" role="menu">
            <button type="button" role="menuitem" onClick={() => void exportImage('svg')}>导出 SVG</button>
            <button type="button" role="menuitem" onClick={() => void exportImage('png')}>导出 PNG</button>
          </div>}
        </div>
        <button type="button" className="icon-button" aria-label="关闭绘图" onClick={() => void close()}><X size={18} /></button>
      </div>
    </div>
    <div className="drawing-stage">
      {loadError ? <p className="drawing-error">{loadError}</p> : <iframe ref={frameRef} className="drawio-frame" title={title} src={drawioUrl(ui.current)} />}
      {!loadError && !ready && <div className="drawing-loading"><LoaderCircle className="spin" size={18} /><span>正在打开绘图…</span></div>}
    </div>
  </div>, document.body)
}
