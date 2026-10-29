import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Mermaid } from 'mermaid'
import { ImagePreview } from './ImagePreview'

const svgCache = new Map<string, string>()
let mermaidModule: Promise<Mermaid> | undefined
let renderChain: Promise<void> = Promise.resolve()
let nextId = 0
let previewCopy = 0

function cacheKey(dark: boolean, code: string) {
  return (dark ? 'dark' : 'light') + '\0' + code
}

function remember(key: string, svg: string) {
  svgCache.set(key, svg)
  if (svgCache.size > 150) svgCache.delete(svgCache.keys().next().value!)
}

function loadMermaid() {
  mermaidModule ??= import('mermaid').then(module => module.default).catch(error => {
    mermaidModule = undefined
    throw error
  })
  return mermaidModule
}

function diagramError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return message.split('\n').map(line => line.trim()).find(Boolean) || '图表渲染失败'
}

function renderDiagram(dark: boolean, code: string) {
  const run = renderChain.then(async () => {
    const mermaid = await loadMermaid()
    const id = `echo-mermaid-${++nextId}`
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default' })
    try {
      return (await mermaid.render(id, code)).svg
    } catch (error) {
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
      throw error
    }
  })
  renderChain = run.then(() => undefined, () => undefined)
  return run
}

function readSize(value: string | null) {
  if (!value || value.includes('%')) return 0
  const size = Number.parseFloat(value)
  return Number.isFinite(size) && size > 0 ? size : 0
}

function retarget(value: string, ids: Map<string, string>) {
  return value.replace(/url\(#([^)]+)\)|#([A-Za-z_][\w:.-]*)/g, (match, urlId: string | undefined, hashId: string | undefined) => {
    const id = urlId || hashId || ''
    const next = ids.get(id)
    return next ? match.replace(id, next) : match
  })
}

function sizedSvg(svg: string) {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  if (root.nodeName.toLowerCase() !== 'svg') return svg
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? []
  const width = box.length === 4 && box[2] > 0 ? box[2] : readSize(root.getAttribute('width')) || 960
  const height = box.length === 4 && box[3] > 0 ? box[3] : readSize(root.getAttribute('height')) || 540
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  root.setAttribute('width', String(Math.round(width)))
  root.setAttribute('height', String(Math.round(height)))
  root.removeAttribute('style')
  const suffix = `-preview${++previewCopy}`
  const ids = new Map<string, string>()
  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    const id = node.getAttribute('id')
    if (id) ids.set(id, `${id}${suffix}`)
  }
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) {
      const next = attr.name === 'id' ? ids.get(attr.value) : attr.value.includes('#') ? retarget(attr.value, ids) : attr.value
      if (next && next !== attr.value) node.setAttribute(attr.name, next)
    }
  }
  return new XMLSerializer().serializeToString(root)
}

export function MermaidBlock({ code, dark, fallback, preview = false }: { code: string; dark: boolean; fallback: ReactNode; preview?: boolean }) {
  const cached = svgCache.get(cacheKey(dark, code))
  const [svg, setSvg] = useState(cached ?? '')
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(!cached)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  useEffect(() => { setOpen(false) }, [code, dark])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  function openPreview() {
    const next = URL.createObjectURL(new Blob([sizedSvg(svg)], { type: 'image/svg+xml;charset=utf-8' }))
    setUrl(current => { if (current) URL.revokeObjectURL(current); return next })
    setOpen(true)
  }
  useEffect(() => {
    const key = cacheKey(dark, code)
    const hit = svgCache.get(key)
    if (hit) {
      setSvg(hit)
      setError('')
      setRendering(false)
      return
    }
    let alive = true
    setRendering(true)
    setError('')
    const timer = window.setTimeout(() => {
      void renderDiagram(dark, code).then(rendered => {
        remember(key, rendered)
        if (!alive) return
        setSvg(rendered)
        setError('')
        setRendering(false)
      }).catch(reason => {
        if (!alive) return
        setSvg('')
        setError(diagramError(reason))
        setRendering(false)
      })
    }, 300)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [code, dark])
  if (error) return <div className="mermaid-fallback">{fallback}<p className="mermaid-error">{error}</p></div>
  const markup = svg ? { __html: svg } : undefined
  if (preview && svg) return <>
    <button type="button" className="mermaid-block" aria-label="预览图表" title="预览图表" onClick={openPreview} dangerouslySetInnerHTML={markup} />
    {open && url && <ImagePreview src={url} alt="图表" fileName="图表.svg" kind="diagram" markup={sizedSvg(svg)} onClose={() => setOpen(false)} />}
  </>
  return <div className="mermaid-block" data-rendering={rendering ? 'true' : undefined} dangerouslySetInnerHTML={markup} />
}
