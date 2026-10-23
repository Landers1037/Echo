import { createContext, createElement, useContext, useEffect, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { codeToHtml } from 'shiki'
import { Check, Copy } from 'lucide-react'

export type MarkdownViewProps = {
  content: string
  notePath: string
  assets?: Record<string, string>
  lineNumbers: boolean
  fontSize?: number
  onNavigate?: (path: string) => void
  onToggleTask?: (line: number, checked: boolean) => void
  exporting?: boolean
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

function CodeBlock({ code, language, lineNumbers, exporting }: { code: string; language: string; lineNumbers: boolean; exporting: boolean }) {
  const [html, setHtml] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    setHtml('')
    void highlightedCode(code, language).then(result => { if (alive) setHtml(result) }).catch(() => { /* Plain code remains available if highlighting fails. */ })
    return () => { alive = false }
  }, [code, language])
  return <div className={`code-block${lineNumbers ? ' show-line-numbers' : ''}`} data-rendering={!html ? 'true' : undefined}>
    <div className="code-header"><span>{language || 'text'}</span>{!exporting && <button className="code-copy" type="button" onClick={() => { void navigator.clipboard.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800) }) }} aria-label="复制代码">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制'}</button>}</div>
    {html ? <div className="code-highlight" dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code>{code}</code></pre>}
  </div>
}

function TaskCheckbox({ checked, onToggle }: { checked?: boolean; onToggle?: MarkdownViewProps['onToggleTask'] }) {
  const line = useContext(TaskLineContext)
  return <input type="checkbox" checked={Boolean(checked)} disabled={!onToggle || line < 1} aria-label={checked ? '标记任务为未完成' : '标记任务为完成'} onChange={event => onToggle?.(line, event.target.checked)} />
}

function sourceHeading(tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5') {
  return ({ node, children, ...props }: ComponentPropsWithoutRef<'h1'> & ExtraProps) => createElement(tag, { ...props, 'data-heading-line': node?.position?.start.line, tabIndex: -1 }, children)
}
const previewHeadings = { h1: sourceHeading('h1'), h2: sourceHeading('h2'), h3: sourceHeading('h3'), h4: sourceHeading('h4'), h5: sourceHeading('h5') }

export function MarkdownView({ content, notePath, assets, lineNumbers, fontSize, onNavigate, onToggleTask, exporting = false }: MarkdownViewProps) {
  return <div className="markdown-body" style={!exporting && fontSize !== undefined ? { fontSize } : undefined}><ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]} skipHtml components={{
    ...(!exporting ? previewHeadings : {}),
    pre({ children }) { return <>{children}</> },
    code({ className, children, node }) {
      const code = String(children).replace(/\n$/, '')
      const language = /language-([^\s]+)/.exec(className || '')?.[1] || 'text'
      const block = Boolean(className) || (node?.position?.start.line !== node?.position?.end.line) || String(children).endsWith('\n')
      return block ? <CodeBlock code={code} language={language} lineNumbers={lineNumbers} exporting={exporting} /> : <code className={className}>{children}</code>
    },
    img({ src, alt, title }) {
      if (!src) return <span className="missing-image">图片地址为空</span>
      const external = /^(https?:|data:|blob:|\/\/)/i.test(src)
      const embedded = assets?.[src] || assets?.[decodeSafe(src)]
      if (exporting && !external && !embedded) return <span className="missing-image">[图片缺失：{alt || src}]</span>
      const image = embedded || (external ? src : `/api/assets?path=${encodeURIComponent(resolveNotePath(notePath, src))}`)
      return <img src={image} alt={alt || ''} title={title} loading={exporting ? 'eager' : 'lazy'} onError={event => { event.currentTarget.classList.add('image-error') }} />
    },
    a({ href, children, title }) {
      const internal = Boolean(href && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href) && /\.md(?:[?#]|$)/i.test(href))
      const target = internal && href ? resolveNotePath(notePath, href) : ''
      return <a href={href} title={title} data-note-link={internal ? target : undefined} onClick={internal && onNavigate ? event => { event.preventDefault(); onNavigate(target) } : undefined} target={!internal && href && /^(https?:|\/\/)/i.test(href) ? '_blank' : undefined} rel="noreferrer">{children}</a>
    },
    li({ children, className, node }) {
      const line = node?.position?.start.line || -1
      return <TaskLineContext.Provider value={line}><li className={className}>{children as ReactNode}</li></TaskLineContext.Provider>
    },
    input({ type, checked }) { return type === 'checkbox' ? <TaskCheckbox checked={checked} onToggle={onToggleTask} /> : null },
    table({ children }) { return <div className="markdown-table-wrap"><table>{children}</table></div> },
  }}>{content}</ReactMarkdown></div>
}

function decodeSafe(value: string) { try { return decodeURIComponent(value) } catch { return value } }
