import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { displayedNoteTitle } from './noteTitle'
import { exportNotes } from './export'
import type { Note, Settings, TreeEntry } from './types'
import { keyFromEvent } from './shortcuts'

vi.mock('./components/Editor', () => ({
  Editor: ({ value, onChange, fontSize }: { value: string; onChange: (value: string) => void; fontSize: number }) => <textarea className="cm-editor" aria-label="笔记源码" style={{ fontSize }} value={value} onChange={event => onChange(event.target.value)} />,
}))
vi.mock('./components/MarkdownView', () => ({ MarkdownView: ({ content, fontSize, strictLineBreaks }: { content: string; fontSize?: number; strictLineBreaks?: boolean }) => <article data-testid="preview" data-strict-breaks={strictLineBreaks ? 'true' : 'false'} style={{ fontSize }}>{content}</article> }))
vi.mock('./components/TasksView', () => ({ TasksView: () => <div data-testid="tasks-view" /> }))
vi.mock('./components/PlansView', () => ({ PlansView: () => <div data-testid="plans-view" />, planScheduleLabel: () => '' }))
vi.mock('./export', () => ({ exportNotes: vi.fn(async () => {}) }))
vi.mock('./components/Drawing', () => ({
  DrawingEmbed: () => null,
  DrawingModal: ({ path, onClose }: { path: string; onClose: () => void }) => <div role="dialog" aria-label="绘图"><span>{path}</span><button type="button" onClick={onClose}>关闭绘图</button></div>,
}))
vi.mock('./components/Drawio', () => ({
  DrawioEmbed: () => null,
  DrawioModal: ({ path, onClose }: { path: string; onClose: () => void }) => <div role="dialog" aria-label="绘图"><span>{path}</span><button type="button" onClick={onClose}>关闭绘图</button></div>,
}))
vi.mock('motion/react', async () => {
  const React = await import('react')
  type Props = React.ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }
  const Div = React.forwardRef<HTMLDivElement, Props>(({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) => React.createElement('div', { ...props, ref }))
  type ButtonProps = React.ComponentProps<'button'> & Pick<Props, 'initial' | 'animate' | 'exit' | 'transition'>
  const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }, ref) => React.createElement('button', { ...props, ref }))
  return { MotionConfig: ({ children }: { children: React.ReactNode }) => children, AnimatePresence: ({ children }: { children: React.ReactNode }) => children, motion: { div: Div, button: Button } }
})

const settings: Settings = { theme: 'light', uiStyle: 'sage', accent: '#72967b', animations: false, editorFontSize: 14, editorLineNumbers: true, previewLineNumbers: false, multiTabs: false, sourceSplitPreview: false, strictLineBreaks: false, noteWidth: 'default', assetsDir: '.assets', shortcuts: {} }
type Write = { path: string; content: string; revision: string; force?: boolean }
type Batch = { paths: string[]; tags: string[]; group: string; revisions: Record<string, string> }
type Call = { method: string; path: string; body?: unknown }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function noteTree(notes: Note[], folders: string[], drawings: string[] = []): TreeEntry[] {
  const root: TreeEntry[] = []
  const directories = new Map<string, TreeEntry>()
  function children(path: string): TreeEntry[] {
    if (!path) return root
    if (!directories.has(path)) {
      const parts = path.split('/')
      const entry: TreeEntry = { path, name: parts.pop()!, type: 'folder', children: [] }
      directories.set(path, entry)
      children(parts.join('/')).push(entry)
    }
    return directories.get(path)!.children!
  }
  folders.forEach(children)
  for (const note of notes) {
    const parts = note.path.split('/')
    children(parts.slice(0, -1).join('/')).push({ path: note.path, name: parts.at(-1)!, type: 'note' })
  }
  for (const drawing of drawings) {
    const parts = drawing.split('/')
    children(parts.slice(0, -1).join('/')).push({ path: drawing, name: parts.at(-1)!, type: 'drawing' })
  }
  return root
}

