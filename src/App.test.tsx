import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { exportNotes } from './export'
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
  type ButtonProps = React.ComponentProps<'button'> & Pick<Props, 'initial' | 'animate' | 'exit' | 'transition'>
  const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) => React.createElement('button', { ...props, ref }))
  return { MotionConfig: ({ children }: { children: React.ReactNode }) => children, AnimatePresence: ({ children }: { children: React.ReactNode }) => children, motion: { div: Div, button: Button } }
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

function createServer(extraNotes: Note[] = []) {
  let note: Note = { path: '测试.md', title: '测试笔记', metadata: { tags: [], group: '' }, revision: 'v1', modified: '2026-10-22T12:00:00Z', content: '# 初始笔记\n' }
  let savedSettings = { ...settings }
  let settingsError = false
  let cleanupError = false
  let unusedImages = [{ path: '.assets/unused.png', size: 2048 }]
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
    if (url.pathname === '/api/storage/open' && method === 'POST') return response({ ok: true })
    if (url.pathname === '/api/settings') {
      if (method === 'PUT') {
        if (settingsError) { settingsError = false; return response({ error: '设置写入失败' }, 500) }
        savedSettings = body as Settings
      }
      return response(savedSettings)
    }
    if (url.pathname === '/api/storage') return response({ root: 'D:\\EchoNotes', assetsDir: savedSettings.assetsDir, databaseBytes: 2048, noteBytes: 4096, noteCount: 2, assetBytes: 4096 + unusedImages.length * 2048, assetCount: 2 + unusedImages.length })
    if (url.pathname === '/api/storage/unused-assets') return response({ assetsDir: savedSettings.assetsDir, files: unusedImages, bytes: unusedImages.length * 2048, token: 'scan-v1' })
    if (url.pathname === '/api/storage/cleanup' && method === 'POST') {
      if (cleanupError) { cleanupError = false; return response({ error: '笔记或图片资源已变化，请重新检查后清理' }, 409) }
      const removedCount = unusedImages.length
      unusedImages = []
      return response({ removedCount, removedBytes: removedCount * 2048, failed: [] })
    }
    if (url.pathname === '/api/notes' && method === 'GET') return response(url.searchParams.has('path') ? [note, ...extraNotes].find(item => item.path === url.searchParams.get('path')) : [note, ...extraNotes].map(item => ({ ...item, content: '' })))
    if (url.pathname === '/api/tree') return response([note, ...extraNotes].map(item => ({ path: item.path, name: item.path, type: 'note' })))
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
  return { fetch, writes, batches, calls, current: () => note, savedSettings: () => savedSettings, failNextCleanup: () => { cleanupError = true }, failNextSettings: () => { settingsError = true }, delayNextWrite: () => { nextWriteGate = deferred(); return nextWriteGate }, conflictNextWrite: (disk: Note) => { nextConflict = disk } }
}

