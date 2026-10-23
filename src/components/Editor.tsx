import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorView, keymap } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import { Bold, Italic, Heading, Strikethrough, Quote, List, ListOrdered, ListTodo, Link, ImagePlus, Code2, Table2, Undo2, Redo2, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { undo, redo } from '@codemirror/commands'

export type EditorProps = {
  value: string
  onChange: (value: string) => void
  lineNumbers: boolean
  dark: boolean
  onUpload: (file: File) => Promise<string>
  onSave: () => void
  onTaskInsert?: () => void
}

type Upload = { id: number; file: File; status: 'uploading' | 'error'; error?: string }
type Anchor = { from: number; to: number }

export function Editor(props: EditorProps) {
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const anchors = useRef(new Map<number, Anchor>())
  const uploadCounter = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const navigate = (event: Event) => {
      const editor = view.current
      if (!editor || event.target !== editor.dom) return
      const number = Number((event as CustomEvent).detail)
      if (!Number.isFinite(number)) return
      const line = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, Math.trunc(number))))
      editor.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      editor.focus()
    }
    document.addEventListener('echo:goto-line', navigate)
    return () => {
      mounted.current = false
      anchors.current.clear()
      document.removeEventListener('echo:goto-line', navigate)
    }
  }, [])

  function replaceSelection(before: string, after = '', placeholder = '文字') {
    const editor = view.current
    if (!editor) return
    const { from, to } = editor.state.selection.main
    const selected = editor.state.sliceDoc(from, to) || placeholder
    const insert = before + selected + after
    editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + before.length, head: from + before.length + selected.length }, scrollIntoView: true })
    editor.focus()
  }

  function prefixLines(prefix: string) {
    const editor = view.current
    if (!editor) return
    const { from, to } = editor.state.selection.main
    const first = editor.state.doc.lineAt(from)
    const last = editor.state.doc.lineAt(to)
    const selected = editor.state.sliceDoc(first.from, last.to)
    const insert = selected.split('\n').map((line, index) => prefix === '1. ' ? `${index + 1}. ${line}` : prefix + line).join('\n')
    editor.dispatch({ changes: { from: first.from, to: last.to, insert }, selection: { anchor: first.from, head: first.from + insert.length }, scrollIntoView: true })
    editor.focus()
  }

  function insertText(text: string) {
    const editor = view.current
    if (!editor) return
    const { from, to } = editor.state.selection.main
    editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true })
    editor.focus()
  }

  async function performUpload(upload: Upload) {
    setUploads(items => items.some(item => item.id === upload.id)
      ? items.map(item => item.id === upload.id ? { ...item, status: 'uploading', error: undefined } : item)
      : [...items, upload])
    try {
      const path = await latest.current.onUpload(upload.file)
      const editor = view.current
      const anchor = anchors.current.get(upload.id)
      anchors.current.delete(upload.id)
      if (mounted.current && editor && anchor) {
        const alt = upload.file.name.replace(/\.[^.]+$/, '').replace(/[\[\]\r\n]/g, '') || '图片'
        const insert = `![${alt}](${path.replace(/ /g, '%20').replace(/\)/g, '%29')})`
        editor.dispatch({ changes: { from: anchor.from, to: anchor.to, insert } })
      }
      if (mounted.current) setUploads(items => items.filter(item => item.id !== upload.id))
    } catch (error) {
      if (mounted.current) setUploads(items => items.map(item => item.id === upload.id ? { ...item, status: 'error', error: error instanceof Error ? error.message : '上传失败' } : item))
    }
  }

  function uploadFile(file: File, position?: number) {
    const editor = view.current
    if (!editor) return
    const id = ++uploadCounter.current
    anchors.current.set(id, position === undefined ? { from: editor.state.selection.main.from, to: editor.state.selection.main.to } : { from: position, to: position })
    void performUpload({ id, file, status: 'uploading' })
  }

  const extensions = useMemo<Extension[]>(() => [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    autocompletion(),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.docChanged) return
      for (const [id, anchor] of anchors.current) anchors.current.set(id, {
        from: update.changes.mapPos(anchor.from, 1),
        to: update.changes.mapPos(anchor.to, 1),
      })
    }),
    keymap.of([
      { key: 'Mod-s', run: () => { latest.current.onSave(); return true } },
      { key: 'Mod-b', run: () => { replaceSelection('**', '**'); return true } },
      { key: 'Mod-i', run: () => { replaceSelection('*', '*'); return true } },
      ...searchKeymap,
    ]),
    EditorView.domEventHandlers({
      paste(event) {
        const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => file !== null)
        if (!files.length) return false
        event.preventDefault()
        files.forEach(file => uploadFile(file))
        return true
      },
      drop(event, editor) {
        const files = Array.from(event.dataTransfer?.files || []).filter(file => file.type.startsWith('image/'))
        if (!files.length) return false
        event.preventDefault()
        const position = editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.state.selection.main.head
        files.forEach(file => uploadFile(file, position))
        return true
      },
    }),
    EditorView.theme({
      '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
      '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '14px', lineHeight: '1.9', overflow: 'auto' },
      '.cm-content': { padding: '32px 36px', minHeight: '100%', caretColor: 'var(--accent)' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', borderRight: 'none' },
      '.cm-lineNumbers .cm-gutterElement': { paddingLeft: '12px', paddingRight: '8px' },
      '.cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
    }),
  ], [])

  const tools = [
    { icon: Heading, title: '标题', action: () => prefixLines('## ') },
    { icon: Bold, title: '粗体 (Ctrl+B)', action: () => replaceSelection('**', '**') },
    { icon: Italic, title: '斜体 (Ctrl+I)', action: () => replaceSelection('*', '*') },
    { icon: Strikethrough, title: '删除线', action: () => replaceSelection('~~', '~~') },
    { icon: Quote, title: '引用', action: () => prefixLines('> ') },
    { icon: List, title: '无序列表', action: () => prefixLines('- ') },
    { icon: ListOrdered, title: '有序列表', action: () => prefixLines('1. ') },
    { icon: ListTodo, title: '待办任务', action: () => { prefixLines('- [ ] '); latest.current.onTaskInsert?.() } },
    { icon: Link, title: '链接', action: () => replaceSelection('[', '](https://)', '链接文字') },
    { icon: ImagePlus, title: '上传图片（也可直接粘贴）', action: () => fileInput.current?.click() },
    { icon: Code2, title: '代码块', action: () => replaceSelection('\n```javascript\n', '\n```\n', '// 在这里编写代码') },
    { icon: Table2, title: '插入表格', action: () => insertText('\n| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n') },
  ]

  return <div className="editor-shell">
    <div className="editor-toolbar" role="toolbar" aria-label="Markdown 快捷操作">
      {tools.map(({ icon: Icon, title, action }) => <button key={title} type="button" className="icon-button" title={title} aria-label={title} onMouseDown={event => event.preventDefault()} onClick={action}><Icon size={16} strokeWidth={1.7} /></button>)}
      <span className="toolbar-separator" />
      <button type="button" className="icon-button" title="撤销" aria-label="撤销" onClick={() => { if (view.current) undo(view.current) }}><Undo2 size={16} /></button>
      <button type="button" className="icon-button" title="重做" aria-label="重做" onClick={() => { if (view.current) redo(view.current) }}><Redo2 size={16} /></button>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={event => { Array.from(event.target.files || []).forEach(file => uploadFile(file)); event.target.value = '' }} />
    </div>
    {uploads.length > 0 && <div className="upload-status" role="status">{uploads.map(upload => <div className={upload.status === 'error' ? 'upload-item error' : 'upload-item'} key={upload.id}>
      {upload.status === 'uploading' ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}
      <span>{upload.file.name} · {upload.status === 'uploading' ? '正在上传…' : upload.error}</span>
      {upload.status === 'error' && <><button type="button" onClick={() => void performUpload(upload)}><RefreshCw size={13} /> 重试</button><button type="button" aria-label="取消上传" onClick={() => { anchors.current.delete(upload.id); setUploads(items => items.filter(item => item.id !== upload.id)) }}><X size={13} /></button></>}
    </div>)}</div>}
    <CodeMirror value={props.value} theme={props.dark ? 'dark' : 'light'} extensions={extensions} basicSetup={{ lineNumbers: props.lineNumbers, foldGutter: true, highlightActiveLineGutter: false, highlightActiveLine: true, autocompletion: true, closeBrackets: true, searchKeymap: true }} onCreateEditor={editor => { view.current = editor }} onChange={props.onChange} className="codemirror-editor" aria-label="Markdown 源码编辑器" />
  </div>
}
