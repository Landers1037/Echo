import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TasksView } from './TasksView'
import type { CustomTask, Task } from '../types'

const task: Task = { id: 'task-1', notePath: '工作/计划.md', noteTitle: '计划', line: 3, text: '整理资料', status: 'todo', revision: 'v1' }
const custom: CustomTask = { id: 'c1', text: '买咖啡', description: '午后', status: 'todo', createdAt: '', updatedAt: '' }
const noop = async () => {}
afterEach(cleanup)

describe('task board', () => {
  it('defaults to custom tasks and keeps note tasks on their own tab', async () => {
    const update = vi.fn(async () => {})
    const navigate = vi.fn()
    render(<TasksView tasks={[task]} customTasks={[custom]} onUpdateTask={update} onNavigate={navigate} onSaveCustom={noop} onDeleteCustom={noop} />)
    expect(screen.getByRole('tab', { name: '自定任务', selected: true })).toBeInTheDocument()
    expect(screen.getByText('买咖啡')).toBeInTheDocument()
    expect(screen.queryByText('整理资料')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '笔记任务' }))
    const status = screen.getByRole('combobox', { name: '任务状态：整理资料' })
    fireEvent.keyDown(status, { key: 'ArrowDown' })
    fireEvent.keyDown(status, { key: 'ArrowDown' })
    fireEvent.keyDown(status, { key: 'Enter' })
    await waitFor(() => expect(update).toHaveBeenCalledWith(task, { status: 'doing' }))
    fireEvent.click(screen.getByRole('button', { name: '整理资料' }))
    expect(navigate).toHaveBeenCalledWith(task)
    expect(screen.queryByLabelText('设置排期与提醒：整理资料')).not.toBeInTheDocument()
  })

  it('creates, edits and deletes a custom task', async () => {
    const save = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    render(<TasksView tasks={[]} customTasks={[custom]} onUpdateTask={noop} onNavigate={() => {}} onSaveCustom={save} onDeleteCustom={remove} />)
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '写周报' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '周五前' } })
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ text: '写周报', description: '周五前', status: 'todo' }))

    fireEvent.click(screen.getByRole('button', { name: '编辑任务：买咖啡' }))
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '买咖啡豆' } })
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', text: '买咖啡豆', status: 'todo' })))
    await waitFor(() => expect(screen.queryByRole('heading', { name: '编辑任务' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '删除任务：买咖啡' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除任务：买咖啡' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(custom))
  })

  it('passes stable source identities through native HTML drag and drop', async () => {
    const update = vi.fn(async () => {})
    const save = vi.fn(async () => {})
    const { container } = render(<TasksView tasks={[task]} customTasks={[custom]} onUpdateTask={update} onNavigate={() => {}} onSaveCustom={save} onDeleteCustom={noop} />)
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) || '', types: ['application/x-echo-task'], effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(container.querySelector('.task-card')!, { dataTransfer })
    fireEvent.drop(screen.getByRole('region', { name: '进行中' }), { dataTransfer })
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', status: 'doing' })))
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: '笔记任务' }))
    data.clear()
    fireEvent.dragStart(container.querySelector('.task-card')!, { dataTransfer })
    fireEvent.drop(screen.getByRole('region', { name: '已完成' }), { dataTransfer })
    await waitFor(() => expect(update).toHaveBeenCalledWith(task, { status: 'done' }))
  })
})
