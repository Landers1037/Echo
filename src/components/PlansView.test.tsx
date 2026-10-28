import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlansView } from './PlansView'
import type { Plan } from '../types'

function pickDay(label: string) {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(label)
  if (!match) throw new Error(label)
  const target = new Date(Number(match[1]), Number(match[2]) - 1, 1).getTime()
  for (let step = 0; step < 48; step++) {
    const day = screen.queryByRole('button', { name: label })
    if (day) { fireEvent.click(day); return }
    const caption = screen.getByTestId('calendar-month').textContent || ''
    const current = /^(\d{4})年(\d{1,2})月$/.exec(caption)
    if (!current) throw new Error(caption)
    const cursor = new Date(Number(current[1]), Number(current[2]) - 1, 1).getTime()
    fireEvent.click(screen.getByRole('button', { name: cursor < target ? '下个月' : '上个月' }))
  }
  throw new Error(`找不到${label}`)
}

const plan: Plan = { id: 'p1', title: '晨会', note: '站会', repeat: 'weekly', time: '09:00', weekdays: [1, 3, 5], timezone: 'Asia/Shanghai', enabled: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
afterEach(cleanup)

describe('plans and reminders', () => {
  it('validates one-time, daily and weekly schedules before saving', async () => {
    const save = vi.fn(async () => {})
    render(<PlansView plans={[]} onSave={save} onDelete={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '新建计划' }))
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请填写计划标题')

    fireEvent.change(screen.getByLabelText('计划标题'), { target: { value: '体检' } })
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请设置提醒日期')
    pickDay('2026年10月30日')
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: '体检', repeat: 'once', date: '2026-10-30', time: '09:00', enabled: true })))
    await waitFor(() => expect(screen.queryByRole('heading', { name: '新建计划' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '新建计划' }))
    fireEvent.change(screen.getByLabelText('计划标题'), { target: { value: '喝水' } })
    fireEvent.click(screen.getByRole('button', { name: '每天' }))
    fireEvent.click(screen.getByRole('button', { name: '增加小时' }))
    fireEvent.click(screen.getByRole('button', { name: '30分' }))
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: '喝水', repeat: 'daily', date: '', weekdays: [], time: '10:30' })))
    await waitFor(() => expect(screen.queryByRole('heading', { name: '新建计划' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '新建计划' }))
    fireEvent.change(screen.getByLabelText('计划标题'), { target: { value: '例会' } })
    fireEvent.click(screen.getByRole('button', { name: '每周' }))
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请至少选择一天')
    fireEvent.click(screen.getByRole('button', { name: '周五' }))
    fireEvent.click(screen.getByRole('button', { name: '周一' }))
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: '例会', repeat: 'weekly', weekdays: [1, 5] })))
  })

  it('shows the schedule, confirms deletion, and toggles the reminder', async () => {
    const save = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    render(<PlansView plans={[plan]} onSave={save} onDelete={remove} />)
    expect(screen.getByText('每周一、三、五 09:00')).toBeInTheDocument()
    expect(screen.getByText('站会')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '关闭提醒：晨会' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', enabled: false, weekdays: [1, 3, 5] })))

    fireEvent.click(screen.getByRole('button', { name: '删除计划：晨会' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除计划：晨会' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(plan))
  })
})
