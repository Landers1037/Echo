import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { Annotation, Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { NoteAiSession } from '../agent/editorSession'
import { autocompletion } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import { Bold, Italic, Heading, Strikethrough, Underline, Quote, List, ListOrdered, ListTodo, Link, FileSymlink, ImagePlus, Shapes, Code, Code2, Table2, Undo2, Redo2, LoaderCircle, RefreshCw, X, Workflow } from 'lucide-react'
import { undo, redo } from '@codemirror/commands'
import { bindingFor, formatShortcut, shortcutBindings } from '../shortcuts'

const aiAnnotation = Annotation.define<true>()
const setAiHighlight = StateEffect.define<DecorationSet>()
const aiEditMark = Decoration.mark({ class: 'cm-ai-edit' })
const aiHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(setAiHighlight)) value = effect.value
    return value
  },
  provide: field => EditorView.decorations.from(field),
})

export type EditorController = {
  getDoc: () => string
  beginAiSession: () => void
  applyAiStream: (toolId: string, name: string, partialArgs: string) => void
  finishAiSession: () => { failures: string[] }
  resolveAiSession: (action: 'accept' | 'reject') => void
}

export type EditorProps = {
  value: string
  onChange: (value: string) => void
  fontSize: number
  lineNumbers: boolean
  dark: boolean
  onUpload: (file: File) => Promise<string>
  onDrawingInsert?: () => Promise<string>
  onNoteReference?: () => Promise<string | null>
  onDrawioReference?: () => Promise<string | null>
  onSave: () => void
  onTaskInsert?: () => void
  shortcuts: Record<string, string>
  onReady?: (controller: EditorController) => void
}

type Upload = { id: number; file: File; status: 'uploading' | 'error'; error?: string }
type Anchor = { from: number; to: number }

function shortcutExtension(shortcuts: Record<string, string> | undefined, commands: { current: Record<string, () => void> }): Extension {
  return keymap.of(shortcutBindings(shortcuts).map(binding => ({
    key: binding.key,
    run: () => { commands.current[binding.id]?.(); return true },
  })))
}

