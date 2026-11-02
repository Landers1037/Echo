import { useEffect, useRef, useState } from 'react'
import { FileType, LoaderCircle, X, AlertTriangle, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { apiURL, query } from '../api'

type Props = {
  path: string
  onClose: () => void
  onError?: (message: string) => void
}

type DocxViewerHandle = {
  destroy: () => void
  getScale: () => number
  setScale: (scale: number) => void
  fitWidth: () => void
}

const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 1.25

function displayName(path: string) {
  return path.split('/').pop()?.replace(/\.docx$/i, '') || path
}

function clampZoom(scale: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

function formatZoom(scale: number) {
  return `${Math.round(scale * 100)}%`
}

export function DocxPreview({ path, onClose, onError }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<DocxViewerHandle | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [pager, setPager] = useState('')
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let canceled = false
    let viewer: DocxViewerHandle | null = null
    viewerRef.current = null
    setStatus('loading')
    setMessage('')
    setPager('')
    setScale(1)

    void (async () => {
      try {
        const [{ DocxScrollViewer }, mathModule] = await Promise.all([
          import('@silurus/ooxml/docx'),
          import('@silurus/ooxml/math').catch(() => null),
        ])
        if (canceled || !hostRef.current) return
        const response = await fetch(apiURL(`/api/documents?path=${query(path)}`))
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(text || `无法加载文档（${response.status}）`)
        }
        const buffer = await response.arrayBuffer()
        if (canceled || !hostRef.current) return
        host.replaceChildren()
        const next = new DocxScrollViewer(host, {
          enableTextSelection: true,
          useGoogleFonts: false,
          cjkFallback: 'sc',
          mode: 'worker',
          progressiveLayout: true,
          enableZoom: true,
          zoomMin: ZOOM_MIN,
          zoomMax: ZOOM_MAX,
          refitOnResize: false,
          math: mathModule?.math,
          onVisiblePageChange(pageIndex, availablePages, layoutComplete) {
            setPager(`第 ${pageIndex + 1} / ${availablePages} 页${layoutComplete ? '' : '…'}`)
          },
          onScaleChange(nextScale) {
            setScale(nextScale)
          },
          onError(error) {
            const text = error instanceof Error ? error.message : String(error)
            onErrorRef.current?.(text)
          },
        }) as DocxViewerHandle
        viewer = next
        viewerRef.current = next
        await (next as DocxViewerHandle & { load: (source: ArrayBuffer) => Promise<unknown> }).load(buffer)
        if (canceled) {
          next.destroy()
          return
        }
        setScale(next.getScale())
        setStatus('ready')
      } catch (error) {
        if (canceled) return
        const text = error instanceof Error ? error.message : String(error)
        const friendly = /password|encrypt|legacy|unsupported/i.test(text)
          ? '无法预览该文档（可能已加密或不支持）。'
          : (text || '文档预览失败。')
        setStatus('error')
        setMessage(friendly)
        onErrorRef.current?.(friendly)
      }
    })()

    return () => {
      canceled = true
      viewerRef.current = null
      viewer?.destroy()
      host.replaceChildren()
    }
  }, [path])

  function zoomBy(factor: number) {
    const viewer = viewerRef.current
    if (!viewer) return
    const next = clampZoom(viewer.getScale() * factor)
    viewer.setScale(next)
    setScale(viewer.getScale())
  }

  function zoomToFit() {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.fitWidth()
    setScale(viewer.getScale())
  }

  const zoomReady = status === 'ready'

  return (
    <div className="docx-workspace" role="region" aria-label={`预览 ${path}`}>
      <section className="note-heading docx-heading">
        <div className="note-title-row">
          <h1 className="docx-title"><FileType size={20} /><span>{displayName(path)}</span></h1>
          <div className="note-title-actions">
            {pager && <span className="docx-pager" aria-live="polite">{pager}</span>}
            <div className="docx-zoom" role="group" aria-label="文档缩放">
              <button type="button" className="icon-button" aria-label="缩小" title="缩小" disabled={!zoomReady || scale <= ZOOM_MIN} onClick={() => zoomBy(1 / ZOOM_STEP)}><ZoomOut size={17} /></button>
              <span className="docx-zoom-label" aria-live="polite">{formatZoom(scale)}</span>
              <button type="button" className="icon-button" aria-label="放大" title="放大" disabled={!zoomReady || scale >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}><ZoomIn size={17} /></button>
              <button type="button" className="icon-button" aria-label="适应宽度" title="适应宽度" disabled={!zoomReady} onClick={zoomToFit}><Maximize2 size={16} /></button>
            </div>
            <button type="button" className="icon-button" aria-label="关闭文档预览" title="关闭" onClick={onClose}><X size={18} /></button>
          </div>
        </div>
        <p className="field-help">{path} · 只读预览 · Ctrl + 滚轮也可缩放</p>
      </section>
      <div className="docx-body">
        {status === 'loading' && <div className="docx-status"><LoaderCircle className="spin" size={20} /><span>正在加载 Word 文档…</span></div>}
        {status === 'error' && <div className="docx-status docx-status-error" role="alert"><AlertTriangle size={18} /><span>{message}</span></div>}
        <div ref={hostRef} className="docx-viewer" aria-hidden={status !== 'ready'} style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }} />
      </div>
    </div>
  )
}
