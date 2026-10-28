import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPanel } from './AgentPanel'

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

const conversations = [{ id: 'c1', title: '旧对话', mode: 'chat' as const, notePath: '日记.md', createdAt: '', updatedAt: '' }]

function renderPanel() {
  conversations.splice(0, conversations.length, { id: 'c1', title: '旧对话', mode: 'chat', notePath: '日记.md', createdAt: '', updatedAt: '' })
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    if (url.includes('/api/agent/conversations') && method === 'GET') return Response.json(conversations)
    if (url.includes('/api/agent/conversations') && method === 'DELETE') {
      conversations.splice(0, conversations.length)
      return Response.json({ ok: true })
    }
    throw new Error(`${method} ${url}`)
  }))
  return render(<AgentPanel open width={340} note={{ path: '日记.md', title: '日记' }} getNoteContent={() => '# 日记'} editor={null} onPendingChange={() => {}} onEnsureSource={() => {}} onEditsResolved={() => {}} onRegisterInterrupt={() => {}} onCollapse={() => {}} />)
}

describe('agent panel', () => {
  it('starts in note mode and can switch to chat', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: '笔记' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('日记')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '聊天' }))
    expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('未打开笔记')).not.toBeInTheDocument()
  })

  it('lists history and deletes a conversation', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }))
    expect(await screen.findByText('旧对话')).toBeInTheDocument()
    expect(screen.getByText('聊天 · 日记.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '删除 旧对话' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.queryByText('旧对话')).not.toBeInTheDocument())
    expect(screen.getByText('还没有对话')).toBeInTheDocument()
  })
})
