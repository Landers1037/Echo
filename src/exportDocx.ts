import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { HighlightColor, TextRun, UnderlineType } from 'docx'
import remarkBreaks from 'remark-breaks'
import remarkDocx from 'remark-docx'
import { imagePlugin } from 'remark-docx/plugins/image'
import { mermaidPlugin } from 'remark-docx/plugins/mermaid'
import { shikiPlugin } from 'remark-docx/plugins/shiki'
import type { RemarkDocxPlugin } from 'remark-docx'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Root, RootContent } from 'mdast'
import { DrawingEmbed } from './components/Drawing'
import { DrawioEmbed } from './components/Drawio'
import { drawingKind, remarkUnderline } from './components/MarkdownView'
import type { ExportSnapshot } from './types'

const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

type NoteSnapshot = ExportSnapshot['notes'][number]
type RunStyle = {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  inlineCode?: boolean
  link?: boolean
  underline?: boolean
}
type RunContext = {
  render: (nodes: readonly RootContent[], ctx?: RunContext) => unknown
  style: RunStyle
  rtl?: boolean
}

function underlinePlugin(): RemarkDocxPlugin {
  return async () => ({
    underline(node: { children?: RootContent[] }, ctx: RunContext) {
      return ctx.render(node.children ?? [], { ...ctx, style: { ...ctx.style, underline: true } })
    },
    text(node: { value: string }, ctx: RunContext) {
      if (!ctx.style.underline) return null
      return new TextRun({
        text: node.value,
        bold: ctx.style.bold,
        italics: ctx.style.italic,
        strike: ctx.style.strike,
        underline: { type: UnderlineType.SINGLE },
        highlight: ctx.style.inlineCode ? HighlightColor.LIGHT_GRAY : undefined,
        style: ctx.style.link ? 'Hyperlink' : undefined,
        rightToLeft: ctx.rtl,
      })
    },
  }) as Awaited<ReturnType<RemarkDocxPlugin>>
}

function assetData(assets: Record<string, string>, url: string) {
  const candidates = [url]
  try {
    const decoded = decodeURIComponent(url)
    if (decoded !== url) candidates.push(decoded)
  } catch { /* The markdown url is not percent-encoded. */ }
  try {
    const encoded = encodeURI(url)
    if (!candidates.includes(encoded)) candidates.push(encoded)
  } catch { /* Leave the original url as the only candidate. */ }
  return candidates.map(key => assets[key]).find(Boolean) || ''
}

function dataUrlBytes(value: string) {
  const comma = value.indexOf(',')
  const meta = comma >= 0 ? value.slice(0, comma) : ''
  const payload = comma >= 0 ? value.slice(comma + 1) : value
  if (/;base64/i.test(meta)) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes.buffer
  }
  return new TextEncoder().encode(decodeURIComponent(payload)).buffer
}

function pixelLength(value: string | null | undefined) {
  if (!value || value.includes('%')) return 0
  const size = Number.parseFloat(value)
  return Number.isFinite(size) && size > 0 ? size : 0
}

function viewBoxSize(svg: SVGElement) {
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? []
  return box.length === 4 && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : null
}

function measureSvg(svg: SVGElement): { width: number; height: number } {
  const box = viewBoxSize(svg)
  const nested = svg.querySelector('svg')
  const nestedBox = nested ? viewBoxSize(nested) : null
  let width = box?.width || pixelLength(svg.getAttribute('width')) || pixelLength(svg.style.minWidth) || nestedBox?.width || 0
  let height = box?.height || pixelLength(svg.getAttribute('height')) || pixelLength(svg.style.minHeight) || nestedBox?.height || 0
  const graphic = svg as SVGElement & { getBBox?: () => { width: number; height: number } }
  if ((!width || !height) && typeof graphic.getBBox === 'function') {
    try {
      const bounds = graphic.getBBox()
      width = width || bounds.width
      height = height || bounds.height
    } catch { /* The SVG is not rendered yet. */ }
  }
  return { width: Math.max(1, Math.round(width || 960)), height: Math.max(1, Math.round(height || 540)) }
}

// image-size rejects an SVG whose width or height is a percentage when it also has no usable viewBox,
// and that TypeError aborts the whole Word export.
function svgBytes(svg: SVGElement) {
  const { width, height } = measureSvg(svg)
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  if (!viewBoxSize(svg)) svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const encoded = new TextEncoder().encode(svg.outerHTML)
  return encoded.byteLength === encoded.buffer.byteLength ? encoded.buffer : encoded.slice().buffer
}

function looksLikeSvg(bytes: ArrayBuffer) {
  const head = new TextDecoder().decode(new Uint8Array(bytes).subarray(0, 300)).trim().replace(/^\uFEFF/, '')
  return /^<\?xml[\s>]/i.test(head) || /^<svg[\s>]/i.test(head)
}

