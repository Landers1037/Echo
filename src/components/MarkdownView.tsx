import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkFrontmatter from 'remark-frontmatter'
import { codeToHtml } from 'shiki'
import { Check, Copy, FileSymlink } from 'lucide-react'
import { apiURL } from '../api'
import { NOTE_REF_TITLE } from '../noteReference'
import { DrawingEmbed } from './Drawing'
import { DrawioEmbed } from './Drawio'
import { ImagePreview, PreviewableImage } from './ImagePreview'
import { LinkCard } from './LinkCard'
import { MermaidBlock } from './Mermaid'

export type MarkdownViewProps = {
  content: string
  notePath: string
  assets?: Record<string, string>
  lineNumbers: boolean
  fontSize?: number
  noteTitles?: Record<string, string>
  onNavigate?: (path: string) => void
  onToggleTask?: (line: number, checked: boolean) => void
  onEditDrawing?: (path: string) => void
  drawingVersion?: number
  exporting?: boolean
  dark?: boolean
  strictLineBreaks?: boolean
  autoParseLinks?: boolean
  annotations?: ReactNode
}

type MarkdownRenderContextValue = {
  notePath: string
  assets?: Record<string, string>
  lineNumbers: boolean
  noteTitles?: Record<string, string>
  onNavigate?: (path: string) => void
  onToggleTask?: (line: number, checked: boolean) => void
  onEditDrawing?: (path: string) => void
  drawingVersion: number
  exporting: boolean
  dark: boolean
  autoParseLinks: boolean
  openImage: (src: string, alt: string) => void
}

const TaskLineContext = createContext(-1)
const MarkdownRenderContext = createContext<MarkdownRenderContextValue | null>(null)
const codePromiseCache = new Map<string, Promise<string>>()
const codeHtmlCache = new Map<string, string>()

function useMarkdownRender() {
  const value = useContext(MarkdownRenderContext)
  if (!value) throw new Error('MarkdownRenderContext missing')
  return value
}

export function resolveNotePath(notePath: string, target: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(target.split('#')[0].split('?')[0]) } catch { decoded = target }
  const root = decoded.startsWith('/') ? [] : notePath.split('/').slice(0, -1)
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') root.pop()
    else root.push(part)
  }
  return root.join('/')
}

function codeCacheKey(code: string, language: string) {
  return language + '\u0000' + code
}

function rememberCodeHtml(key: string, html: string) {
  codeHtmlCache.set(key, html)
  if (codeHtmlCache.size > 150) codeHtmlCache.delete(codeHtmlCache.keys().next().value!)
}

function highlightedCode(code: string, language: string): Promise<string> {
  const key = codeCacheKey(code, language)
  const cached = codeHtmlCache.get(key)
  if (cached) return Promise.resolve(cached)
  if (!codePromiseCache.has(key)) {
    const request = codeToHtml(code, { lang: language, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: 'light' })
      .catch(() => codeToHtml(code, { lang: 'text', themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: 'light' }))
      .then(html => {
        rememberCodeHtml(key, html)
        return html
      })
    codePromiseCache.set(key, request)
    if (codePromiseCache.size > 150) codePromiseCache.delete(codePromiseCache.keys().next().value!)
  }
  return codePromiseCache.get(key)!
}

function CodeBlock({ code, language, lineNumbers, exporting, sourceLine }: { code: string; language: string; lineNumbers: boolean; exporting: boolean; sourceLine?: number }) {
  const cacheKey = codeCacheKey(code, language)
  const [html, setHtml] = useState(() => codeHtmlCache.get(cacheKey) || '')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    const cached = codeHtmlCache.get(cacheKey)
    if (cached) {
      setHtml(cached)
      return
    }
    void highlightedCode(code, language).then(result => { if (alive) setHtml(result) }).catch(() => { /* Plain code remains available if highlighting fails. */ })
    return () => { alive = false }
  }, [cacheKey, code, language])
  return <div className={`code-block${lineNumbers ? ' show-line-numbers' : ''}`} data-rendering={!html ? 'true' : undefined} data-source-line={sourceLine}>
    <div className="code-header"><span>{language || 'text'}</span>{!exporting && <button className="code-copy" type="button" onClick={() => { void navigator.clipboard.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800) }) }} aria-label="复制代码">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button>}</div>
    {html ? <div className="code-highlight" dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code>{code}</code></pre>}
  </div>
}