function createServer(extraNotes: Note[] = [], initialFolders: string[] = [], initialSettings: Partial<Settings> = {}, initialDrawings: string[] = []) {
  let note: Note = { path: '测试.md', title: '测试笔记', metadata: { tags: [], group: '' }, revision: 'v1', modified: '2026-10-22T12:00:00Z', content: '# 初始笔记\n' }
  const createdNotes: Note[] = []
  const folders = [...initialFolders]
  const drawings = [...initialDrawings]
  const allNotes = () => [note, ...extraNotes, ...createdNotes]
  let savedSettings = { ...settings, ...initialSettings }
  let settingsError = false
  let cleanupError = false
  let unusedImages = [{ path: '.assets/unused.png', size: 2048 }]
  let version = 1
  let nextWriteGate: ReturnType<typeof deferred> | undefined
  let nextConflict: Note | undefined
  const writes: Write[] = []
  const batches: Batch[] = []
  const calls: Call[] = []
  let currentRepository = 'D:\\EchoNotes'
  let repositories = [
    { path: 'D:\\EchoNotes', name: '本地笔记', lastOpened: '2026-10-27T01:00:00.000Z' },
    { path: 'D:\\Archive', name: '归档', lastOpened: '2026-10-26T01:00:00.000Z' },
  ]
  let nextPick = { canceled: true, switched: false, path: '' }
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method || 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: url.pathname, body })
    if (url.pathname === '/api/storage/open' && method === 'POST') return response({ ok: true })
    if (url.pathname === '/api/agent/config') return response({ enabled: false, baseURL: 'https://api.openai.com/v1', hasKey: false, apiKeyHint: '', model: 'gpt-4o-mini', contextTokens: 32000, maxOutputTokens: 4096, temperature: 0.7, systemPrompt: '', timeoutSeconds: 90 })
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
    if (url.pathname === '/api/notes' && method === 'GET') return response(url.searchParams.has('path') ? allNotes().find(item => item.path === url.searchParams.get('path')) : allNotes().map(item => ({ ...item, content: '' })))
    if (url.pathname === '/api/tree') return response(noteTree(allNotes(), folders, drawings))
    if (url.pathname === '/api/drawings' && method === 'POST') {
      const request = body as { path?: string; notePath?: string }
      if (request.notePath) return response({ path: '.assets/drawing.excalidraw', markdownPath: '.assets/drawing.excalidraw', revision: 'd1', modified: note.modified, content: '{"type":"excalidraw","elements":[]}' }, 201)
      const createdPath = request.path || '未命名绘图.excalidraw'
      drawings.push(createdPath)
      return response({ path: createdPath, revision: 'd1', modified: note.modified, content: '{"type":"excalidraw","elements":[]}' }, 201)
    }
    if (url.pathname === '/api/notes' && method === 'POST') {
      const request = body as { path: string; content: string }
      if (allNotes().some(item => item.path === request.path)) return response({ error: '目标笔记已经存在' }, 409)
      const created: Note = { path: request.path, title: request.path.split('/').at(-1)!.replace(/\.md$/i, ''), content: request.content, metadata: { tags: [], group: '' }, revision: `created-${createdNotes.length}`, modified: note.modified }
      createdNotes.push(created)
      return response(created, 201)
    }
    if (url.pathname === '/api/folders' && method === 'POST') { folders.push((body as { path: string }).path); return response({ ok: true }, 201) }
    if (url.pathname === '/api/groups') return response(['工作'])
    if (url.pathname === '/api/tags') return response(['重点', '项目'])
    if (url.pathname === '/api/tasks' || url.pathname === '/api/reminders' || url.pathname === '/api/plans' || url.pathname === '/api/custom-tasks') return response([])
    if (url.pathname === '/api/notes' && method === 'PUT') {
      const write = body as Write
      writes.push(write)
      if (nextConflict) { note = nextConflict; nextConflict = undefined; return response({ error: '笔记已被外部修改', current: note }, 409) }
      const gate = nextWriteGate
      nextWriteGate = undefined
      if (gate) await gate.promise
      if (write.revision !== note.revision && !write.force) return response({ error: '笔记已被外部修改', current: note }, 409)
      note = { ...note, content: write.content, title: displayedNoteTitle(write.content, note.path.replace(/\.md$/i, '')), revision: `v${++version}` }
      return response(note)
    }
    if (url.pathname === '/api/repositories' && method === 'GET') return response({ current: currentRepository, items: repositories, switched: false, canceled: false })
    if (url.pathname === '/api/repositories' && method === 'PUT') {
      const request = body as { path: string; name: string }
      const item = repositories.find(entry => entry.path === request.path)
      if (!item) return response({ error: '找不到该仓库记录' }, 400)
      item.name = request.name
      return response({ current: currentRepository, items: repositories, switched: false, canceled: false })
    }
    if (url.pathname === '/api/repositories' && method === 'DELETE') {
      const target = url.searchParams.get('path')
      if (target === currentRepository) return response({ error: '不能删除当前打开的仓库' }, 400)
      repositories = repositories.filter(entry => entry.path !== target)
      return response({ current: currentRepository, items: repositories, switched: false, canceled: false })
    }
    if (url.pathname === '/api/repositories/switch' && method === 'POST') {
      const request = body as { path: string }
      const known = repositories.find(entry => entry.path === request.path)
      if (!known) return response({ error: '无法访问仓库目录' }, 400)
      const switched = request.path !== currentRepository
      currentRepository = request.path
      repositories = [known, ...repositories.filter(entry => entry.path !== known.path)]
      return response({ current: currentRepository, items: repositories, switched, canceled: false })
    }
    if (url.pathname === '/api/repositories/pick' && method === 'POST') {
      if (nextPick.canceled) return response({ current: currentRepository, items: repositories, switched: false, canceled: true })
      const path = nextPick.path
      const switched = nextPick.switched && path !== currentRepository
      if (!repositories.some(entry => entry.path === path)) repositories = [{ path, name: '新仓库', lastOpened: '2026-10-27T02:00:00.000Z' }, ...repositories]
      currentRepository = path
      return response({ current: currentRepository, items: repositories, switched, canceled: false })
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
  return { fetch, writes, batches, calls, current: () => note, savedSettings: () => savedSettings, failNextCleanup: () => { cleanupError = true }, failNextSettings: () => { settingsError = true }, delayNextWrite: () => { nextWriteGate = deferred(); return nextWriteGate }, conflictNextWrite: (disk: Note) => { nextConflict = disk }, queuePick: (path: string, switched = true) => { nextPick = { canceled: false, switched, path } } }
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

describe('App creates items inside a folder', () => {
  it.each([
    ['会议记录', '验收/子目录/会议记录.md'],
    ['深入\\会议记录', '验收/子目录/深入/会议记录.md'],
    ['会议记录.MD', '验收/子目录/会议记录.MD'],
  ])('saves the current draft, then creates %s under the chosen folder', async (name, path) => {
    const server = createServer([], ['验收/子目录', '其他目录'])
    const editor = await openApp(server)
    fireEvent.change(editor, { target: { value: '# 创建前的草稿\n' } })
    fireEvent.click(screen.getByRole('button', { name: '验收' }))
    fireEvent.click(screen.getByRole('button', { name: '管理文件夹 验收/子目录' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '文件夹操作' })).getByRole('button', { name: '新建笔记' }))
    const dialog = screen.getByRole('dialog', { name: '新建笔记' })
    expect(dialog).toHaveTextContent('创建位置：验收/子目录')
    fireEvent.change(within(dialog).getByLabelText('笔记名称'), { target: { value: name } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建笔记' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '笔记源码' })).toHaveValue(''))
    await screen.findByRole('button', { name: '会议记录' })
    expect(server.current().content).toBe('# 创建前的草稿\n')
    expect(server.calls.filter(call => call.path === '/api/notes' && call.method !== 'GET').map(call => call.method)).toEqual(['PUT', 'POST'])
    expect(server.calls.find(call => call.path === '/api/notes' && call.method === 'POST')?.body).toEqual({ path, content: '' })
    expect(screen.getByRole('button', { name: '验收' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '子目录' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '其他目录' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: '会议记录' })).toBeVisible()
    expect(screen.getByRole('button', { name: '折叠目录' })).toBeInTheDocument()
  })

  it('creates nested subdirectories and reveals just their parent directories', async () => {
    const server = createServer([], ['验收', '其他目录'])
    const editor = await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '管理文件夹 验收' }))
    fireEvent.click(screen.getByRole('button', { name: '新建目录' }))
    const dialog = screen.getByRole('dialog', { name: '新建目录' })
    expect(dialog).toHaveTextContent('创建位置：验收')
    fireEvent.change(within(dialog).getByLabelText('目录名称'), { target: { value: '项目/资料' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建目录' }))
    await screen.findByRole('button', { name: '资料' })
    expect(server.calls.find(call => call.path === '/api/folders' && call.method === 'POST')?.body).toEqual({ path: '验收/项目/资料' })
    expect(screen.getByRole('button', { name: '验收' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '项目' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '其他目录' })).toHaveAttribute('aria-expanded', 'false')
    expect(editor).toHaveValue('# 初始笔记\n')
  })

  it('cancels without creating anything and keeps root creation independent of the selected folder', async () => {
    const server = createServer([], ['验收'])
    await openApp(server)
    for (const title of ['新建目录', '新建笔记']) {
      fireEvent.click(screen.getByRole('button', { name: '管理文件夹 验收' }))
      fireEvent.click(within(screen.getByRole('dialog', { name: '文件夹操作' })).getByRole('button', { name: title }))
      fireEvent.click(within(screen.getByRole('dialog', { name: title })).getByRole('button', { name: '取消' }))
    }
    expect(server.calls.some(call => call.method === 'POST' && ['/api/notes', '/api/folders'].includes(call.path))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '笔记操作' }))
    const noteMenu = screen.getByRole('dialog', { name: '笔记操作' })
    expect(within(noteMenu).queryByRole('button', { name: '新建目录' })).not.toBeInTheDocument()
    expect(within(noteMenu).queryByRole('button', { name: '新建笔记' })).not.toBeInTheDocument()
    fireEvent.click(within(noteMenu).getByRole('button', { name: '关闭弹窗' }))
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }))
    expect(screen.getByRole('dialog', { name: '新建笔记' })).not.toHaveTextContent('创建位置：验收')
    fireEvent.change(screen.getByLabelText('笔记路径'), { target: { value: '根目录笔记' } })
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }))
    await waitFor(() => expect(server.calls.find(call => call.path === '/api/notes' && call.method === 'POST')?.body).toEqual({ path: '根目录笔记.md', content: '' }))
  })

  it('opens directory drawings and creates one inside the selected folder', async () => {
    const server = createServer([], ['验收'], {}, ['图表/架构.excalidraw'])
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '图表' }))
    fireEvent.click(screen.getByRole('button', { name: '架构' }))
    expect(screen.getByRole('dialog', { name: '绘图' })).toHaveTextContent('图表/架构.excalidraw')
    fireEvent.click(screen.getByRole('button', { name: '关闭绘图' }))
    fireEvent.change(screen.getByLabelText('搜索笔记'), { target: { value: '没有这篇' } })
    expect(screen.queryByRole('button', { name: '架构' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '管理文件夹 验收' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '文件夹操作' })).getByRole('button', { name: '新建绘图' }))
    const dialog = screen.getByRole('dialog', { name: '新建绘图' })
    expect(dialog).toHaveTextContent('创建位置：验收')
    fireEvent.change(within(dialog).getByLabelText('绘图名称'), { target: { value: '流程' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建绘图' }))
    expect(await screen.findByRole('dialog', { name: '绘图' })).toHaveTextContent('验收/流程.excalidraw')
    expect(server.calls.find(call => call.path === '/api/drawings' && call.method === 'POST')?.body).toEqual({ path: '验收/流程.excalidraw' })
    expect(await screen.findByRole('button', { name: '流程' })).toBeVisible()
    expect(screen.getByRole('button', { name: '验收' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('creates a draw.io diagram from the footer and inside the selected folder', async () => {
    const server = createServer([], ['验收'])
    await openApp(server)
    const draw = screen.getByRole('button', { name: 'Draw.io 绘图' })
    expect(draw.nextElementSibling).toBe(screen.getByRole('button', { name: '回收站' }))
    fireEvent.click(draw)
    const dialog = screen.getByRole('dialog', { name: '新建 Draw.io' })
    expect(within(dialog).getByLabelText('绘图路径')).toHaveValue('未命名图表.drawio')
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 Draw.io' }))
    expect(await screen.findByRole('dialog', { name: '绘图' })).toHaveTextContent('未命名图表.drawio')
    fireEvent.click(screen.getByRole('button', { name: '关闭绘图' }))
    fireEvent.click(screen.getByRole('button', { name: '管理文件夹 验收' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '文件夹操作' })).getByRole('button', { name: '新建 Draw.io' }))
    const nested = screen.getByRole('dialog', { name: '新建 Draw.io' })
    expect(nested).toHaveTextContent('创建位置：验收')
    fireEvent.change(within(nested).getByLabelText('绘图名称'), { target: { value: '流程' } })
    fireEvent.click(within(nested).getByRole('button', { name: '创建 Draw.io' }))
    expect(await screen.findByRole('dialog', { name: '绘图' })).toHaveTextContent('验收/流程.drawio')
    expect(server.calls.filter(call => call.path === '/api/drawings' && call.method === 'POST').map(call => call.body)).toEqual([
      { path: '未命名图表.drawio' },
      { path: '验收/流程.drawio' },
    ])
    expect(await screen.findByRole('button', { name: '流程' })).toBeVisible()
    expect(screen.getByRole('button', { name: '验收' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('locates the open note in the directory tree', async () => {
    const nested: Note = { path: '项目/资料/纪要.md', title: '会议纪要', content: '# 纪要\n', metadata: { tags: ['重点'], group: '工作' }, revision: 'v2', modified: '2026-10-22T12:00:00Z' }
    await openApp(createServer([nested], ['项目/资料', '其他']))
    const locate = screen.getByRole('button', { name: '在目录中定位当前笔记' })
    expect(within(locate.parentElement!).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['在目录中定位当前笔记', '新建绘图', '新建文件夹'])
    expect(locate).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    fireEvent.click(screen.getByRole('button', { name: '资料' }))
    fireEvent.click(screen.getByRole('button', { name: '会议纪要' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '笔记源码' })).toHaveValue('# 纪要\n'))
    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    expect(screen.getByRole('button', { name: '项目' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '会议纪要' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '分组' }))
    fireEvent.click(screen.getAllByRole('button', { name: /^工作/ }).find(button => button.className.includes('group-heading'))!)
    fireEvent.change(screen.getByLabelText('搜索笔记'), { target: { value: '不存在' } })
    fireEvent.click(screen.getAllByRole('button', { name: '# 重点' }).find(button => button.className.includes('tag-filter'))!)
    const scroll = vi.fn()
    const previousScroll = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    try {
      fireEvent.click(locate)

      expect(screen.getByLabelText('搜索笔记')).toHaveValue('')
      expect(screen.getByRole('button', { name: '目录' })).toHaveClass('selected')
      expect(screen.getAllByRole('button', { name: '# 重点' }).find(button => button.className.includes('tag-filter'))).not.toHaveClass('active')
      expect(screen.getByRole('button', { name: '项目' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: '资料' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: '其他' })).toHaveAttribute('aria-expanded', 'false')
      const noteButton = screen.getByRole('button', { name: '会议纪要' })
      const row = noteButton.closest('.note-row')
      expect(noteButton).toBeVisible()
      expect(row).toHaveClass('is-located')
      expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'auto' })
      expect(scroll.mock.instances[0]).toBe(row)
    } finally {
      Element.prototype.scrollIntoView = previousScroll
    }
  })
})

describe('App note navigation', () => {
  it('toggles beside the editing tabs, follows live headings, and navigates duplicate titles by source line', async () => {
    const server = createServer()
    const editor = await openApp(server)
    const toggle = screen.getByRole('button', { name: '导航' })
    const fullscreen = screen.getByRole('button', { name: '全屏预览' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('tablist', { name: '编辑模式' }).nextElementSibling).toBe(fullscreen)
    expect(fullscreen.nextElementSibling).toBe(toggle)
    expect(screen.queryByRole('navigation', { name: '笔记导航' })).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '1 级标题：初始笔记' })).toBeInTheDocument()

    fireEvent.change(editor, { target: { value: '# 重复\n\n##### 重复\n\n###### 不收录' } })
    expect(screen.queryByRole('button', { name: '1 级标题：初始笔记' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /不收录/ })).not.toBeInTheDocument()
    const navigate = vi.fn()
    editor.addEventListener('echo:goto-line', navigate)
    fireEvent.click(screen.getByRole('button', { name: '5 级标题：重复' }))
    expect(navigate).toHaveBeenCalledOnce()
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toBe(3)
    expect(screen.getByRole('button', { name: '5 级标题：重复' })).toHaveAttribute('aria-current', 'location')

    fireEvent.click(screen.getByRole('tab', { name: '预览' }))
    expect(screen.getByRole('navigation', { name: '笔记导航' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭笔记导航' }))
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(screen.queryByRole('navigation', { name: '笔记导航' })).not.toBeInTheDocument()
  })

  it('previews the current note across the screen and returns focus when closed', async () => {
    await openApp(createServer())
    const fullscreen = screen.getByRole('button', { name: '全屏预览' })
    fireEvent.click(fullscreen)
    const preview = screen.getByRole('region', { name: '全屏预览' })
    expect(preview).toHaveTextContent('# 初始笔记')
    expect(within(preview).getByRole('heading', { name: '测试笔记' })).toBeInTheDocument()
    fireEvent.click(within(preview).getByRole('button', { name: '退出全屏' }))
    expect(screen.queryByRole('region', { name: '全屏预览' })).not.toBeInTheDocument()
    expect(fullscreen).toHaveFocus()
  })

  it('shows an empty state and switches to the headings of the newly opened note', async () => {
    const other: Note = { path: '另一篇.md', title: '另一篇笔记', content: '没有标题的正文', metadata: { tags: [], group: '' }, revision: 'other-v1', modified: '2026-10-22T12:00:00Z' }
    await openApp(createServer([other]))
    fireEvent.click(screen.getByRole('button', { name: '导航' }))
    fireEvent.click(screen.getByRole('button', { name: '1 级标题：初始笔记' }))
    fireEvent.click(screen.getByRole('button', { name: '另一篇笔记' }))
    await screen.findByText('暂无标题')
    expect(screen.queryByRole('button', { name: '1 级标题：初始笔记' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '笔记源码' }), { target: { value: '## 新标题' } })
    expect(screen.getByRole('button', { name: '2 级标题：新标题' })).not.toHaveAttribute('aria-current')
  })
})

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

  it('exports the active note as a Word document', async () => {
    await openApp(createServer())
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    fireEvent.click(screen.getByRole('button', { name: /Word 文档/ }))
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出笔记' })).not.toBeInTheDocument())
    expect(exportNotes).toHaveBeenCalledWith(expect.objectContaining({ paths: ['测试.md'], format: 'docx' }))
  })

  it.each(['导出', '导出所选'])('pins a different note despite bulk selections, then restores the %s entry', async entry => {
    const other: Note = { path: '归档/另一篇.md', title: '另一篇笔记', content: '# 另一篇\n', metadata: { tags: [], group: '' }, revision: 'other-v1', modified: '2026-10-22T12:00:00Z' }
    const server = createServer([other])
    const editor = await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
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

describe('App editor font settings', () => {
  it('previews the size across settings sections, restores the default and discards changes on cancel', async () => {
    const server = createServer()
    const editor = await openApp(server)
    expect(editor).toHaveStyle({ fontSize: '14px' })
    fireEvent.click(screen.getByRole('tab', { name: '预览' }))
    expect(screen.getByTestId('preview')).toBeVisible()
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '14px' })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    const slider = screen.getByRole('slider', { name: '默认字体大小' })
    expect(slider).toHaveValue('14')
    expect(slider).toHaveAttribute('min', '12')
    expect(slider).toHaveAttribute('max', '32')
    fireEvent.change(slider, { target: { value: '22' } })
    expect(editor).toHaveStyle({ fontSize: '22px' })
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '22px' })
    expect(screen.getByLabelText('编辑器字体预览')).toHaveStyle({ fontSize: '22px' })
    fireEvent.click(screen.getByRole('button', { name: '外观设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    expect(screen.getByRole('slider', { name: '默认字体大小' })).toHaveValue('22')
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(editor).toHaveStyle({ fontSize: '14px' })
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '14px' })
    fireEvent.change(screen.getByRole('slider', { name: '默认字体大小' }), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(editor).toHaveStyle({ fontSize: '14px' })
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '14px' })
    expect(editor).toHaveValue('# 初始笔记\n')
    expect(server.calls.some(call => call.path === '/api/settings' && call.method === 'PUT')).toBe(false)
  })

  it('persists the chosen size and restores it from the notebook settings after reload', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    fireEvent.change(screen.getByRole('slider', { name: '默认字体大小' }), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings().editorFontSize).toBe(20)
    fireEvent.click(screen.getByRole('tab', { name: '预览' }))
    expect(screen.getByTestId('preview')).toBeVisible()
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '20px' })
    expect(JSON.parse(localStorage.getItem('echo:settings')!).editorFontSize).toBe(20)
    cleanup()
    localStorage.removeItem('echo:settings')
    const editor = await openApp(server)
    expect(editor).toHaveStyle({ fontSize: '20px' })
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '20px' })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    expect(screen.getByRole('slider', { name: '默认字体大小' })).toHaveValue('20')
  })

  it('keeps a failed save editable and restores the persisted size when the dialog closes', async () => {
    const server = createServer()
    server.failNextSettings()
    const editor = await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    fireEvent.change(screen.getByRole('slider', { name: '默认字体大小' }), { target: { value: '24' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('设置写入失败')
    expect(editor).toHaveStyle({ fontSize: '24px' })
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '24px' })
    expect(server.savedSettings().editorFontSize).toBe(14)
    expect(JSON.parse(localStorage.getItem('echo:settings')!).editorFontSize).toBe(14)
    expect(screen.getByRole('slider', { name: '默认字体大小' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(editor).toHaveStyle({ fontSize: '14px' })
    expect(screen.getByTestId('preview')).toHaveStyle({ fontSize: '14px' })
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

  it('previews an interface style immediately, restores it on cancel, and persists the saved choice', async () => {
    const server = createServer()
    await openApp(server)
    expect(document.documentElement).toHaveAttribute('data-style', 'sage')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: /暖纸书写/ }))
    expect(document.documentElement).toHaveAttribute('data-style', 'paper')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a0714f')
    expect(screen.getByRole('button', { name: /暖纸书写/ })).toHaveAttribute('aria-pressed', 'true')
    expect(server.calls.filter(call => call.path === '/api/settings' && call.method === 'PUT')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.documentElement).toHaveAttribute('data-style', 'sage')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#72967b')

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: /黑白编辑/ }))
    fireEvent.click(screen.getByRole('button', { name: '暗黑' }))
    expect(document.documentElement).toHaveAttribute('data-style', 'mono')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#f4f4f4')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings()).toMatchObject({ uiStyle: 'mono', theme: 'dark', accent: '#f4f4f4' })
    expect(JSON.parse(localStorage.getItem('echo:settings')!)).toMatchObject({ uiStyle: 'mono', theme: 'dark', accent: '#f4f4f4' })

    cleanup()
    localStorage.removeItem('echo:settings')
    await openApp(server)
    expect(document.documentElement).toHaveAttribute('data-style', 'mono')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#f4f4f4')
  })

  it('previews the ink style and switches its accent between light and dark', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: /水墨东方/ }))
    expect(document.documentElement).toHaveAttribute('data-style', 'ink')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#b23a2b')
    expect(screen.getByRole('button', { name: /水墨东方/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '暗黑' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#d4584a')
    fireEvent.click(screen.getByRole('button', { name: '明亮' }))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#b23a2b')
    expect(server.calls.filter(call => call.path === '/api/settings' && call.method === 'PUT')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.documentElement).toHaveAttribute('data-style', 'sage')
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
    expect(await screen.findByTestId('plans-view')).toBeInTheDocument()
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
  it('edits the visible title in place and saves it as the first heading', async () => {
    const server = createServer()
    const editor = await openApp(server)
    expect(screen.queryByRole('textbox', { name: '笔记标题' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑标题' }))
    const input = screen.getByRole('textbox', { name: '笔记标题' })
    expect(input).toHaveValue('测试笔记')
    fireEvent.change(input, { target: { value: '  新的标题  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(editor).toHaveValue('# 新的标题\n')
    expect(screen.getByRole('heading', { name: '新的标题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新的标题' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '笔记标题' })).not.toBeInTheDocument()
    await waitFor(() => expect(server.current()).toMatchObject({ content: '# 新的标题\n', title: '新的标题', path: '测试.md' }))
    expect(server.writes).toHaveLength(1)
  })

  it('discards a blank or cancelled title edit without writing', async () => {
    const server = createServer()
    const editor = await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '编辑标题' }))
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: '不要保存' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '笔记标题' }), { key: 'Escape' })
    expect(screen.getByRole('heading', { name: '测试笔记' })).toBeInTheDocument()
    expect(editor).toHaveValue('# 初始笔记\n')

    fireEvent.click(screen.getByRole('button', { name: '编辑标题' }))
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: '   ' } })
    fireEvent.blur(screen.getByRole('textbox', { name: '笔记标题' }))
    expect(screen.getByRole('heading', { name: '测试笔记' })).toBeInTheDocument()
    expect(server.writes).toHaveLength(0)
  })

  it('saves the title when the inline editor loses focus', async () => {
    const server = createServer()
    const editor = await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '编辑标题' }))
    fireEvent.change(screen.getByRole('textbox', { name: '笔记标题' }), { target: { value: '失焦保存' } })
    fireEvent.blur(screen.getByRole('textbox', { name: '笔记标题' }))
    expect(editor).toHaveValue('# 失焦保存\n')
    await waitFor(() => expect(server.current()).toMatchObject({ content: '# 失焦保存\n', title: '失焦保存' }))
  })

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

