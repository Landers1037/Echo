import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Code2, LoaderCircle, X } from 'lucide-react'
import { apiURL, query } from '../api'

type Props = {
  path: string
  onClose: () => void
  onError?: (message: string) => void
}

function displayName(path: string) {
  return path.split('/').pop()?.replace(/\.html?$/i, '') || path
}

export function HtmlPreview({ path, onClose, onError }: Props) {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    let canceled = false
    let objectUrl = ''
    setStatus('loading')
    setMessage('')
    setUrl('')
    void (async () => {
      try {
        const response = await fetch(apiURL(`/api/documents?path=${query(path)}`))
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(text || `无法加载 HTML（${response.status}）`)
        }
        const html = await response.text()
        if (canceled) return
        objectUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        setUrl(objectUrl)
        setStatus('ready')
      } catch (error) {
        if (canceled) return
        const text = error instanceof Error ? error.message : String(error)
        setMessage(text)
        setStatus('error')
        onErrorRef.current?.(text)
      }
    })()
    return () => {
      canceled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  return (
    <div className="html-workspace" role="region" aria-label={`预览 ${path}`}>
      <section className="note-heading docx-heading">
        <div className="note-title-row">
          <h1 className="docx-title"><Code2 size={20} /><span>{displayName(path)}</span></h1>
          <div className="note-title-actions">
            <button type="button" className="icon-button" aria-label="关闭 HTML 预览" title="关闭" onClick={onClose}><X size={18} /></button>
          </div>
        </div>
        <p className="field-help">{path} · HTML 演示只读预览（沙箱运行）</p>
      </section>
      <div className="html-body">
        {status === 'loading' && <div className="docx-status"><LoaderCircle className="spin" size={20} /><span>正在加载 HTML 演示…</span></div>}
        {status === 'error' && <div className="docx-status docx-status-error" role="alert"><AlertTriangle size={18} /><span>{message}</span></div>}
        {url && <iframe className="html-preview-frame" title={displayName(path)} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
      </div>
    </div>
  )
}
