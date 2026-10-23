import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

const options = [
  { value: 'current', label: '当前笔记' },
  { value: 'selected', label: '所选笔记（0 篇）', disabled: true },
  { value: 'filtered', label: '搜索结果（2 篇）' },
]

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Select', () => {
  it('labels the selector and exposes selected and disabled options', () => {
    const change = vi.fn()
    render(<><label htmlFor="scope">导出范围</label><Select id="scope" value="current" options={options} onChange={change} /></>)
    const trigger = screen.getByRole('combobox', { name: '导出范围' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox', { name: '导出范围' })).toBeVisible()
    expect(screen.getByRole('option', { name: '当前笔记' })).toHaveAttribute('aria-selected', 'true')
    const disabled = screen.getByRole('option', { name: '所选笔记（0 篇）' })
    expect(disabled).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(disabled)
    expect(change).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('option', { name: '搜索结果（2 篇）' }))
    expect(change).toHaveBeenCalledExactlyOnceWith('filtered')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('navigates enabled options and commits only with Enter or Space', () => {
    const change = vi.fn()
    render(<Select aria-label="范围" value="current" options={options} onChange={change} />)
    const trigger = screen.getByRole('combobox', { name: '范围' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: '搜索结果（2 篇）' }).id)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: '当前笔记' }).id)
    fireEvent.keyDown(trigger, { key: 'End' })
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(change).not.toHaveBeenCalled()
    fireEvent.keyDown(trigger, { key: 'End' })
    fireEvent.keyDown(trigger, { key: ' ' })
    expect(change).toHaveBeenCalledExactlyOnceWith('filtered')
  })

  it('closes with Escape without dismissing the parent dialog, and leaves Tab unblocked', () => {
    const parentKey = vi.fn()
    render(<div onKeyDown={parentKey}><Select aria-label="范围" value="current" options={options} onChange={vi.fn()} /></div>)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(parentKey).not.toHaveBeenCalled()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(parentKey).toHaveBeenCalledOnce()
    fireEvent.click(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('supports typeahead and repeated letters while skipping disabled matches', () => {
    const change = vi.fn()
    render(<Select aria-label="字母" value="alpha" options={[
      { value: 'alpha', label: 'Alpha' }, { value: 'disabled', label: 'Beta', disabled: true },
      { value: 'bravo', label: 'Bravo' }, { value: 'bronze', label: 'Bronze' },
    ]} onChange={change} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'b' })
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Bravo' }).id)
    fireEvent.keyDown(trigger, { key: 'b' })
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Bronze' }).id)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(change).toHaveBeenCalledExactlyOnceWith('bronze')
  })

  it('closes on outside clicks, blur or container scrolling without changing the value', () => {
    const change = vi.fn()
    render(<><Select aria-label="范围" value="current" options={options} onChange={change} /><button>其他操作</button></>)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    fireEvent.scroll(screen.getByRole('listbox'))
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerDown(screen.getByRole('button', { name: '其他操作' }))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    fireEvent.blur(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    fireEvent.scroll(document)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(change).not.toHaveBeenCalled()
  })

  it('positions the menu above the control near the bottom and keeps it inside the viewport', () => {
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 990, top: 700, right: 1130, bottom: 740, width: 140, height: 40, x: 990, y: 700, toJSON() {} })
    render(<Select aria-label="范围" value="current" options={options} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox'))
    const menu = screen.getByRole('listbox')
    expect(menu).toHaveStyle({ transform: 'translateY(-100%)' })
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(700)
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0)
    expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(1024)
  })

  it('cannot open when disabled and closes if disabled while open', () => {
    const { rerender } = render(<Select aria-label="范围" value="current" options={options} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox'))
    rerender(<Select aria-label="范围" disabled value="current" options={options} onChange={vi.fn()} />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