function TaskCheckbox({ checked, onToggle }: { checked?: boolean; onToggle?: MarkdownViewProps['onToggleTask'] }) {
  const line = useContext(TaskLineContext)
  return <input type="checkbox" checked={Boolean(checked)} disabled={!onToggle || line < 1} aria-label={checked ? '标记任务为未完成' : '标记任务为完成'} onChange={event => onToggle?.(line, event.target.checked)} />
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: { hName?: string } }
const openUnderline = /^<\s*u\s*>$/i
const closeUnderline = /^<\s*\/\s*u\s*>$/i

function htmlValue(node: MarkdownNode) {
  return node.type === 'html' && typeof node.value === 'string' ? node.value.trim() : ''
}

function closingUnderline(children: MarkdownNode[], start: number) {
  let depth = 1
  for (let index = start; index < children.length; index++) {
    const value = htmlValue(children[index])
    if (openUnderline.test(value)) depth++
    else if (closeUnderline.test(value)) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function wrapUnderline(node: MarkdownNode) {
  if (!node.children) return
  const next: MarkdownNode[] = []
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index]
    if (openUnderline.test(htmlValue(child))) {
      const close = closingUnderline(node.children, index + 1)
      if (close >= 0) {
        next.push({ type: 'underline', data: { hName: 'u' }, children: node.children.slice(index + 1, close) })
        index = close
        continue
      }
    }
    next.push(child)
  }
  node.children = next
  for (const child of next) wrapUnderline(child)
}

export function remarkUnderline() {
  return (tree: MarkdownNode) => { wrapUnderline(tree) }
}

const defaultRemarkPlugins = [remarkGfm, remarkFrontmatter, remarkUnderline]
const breakRemarkPlugins = [remarkGfm, remarkBreaks, remarkFrontmatter, remarkUnderline]

function sourceHeading(tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5') {
  return ({ node, children, ...props }: ComponentPropsWithoutRef<'h1'> & ExtraProps) => createElement(tag, { ...props, 'data-heading-line': node?.position?.start.line, 'data-source-line': node?.position?.start.line, tabIndex: -1 }, children)
}
function sourceParagraph({ node, children, ...props }: ComponentPropsWithoutRef<'p'> & ExtraProps) {
  return <p {...props} data-source-line={node?.position?.start.line}>{children}</p>
}
function sourceQuote({ node, children, ...props }: ComponentPropsWithoutRef<'blockquote'> & ExtraProps) {
  return <blockquote {...props} data-source-line={node?.position?.start.line}>{children}</blockquote>
}
function sourceH6({ node, children, ...props }: ComponentPropsWithoutRef<'h6'> & ExtraProps) {
  return <h6 {...props} data-source-line={node?.position?.start.line}>{children}</h6>
}
const previewBlocks = { p: sourceParagraph, blockquote: sourceQuote, h6: sourceH6 }
const previewHeadings = { h1: sourceHeading('h1'), h2: sourceHeading('h2'), h3: sourceHeading('h3'), h4: sourceHeading('h4'), h5: sourceHeading('h5') }

export function drawingKind(src: string): '' | 'drawio' | 'excalidraw' {
  const clean = decodeSafe(src).split('#')[0].split('?')[0]
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(clean)) return ''
  if (/\.drawio$/i.test(clean)) return 'drawio'
  if (/\.excalidraw$/i.test(clean)) return 'excalidraw'
  return ''
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<'pre'>) {
  return <>{children}</>
}

