import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import './ImagePreview.css'

const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

type Notice = { id: number; text: string }
type Drag = { id: number; x: number; y: number; ox: number; oy: number; moved: boolean }
type PreviewApi = { step: (direction: 1 | -1, clientX?: number, clientY?: number) => void; reset: () => void; close: () => void }

export function imageDownloadName(src: string, alt: string) {
  const fromSource = fileNameFromSource(src)
  if (fromSource) return fromSource
  const stem = sanitizeFileName(alt) || '图片'
  return /\.[a-z0-9]{1,8}$/i.test(stem) ? stem : `${stem}.png`
}

export function PreviewableImage({ src, alt, title, onOpen }: { src: string; alt: string; title?: string; onOpen: () => void }) {
  function open(event: ReactMouseEvent<HTMLImageElement> | ReactKeyboardEvent<HTMLImageElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.classList.contains('image-error')) return
    onOpen()
  }
  return <img className="preview-image" src={src} alt={alt} title={title} role="button" tabIndex={0} aria-label={alt ? `预览图片：${alt}` : '预览图片'} draggable={false} loading="lazy" onClick={open} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') open(event) }} onError={event => event.currentTarget.classList.add('image-error')} />
}

export function ImagePreview({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const frame = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const photo = useRef<HTMLImageElement>(null)
  const drag = useRef<Drag | null>(null)
  const pointerDrag = useRef(false)
  const suppressClick = useRef(false)
  const wheelDelta = useRef(0)
  const noticeId = useRef(0)
  const scaleRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<'copy' | 'download' | ''>('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [root, setRoot] = useState<Element>(() => document.fullscreenElement ?? document.body)
  const name = imageDownloadName(src, alt)
  const percent = Math.round(scale * 100)
  const api = useRef<PreviewApi>({ step: () => {}, reset: () => {}, close: () => {} })

  function showNotice(text: string) {
    noticeId.current += 1
    setNotice({ id: noticeId.current, text })
  }

  function apply(nextScale: number, nextOffset: { x: number; y: number }) {
    const next = steps.includes(nextScale) ? nextScale : nearest(nextScale)
    const positioned = Math.abs(next - 1) < 0.001 ? { x: 0, y: 0 } : clampOffset(nextOffset, next)
    scaleRef.current = next
    offsetRef.current = positioned
    setScale(next)
    setOffset(positioned)
  }

  function clampOffset(next: { x: number; y: number }, nextScale: number) {
    const bounds = stage.current
    const image = photo.current
    if (!bounds || !image) return next
    const stageWidth = bounds.clientWidth
    const stageHeight = bounds.clientHeight
    const visualWidth = image.offsetWidth * nextScale
    const visualHeight = image.offsetHeight * nextScale
    if (stageWidth < 1 || stageHeight < 1 || visualWidth < 1 || visualHeight < 1) return next
    const maxX = Math.max(0, (visualWidth - stageWidth) / 2)
    const maxY = Math.max(0, (visualHeight - stageHeight) / 2)
    return { x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) }
  }

  function zoomTo(next: number, clientX?: number, clientY?: number) {
    const current = scaleRef.current
    if (Math.abs(next - current) < 0.001) return
    const bounds = stage.current?.getBoundingClientRect()
    const originX = clientX ?? (bounds ? bounds.left + bounds.width / 2 : 0)
    const originY = clientY ?? (bounds ? bounds.top + bounds.height / 2 : 0)
    const offset = offsetRef.current
    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      apply(next, { x: offset.x * next / current, y: offset.y * next / current })
      return
    }
    const centerX = originX - (bounds.left + bounds.width / 2)
    const centerY = originY - (bounds.top + bounds.height / 2)
    apply(next, {
      x: centerX - ((centerX - offset.x) / current) * next,
      y: centerY - ((centerY - offset.y) / current) * next,
    })
  }

  function stepBy(direction: 1 | -1, clientX?: number, clientY?: number) {
    const index = nearestIndex(scaleRef.current)
    zoomTo(steps[Math.min(steps.length - 1, Math.max(0, index + direction))], clientX, clientY)
  }

  function canStep(direction: 1 | -1) {
    const index = nearestIndex(scale)
    return index + direction >= 0 && index + direction < steps.length
  }

  api.current.step = stepBy
  api.current.reset = () => zoomTo(1)
  api.current.close = onClose

  useEffect(() => {
    const sync = () => setRoot(document.fullscreenElement ?? document.body)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(current => current?.id === notice.id ? null : current), 1800)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const node = frame.current
    if (!node) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    node.focus({ preventScroll: true })
    document.body.style.overflow = 'hidden'
    function onKey(event: KeyboardEvent) {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== node) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); api.current.close(); return }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') { event.preventDefault(); api.current.step(1); return }
      if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') { event.preventDefault(); api.current.step(-1); return }
      if (event.key === '0' || event.code === 'Numpad0') { event.preventDefault(); api.current.reset(); return }
      if (event.key !== 'Tab') return
      const items = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled)'))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      wheelDelta.current += event.deltaY
      if (Math.abs(wheelDelta.current) < 80) return
      const direction = wheelDelta.current < 0 ? 1 : -1
      wheelDelta.current = 0
      api.current.step(direction, event.clientX, event.clientY)
    }
    document.addEventListener('keydown', onKey)
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      document.removeEventListener('keydown', onKey)
      node.removeEventListener('wheel', onWheel)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [])

  function beginDrag(id: number, x: number, y: number, target: HTMLImageElement, capture: boolean) {
    if (scaleRef.current <= 1 || !Number.isFinite(x) || !Number.isFinite(y)) return
    drag.current = { id, x, y, ox: offsetRef.current.x, oy: offsetRef.current.y, moved: false }
    setPanning(true)
    if (!capture) return
    try { target.setPointerCapture(id) } catch { /* 当前环境不支持指针捕获时仍可拖动。 */ }
  }

  function moveDrag(id: number, x: number, y: number) {
    const current = drag.current
    if (!current || current.id !== id || !Number.isFinite(x) || !Number.isFinite(y)) return
    const dx = x - current.x
    const dy = y - current.y
    if (!current.moved && Math.hypot(dx, dy) < 4) return
    current.moved = true
    apply(scaleRef.current, { x: current.ox + dx, y: current.oy + dy })
  }

  function finishDrag(id: number) {
    const current = drag.current
    if (!current || current.id !== id) return
    if (current.moved) suppressClick.current = true
    drag.current = null
    setPanning(false)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLImageElement>) {
    if (!realPointer(event) || event.button !== 0) return
    pointerDrag.current = true
    beginDrag(event.pointerId, event.clientX, event.clientY, event.currentTarget, true)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLImageElement>) {
    if (!realPointer(event)) return
    moveDrag(event.pointerId, event.clientX, event.clientY)
  }

  function onPointerUp(event: ReactPointerEvent<HTMLImageElement>) {
    if (!realPointer(event)) return
    finishDrag(event.pointerId)
    pointerDrag.current = false
  }

  function onMouseDown(event: ReactMouseEvent<HTMLImageElement>) {
    if (pointerDrag.current || event.button !== 0) return
    beginDrag(0, event.clientX, event.clientY, event.currentTarget, false)
  }

  async function copy() {
    if (busy) return
    setBusy('copy')
    setNotice(null)
    try {
      await copyImage(src, photo.current)
      showNotice('已复制图片')
    } catch {
      showNotice('无法复制这张图片')
    } finally {
      setBusy('')
    }
  }

  async function download() {
    if (busy) return
    setBusy('download')
    setNotice(null)
    try {
      await downloadImage(src, name)
    } catch {
      showNotice('无法下载这张图片')
    } finally {
      setBusy('')
    }
  }

  const copied = notice?.text === '已复制图片'
  return createPortal(<div ref={frame} className={`image-preview${scale > 1 ? ' is-zoomed' : ''}${panning ? ' is-panning' : ''}`} role="dialog" aria-modal="true" aria-label={alt ? `图片预览：${alt}` : '图片预览'} tabIndex={-1}>
    <p className="image-preview-name" title={name}>{name}</p>
    <button type="button" className="image-preview-close" aria-label="关闭图片预览" title="关闭（Esc）" onClick={onClose}><X size={18} /></button>
    <div ref={stage} className="image-preview-stage" onClick={event => { if (suppressClick.current) { suppressClick.current = false; return } if (event.target === event.currentTarget) onClose() }}>
      {failed ? <p className="image-preview-missing">这张图片无法显示</p> : <img ref={photo} className="image-preview-photo" src={src} alt={alt || '图片'} draggable={false} title={scale > 1 ? '拖动查看，双击还原' : '双击放大'} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onMouseDown={onMouseDown} onMouseMove={event => { if (!pointerDrag.current) moveDrag(0, event.clientX, event.clientY) }} onMouseUp={() => { if (!pointerDrag.current) finishDrag(0) }} onDoubleClick={event => { event.stopPropagation(); if (Math.abs(scaleRef.current - 1) < 0.001) zoomTo(2, event.clientX, event.clientY); else zoomTo(1) }} onDragStart={event => event.preventDefault()} onError={() => setFailed(true)} />}
    </div>
    <div className="image-preview-toolbar" role="toolbar" aria-label="图片操作">
      <button type="button" className="image-preview-tool" aria-label="缩小" title="缩小（-）" disabled={!canStep(-1) || busy !== ''} onClick={() => stepBy(-1)}><ZoomOut size={16} /></button>
      <button type="button" className="image-preview-scale" aria-label={`重置缩放，当前 ${percent}%`} title="重置缩放（0）" disabled={busy !== ''} onClick={() => zoomTo(1)}>{percent}%</button>
      <button type="button" className="image-preview-tool" aria-label="放大" title="放大（+）" disabled={!canStep(1) || busy !== ''} onClick={() => stepBy(1)}><ZoomIn size={16} /></button>
      <span className="image-preview-divider" />
      <button type="button" className="image-preview-action" aria-label={copied ? '已复制图片' : '复制图片'} disabled={busy !== ''} onClick={() => { void copy() }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}</button>
      <button type="button" className="image-preview-action" aria-label="下载图片" disabled={busy !== ''} onClick={() => { void download() }}><Download size={15} />下载</button>
    </div>
    {notice && <p className="image-preview-status" role="status">{notice.text}</p>}
  </div>, root)
}

