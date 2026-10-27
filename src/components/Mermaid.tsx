import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Mermaid } from 'mermaid'

const svgCache = new Map<string, string>()
let mermaidModule: Promise<Mermaid> | undefined
let renderChain: Promise<void> = Promise.resolve()
let nextId = 0

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

export function MermaidBlock({ code, dark, fallback }: { code: string; dark: boolean; fallback: ReactNode }) {
  const cached = svgCache.get(cacheKey(dark, code))
  const [svg, setSvg] = useState(cached ?? '')
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(!cached)
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
  return <div className="mermaid-block" data-rendering={rendering ? 'true' : undefined} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
}
