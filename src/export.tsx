import { createRoot } from 'react-dom/client'
import { zipSync, strToU8 } from 'fflate'
import { MarkdownView } from './components/MarkdownView'
import type { ExportSnapshot } from './types'

type ExportFormat = 'md' | 'bundle' | 'html' | 'pdf'
type Warning = { missing: string[]; external: string[] }
type ExportOptions = {
  paths: string[]
  format: ExportFormat
  lineNumbers: boolean
  beforeExport: () => Promise<void>
  onWarning: (warning: Warning) => Promise<boolean>
}

const exportStyles = `
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#252b27;background:#fff;font-size:15px;line-height:1.85}
*{box-sizing:border-box}body{margin:0}main{max-width:900px;margin:56px auto;padding:0 36px}a{color:#527b5b;text-decoration:none}a:hover{text-decoration:underline}h1,h2,h3,h4{line-height:1.35;break-after:avoid}h1{font-size:32px;font-weight:650;letter-spacing:-.03em;margin:0 0 18px}h2{font-size:23px;margin:32px 0 14px}h3{font-size:19px;margin:26px 0 12px}p{margin:14px 0}.export-meta{font-size:12px;color:#777e78;display:flex;flex-wrap:wrap;gap:10px;margin:0 0 34px}.export-tag{background:#eff3ee;color:#527b5b;padding:1px 8px;border-radius:4px}.export-note+.export-note{margin-top:70px;padding-top:40px;border-top:1px solid #e8ece7}.export-path{font-size:12px;color:#8b928c;margin-bottom:10px}.markdown-body{overflow-wrap:anywhere}.markdown-body img{max-width:100%;height:auto;display:block;border-radius:5px;margin:22px 0}.markdown-body blockquote{margin:22px 0;padding:2px 20px;border-left:3px solid #96ac98;color:#687369;background:#f7f9f6}.markdown-body ul,.markdown-body ol{padding-left:24px}.markdown-body li{margin:5px 0}.markdown-body hr{border:0;border-top:1px solid #e1e6df;margin:30px 0}.markdown-body code{font:13px/1.7 "SFMono-Regular",Consolas,"Liberation Mono",monospace;background:#f2f4f0;border-radius:4px;padding:2px 5px}.markdown-body pre{overflow:auto;margin:0;padding:16px 18px;background:#f6f8fa!important;white-space:pre;tab-size:2}.markdown-body pre code{background:none;padding:0;color:inherit}.code-block{border:1px solid #e3e8e1;border-radius:6px;overflow:hidden;margin:22px 0}.code-header{padding:6px 14px;background:#f3f5f1;border-bottom:1px solid #e3e8e1;font:11px/1.6 "SFMono-Regular",Consolas,monospace;color:#778272}.show-line-numbers pre code{counter-reset:line}.show-line-numbers pre code>.line:before{counter-increment:line;content:counter(line);display:inline-block;width:2.7em;margin-right:1.3em;color:#98a198;text-align:right;user-select:none}.markdown-table-wrap{overflow:auto;margin:22px 0}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #e0e6de;padding:9px 13px;text-align:left}th{background:#f3f6f0;font-weight:600}tr:nth-child(even){background:#fafbf9}.contains-task-list{list-style:none;padding-left:3px!important}.task-list-item input{margin:0 9px 0 0;accent-color:#72967b}.export-toc{padding:22px 28px;background:#f6f8f3;border-radius:6px;margin:0 0 42px}.export-toc h2{margin-top:0}.print-actions{position:sticky;top:0;z-index:3;display:flex;gap:14px;align-items:center;justify-content:center;border-bottom:1px solid #e4e8e0;padding:12px;background:#f5f8f0;font-size:13px}.print-actions button{font:inherit;border:0;border-radius:5px;background:#527b5b;color:white;padding:8px 15px;cursor:pointer}.print-status{color:#778272}.image-error{min-height:32px}.missing-image{color:#a45740}
@page{size:A4;margin:18mm 16mm} @media print{body{font-size:11pt}main{width:auto;max-width:none;margin:0;padding:0}.print-actions{display:none}.export-note+.export-note{break-before:page;border:0;margin:0;padding:0}.export-toc{break-after:page}a{color:inherit;text-decoration:none}thead{display:table-header-group}tr{break-inside:avoid}img{max-height:240mm;object-fit:contain;break-inside:avoid}.markdown-table-wrap{overflow:visible}table{table-layout:fixed}th,td{overflow-wrap:anywhere}pre{white-space:pre-wrap!important;overflow:visible!important;word-break:break-word}pre code{white-space:pre-wrap!important}.code-block{break-inside:auto}.code-header{break-after:avoid}h1,h2,h3,h4{break-after:avoid}.export-meta{margin-bottom:24px}}
`

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function documentHtml(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${exportStyles}</style></head><body><main>${body}</main></body></html>`
}

function fileName(path: string, extension: string) {
  return (path.split('/').pop() || '笔记').replace(/\.md$/i, '').replace(/[<>:"/\\|?*]/g, '_') + extension
}

function htmlPath(path: string) { return path.replace(/\.md$/i, '') + '.html' }

function relativePath(from: string, target: string) {
  const left = from.split('/').slice(0, -1)
  const right = target.split('/')
  while (left.length && right.length && left[0] === right[0]) { left.shift(); right.shift() }
  return [...left.map(() => '..'), ...right].map(part => part === '..' ? part : encodeURIComponent(part)).join('/')
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

async function renderNote(note: ExportSnapshot['notes'][number], lineNumbers: boolean, selected: Set<string>, merged = false) {
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-20000px;top:0;width:800px;pointer-events:none;'
  document.body.append(container)
  const root = createRoot(container)
  try {
    root.render(<MarkdownView content={note.content} notePath={note.path} assets={note.assets} lineNumbers={lineNumbers} exporting />)
    // Wait for React's commit and Shiki's asynchronous language loading.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 40))
      if (container.querySelector('.markdown-body') && !container.querySelector('[data-rendering="true"]')) break
    }
    for (const link of container.querySelectorAll<HTMLAnchorElement>('a[data-note-link]')) {
      const target = link.getAttribute('data-note-link') || ''
      const hash = (link.getAttribute('href') || '').match(/#.*$/)?.[0] || ''
      if (selected.has(target)) link.setAttribute('href', merged ? `#note-${encodeURIComponent(target)}` : relativePath(htmlPath(note.path), htmlPath(target)) + hash)
      link.removeAttribute('data-note-link')
    }
    return `<article class="export-note" id="note-${escapeHtml(encodeURIComponent(note.path))}"><div class="export-path">${escapeHtml(note.path)}</div><h1>${escapeHtml(note.title)}</h1><div class="export-meta"><span>${escapeHtml(note.metadata.group || '未分组')}</span>${note.metadata.tags.map(tag => `<span class="export-tag">#${escapeHtml(tag)}</span>`).join('')}</div>${container.innerHTML}</article>`
  } finally { root.unmount(); container.remove() }
}

