import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { Note, Settings } from './types'

vi.mock('./components/Editor', () => ({
  Editor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="笔记源码" value={value} onChange={event => onChange(event.target.value)} />,
}))
vi.mock('./components/MarkdownView', () => ({ MarkdownView: ({ content }: { content: string }) => <article data-testid="preview">{content}</article> }))
vi.mock('./components/TasksView', () => ({ TasksView: () => <div data-testid="tasks-view" /> }))
vi.mock('./export', () => ({ exportNotes: vi.fn(async () => {}) }))
vi.mock('motion/react', async () => {
  const React = await import('react')
  type Props = React.ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }
  const Div = React.forwardRef<HTMLDivElement, Props>(({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) => React.createElement('div', { ...props, ref }))
  return { MotionConfig: ({ children }: { children: React.ReactNode }) => children, AnimatePresence: ({ children }: { children: React.ReactNode }) => children, motion: { div: Div } }
})

const settings: Settings = { theme: 'light', accent: '#72967b', animations: false, editorLineNumbers: true, previewLineNumbers: false, assetsDir: '.assets' }
type Write = { path: string; content: string; revision: string; force?: boolean }
type Batch = { paths: string[]; tags: string[]; group: string; revisions: Record<string, string> }
type Call = { method: string; path: string; body?: unknown }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function createServer() {
  let note: Note = { path: '测试.md', title: '测试笔记', metadata: { tags: [], group: '' }, revision: 'v1', modified: '2026-10-22T12:00:00Z', content: '# 初始笔记\n' }
  let version = 1
  let nextWriteGate: ReturnType<typeof deferred> | undefined
  let nextConflict: Note | undefined
  const writes: Write[] = []
  const batches: Batch[] = []
  const calls: Call[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method || 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: url.pathname, body })
    if (url.pathname === '/api/settings') return response(settings)
    if (url.pathname === '/api/notes' && method === 'GET') return response(url.searchParams.has('path') ? note : [{ ...note, content: '' }])
    if (url.pathname === '/api/tree') return response([{ path: note.path, name: note.path, type: 'note' }])
    if (url.pathname === '/api/groups') return response(['工作'])
    if (url.pathname === '/api/tags') return response(['重点', '项目'])
    if (url.pathname === '/api/tasks' || url.pathname === '/api/reminders') return response([])
    if (url.pathname === '/api/notes' && method === 'PUT') {
      const write = body as Write
      writes.push(write)
      if (nextConflict) { note = nextConflict; nextConflict = undefined; return response({ error: '笔记已被外部修改', current: note }, 409) }
      const gate = nextWriteGate
      nextWriteGate = undefined
      if (gate) await gate.promise
      if (write.revision !== note.revision && !write.force) return response({ error: '笔记已被外部修改', current: note }, 409)
      note = { ...note, content: write.content, revision: `v${++version}` }
      return response(note)
    }
    if (url.pathname === '/api/notes/batch' && method === 'POST') {
      const batch = body as Batch
      batches.push(batch)
      if (batch.revisions[note.path] !== note.revision) return response({ error: '分类使用了过期版本', current: note }, 409)
      note = { ...note, metadata: { tags: batch.tags, group: batch.group }, revision: `v${++version}` }
      return response([note])
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`)
  })
  return { fetch, writes, batches, calls, current: () => note, delayNextWrite: () => { nextWriteGate = deferred(); return nextWriteGate }, conflictNextWrite: (disk: Note) => { nextConflict = disk } }
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { get length() { return values.size }, clear: () => values.clear(), getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, String(value)) }, removeItem: (key: string) => { values.delete(key) }, key: (index: number) => [...values.keys()][index] ?? null })
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ matches: false, media, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })))
  vi.stubGlobal('EventSource', class { onmessage = null; addEventListener() {} close() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function openApp(server: ReturnType<typeof createServer>) {
  vi.stubGlobal('fetch', server.fetch)
  render(<App />)
  const editor = await screen.findByRole('textbox', { name: '笔记源码' }) as HTMLTextAreaElement
  expect(editor.value).toBe('# 初始笔记\n')
  return editor
}
function saveShortcut() { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) }

describe('App saves and metadata integration', () => {
  it('loads a note, keeps a local draft immediately and autosaves after the debounce', async () => {
    const server = createServer()
    const editor = await openApp(server)
    fireEvent.change(editor, { target: { value: '# 自动保存内容\n' } })
    expect(JSON.parse(localStorage.getItem('echo:draft:测试.md')!).content).toBe('# 自动保存内容\n')
    expect(server.writes).toHaveLength(0)
    await waitFor(() => expect(server.writes).toHaveLength(1), { timeout: 2200 })
    await waitFor(() => expect(screen.getByRole('button', { name: '已保存' })).toBeInTheDocument())
    expect(server.current().content).toBe('# 自动保存内容\n')
    expect(localStorage.getItem('echo:draft:测试.md')).toBeNull()
  })

  it('drains edits typed during a delayed request using the newly saved revision', async () => {
    const server = createServer()
    const gate = server.delayNextWrite()
    const editor = await openApp(server)
    fireEvent.change(editor, { target: { value: '# 第一稿\n' } })
    saveShortcut()
    await waitFor(() => expect(server.writes).toHaveLength(1))
    fireEvent.change(editor, { target: { value: '# 第二稿\n' } })
    fireEvent.change(editor, { target: { value: '# 最后一次键入\n' } })
    expect(server.writes[0].content).toBe('# 第一稿\n')
    await act(async () => { gate.resolve(); await gate.promise })
    await waitFor(() => expect(server.writes).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: '已保存' })).toBeInTheDocument())
    expect(server.writes[1]).toMatchObject({ content: '# 最后一次键入\n', revision: 'v2' })
    expect(server.current().content).toBe('# 最后一次键入\n')
    expect(editor.value).toBe('# 最后一次键入\n')
    expect(localStorage.getItem('echo:draft:测试.md')).toBeNull()
  })

  it('flushes the pending source before classification and sends the new revision to the batch API', async () => {
    const server = createServer()
    const editor = await openApp(server)
    fireEvent.change(editor, { target: { value: '# 分类前尚未保存\n' } })
    fireEvent.click(screen.getByRole('button', { name: '添加标签' }))
    await screen.findByRole('dialog', { name: '标签与分组' })
    fireEvent.change(screen.getByLabelText('标签', { selector: 'input' }), { target: { value: '重点, 项目' } })
    fireEvent.change(screen.getByLabelText('分组', { selector: 'select' }), { target: { value: '工作' } })
    fireEvent.click(screen.getByRole('button', { name: '保存分类' }))
    await waitFor(() => expect(server.batches).toHaveLength(1))
    expect(server.writes[0].content).toBe('# 分类前尚未保存\n')
    expect(server.batches[0]).toMatchObject({ paths: ['测试.md'], tags: ['重点', '项目'], group: '工作', revisions: { '测试.md': 'v2' } })
    const mutations = server.calls.filter(call => call.method !== 'GET')
    expect(mutations.map(call => `${call.method} ${call.path}`)).toEqual(['PUT /api/notes', 'POST /api/notes/batch'])
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '标签与分组' })).not.toBeInTheDocument())
    expect(editor.value).toBe('# 分类前尚未保存\n')
    expect(server.current().metadata).toEqual({ tags: ['重点', '项目'], group: '工作' })
  })

  it('preserves a conflicting local draft until the user selects the disk version', async () => {
    const server = createServer()
    const editor = await openApp(server)
    const disk = { ...server.current(), content: '# 磁盘上的新内容\n', revision: 'external-v2' }
    server.conflictNextWrite(disk)
    fireEvent.change(editor, { target: { value: '# 不能丢失的本地草稿\n' } })
    saveShortcut()
    expect(await screen.findByRole('dialog', { name: '笔记存在版本冲突' })).toBeInTheDocument()
    expect(editor.value).toBe('# 不能丢失的本地草稿\n')
    expect(JSON.parse(localStorage.getItem('echo:draft:测试.md')!).content).toBe('# 不能丢失的本地草稿\n')
    expect(server.current().content).toBe(disk.content)
    fireEvent.click(screen.getByRole('button', { name: '使用磁盘版本' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '笔记存在版本冲突' })).not.toBeInTheDocument())
    expect(editor.value).toBe(disk.content)
    expect(localStorage.getItem('echo:draft:测试.md')).toBeNull()
    expect(server.writes).toHaveLength(1)
    expect(server.writes[0].force).not.toBe(true)
  })
})