async function copyImage(src: string, image: HTMLImageElement | null) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('无法复制这张图片')
  const png = loadPng(src, image)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

async function loadPng(src: string, image: HTMLImageElement | null) {
  if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
    try { return await pngFromImage(image) } catch { /* 画布被跨域图片污染时改为重新获取文件。 */ }
  }
  const response = await fetch(src)
  if (!response.ok) throw new Error('无法复制这张图片')
  const blob = await response.blob()
  const header = response.headers.get('Content-Type')?.split(';')[0].trim() || ''
  const type = (blob.type || header).split(';')[0].trim()
  if (type === 'image/png' || header === 'image/png') return blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' })
  return pngFromBlob(blob)
}

function pngFromImage(image: HTMLImageElement) {
  return drawToPng(image.naturalWidth, image.naturalHeight, context => context.drawImage(image, 0, 0))
}

async function pngFromBlob(blob: Blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try { return await drawToPng(bitmap.width, bitmap.height, context => context.drawImage(bitmap, 0, 0)) }
    finally { bitmap.close() }
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadElement(url)
    return await drawToPng(image.naturalWidth, image.naturalHeight, context => context.drawImage(image, 0, 0))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function drawToPng(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context || !width || !height) return Promise.reject(new Error('无法复制这张图片'))
  try { draw(context) } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('无法复制这张图片')) }
  return new Promise<Blob>((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法复制这张图片')), 'image/png') }
    catch (error) { reject(error instanceof Error ? error : new Error('无法复制这张图片')) }
  })
}

function loadElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法复制这张图片'))
    image.src = src
  })
}

export async function downloadImage(src: string, name: string) {
  try {
    const response = await fetch(src)
    if (!response.ok) throw new Error('无法下载这张图片')
    const url = URL.createObjectURL(await response.blob())
    saveAnchor(url, name)
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  } catch {
    if (!directDownload(src)) throw new Error('无法下载这张图片')
    saveAnchor(src, name)
  }
}

function directDownload(src: string) {
  if (src.startsWith('data:') || src.startsWith('blob:')) return true
  try { return new URL(src, window.location.href).origin === window.location.origin } catch { return false }
}

function saveAnchor(href: string, name: string) {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  anchor.rel = 'noreferrer'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function realPointer(event: ReactPointerEvent<HTMLImageElement>) {
  return typeof PointerEvent === 'function' && event.nativeEvent instanceof PointerEvent && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
}

function nearest(value: number) {
  return steps[nearestIndex(value)]
}

function nearestIndex(value: number) {
  let index = 0
  for (let cursor = 1; cursor < steps.length; cursor++) if (Math.abs(steps[cursor] - value) < Math.abs(steps[index] - value)) index = cursor
  return index
}

function fileNameFromSource(src: string) {
  if (src.startsWith('data:') || src.startsWith('blob:')) return ''
  try {
    const url = new URL(src, 'http://echo.local')
    const raw = url.pathname === '/api/assets' ? url.searchParams.get('path') || '' : decodeURIComponent(url.pathname)
    const base = raw.split(/[/\\]/).filter(Boolean).pop() || ''
    const clean = sanitizeFileName(base)
    return /\.[a-z0-9]{1,8}$/i.test(clean) ? clean : ''
  } catch { return '' }
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 120)
}