describe('editor shortcut settings', () => {
  it('records a custom shortcut and saves only the override', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '快捷键设置' }))
    const bold = () => screen.getByText('加粗').closest('.shortcut-row') as HTMLElement
    expect(within(bold()).getByText('B')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '禁用加粗快捷键' }))
    expect(within(bold()).getByText('未设置')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复加粗默认快捷键' }))
    expect(within(bold()).getByText('B')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '修改加粗快捷键' }))
    expect(screen.getByRole('status')).toHaveTextContent('请按下新的快捷键，Esc 取消')
    const shortcut = keyFromEvent(new KeyboardEvent('keydown', { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }))
    fireEvent.keyDown(window, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })
    expect(shortcut).toMatch(/Shift-b$/)
    expect(within(bold()).getByText('Shift')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings().shortcuts).toEqual({ bold: shortcut })
  })

  it('rejects reserved shortcuts and disables the action that already owns a key', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '快捷键设置' }))
    fireEvent.click(screen.getByRole('button', { name: '修改加粗快捷键' }))
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('已被“保存”占用')
    expect(screen.getByRole('button', { name: '取消修改加粗快捷键' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'i', code: 'KeyI', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: '禁用并继续' }))
    expect(screen.getByText('斜体').closest('.shortcut-row')).toHaveTextContent('未设置')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    const italic = keyFromEvent(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true }))
    expect(server.savedSettings().shortcuts).toEqual({ bold: italic, italic: '' })
    expect(server.calls.filter(call => call.path === '/api/settings' && call.method === 'PUT')).toHaveLength(1)
  })
})

