import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { Link2, RefreshCw } from 'lucide-react'
import { api, json, resolveApiPath } from '../api'

type ServerPreview = { url: string; title?: string; site?: string; hasImage: boolean; image?: string }
type LinkPreview = ServerPreview & { revision: number }

const previewCache = new Map<string, LinkPreview>()
const previewInflight = new Map<string, Promise<LinkPreview>>()
const listeners = new Set<(url: string, preview: LinkPreview) => void>()

export function clearLinkPreviews() {
  previewCache.clear()
  previewInflight.clear()
}

function publish(url: string, preview: ServerPreview): LinkPreview {
  const next: LinkPreview = { ...preview, hasImage: Boolean(preview.hasImage && preview.image), revision: (previewCache.get(url)?.revision ?? 0) + 1 }
  previewCache.set(url, next)
  listeners.forEach(listener => listener(url, next))
  return next
}

function loadLinkPreview(url: string, refresh = false): Promise<LinkPreview> {
  if (!refresh) {
    const cached = previewCache.get(url)
    if (cached) return Promise.resolve(cached)
    const pending = previewInflight.get(url)
    if (pending) return pending
  }
  const request = refresh
    ? api<ServerPreview>('/link-previews', json('POST', { url }))
    : api<ServerPreview>(`/link-previews?url=${encodeURIComponent(url)}`)
  const task = request.then(preview => publish(url, preview))
  if (!refresh) {
    previewInflight.set(url, task)
    void task.finally(() => { if (previewInflight.get(url) === task) previewInflight.delete(url) }).catch(() => {})
  }
  return task
}

function linkHost(url: string) {
  try { return new URL(url, 'https://echo.local').hostname } catch { return '' }
}

function sameAddress(label: string, href: string) {
  const text = label.trim()
  if (!text || text === href) return true
  try { return new URL(text, 'https://echo.local').href === new URL(href, 'https://echo.local').href } catch { return false }
}

function cardTitle(label: string, href: string, preview: LinkPreview) {
  if (!sameAddress(label, href)) return label.trim()
  return preview.title?.trim() || preview.site || linkHost(href) || href
}

function imageSrc(preview: LinkPreview) {
  const image = resolveApiPath(preview.image || '')
  return `${image}${image.includes('?') ? '&' : '?'}v=${preview.revision}`
}

export function LinkCard({ url, label }: { url: string; label: string }) {
  const [bound, setBound] = useState(url)
  const [preview, setPreview] = useState<LinkPreview | null>(() => previewCache.get(url) ?? null)
  const [busy, setBusy] = useState(() => !previewCache.has(url))
  const [broken, setBroken] = useState(false)
  if (bound !== url) {
    const cached = previewCache.get(url) ?? null
    setBound(url)
    setPreview(cached)
    setBusy(!cached)
    setBroken(false)
  }
  useEffect(() => subscribe(url, value => setPreview(value)), [url])
  useEffect(() => {
    const cached = previewCache.get(url)
    if (cached) {
      setPreview(cached)
      setBusy(false)
      return
    }
    let alive = true
    setBusy(true)
    loadLinkPreview(url).then(result => { if (alive) { setPreview(result); setBusy(false) } }).catch(() => { if (alive) { setPreview(null); setBusy(false) } })
    return () => { alive = false }
  }, [url])

  async function refresh(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    setBusy(true)
    setBroken(false)
    try { setPreview(await loadLinkPreview(url, true)) } catch { /* Keep the cached card when the page cannot be reached. */ } finally { setBusy(false) }
  }

  const showImage = Boolean(preview?.hasImage && preview.image && !broken)
  const title = preview ? cardTitle(label, url, preview) : (!sameAddress(label, url) ? label.trim() : '')
  const site = preview?.site || linkHost(url)
  const refreshButton = <button type="button" className="link-card-refresh" aria-label="刷新链接" title="刷新链接" disabled={busy} onMouseDown={event => event.stopPropagation()} onClick={event => { void refresh(event) }}><RefreshCw size={14} className={busy ? 'spin' : undefined} /></button>
  if (!showImage || !preview) {
    const showTitle = Boolean(title && title !== url)
    return <span className={showTitle ? 'link-card compact has-title' : 'link-card compact'} aria-busy={busy}>
      <a className="link-card-open" href={url} title={url} target="_blank" rel="noreferrer">
        <Link2 size={14} className="link-card-icon" aria-hidden="true" />
        <span className="link-card-copy">
          {showTitle && <span className="link-card-title">{title}</span>}
          <span className="link-card-address">{url}</span>
        </span>
      </a>
      {refreshButton}
    </span>
  }
  return <span className="link-card has-image" aria-busy={busy}>
    <a className="link-card-open" href={url} title={url} target="_blank" rel="noreferrer">
      <img className="link-card-thumb" alt="" src={imageSrc(preview)} onError={() => setBroken(true)} />
      <span className="link-card-copy">
        <span className="link-card-title">{title}</span>
        {site && site !== title && <span className="link-card-site">{site}</span>}
      </span>
    </a>
    {refreshButton}
  </span>
}

function subscribe(url: string, listener: (preview: LinkPreview) => void) {
  const wrapped = (key: string, preview: LinkPreview) => { if (key === url) listener(preview) }
  listeners.add(wrapped)
  return () => { listeners.delete(wrapped) }
}
