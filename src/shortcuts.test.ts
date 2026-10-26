import { describe, expect, it } from 'vitest'
import { canonicalShortcut, findConflict, formatShortcut, keyFromEvent, resolveShortcuts, shortcutActions, shortcutBindings, withShortcut } from './shortcuts'

describe('editor shortcut model', () => {
  it('formats shortcuts and reads modified keys from a keyboard event', () => {
    expect(formatShortcut('Mod-Shift-k', false)).toBe('Ctrl + Shift + K')
    expect(formatShortcut('Mod-1', false)).toBe('Ctrl + 1')
    expect(formatShortcut('Mod-b', true)).toBe('Cmd + B')
    expect(formatShortcut('', false)).toBe('未设置')
    expect(keyFromEvent(key({ key: 'b', code: 'KeyB', ctrlKey: true }), false)).toBe('Mod-b')
    expect(keyFromEvent(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), false)).toBe('Mod-Shift-k')
    expect(keyFromEvent(key({ key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }), false)).toBe('Mod-Shift-7')
    expect(keyFromEvent(key({ key: 'b', code: 'KeyB', metaKey: true }), true)).toBe('Mod-b')
    expect(keyFromEvent(key({ key: 'b', code: 'KeyB' }), false)).toBeNull()
    expect(keyFromEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), false)).toBeNull()
  })

  it('merges overrides, detects conflicts and keeps equivalent keys from binding twice', () => {
    expect(resolveShortcuts(null).bold).toBe('Mod-b')
    expect(resolveShortcuts({ italic: '' }).italic).toBe('')
    expect(canonicalShortcut('Ctrl-Shift-z', false)).toBe('Mod-Shift-z')
    expect(findConflict('bold', 'Mod-s', {}, false)).toMatchObject({ type: 'reserved', label: '保存' })
    expect(findConflict('bold', 'Ctrl-i', {}, false)).toMatchObject({ type: 'action', id: 'italic', name: '斜体' })
    expect(findConflict('bold', 'Mod-i', { italic: 'Mod-Shift-i' }, false)).toBeNull()
    expect(findConflict('bold', 'Mod-b', {}, false)).toBeNull()
    const overridden = withShortcut({}, 'bold', 'Mod-Shift-b')
    expect(overridden).toEqual({ bold: 'Mod-Shift-b' })
    expect(withShortcut(overridden, 'bold', shortcutActions.find(action => action.id === 'bold')!.defaultKey)).toEqual({})
    expect(withShortcut({ italic: 'Mod-e' }, 'italic', '')).toEqual({ italic: '' })
    const bindings = shortcutBindings({ bold: 'Mod-i', italic: 'Mod-i' }, false)
    expect(bindings.filter(binding => binding.key === 'Mod-i')).toHaveLength(1)
    expect(bindings.some(binding => binding.id === 'italic')).toBe(false)
  })
})

function key(init: KeyboardEventInit) {
  return new KeyboardEvent('keydown', init)
}