beforeEach(() => {
  vi.mocked(exportNotes).mockClear()
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

describe('App single-note export', () => {
  it('exports the active note from its operations menu and saves its pending draft first', async () => {
    const server = createServer()
    const editor = await openApp(server)
    vi.mocked(exportNotes).mockImplementationOnce(async ({ beforeExport }) => { await beforeExport() })
    fireEvent.change(editor, { target: { value: '# 导出前的草稿\n' } })
    fireEvent.click(screen.getByRole('button', { name: '笔记操作' }))
    fireEvent.click(screen.getByRole('button', { name: '导出该笔记' }))
    expect(screen.getByRole('dialog', { name: '导出笔记' })).toHaveTextContent('测试.md')
    expect(screen.queryByRole('combobox', { name: '导出范围' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /原始 \.md 文件/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /Markdown 资源包/ }))
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出笔记' })).not.toBeInTheDocument())
    expect(exportNotes).toHaveBeenCalledWith(expect.objectContaining({ paths: ['测试.md'], format: 'bundle' }))
    expect(server.current().content).toBe('# 导出前的草稿\n')
  })

  it.each(['导出', '导出所选'])('pins a different note despite bulk selections, then restores the %s entry', async entry => {
    const other: Note = { path: '归档/另一篇.md', title: '另一篇笔记', content: '# 另一篇\n', metadata: { tags: [], group: '' }, revision: 'other-v1', modified: '2026-10-22T12:00:00Z' }
    const server = createServer([other])
    const editor = await openApp(server)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 测试笔记' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 另一篇笔记' }))
    fireEvent.click(screen.getByRole('button', { name: '管理 归档/另一篇.md' }))
    fireEvent.click(screen.getByRole('button', { name: '导出该笔记' }))
    expect(screen.getByRole('dialog', { name: '导出笔记' })).toHaveTextContent('归档/另一篇.md')
    expect(screen.getByText(/将导出 1 篇笔记/)).toBeInTheDocument()
    expect(editor.value).toBe('# 初始笔记\n')
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出笔记' })).not.toBeInTheDocument())
    expect(exportNotes).toHaveBeenLastCalledWith(expect.objectContaining({ paths: [other.path], format: 'html' }))

    fireEvent.click(screen.getByRole('button', { name: entry }))
    expect(screen.getByRole('combobox', { name: '导出范围' })).toHaveTextContent('所选笔记（2 篇）')
    expect(screen.getByText(/将导出 2 篇笔记/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /原始 \.md 文件/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出笔记' })).not.toBeInTheDocument())
    expect(exportNotes).toHaveBeenLastCalledWith(expect.objectContaining({ paths: ['测试.md', other.path] }))
    expect(editor.value).toBe('# 初始笔记\n')
  })
})

describe('App appearance settings', () => {
  it('previews themes and preset or custom accents immediately and restores them on cancel', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '暗黑' }))
    fireEvent.click(screen.getByRole('button', { name: '强调色 #9379b7' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#9379b7')
    expect(screen.getByRole('button', { name: '暗黑' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '跟随系统' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    fireEvent.change(screen.getByLabelText('自定义强调色'), { target: { value: '#123abc' } })
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123abc')
    expect(server.calls.filter(call => call.path === '/api/settings' && call.method === 'PUT')).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('echo:settings')!)).toMatchObject({ theme: 'light', accent: '#72967b' })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#72967b')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('button', { name: '明亮' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('自定义强调色')).toHaveValue('#72967b')
  })

  it('persists a saved appearance and restores it from the server when the app reloads', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '暗黑' }))
    fireEvent.click(screen.getByRole('button', { name: '强调色 #5885b5' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings()).toMatchObject({ theme: 'dark', accent: '#5885b5' })
    expect(JSON.parse(localStorage.getItem('echo:settings')!)).toMatchObject({ theme: 'dark', accent: '#5885b5' })

    cleanup()
    localStorage.removeItem('echo:settings')
    await openApp(server)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#5885b5')
  })

  it('keeps a failed save editable without persisting the preview and restores it on close', async () => {
    const server = createServer()
    server.failNextSettings()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '暗黑' }))
    fireEvent.click(screen.getByRole('button', { name: '强调色 #bd7790' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('设置写入失败')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(server.savedSettings()).toMatchObject({ theme: 'light', accent: '#72967b' })
    expect(JSON.parse(localStorage.getItem('echo:settings')!)).toMatchObject({ theme: 'light', accent: '#72967b' })

    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#72967b')
  })
})

