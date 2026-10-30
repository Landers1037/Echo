import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CalendarView } from './CalendarView'
import type { NoteSummary } from '../types'

afterEach(cleanup)

function summary(partial: Pick<NoteSummary, 'path' | 'title' | 'created' | 'words'>): NoteSummary {
  return { metadata: { tags: [], group: '' }, revision: 'v1', modified: partial.created || '', ...partial }
}

describe('calendar view', () => {
  it('groups notes by the local creation date and opens that day', () => {
    const today = new Date()
    const year = today.getFullYear()
    const month = today.getMonth()
    const date = today.getDate()
    const morning = new Date(year, month, date, 8, 5)
    const evening = new Date(year, month, date, 18, 40)
    const onOpen = vi.fn()
    render(<CalendarView notes={[
      summary({ path: '项目/资料/纪要.md', title: '会议纪要', created: evening.toISOString(), words: 860 }),
      summary({ path: '晨记.md', title: '晨记', created: morning.toISOString(), words: 128 }),
    ]} onOpen={onOpen} />)

    const day = screen.getByRole('button', { name: `${year}年${month + 1}月${date}日，新建 2 篇` })
    expect(day).toHaveTextContent('晨记')
    expect(day).toHaveTextContent('会议纪要')
    fireEvent.click(day)

    expect(screen.getByRole('heading', { name: `${year}年${month + 1}月${date}日` })).toBeInTheDocument()
    const first = screen.getByRole('button', { name: /晨记/ })
    expect(first).toHaveTextContent('08:05')
    expect(first).toHaveTextContent('128')
    expect(first).toHaveTextContent('根目录')
    const second = screen.getByRole('button', { name: /会议纪要/ })
    expect(second).toHaveTextContent('18:40')
    expect(second).toHaveTextContent('860')
    expect(second).toHaveTextContent('项目/资料')
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(second)
    expect(onOpen).toHaveBeenCalledWith('项目/资料/纪要.md')
  })

  it('explains a day with no new notes and returns to the month', () => {
    const today = new Date()
    const other = today.getDate() === 1 ? 2 : 1
    render(<CalendarView notes={[]} onOpen={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: `${today.getFullYear()}年${today.getMonth() + 1}月${other}日` }))
    expect(screen.getByText('这一天没有新建笔记')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回日历' }))
    expect(screen.getByRole('heading', { name: '日历视图' })).toBeInTheDocument()
  })

  it('jumps to a chosen year and month', () => {
    const year = new Date().getFullYear() - 2
    render(<CalendarView notes={[]} onOpen={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /选择年份和月份/ }))
    fireEvent.click(screen.getByRole('button', { name: `${year}年`, exact: true }))
    fireEvent.click(screen.getByRole('button', { name: `${year}年3月`, exact: true }))
    expect(screen.getByTestId('note-calendar-month')).toHaveTextContent(`${year}年3月`)
    expect(screen.getByRole('button', { name: `${year}年3月1日` })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '选择年份和月份' })).not.toBeInTheDocument()
  })
})
