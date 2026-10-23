import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TasksView } from './TasksView'
import type { Task } from '../types'

const task: Task = { id: 'task-1', notePath: '工作/计划.md', noteTitle: '计划', line: 3, text: '整理资料', status: 'todo', revision: 'v1' }
afterEach(cleanup)

describe('task interactions', () => {
  it('updates status through the keyboard-accessible selector and navigates to its source', async () => {
    const update = vi.fn(async () => {})
    const navigate = vi.fn()
    render(<TasksView tasks={[task]} mode="board" onUpdate={update} onNavigate={navigate} />)
    const status = screen.getByRole('combobox', { name: '任务状态：整理资料' })
    fireEvent.keyDown(status, { key: 'ArrowDown' })
    fireEvent.keyDown(status, { key: 'ArrowDown' })
    fireEvent.keyDown(status, { key: 'Enter' })
    await waitFor(() => expect(update).toHaveBeenCalledWith(task, { status: 'doing' }))
    fireEvent.click(screen.getByRole('button', { name: '整理资料' }))
    expect(navigate).toHaveBeenCalledWith(task)
  })

  it('does not save repeating tasks without a due date', () => {
    const update = vi.fn(async () => {})
    render(<TasksView tasks={[task]} mode="tasks" onUpdate={update} onNavigate={() => {}} />)
    fireEvent.click(screen.getByLabelText('设置排期与提醒：整理资料'))
    fireEvent.click(screen.getByRole('combobox', { name: '重复规则' }))
    fireEvent.click(screen.getByRole('option', { name: '每月' }))
    fireEvent.click(screen.getByRole('button', { name: '保存安排' }))
    expect(screen.getByRole('alert')).toHaveTextContent('重复任务需要设置截止时间')
    expect(update).not.toHaveBeenCalled()
  })

  it('passes stable source identities through native HTML drag and drop', async () => {
    const update = vi.fn(async () => {})
    const { container } = render(<TasksView tasks={[task]} mode="board" onUpdate={update} onNavigate={() => {}} />)
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) || '', types: ['application/x-echo-task'], effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(container.querySelector('.task-card')!, { dataTransfer })
    fireEvent.drop(screen.getByRole('region', { name: '进行中' }), { dataTransfer })
    await waitFor(() => expect(update).toHaveBeenCalledWith(task, { status: 'doing' }))
  })
})
