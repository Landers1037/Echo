import { useEffect, useRef, useState } from 'react'
import { FileSpreadsheet, FileType, LoaderCircle, Maximize2, Presentation, X, AlertTriangle, ZoomIn, ZoomOut } from 'lucide-react'
import { apiURL, query } from '../api'

export type OfficeKind = 'docx' | 'pptx' | 'xlsx'

type Props = {
  path: string
  onClose: () => void
  onError?: (message: string) => void
}

type ViewerHandle = {
  destroy: () => void
  getScale: () => number
  setScale: (scale: number) => void
  fitWidth: () => void
  load: (source: ArrayBuffer) => Promise<unknown>
}

const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 1.25

export function officeKind(path: string): OfficeKind | null {
  const match = path.match(/\.(docx|pptx|xlsx)$/i)
  return match ? match[1].toLowerCase() as OfficeKind : null
}

function displayName(path: string) {
  return path.split('/').pop()?.replace(/\.(?:docx|pptx|xlsx)$/i, '') || path
}

function clampZoom(scale: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

function formatZoom(scale: number) {
  return `${Math.round(scale * 100)}%`
}

function kindLabel(kind: OfficeKind) {
  if (kind === 'pptx') return 'PowerPoint'
  if (kind === 'xlsx') return 'Excel'
  return 'Word'
}

function KindIcon({ kind }: { kind: OfficeKind }) {
  if (kind === 'pptx') return <Presentation size={20} />
  if (kind === 'xlsx') return <FileSpreadsheet size={20} />
  return <FileType size={20} />
}

export function OfficePreview({ path, onClose, onError }: Props) {
  const kind = officeKind(path) || 'docx'
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<ViewerHandle | null>(null)
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
    let viewer: ViewerHandle | null = null
    viewerRef.current = null
    setStatus('loading')
    setMessage('')
    setPager('')
    setScale(1)

    void (async () => {
      try {
        const currentKind = officeKind(path)
        if (!currentKind) throw new Error('不支持的文档类型')
        const response = await fetch(apiURL(`/api/documents?path=${query(path)}`))
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(text || `无法加载文档（${response.status}）`)
        }
        const buffer = await response.arrayBuffer()
        if (canceled || !hostRef.current) return
        host.replaceChildren()

        let next: ViewerHandle
        if (currentKind === 'pptx') {
          const { PptxScrollViewer } = await import('@silurus/ooxml/pptx')
          next = new PptxScrollViewer(host, {
            enableTextSelection: true,
            useGoogleFonts: false,
            cjkFallback: 'sc',
            mode: 'worker',
            progressiveLayout: true,
            enableZoom: true,
            zoomMin: ZOOM_MIN,
            zoomMax: ZOOM_MAX,
            refitOnResize: false,
            onVisibleSlideChange(pageIndex, availablePages, layoutComplete) {
              setPager(`第 ${pageIndex + 1} / ${availablePages} 页${layoutComplete ? '' : '…'}`)
            },
            onScaleChange(nextScale) { setScale(nextScale) },
            onError(error) {
              const text = error instanceof Error ? error.message : String(error)
              onErrorRef.current?.(text)
            },
          }) as unknown as ViewerHandle
        } else if (currentKind === 'xlsx') {
          const { XlsxViewer } = await import('@silurus/ooxml/xlsx')
          next = new XlsxViewer(host, {
            useGoogleFonts: false,
            cjkFallback: 'sc',
            zoomMin: ZOOM_MIN,
            zoomMax: ZOOM_MAX,
            showZoomSlider: false,
            onReady(sheetNames) {
              setPager(sheetNames.length ? `${sheetNames.length} 个工作表` : '')
            },
            onSheetChange(index, total) {
              setPager(`工作表 ${index + 1} / ${total}`)
            },
            onScaleChange(nextScale) { setScale(nextScale) },
            onError(error) {
              const text = error instanceof Error ? error.message : String(error)
              onErrorRef.current?.(text)
            },
          }) as unknown as ViewerHandle
        } else {
          const [{ DocxScrollViewer }, mathModule] = await Promise.all([
            import('@silurus/ooxml/docx'),
            import('@silurus/ooxml/math').catch(() => null),
          ])
          next = new DocxScrollViewer(host, {
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
            onScaleChange(nextScale) { setScale(nextScale) },
            onError(error) {
              const text = error instanceof Error ? error.message : String(error)
              onErrorRef.current?.(text)
            },
          }) as unknown as ViewerHandle
        }

        viewer = next
        viewerRef.current = next
        await next.load(buffer)
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
          <h1 className="docx-title"><KindIcon kind={kind} /><span>{displayName(path)}</span></h1>
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
        <p className="field-help">{path} · {kindLabel(kind)} 只读预览{kind === 'xlsx' ? '' : ' · Ctrl + 滚轮也可缩放'}</p>
      </section>
      <div className="docx-body">
        {status === 'loading' && <div className="docx-status"><LoaderCircle className="spin" size={20} /><span>正在加载 {kindLabel(kind)} 文档…</span></div>}
        {status === 'error' && <div className="docx-status docx-status-error" role="alert"><AlertTriangle size={18} /><span>{message}</span></div>}
        <div ref={hostRef} className="docx-viewer" aria-hidden={status !== 'ready'} style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }} />
      </div>
    </div>
  )
}
