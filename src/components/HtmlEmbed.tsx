import { useEffect, useState } from 'react'
import { AlertTriangle, LoaderCircle, Maximize2 } from 'lucide-react'
import { apiURL, query } from '../api'

type Props = {
  path: string
  alt?: string
  exporting?: boolean
  embedded?: string
  onOpen?: (path: string) => void
}

async function loadHtmlSource(path: string, embedded?: string) {
  if (embedded) {
    if (embedded.startsWith('data:text/html')) {
      const comma = embedded.indexOf(',')
      if (comma < 0) throw new Error('HTML 数据无效')
      const meta = embedded.slice(0, comma)
      const body = embedded.slice(comma + 1)
      if (/;base64/i.test(meta)) {
        const binary = atob(body)
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
        return new TextDecoder().decode(bytes)
      }
      return decodeURIComponent(body)
    }
    return embedded
  }
  const response = await fetch(apiURL(`/api/documents?path=${query(path)}`))
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `无法加载 HTML（${response.status}）`)
  }
  return response.text()
}

export function HtmlEmbed({ path, alt = 'HTML 演示', exporting = false, embedded, onOpen }: Props) {
  const [url, setUrl] = useState('')
  const [srcdoc, setSrcdoc] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    let objectUrl = ''
    setLoading(true)
    setError('')
    setUrl('')
    setSrcdoc('')
    void loadHtmlSource(path, embedded).then(html => {
      if (!alive) return
      if (exporting) {
        setSrcdoc(html)
        setLoading(false)
        return
      }
      objectUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      setUrl(objectUrl)
      setLoading(false)
    }).catch(err => {
      if (!alive) return
      setError(err instanceof Error ? err.message : 'HTML 无法显示')
      setLoading(false)
    })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, embedded, exporting])

  if (exporting && error) return <p className="html-embed-error">[HTML 演示缺失：{alt}]</p>
  if (exporting) {
    if (loading) return <p className="html-embed-status">正在嵌入 HTML 演示…</p>
    return <div className="html-embed exporting">
      <iframe className="html-frame" title={alt} srcDoc={srcdoc} sandbox="allow-scripts" referrerPolicy="no-referrer" />
    </div>
  }

  return <div className="html-embed">
    {loading && <div className="html-embed-status"><LoaderCircle className="spin" size={16} /><span>正在加载 HTML 演示…</span></div>}
    {error && <div className="html-embed-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
    {url && <iframe className="html-frame" title={alt} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
    {onOpen && !error && <div className="html-embed-actions">
      <button type="button" className="drawing-edit" aria-label="整页打开 HTML" title="整页打开" onClick={() => onOpen(path)}><Maximize2 size={15} /></button>
    </div>}
  </div>
}