describe('App settings navigation and storage', () => {
  it('keeps settings drafts when switching the left menu and saves from the detail page', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('navigation', { name: '设置菜单' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    expect(screen.queryByRole('button', { name: '暗黑' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '源码编辑器行号' }))
    fireEvent.click(screen.getByRole('button', { name: '外观设置' }))
    fireEvent.click(screen.getByRole('button', { name: '强调色 #5885b5' }))
    fireEvent.click(screen.getByRole('button', { name: '存储设置' }))
    expect(await screen.findByText('2.00 KB')).toBeInTheDocument()
    expect(screen.getByText('4.00 KB')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('资源目录'), { target: { value: 'images' } })
    expect(screen.getByRole('button', { name: '检查未引用图片' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    expect(screen.getByRole('switch', { name: '源码编辑器行号' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings()).toMatchObject({ accent: '#5885b5', editorLineNumbers: false, assetsDir: 'images' })
  })

  it('saves pending note references before scanning and only cleans after explicit confirmation', async () => {
    const server = createServer()
    const editor = await openApp(server)
    fireEvent.change(editor, { target: { value: '# Pending\n![keep](.assets/kept.png)\n' } })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '存储设置' }))
    fireEvent.click(screen.getByRole('button', { name: '检查未引用图片' }))
    expect(await screen.findByRole('list', { name: '未引用图片列表' })).toHaveTextContent('.assets/unused.png')
    const saveIndex = server.calls.findIndex(call => call.path === '/api/notes' && call.method === 'PUT')
    const scanIndex = server.calls.findIndex(call => call.path === '/api/storage/unused-assets')
    expect(saveIndex).toBeGreaterThan(-1)
    expect(scanIndex).toBeGreaterThan(saveIndex)
    expect(server.current().content).toContain('![keep](.assets/kept.png)')
    fireEvent.click(screen.getByRole('button', { name: '清理 1 张图片' }))
    expect(server.calls.filter(call => call.path === '/api/storage/cleanup')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '取消清理' }))
    expect(server.calls.filter(call => call.path === '/api/storage/cleanup')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '清理 1 张图片' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已清理 1 张图片，释放 2.00 KB')
    expect(server.calls.find(call => call.path === '/api/storage/cleanup')?.body).toEqual({ token: 'scan-v1' })
    expect(screen.queryByRole('list', { name: '未引用图片列表' })).not.toBeInTheDocument()
  })

  it('requires another scan after stale cleanup and preserves files on failure', async () => {
    const server = createServer()
    server.failNextCleanup()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '存储设置' }))
    fireEvent.click(screen.getByRole('button', { name: '检查未引用图片' }))
    fireEvent.click(await screen.findByRole('button', { name: '清理 1 张图片' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清理' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请重新检查后清理')
    expect(screen.queryByRole('button', { name: '确认清理' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '检查未引用图片' }))
    expect(await screen.findByRole('list', { name: '未引用图片列表' })).toHaveTextContent('.assets/unused.png')
  })
})

describe('App sidebar navigation', () => {
  it('opens the notebook directory from the local space card and blocks duplicate clicks while opening', async () => {
    const server = createServer()
    const gate = deferred()
    const normalFetch = server.fetch.getMockImplementation()!
    server.fetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/storage/open') await gate.promise
      return normalFetch(input, init)
    })
    const editor = await openApp(server)
    const button = screen.getByRole('button', { name: '本地空间：打开笔记库目录' })
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('正在打开文件浏览器…')
    fireEvent.click(button)
    await act(async () => { gate.resolve(); await gate.promise })
    expect(await screen.findByText('已打开笔记库目录。')).toBeInTheDocument()
    expect(button).toBeEnabled()
    expect(server.calls.filter(call => call.path === '/api/storage/open')).toEqual([{ method: 'POST', path: '/api/storage/open', body: undefined }])
    expect(server.writes).toHaveLength(0)
    expect(editor.value).toBe('# 初始笔记\n')
  })

  it('shows a desktop launch failure and allows retrying the local space button', async () => {
    const server = createServer()
    const normalFetch = server.fetch.getMockImplementation()!
    let fail = true
    server.fetch.mockImplementation(async (input, init) => {
      if (String(input) === '/api/storage/open' && fail) { fail = false; return response({ error: '无法打开文件浏览器' }, 400) }
      return normalFetch(input, init)
    })
    await openApp(server)
    const button = screen.getByRole('button', { name: '本地空间：打开笔记库目录' })
    fireEvent.click(button)
    expect(await screen.findByText('无法打开文件浏览器')).toBeInTheDocument()
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(await screen.findByText('已打开笔记库目录。')).toBeInTheDocument()
  })

  it('collapses the desktop sidebar and reopens it with Ctrl+K before focusing search', async () => {
    await openApp(createServer())
    const toggle = screen.getByRole('button', { name: '折叠目录' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', 'note-sidebar')

    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '展开目录' })).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('note-sidebar')).toHaveAttribute('inert')
    expect(screen.queryByRole('separator', { name: '调整目录宽度' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.getByRole('textbox', { name: '搜索笔记' })).toHaveFocus())
    expect(document.getElementById('note-sidebar')).not.toHaveAttribute('inert')
    expect(screen.getByRole('separator', { name: '调整目录宽度' })).toBeVisible()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '测试笔记' })) })
    expect(screen.getByRole('button', { name: '折叠目录' })).toHaveAttribute('aria-expanded', 'true')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '计划与提醒' })) })
    expect(await screen.findByTestId('tasks-view')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠目录' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('starts closed on mobile and closes again after selecting a note or the close button', async () => {
    vi.mocked(matchMedia).mockImplementation(media => ({ matches: media === '(max-width: 760px)', media, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }))
    await openApp(createServer())
    expect(screen.getByRole('button', { name: '展开目录' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: '展开目录' }))
    expect(screen.getByRole('button', { name: '折叠目录' })).toHaveAttribute('aria-expanded', 'true')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '测试笔记' })) })
    expect(screen.getByRole('button', { name: '展开目录' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: '展开目录' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭目录' }))
    expect(screen.getByRole('button', { name: '展开目录' })).toHaveAttribute('aria-expanded', 'false')
  })
})

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
    fireEvent.click(screen.getByRole('combobox', { name: '分组' }))
    fireEvent.click(screen.getByRole('option', { name: '工作' }))
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
