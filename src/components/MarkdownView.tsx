import { createContext, createElement, useContext, useEffect, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { ExtraProps } from 'react-markdown'
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

const TaskLineContext = createContext(-1)
const codeCache = new Map<string, Promise<string>>()

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

function highlightedCode(code: string, language: string): Promise<string> {
  const key = language + '\u0000' + code
  if (!codeCache.has(key)) {
    codeCache.set(key, codeToHtml(code, { lang: language, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: 'light' }).catch(() => codeToHtml(code, { lang: 'text', themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: 'light' })))
    if (codeCache.size > 150) codeCache.delete(codeCache.keys().next().value!)
  }
  return codeCache.get(key)!
}

function CodeBlock({ code, language, lineNumbers, exporting, sourceLine }: { code: string; language: string; lineNumbers: boolean; exporting: boolean; sourceLine?: number }) {
  const [html, setHtml] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    setHtml('')
    void highlightedCode(code, language).then(result => { if (alive) setHtml(result) }).catch(() => { /* Plain code remains available if highlighting fails. */ })
    return () => { alive = false }
  }, [code, language])
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

export function MarkdownView({ content, notePath, assets, lineNumbers, fontSize, noteTitles, onNavigate, onToggleTask, onEditDrawing, drawingVersion = 0, exporting = false, dark = false, strictLineBreaks = false, autoParseLinks = false, annotations }: MarkdownViewProps) {
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null)
  useEffect(() => { setImagePreview(null) }, [notePath, exporting])
  const remarkPlugins = strictLineBreaks ? [remarkGfm, remarkBreaks, remarkFrontmatter, remarkUnderline] : [remarkGfm, remarkFrontmatter, remarkUnderline]
  return <div className="markdown-body" style={!exporting && fontSize !== undefined ? { fontSize } : undefined}><ReactMarkdown remarkPlugins={remarkPlugins} skipHtml components={{
    ...(!exporting ? previewHeadings : {}),
    ...(!exporting ? previewBlocks : {}),
    pre({ children }) { return <>{children}</> },
    code({ className, children, node }) {
      const code = String(children).replace(/\n$/, '')
      const language = /language-([^\s]+)/.exec(className || '')?.[1] || 'text'
      const block = Boolean(className) || (node?.position?.start.line !== node?.position?.end.line) || String(children).endsWith('\n')
      const sourceLine = exporting ? undefined : node?.position?.start.line
      if (language === 'mermaid' && block) {
        const diagram = <MermaidBlock code={code} dark={!exporting && dark} preview={!exporting} fallback={<CodeBlock code={code} language={language} lineNumbers={lineNumbers} exporting={exporting} sourceLine={sourceLine} />} />
        return exporting ? diagram : <div data-source-line={sourceLine}>{diagram}</div>
      }
      return block ? <CodeBlock code={code} language={language} lineNumbers={lineNumbers} exporting={exporting} sourceLine={sourceLine} /> : <code className={className}>{children}</code>
    },
    img({ src, alt, title }) {
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
      return <PreviewableImage src={image} alt={alt || ''} title={title} onOpen={() => setImagePreview({ src: image, alt: alt || '' })} />
    },
    a({ href, children, title, node }) {
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
    },
    li({ children, className, node }) {
      const line = node?.position?.start.line || -1
      return <TaskLineContext.Provider value={line}><li className={className} data-source-line={exporting || line < 1 ? undefined : line}>{children as ReactNode}</li></TaskLineContext.Provider>
    },
    input({ type, checked }) { return type === 'checkbox' ? <TaskCheckbox checked={checked} onToggle={onToggleTask} /> : null },
    table({ children, node }) { return <div className="markdown-table-wrap" data-source-line={exporting ? undefined : node?.position?.start.line}><table>{children}</table></div> },
  }}>{content}</ReactMarkdown>{imagePreview && <ImagePreview src={imagePreview.src} alt={imagePreview.alt} onClose={() => setImagePreview(null)} />}{!exporting && annotations}</div>
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