function MarkdownCode({ className, children, node }: ComponentPropsWithoutRef<'code'> & ExtraProps) {
  const { lineNumbers, exporting, dark } = useMarkdownRender()
  const code = String(children).replace(/\n$/, '')
  const language = /language-([^\s]+)/.exec(className || '')?.[1] || 'text'
  const block = Boolean(className) || (node?.position?.start.line !== node?.position?.end.line) || String(children).endsWith('\n')
  const sourceLine = exporting ? undefined : node?.position?.start.line
  if (language === 'mermaid' && block) {
    const diagram = <MermaidBlock code={code} dark={!exporting && dark} preview={!exporting} fallback={<CodeBlock code={code} language={language} lineNumbers={lineNumbers} exporting={exporting} sourceLine={sourceLine} />} />
    return exporting ? diagram : <div data-source-line={sourceLine}>{diagram}</div>
  }
  return block ? <CodeBlock code={code} language={language} lineNumbers={lineNumbers} exporting={exporting} sourceLine={sourceLine} /> : <code className={className}>{children}</code>
}

function MarkdownImg({ src, alt, title }: ComponentPropsWithoutRef<'img'>) {
  const { notePath, assets, exporting, drawingVersion, onEditDrawing, openImage } = useMarkdownRender()
  if (!src) return <span className="missing-image">图片地址为空</span>
  const kind = drawingKind(src)
  if (kind) {
    const drawing = resolveNotePath(notePath, src)
    const embedded = assets?.[src] || assets?.[decodeSafe(src)]
    if (exporting && !embedded) return <span className="missing-image">[绘图缺失：{alt || src}]</span>
    const embed = { path: embedded || drawing, alt: alt || '绘图', exporting, version: drawingVersion, onEdit: exporting ? undefined : onEditDrawing }
    return kind === 'drawio' ? <DrawioEmbed {...embed} /> : <DrawingEmbed {...embed} />
  }
  const external = /^(https?:|data:|blob:|\/\/)/i.test(src)
  const embedded = assets?.[src] || assets?.[decodeSafe(src)]
  if (exporting && !external && !embedded) return <span className="missing-image">[图片缺失：{alt || src}]</span>
  const image = embedded || (external ? src : apiURL(`/api/assets?path=${encodeURIComponent(resolveNotePath(notePath, src))}`))
  if (exporting) return <img src={image} alt={alt || ''} title={title} loading="eager" onError={event => { event.currentTarget.classList.add('image-error') }} />
  return <PreviewableImage src={image} alt={alt || ''} title={title} onOpen={() => openImage(image, alt || '')} />
}

