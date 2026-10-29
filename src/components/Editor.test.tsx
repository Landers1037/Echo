import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { insertNewline } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { Editor } from './Editor'
import type { EditorController } from './Editor'

const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, toJSON() { return {} } }
const emptyRects = { length: 0, item: () => null, [Symbol.iterator]: function* iterate() {} } as unknown as DOMRectList
Range.prototype.getClientRects = () => emptyRects
Range.prototype.getBoundingClientRect = () => emptyRect

afterEach(cleanup)

const props = {
  value: '正文',
  onChange: () => {},
  fontSize: 14,
  lineNumbers: false,
  dark: false,
  shortcuts: {},
  onUpload: async () => 'image.png',
  onSave: () => {},
}

describe('editor formatting shortcuts', () => {
  it('labels toolbar actions with the active shortcut', () => {
    const { rerender } = render(<Editor {...props} />)
    expect(screen.getByRole('button', { name: /加粗/ })).toHaveAccessibleName(/加粗 \((Ctrl|Cmd) \+ B\)/)
    expect(screen.getByRole('button', { name: /下划线/ })).toHaveAccessibleName(/下划线 \((Ctrl|Cmd) \+ U\)/)
    expect(screen.getByRole('button', { name: /行内代码/ })).toBeInTheDocument()
    rerender(<Editor {...props} shortcuts={{ bold: '', underline: 'Mod-Shift-u' }} />)
    expect(screen.getByRole('button', { name: '加粗' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /下划线/ })).toHaveAccessibleName(/下划线 \((Ctrl|Cmd) \+ Shift \+ U\)/)
  })

  it('keeps formatted text when Enter follows a shortcut', () => {
    render(<Editor {...props} value="你好" />)
    const editor = EditorView.findFromDOM(document.querySelector('.cm-editor')!)
    if (!editor) throw new Error('编辑器尚未挂载')
    editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } })
    fireEvent.click(screen.getByRole('button', { name: /加粗/ }))
    insertNewline(editor)
    expect(editor.state.doc.toString()).toBe('**你好**\n')

    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '你好' }, selection: { anchor: 0, head: 2 } })
    fireEvent.click(screen.getByRole('button', { name: '标题' }))
    insertNewline(editor)
    expect(editor.state.doc.toString()).toBe('## 你好\n')
  })

  it('streams an AI edit into the document and restores it when rejected', async () => {
    const ready = { current: null as EditorController | null }
    const onChange = vi.fn()
    render(<Editor {...props} value={'# 标题\n\n你好世界'} onChange={onChange} onReady={value => { ready.current = value }} />)
    await waitFor(() => expect(ready.current).toBeTruthy())
    ready.current?.beginAiSession()
    ready.current?.applyAiStream('edit-1', 'edit_note', '{"edits":[{"search":"你好世界","replace":"你好，Echo"}]}')
    await waitFor(() => expect(onChange.mock.calls.some(call => String(call[0]).includes('你好，Echo'))).toBe(true))
    ready.current?.resolveAiSession('reject')
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toBe('# 标题\n\n你好世界'))
  })

  it('inserts a note reference returned by the picker', async () => {
    const onChange = vi.fn()
    const onNoteReference = vi.fn(async () => '[介绍](../文档/介绍.md "echo-ref")')
    render(<Editor {...props} value="正文" onChange={onChange} onNoteReference={onNoteReference} />)
    fireEvent.click(screen.getByRole('button', { name: '引用笔记' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onNoteReference).toHaveBeenCalledOnce()
    expect(String(onChange.mock.calls.at(-1)?.[0])).toContain('[介绍](../文档/介绍.md "echo-ref")')
  })

  it('inserts a drawing reference from the toolbar', async () => {
    const onChange = vi.fn()
    const onDrawingInsert = vi.fn(async () => '../.assets/diagram.excalidraw')
    render(<Editor {...props} onChange={onChange} onDrawingInsert={onDrawingInsert} />)
    fireEvent.click(screen.getByRole('button', { name: '插入绘图' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onDrawingInsert).toHaveBeenCalledOnce()
    expect(String(onChange.mock.calls.at(-1)?.[0])).toContain('![绘图](../.assets/diagram.excalidraw)')
  })
})