describe('source split preview', () => {
  it('shows a live preview beside the source editor after the setting is saved', async () => {
    const server = createServer()
    const editor = await openApp(server)
    expect(screen.getByRole('tab', { name: /源码/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('preview')).not.toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    expect(screen.getByText('源码模式左侧编辑，右侧实时显示 Markdown。预览标签仍为整页预览。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '源码模式分栏预览' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings().sourceSplitPreview).toBe(true)
    expect(editor).toBeVisible()
    expect(screen.getByTestId('preview')).toBeVisible()
    expect(screen.getByTestId('preview').closest('.note-content')).toHaveClass('split-preview')
    fireEvent.change(editor, { target: { value: '# 分栏标题\n实时内容' } })
    expect(screen.getByTestId('preview')).toHaveTextContent('实时内容')
    fireEvent.click(screen.getByRole('tab', { name: '预览' }))
    expect(editor).not.toBeVisible()
    expect(screen.getByTestId('preview')).toBeVisible()
    expect(screen.getByTestId('preview').closest('.note-content')).not.toHaveClass('split-preview')
  })

  it('saves strict line breaks from note settings', async () => {
    const server = createServer()
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    const toggle = screen.getByRole('switch', { name: '严格换行模式' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('开启后，预览里的一次换行就会换行。关闭时仍按 Markdown 默认规则，单次换行保持在同一段中。')).toBeInTheDocument()
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings().strictLineBreaks).toBe(true)
    expect(screen.getByTestId('preview')).toHaveAttribute('data-strict-breaks', 'true')
  })

  it('saves a wider preview column from the note width tabs', async () => {
    const server = createServer()
    await openApp(server)
    expect(document.documentElement).toHaveAttribute('data-note-width', 'default')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    const widths = screen.getByRole('tablist', { name: '笔记宽度' })
    expect(within(widths).getByRole('tab', { name: '默认' })).toHaveAttribute('aria-selected', 'true')
    expect(within(widths).getByRole('tab', { name: '中' })).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(within(widths).getByRole('tab', { name: '大' }))
    expect(within(widths).getByRole('tab', { name: '大' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument())
    expect(server.savedSettings().noteWidth).toBe('large')
    expect(document.documentElement).toHaveAttribute('data-note-width', 'large')
  })
})

function sampleNote(path: string, content: string): Note {
  return { path, title: path.split('/').pop()!.replace(/\.md$/i, ''), content, metadata: { tags: [], group: '' }, revision: 'v1', modified: '2026-10-22T12:00:00Z' }
}
function named(name: string) { return (value: string) => value === name }
function openTabs() { return within(screen.getByRole('tablist', { name: '已打开的笔记' })) }

describe('multi-note tabs', () => {
  it('shows a tab for the current note after the setting is enabled', async () => {
    const server = createServer()
    await openApp(server)
    expect(screen.queryByRole('tablist', { name: '已打开的笔记' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '笔记设置' }))
    expect(screen.getByText('同时打开多篇笔记，最多 10 个，超出时自动关闭最早打开的。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '多笔记 Tab' }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    const tabs = within(await screen.findByRole('tablist', { name: '已打开的笔记' }))
    expect(tabs.getByRole('tab', { name: '测试' })).toHaveAttribute('aria-selected', 'true')
    expect(server.savedSettings().multiTabs).toBe(true)
  })

  it('keeps at most 10 tabs and drops the earliest one', async () => {
    const extras = Array.from({ length: 10 }, (_, index) => sampleNote(`笔记${String(index + 2).padStart(2, '0')}.md`, `# ${index + 2}\n`))
    const server = createServer(extras, [], { multiTabs: true })
    await openApp(server)
    for (const item of extras) {
      fireEvent.click(screen.getByRole('button', { name: named(item.title) }))
      expect(await screen.findByRole('heading', { name: item.title })).toBeInTheDocument()
    }
    const tabs = openTabs()
    expect(tabs.getAllByRole('tab')).toHaveLength(10)
    expect(tabs.queryByRole('tab', { name: '测试笔记' })).not.toBeInTheDocument()
    expect(tabs.getByRole('tab', { name: '笔记02' })).toBeInTheDocument()
    expect(tabs.getByRole('tab', { name: '笔记11' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(JSON.parse(localStorage.getItem('echo:tabs') || '[]')).toEqual(extras.map(item => item.path)))
  })

  it('does not open a second tab for a note that is already open', async () => {
    const server = createServer([sampleNote('另一篇.md', '# 另一篇\n')], [], { multiTabs: true })
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: named('另一篇') }))
    expect(await screen.findByRole('heading', { name: '另一篇' })).toBeInTheDocument()
    expect(openTabs().getAllByRole('tab')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: named('另一篇') }))
    await waitFor(() => expect(server.calls.filter(call => call.method === 'GET' && call.path === '/api/notes')).toHaveLength(4))
    expect(openTabs().getAllByRole('tab')).toHaveLength(2)
    expect(openTabs().getAllByRole('tab').map(tab => tab.textContent)).toEqual(['测试', '另一篇'])
  })

  it('activates the neighboring tab when the current tab is closed', async () => {
    const server = createServer([sampleNote('另一篇.md', '# 另一篇\n')], [], { multiTabs: true })
    await openApp(server)
    fireEvent.click(screen.getByRole('button', { name: named('另一篇') }))
    expect(await screen.findByRole('heading', { name: '另一篇' })).toBeInTheDocument()
    fireEvent.click(openTabs().getByRole('tab', { name: '测试' }))
    expect(await screen.findByRole('heading', { name: '测试笔记' })).toBeInTheDocument()
    fireEvent.click(openTabs().getByRole('button', { name: '关闭 测试' }))
    expect(await screen.findByRole('heading', { name: '另一篇' })).toBeInTheDocument()
    const tabs = openTabs()
    expect(tabs.getAllByRole('tab')).toHaveLength(1)
    expect(tabs.getByRole('tab', { name: '另一篇' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '笔记源码' })).toHaveValue('# 另一篇\n')
  })

  it('restores saved tabs and drops notes that no longer exist', async () => {
    localStorage.setItem('echo:tabs', JSON.stringify(['缺失.md', '另一篇.md', '测试.md']))
    localStorage.setItem('echo:last-note', '另一篇.md')
    const server = createServer([sampleNote('另一篇.md', '# 另一篇\n')], [], { multiTabs: true })
    vi.stubGlobal('fetch', server.fetch)
    render(<App />)
    expect(await screen.findByRole('textbox', { name: '笔记源码' })).toHaveValue('# 另一篇\n')
    const tabs = openTabs()
    expect(tabs.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['另一篇', '测试'])
    expect(tabs.getByRole('tab', { name: '另一篇' })).toHaveAttribute('aria-selected', 'true')
    expect(tabs.queryByRole('tab', { name: '缺失' })).not.toBeInTheDocument()
  })
})

describe('repository switcher', () => {
  function stubReload() {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload, href: 'http://localhost/' })
    return reload
  }

  it('lists the current repository first and renames, removes, or switches another', async () => {
    const server = createServer()
    const editor = await openApp(server)
    localStorage.setItem('echo:last-note', '测试.md')
    localStorage.setItem('echo:tabs', JSON.stringify(['测试.md']))
    localStorage.setItem('echo:draft:测试.md', JSON.stringify({ content: '# 草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '切换仓库' }))
    const dialog = await screen.findByRole('dialog', { name: '切换仓库' })
    expect(dialog).toHaveTextContent('本地笔记')
    expect(dialog).toHaveTextContent('当前')
    expect(dialog).toHaveTextContent('D:\\EchoNotes')
    expect(dialog).toHaveTextContent('归档')
    expect(dialog).toHaveTextContent('D:\\Archive')
    expect(within(dialog).queryByRole('button', { name: '移除仓库 本地笔记' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '编辑仓库名称 归档' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: '仓库名称' }), { target: { value: '资料库' } })
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: '仓库名称' }), { key: 'Enter' })
    expect(await within(dialog).findByRole('button', { name: '切换到 资料库' })).toBeInTheDocument()
    expect(server.calls.some(call => call.method === 'PUT' && call.path === '/api/repositories' && (call.body as { name?: string }).name === '资料库')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '移除仓库 资料库' }))
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: '切换到 资料库' })).not.toBeInTheDocument())
    expect(server.calls.some(call => call.method === 'DELETE' && call.path === '/api/repositories')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
    const reload = stubReload()
    fireEvent.click(screen.getByRole('button', { name: '切换仓库' }))
    const reopened = await screen.findByRole('dialog', { name: '切换仓库' })
    expect(within(reopened).queryByText('资料库')).not.toBeInTheDocument()
    fireEvent.change(editor, { target: { value: '# 切换前\n' } })
    fireEvent.click(within(reopened).getByRole('button', { name: '新增仓库' }))
    await waitFor(() => expect(server.calls.some(call => call.path === '/api/repositories/pick')).toBe(true))
    expect(reload).not.toHaveBeenCalled()
    server.queuePick('D:\\Fresh')
    fireEvent.click(within(reopened).getByRole('button', { name: '新增仓库' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    const pickAt = server.calls.findIndex(call => call.path === '/api/repositories/pick')
    const saveAt = server.calls.findIndex(call => call.method === 'PUT' && call.path === '/api/notes' && (call.body as { content?: string }).content === '# 切换前\n')
    expect(saveAt).toBeGreaterThanOrEqual(0)
    expect(pickAt).toBeGreaterThan(saveAt)
    expect(localStorage.getItem('echo:last-note')).toBeNull()
    expect(localStorage.getItem('echo:tabs')).toBeNull()
    expect(localStorage.getItem('echo:draft:测试.md')).toBeNull()
    expect(localStorage.getItem('echo:settings')).not.toBeNull()
  })

  it('saves the open note before switching to another repository', async () => {
    const server = createServer()
    const editor = await openApp(server)
    localStorage.setItem('echo:last-note', '测试.md')
    localStorage.setItem('echo:tabs', JSON.stringify(['测试.md']))
    localStorage.setItem('echo:draft:测试.md', '{"content":"# 草稿"}')
    const reload = stubReload()
    fireEvent.click(screen.getByRole('button', { name: '切换仓库' }))
    const dialog = await screen.findByRole('dialog', { name: '切换仓库' })
    fireEvent.change(editor, { target: { value: '# 切换前\n' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '切换到 归档' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    const switchAt = server.calls.findIndex(call => call.path === '/api/repositories/switch')
    const saveAt = server.calls.findIndex(call => call.method === 'PUT' && call.path === '/api/notes' && (call.body as { content?: string }).content === '# 切换前\n')
    expect(saveAt).toBeGreaterThanOrEqual(0)
    expect(switchAt).toBeGreaterThan(saveAt)
    expect((server.calls[switchAt].body as { path: string }).path).toBe('D:\\Archive')
    expect(localStorage.getItem('echo:last-note')).toBeNull()
    expect(localStorage.getItem('echo:tabs')).toBeNull()
    expect(localStorage.getItem('echo:draft:测试.md')).toBeNull()
    expect(localStorage.getItem('echo:settings')).not.toBeNull()
  })

  it('reloads when another window switches the repository', async () => {
    let source: { onmessage: ((event: MessageEvent) => void) | null } | undefined
    vi.stubGlobal('EventSource', class {
      onmessage: ((event: MessageEvent) => void) | null = null
      addEventListener() {}
      close() {}
      constructor() { source = this }
    })
    const server = createServer()
    await openApp(server)
    localStorage.setItem('echo:draft:测试.md', '{"content":"# 另一窗口"}')
    const reload = stubReload()
    source?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'switched' }) }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(localStorage.getItem('echo:draft:测试.md')).toBeNull()
    expect(server.calls.some(call => call.method === 'PUT' && call.path === '/api/notes')).toBe(false)
  })
})