export function Editor(props: EditorProps) {
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const shortcutCompartment = useRef(new Compartment()).current
  const readOnlyCompartment = useRef(new Compartment()).current
  const aiActive = useRef(false)
  const [aiLocked, setAiLocked] = useState(false)
  const session = useRef<NoteAiSession | null>(null)
  if (!session.current) {
    session.current = new NoteAiSession({
      getDoc: () => view.current?.state.doc.toString() ?? '',
      replace(from, to, insert) {
        view.current?.dispatch({ changes: { from, to, insert }, annotations: aiAnnotation.of(true) })
      },
      setHighlights(ranges) {
        const editor = view.current
        if (!editor) return
        const marks = ranges.filter(range => range.from >= 0 && range.to > range.from && range.to <= editor.state.doc.length).map(range => aiEditMark.range(range.from, range.to))
        editor.dispatch({ annotations: aiAnnotation.of(true), effects: setAiHighlight.of(marks.length ? Decoration.set(marks, true) : Decoration.none) })
      },
      setLocked(locked) {
        aiActive.current = locked
        setAiLocked(locked)
        view.current?.dispatch({ annotations: aiAnnotation.of(true), effects: readOnlyCompartment.reconfigure(locked ? EditorState.readOnly.of(true) : []) })
      },
    })
  }
  const controller = useRef<EditorController | null>(null)
  if (!controller.current) {
    controller.current = {
      getDoc: () => view.current?.state.doc.toString() ?? '',
      beginAiSession: () => { session.current?.begin(); requestAnimationFrame(() => view.current?.requestMeasure()) },
      applyAiStream: (toolId, name, partialArgs) => session.current?.apply(toolId, name, partialArgs),
      finishAiSession: () => session.current?.finish() ?? { failures: [] },
      resolveAiSession: action => session.current?.resolve(action),
    }
  }
  const commands = useRef<Record<string, () => void>>({})
  const anchors = useRef(new Map<number, Anchor>())
  const uploadCounter = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const mounted = useRef(true)
  useEffect(() => { view.current?.requestMeasure() }, [props.fontSize])
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
    if (!editor || aiActive.current) return
    const { from, to } = editor.state.selection.main
    const hadSelection = from !== to
    const selected = editor.state.sliceDoc(from, to) || placeholder
    const insert = before + selected + after
    const placeholderFrom = from + before.length
    editor.dispatch({
      changes: { from, to, insert },
      selection: hadSelection ? { anchor: from + insert.length } : { anchor: placeholderFrom, head: placeholderFrom + selected.length },
      scrollIntoView: true,
    })
    editor.focus()
  }

  function prefixLines(prefix: string) {
    const editor = view.current
    if (!editor || aiActive.current) return
    const { from, to } = editor.state.selection.main
    const first = editor.state.doc.lineAt(from)
    const last = editor.state.doc.lineAt(to)
    const selected = editor.state.sliceDoc(first.from, last.to)
    const insert = selected.split('\n').map((line, index) => prefix === '1. ' ? `${index + 1}. ${line}` : prefix + line).join('\n')
    editor.dispatch({ changes: { from: first.from, to: last.to, insert }, selection: { anchor: first.from + insert.length }, scrollIntoView: true })
    editor.focus()
  }

  function setHeading(level: number) {
    const editor = view.current
    if (!editor || aiActive.current) return
    const { from, to } = editor.state.selection.main
    const first = editor.state.doc.lineAt(from)
    const last = editor.state.doc.lineAt(to)
    const lines: string[] = []
    for (let number = first.number; number <= last.number; number++) lines.push(editor.state.doc.line(number).text)
    const marker = `${'#'.repeat(level)} `
    const toggleOff = lines.every(line => line.startsWith(marker))
    const insert = lines.map(line => toggleOff ? line.replace(/^#{1,6} /, '') : marker + line.replace(/^#{1,6} /, '')).join('\n')
    editor.dispatch({ changes: { from: first.from, to: last.to, insert }, selection: { anchor: first.from + insert.length }, scrollIntoView: true })
    editor.focus()
  }

  function imageMarkdown(target: string) {
    const href = target.replace(/^<|>$/g, '')
    return /[\s()]/.test(href) ? `![绘图](<${href}>)` : `![绘图](${href})`
  }

  async function insertDrawing() {
    const markdownPath = await latest.current.onDrawingInsert?.()
    if (markdownPath) insertText(`\n${imageMarkdown(markdownPath)}\n`)
  }

  async function insertNoteReference() {
    const markdown = await latest.current.onNoteReference?.()
    if (markdown) insertText(`\n${markdown}\n`)
  }

  async function insertDrawioReference() {
    const markdown = await latest.current.onDrawioReference?.()
    if (markdown) insertText(`\n${markdown}\n`)
  }

  function insertText(text: string) {
    const editor = view.current
    if (!editor || aiActive.current) return
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
    if (!editor || aiActive.current) return
    const id = ++uploadCounter.current
    anchors.current.set(id, position === undefined ? { from: editor.state.selection.main.from, to: editor.state.selection.main.to } : { from: position, to: position })
    void performUpload({ id, file, status: 'uploading' })
  }

  commands.current = {
    heading1: () => setHeading(1),
    heading2: () => setHeading(2),
    heading3: () => setHeading(3),
    heading4: () => setHeading(4),
    heading5: () => setHeading(5),
    heading6: () => setHeading(6),
    bold: () => replaceSelection('**', '**'),
    italic: () => replaceSelection('*', '*'),
    strikethrough: () => replaceSelection('~~', '~~'),
    underline: () => replaceSelection('<u>', '</u>'),
    inlineCode: () => replaceSelection('`', '`', '代码'),
    codeBlock: () => replaceSelection('\n```javascript\n', '\n```\n', '// 在这里编写代码'),
    quote: () => prefixLines('> '),
    orderedList: () => prefixLines('1. '),
    unorderedList: () => prefixLines('- '),
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
    shortcutCompartment.of(shortcutExtension(props.shortcuts, commands)),
    readOnlyCompartment.of([]),
    aiHighlightField,
    EditorState.transactionFilter.of(transaction => {
      if (!aiActive.current || !transaction.docChanged || transaction.annotation(aiAnnotation)) return transaction
      return []
    }),
    keymap.of([
      { key: 'Mod-s', run: () => { latest.current.onSave(); return true } },
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
      '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: 'var(--editor-font-size, 14px)', lineHeight: '1.9', overflow: 'auto' },
      '.cm-content': { padding: '32px 36px', minHeight: '100%', caretColor: 'var(--accent)' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', borderRight: 'none' },
      '.cm-lineNumbers .cm-gutterElement': { paddingLeft: '12px', paddingRight: '8px' },
      '.cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
      '.cm-ai-edit': { backgroundColor: 'color-mix(in srgb, var(--accent) 32%, transparent)', borderRadius: '2px' },
    }),
  ], [commands, props.shortcuts, readOnlyCompartment, shortcutCompartment])
  useEffect(() => {
    view.current?.dispatch({ effects: shortcutCompartment.reconfigure(shortcutExtension(props.shortcuts, commands)) })
  }, [commands, props.shortcuts, shortcutCompartment])

  function toolTitle(label: string, actionId?: string) {
    const key = actionId ? bindingFor(props.shortcuts, actionId) : ''
    return key ? `${label} (${formatShortcut(key)})` : label
  }
  const tools = [
    { id: 'heading', icon: Heading, title: '标题', action: () => prefixLines('## ') },
    { id: 'bold', icon: Bold, title: toolTitle('加粗', 'bold'), action: () => commands.current.bold?.() },
    { id: 'italic', icon: Italic, title: toolTitle('斜体', 'italic'), action: () => commands.current.italic?.() },
    { id: 'strikethrough', icon: Strikethrough, title: toolTitle('删除线', 'strikethrough'), action: () => commands.current.strikethrough?.() },
    { id: 'underline', icon: Underline, title: toolTitle('下划线', 'underline'), action: () => commands.current.underline?.() },
    { id: 'quote', icon: Quote, title: toolTitle('引用', 'quote'), action: () => commands.current.quote?.() },
    { id: 'unordered', icon: List, title: toolTitle('无序列表', 'unorderedList'), action: () => commands.current.unorderedList?.() },
    { id: 'ordered', icon: ListOrdered, title: toolTitle('有序列表', 'orderedList'), action: () => commands.current.orderedList?.() },
    { id: 'task', icon: ListTodo, title: '待办任务', action: () => { prefixLines('- [ ] '); latest.current.onTaskInsert?.() } },
    { id: 'link', icon: Link, title: '链接', action: () => replaceSelection('[', '](https://)', '链接文字') },
    { id: 'noteRef', icon: FileSymlink, title: '引用笔记', action: () => { void insertNoteReference() } },
    { id: 'drawioRef', icon: Workflow, title: '引用 Draw.io', action: () => { void insertDrawioReference() } },
    { id: 'image', icon: ImagePlus, title: '上传图片（也可直接粘贴）', action: () => fileInput.current?.click() },
    { id: 'drawing', icon: Shapes, title: '插入绘图', action: () => { void insertDrawing() } },
    { id: 'inlineCode', icon: Code, title: toolTitle('行内代码', 'inlineCode'), action: () => commands.current.inlineCode?.() },
    { id: 'codeBlock', icon: Code2, title: toolTitle('代码块', 'codeBlock'), action: () => commands.current.codeBlock?.() },
    { id: 'table', icon: Table2, title: '插入表格', action: () => insertText('\n| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n') },
  ]

  return <div className="editor-shell" style={{ '--editor-font-size': `${props.fontSize}px` } as CSSProperties}>
    <div className="editor-toolbar" role="toolbar" aria-label="Markdown 快捷操作">
      {tools.map(({ id, icon: Icon, title, action }) => <button key={id} type="button" className="icon-button" title={title} aria-label={title} disabled={aiLocked} onMouseDown={event => event.preventDefault()} onClick={action}><Icon size={16} strokeWidth={1.7} /></button>)}
      <span className="toolbar-separator" />
      <button type="button" className="icon-button" title="撤销" aria-label="撤销" disabled={aiLocked} onClick={() => { if (view.current) undo(view.current) }}><Undo2 size={16} /></button>
      <button type="button" className="icon-button" title="重做" aria-label="重做" disabled={aiLocked} onClick={() => { if (view.current) redo(view.current) }}><Redo2 size={16} /></button>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={event => { Array.from(event.target.files || []).forEach(file => uploadFile(file)); event.target.value = '' }} />
    </div>
    {uploads.length > 0 && <div className="upload-status" role="status">{uploads.map(upload => <div className={upload.status === 'error' ? 'upload-item error' : 'upload-item'} key={upload.id}>
      {upload.status === 'uploading' ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}
      <span>{upload.file.name} · {upload.status === 'uploading' ? '正在上传…' : upload.error}</span>
      {upload.status === 'error' && <><button type="button" onClick={() => void performUpload(upload)}><RefreshCw size={13} /> 重试</button><button type="button" aria-label="取消上传" onClick={() => { anchors.current.delete(upload.id); setUploads(items => items.filter(item => item.id !== upload.id)) }}><X size={13} /></button></>}
    </div>)}</div>}
    <CodeMirror value={props.value} theme={props.dark ? 'dark' : 'light'} extensions={extensions} basicSetup={{ lineNumbers: props.lineNumbers, foldGutter: true, highlightActiveLineGutter: false, highlightActiveLine: true, autocompletion: true, closeBrackets: true, searchKeymap: true }} onCreateEditor={editor => { view.current = editor; latest.current.onReady?.(controller.current!) }} onChange={props.onChange} className="codemirror-editor" aria-label="Markdown 源码编辑器" />
  </div>
}