function MarkdownAnchor({ href, children, title, node }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const { notePath, noteTitles, onNavigate, exporting, autoParseLinks } = useMarkdownRender()
  const internal = Boolean(href && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href) && /\.md(?:[?#]|$)/i.test(href))
  const target = internal && href ? resolveNotePath(notePath, href) : ''
  if (internal && title === NOTE_REF_TITLE) {
    const known = Boolean(noteTitles && Object.prototype.hasOwnProperty.call(noteTitles, target))
    const filename = target.split('/').pop()?.replace(/\.md$/i, '') || target
    const label = known ? (noteTitles?.[target] || filename) : noteTitles ? filename : children
    const missing = Boolean(noteTitles) && !known
    const open = () => onNavigate?.(target)
    const icon = <FileSymlink size={16} strokeWidth={1.7} />
    return <span className={missing ? 'note-ref missing' : 'note-ref'} title={missing ? '笔记不存在' : undefined}>
      {exporting ? <span className="note-ref-icon" aria-hidden="true">{icon}</span> : <button type="button" className="note-ref-icon" aria-label="打开引用的笔记" onClick={open}>{icon}</button>}
      {exporting ? <span className="note-ref-title">{label}</span> : <button type="button" className="note-ref-title" onClick={open}>{label}</button>}
    </span>
  }
  if (!exporting && autoParseLinks && href && previewableHref(href) && !wrapsImage(node)) return <LinkCard url={href} label={plainText(node)} />
  return <a href={href} title={title} data-note-link={internal ? target : undefined} onClick={internal && onNavigate ? event => { event.preventDefault(); onNavigate(target) } : undefined} target={!internal && href && /^(https?:|\/\/)/i.test(href) ? '_blank' : undefined} rel="noreferrer">{children}</a>
}

function MarkdownListItem({ children, className, node }: ComponentPropsWithoutRef<'li'> & ExtraProps) {
  const { exporting } = useMarkdownRender()
  const line = node?.position?.start.line || -1
  return <TaskLineContext.Provider value={line}><li className={className} data-source-line={exporting || line < 1 ? undefined : line}>{children as ReactNode}</li></TaskLineContext.Provider>
}

function MarkdownInput({ type, checked }: ComponentPropsWithoutRef<'input'>) {
  const { onToggleTask } = useMarkdownRender()
  return type === 'checkbox' ? <TaskCheckbox checked={checked} onToggle={onToggleTask} /> : null
}

function MarkdownTable({ children, node }: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  const { exporting } = useMarkdownRender()
  return <div className="markdown-table-wrap" data-source-line={exporting ? undefined : node?.position?.start.line}><table>{children}</table></div>
}

const previewComponents: Components = {
  ...previewHeadings,
  ...previewBlocks,
  pre: MarkdownPre,
  code: MarkdownCode,
  img: MarkdownImg,
  a: MarkdownAnchor,
  li: MarkdownListItem,
  input: MarkdownInput,
  table: MarkdownTable,
}

const exportComponents: Components = {
  pre: MarkdownPre,
  code: MarkdownCode,
  img: MarkdownImg,
  a: MarkdownAnchor,
  li: MarkdownListItem,
  input: MarkdownInput,
  table: MarkdownTable,
}

export function MarkdownView({ content, notePath, assets, lineNumbers, fontSize, noteTitles, onNavigate, onToggleTask, onEditDrawing, drawingVersion = 0, exporting = false, dark = false, strictLineBreaks = false, autoParseLinks = false, annotations }: MarkdownViewProps) {
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null)
  useEffect(() => { setImagePreview(null) }, [notePath, exporting])
  const remarkPlugins = strictLineBreaks ? breakRemarkPlugins : defaultRemarkPlugins
  const components = exporting ? exportComponents : previewComponents
  const render = useMemo<MarkdownRenderContextValue>(() => ({
    notePath,
    assets,
    lineNumbers,
    noteTitles,
    onNavigate,
    onToggleTask,
    onEditDrawing,
    drawingVersion,
    exporting,
    dark,
    autoParseLinks,
    openImage: (src, alt) => setImagePreview({ src, alt }),
  }), [notePath, assets, lineNumbers, noteTitles, onNavigate, onToggleTask, onEditDrawing, drawingVersion, exporting, dark, autoParseLinks])
  return <MarkdownRenderContext.Provider value={render}><div className="markdown-body" style={!exporting && fontSize !== undefined ? { fontSize } : undefined}><ReactMarkdown remarkPlugins={remarkPlugins} skipHtml components={components}>{content}</ReactMarkdown>{imagePreview && <ImagePreview src={imagePreview.src} alt={imagePreview.alt} onClose={() => setImagePreview(null)} />}{!exporting && annotations}</div></MarkdownRenderContext.Provider>
}

function decodeSafe(value: string) { try { return decodeURIComponent(value) } catch { return value } }

function previewableHref(href: string) {
  return /^(?:https?:)?\/\//i.test(href)
}

function wrapsImage(node: ExtraProps['node']) {
  return node?.children?.some(child => child.type === 'element' && child.tagName === 'img') ?? false
}

function plainText(node: ExtraProps['node']): string {
  if (!node?.children) return ''
  return node.children.map(child => child.type === 'text' ? child.value : child.type === 'element' ? plainText(child) : '').join('')
}