async function requestExport(paths: string[], format: string, allowMissing = false) {
  return fetch('/api/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [...new Set(paths)].sort(), format, allowMissing }) })
}

function warningFrom(data: Record<string, unknown>): Warning {
  return { missing: Array.isArray(data.missing) ? data.missing.map(String) : [], external: Array.isArray(data.external) ? data.external.map(String) : [] }
}

async function checkResponse(response: Response) {
  if (response.ok) return
  const error = await response.json().catch(() => ({})) as { error?: string }
  throw new Error(error.error || `导出失败 (${response.status})`)
}

export async function exportNotes({ paths, format, lineNumbers, beforeExport, onWarning }: ExportOptions): Promise<void> {
  if (!paths.length) throw new Error('请先选择要导出的笔记')
  // Reserve a same-origin print window in the original user gesture, before saving/fetching.
  const printWindow = format === 'pdf' ? window.open('', '_blank') : null
  if (format === 'pdf' && !printWindow) throw new Error('浏览器阻止了打印窗口，请允许本站弹出窗口后重试')
  if (printWindow) {
    printWindow.document.open()
    printWindow.document.write(documentHtml('准备 PDF 导出', '<p>正在保存笔记并准备打印内容…</p>'))
    printWindow.document.close()
  }
  try {
    await beforeExport()
    const wireFormat = format === 'html' || format === 'pdf' ? 'snapshot' : format
    let response = await requestExport(paths, wireFormat)
    let warned = false
    if (response.status === 422) {
      const data = await response.json() as Record<string, unknown>
      const warning = warningFrom(data)
      if (!warning.missing.length && !warning.external.length) throw new Error(String(data.error || '导出内容无法读取'))
      if (!await onWarning(warning)) { printWindow?.close(); return }
      warned = true
      response = await requestExport(paths, wireFormat, true)
    }
    await checkResponse(response)
    if (format === 'md' || format === 'bundle') {
      const disposition = response.headers.get('Content-Disposition') || ''
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
      const ordinary = /filename="([^"]+)"/i.exec(disposition)?.[1]
      const name = encoded ? decodeURIComponent(encoded) : ordinary || (format === 'md' ? fileName(paths[0], '.md') : 'Echo-Markdown.zip')
      download(await response.blob(), name)
      return
    }
    const snapshot = await response.json() as ExportSnapshot
    if (!warned && (snapshot.missing.length || snapshot.external.length) && !await onWarning(snapshot)) { printWindow?.close(); return }
    if (!snapshot.notes.length) throw new Error('没有可导出的笔记')
    const selected = new Set(snapshot.notes.map(note => note.path))
    if (format === 'html') {
      const pages = await Promise.all(snapshot.notes.map(async note => ({ note, body: await renderNote(note, lineNumbers, selected) })))
      if (pages.length === 1) download(new Blob([documentHtml(pages[0].note.title, pages[0].body)], { type: 'text/html;charset=utf-8' }), fileName(pages[0].note.path, '.html'))
      else {
        const files: Record<string, Uint8Array> = {}
        for (const { note, body } of pages) files[htmlPath(note.path)] = strToU8(documentHtml(note.title, body))
        let indexPath = 'index.html'
        if (indexPath in files) indexPath = '_echo-index.html'
        const index = `<h1>Echo 笔记导出</h1><p>${pages.length} 篇笔记</p><ul>${pages.map(({ note }) => `<li><a href="${escapeHtml(htmlPath(note.path).split('/').map(encodeURIComponent).join('/'))}">${escapeHtml(note.title)}</a> <small>${escapeHtml(note.path)}</small></li>`).join('')}</ul>`
        files[indexPath] = strToU8(documentHtml('Echo 笔记导出', index))
        const zip = zipSync(files, { level: 6 })
        download(new Blob([new Uint8Array(zip).buffer as ArrayBuffer], { type: 'application/zip' }), 'Echo-HTML.zip')
      }
      return
    }
    if (!printWindow || printWindow.closed) throw new Error('打印窗口已关闭，请重新导出')
    const articles = await Promise.all(snapshot.notes.map(note => renderNote(note, lineNumbers, selected, true)))
    const toc = snapshot.notes.length > 1 ? `<nav class="export-toc"><h2>目录</h2><ol>${snapshot.notes.map(note => `<li><a href="#note-${escapeHtml(encodeURIComponent(note.path))}">${escapeHtml(note.title)}</a></li>`).join('')}</ol></nav>` : ''
    printWindow.document.open()
    printWindow.document.write(documentHtml(snapshot.notes.length === 1 ? snapshot.notes[0].title : 'Echo 笔记合集', toc + articles.join('')))
    printWindow.document.close()
    const actions = printWindow.document.createElement('div')
    actions.className = 'print-actions'
    const printButton = printWindow.document.createElement('button')
    printButton.textContent = '打印 / 另存为 PDF'
    printButton.onclick = () => { printWindow.focus(); printWindow.print() }
    const status = printWindow.document.createElement('span')
    status.className = 'print-status'
    status.textContent = '正在加载图片与字体…'
    actions.append(printButton, status)
    printWindow.document.body.prepend(actions)
    await Promise.race([
      Promise.all([printWindow.document.fonts.ready, ...Array.from(printWindow.document.images).map(image => image.complete ? Promise.resolve() : new Promise<void>(resolve => { image.onload = () => resolve(); image.onerror = () => resolve() }))]),
      new Promise(resolve => window.setTimeout(resolve, 10_000)),
    ])
    if (!printWindow.closed) {
      status.textContent = '在打印对话框中选择“另存为 PDF”'
      await new Promise(resolve => window.setTimeout(resolve, 100))
      printWindow.focus()
      printWindow.print()
    }
  } catch (error) { printWindow?.close(); throw error }
}
