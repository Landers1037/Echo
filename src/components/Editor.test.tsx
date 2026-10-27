import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './Editor'

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
