import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from './Editor'

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
})