function normalizeSvgBytes(bytes: ArrayBuffer) {
  if (!looksLikeSvg(bytes)) return bytes
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '')
  const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement
  if (root.nodeName.toLowerCase() !== 'svg') throw new Error('图片无法读取')
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:0;height:0;overflow:hidden;'
  document.body.append(host)
  host.append(root)
  try { return svgBytes(root as unknown as SVGElement) }
  finally { host.remove() }
}

async function drawingSvg(kind: 'drawio' | 'excalidraw', source: string, alt: string) {
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-20000px;top:0;width:800px;pointer-events:none;'
  document.body.append(container)
  const root = createRoot(container)
  try {
    if (kind === 'drawio') root.render(createElement(DrawioEmbed, { path: source, alt, exporting: true }))
    else root.render(createElement(DrawingEmbed, { path: source, alt, exporting: true }))
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 40))
      const frame = container.querySelector('.drawing-frame')
      if (frame && frame.getAttribute('data-rendering') !== 'true') break
    }
    const svg = container.querySelector('svg')
    return svg ? svgBytes(svg) : null
  } catch {
    return null
  } finally {
    root.unmount()
    container.remove()
  }
}

function hasChildren(node: RootContent): node is RootContent & { children: RootContent[] } {
  return 'children' in node && Array.isArray(node.children)
}

async function embedDrawings(node: { children: RootContent[] }, assets: Record<string, string>, ready: Map<string, ArrayBuffer>, missing: Set<string>) {
  const next: RootContent[] = []
  for (const child of node.children) {
    if (child.type === 'image') {
      const kind = drawingKind(child.url)
      if (kind) {
        if (!ready.has(child.url) && !missing.has(child.url)) {
          const source = assetData(assets, child.url)
          const bytes = source ? await drawingSvg(kind, source, child.alt || '绘图') : null
          if (bytes) ready.set(child.url, bytes)
          else missing.add(child.url)
        }
        if (missing.has(child.url)) {
          next.push({ type: 'text', value: `[绘图缺失：${child.alt || child.url}]` })
          continue
        }
      }
    }
    if (hasChildren(child)) await embedDrawings(child, assets, ready, missing)
    next.push(child)
  }
  node.children = next
}

async function loadImage(url: string, assets: Record<string, string>, ready: Map<string, ArrayBuffer>) {
  const drawing = ready.get(url)
  if (drawing) return normalizeSvgBytes(drawing)
  if (drawingKind(url)) throw new Error('绘图缺失')
  if (url.startsWith('data:')) return normalizeSvgBytes(dataUrlBytes(url))
  const embedded = assetData(assets, url)
  if (embedded) return normalizeSvgBytes(dataUrlBytes(embedded))
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`图片无法读取 (${response.status})`)
    return normalizeSvgBytes(await response.arrayBuffer())
  }
  throw new Error('图片缺失')
}

export async function noteToDocx(note: NoteSnapshot, { strictLineBreaks }: { strictLineBreaks: boolean }) {
  const ready = new Map<string, ArrayBuffer>()
  const missing = new Set<string>()
  const processor = unified().use(remarkParse).use(remarkGfm)
  // Match the preview: a single newline becomes a break only when strict line breaks are on.
  if (strictLineBreaks) processor.use(remarkBreaks)
  const file = await processor
    .use(remarkFrontmatter)
    .use(remarkUnderline)
    .use(() => async tree => {
      const root = tree as Root
      const frontmatter = new Set<string>(['yaml', 'toml'])
      root.children = root.children.filter(child => !frontmatter.has(child.type))
      await embedDrawings(root, note.assets, ready, missing)
      const meta = [note.metadata.group || '未分组', ...note.metadata.tags.map(tag => `#${tag}`)].join(' ')
      root.children.unshift(
        { type: 'heading', depth: 1, children: [{ type: 'text', value: note.title }] },
        { type: 'paragraph', children: [{ type: 'text', value: meta }] },
      )
    })
    .use(remarkDocx, {
      thematicBreak: 'line',
      plugins: [
        imagePlugin({ load: url => loadImage(url, note.assets, ready) }),
        shikiPlugin({ theme: 'github-light' }),
        mermaidPlugin(),
        underlinePlugin(),
      ],
    })
    .process(note.content)
  const result = await file.result as unknown
  if (result instanceof ArrayBuffer) return new Blob([result], { type: docxType })
  if (result instanceof Uint8Array) return new Blob([Uint8Array.from(result).buffer as ArrayBuffer], { type: docxType })
  throw new Error('Word 文档生成失败')
}
