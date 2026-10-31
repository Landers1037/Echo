import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageDownloadName } from './ImagePreview'
import { clearLinkPreviews } from './LinkCard'
import { MarkdownView, resolveNotePath } from './MarkdownView'

const { initializeMermaid, renderMermaid } = vi.hoisted(() => ({
  initializeMermaid: vi.fn(),
  renderMermaid: vi.fn(async (id: string, code: string) => {
    if (code.includes('BAD')) throw new Error('Parse error on line 1')
    return { svg: `<svg class="diagram" id="${id}"><defs><marker id="arrow"/></defs><path marker-end="url(#arrow)"/></svg>` }
  }),
}))

vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre class="shiki"><code><span class="line">${code.replace(/</g, '&lt;')}</span></code></pre>` }))
vi.mock('mermaid', () => ({ default: { initialize: initializeMermaid, render: (id: string, code: string) => renderMermaid(id, code) } }))
vi.mock('./Drawing', () => ({ DrawingEmbed: ({ path, onEdit }: { path: string; onEdit?: (path: string) => void }) => <button type="button" onClick={() => onEdit?.(path)}>{path}</button> }))
vi.mock('./Drawio', () => ({ DrawioEmbed: ({ path, onEdit }: { path: string; onEdit?: (path: string) => void }) => <button type="button" onClick={() => onEdit?.(path)}>{path}</button> }))
afterEach(() => { cleanup(); clearLinkPreviews(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Markdown rendering', () => {
  it('marks each navigable heading with its source line and keeps exports free of navigation attributes', () => {
    const content = '---\ntitle: 示例\n---\n# 重复\n\n## 重复\n\n##### 五级\n\n###### 六级\n'
    const { container, rerender } = render(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} />)
    expect([...container.querySelectorAll('[data-heading-line]')].map(heading => [heading.tagName, heading.getAttribute('data-heading-line')])).toEqual([['H1', '4'], ['H2', '6'], ['H5', '8']])
    expect(screen.getByRole('heading', { name: '六级' })).not.toHaveAttribute('data-heading-line')
    const heading = container.querySelector('h1')!
    heading.focus()
    rerender(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} fontSize={20} />)
    expect(heading).toHaveFocus()
    expect(container.querySelector('.markdown-body')).toHaveStyle({ fontSize: '20px' })
    rerender(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} fontSize={20} exporting />)
    expect(container.querySelector('[data-heading-line]')).toBeNull()
    expect(container.querySelector('[data-source-line]')).toBeNull()
    expect(container.querySelector('h1')).not.toHaveAttribute('tabindex')
    expect(container.querySelector<HTMLElement>('.markdown-body')!.style.fontSize).toBe('')
  })

  it('keeps task source line numbers with frontmatter and fenced examples', async () => {
    const toggle = vi.fn()
    const content = '---\necho:\n  tags: [工作]\n---\n# 笔记\n\n```markdown\n- [ ] 示例\n```\n\n- [ ] 真正的任务 <!-- echo-task: {"id":"a"} -->\n  - [x] 子任务\n'
    const { container } = render(<MarkdownView content={content} notePath="笔记.md" lineNumbers onToggleTask={toggle} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    fireEvent.click(checkboxes[0])
    expect(toggle).toHaveBeenCalledWith(11, true)
    fireEvent.click(checkboxes[1])
    expect(toggle).toHaveBeenCalledWith(12, false)
    expect(container).not.toHaveTextContent('echo-task')
    expect(container).not.toHaveTextContent('tags:')
    await waitFor(() => expect(container.querySelector('[data-rendering]')).toBeNull())
  })

  it('resolves local images relative to each note and supports embedded export resources', () => {
    const { rerender } = render(<MarkdownView content="![照片](../.assets/a.png)" notePath="项目/记录.md" lineNumbers={false} />)
    expect(screen.getByAltText('照片')).toHaveAttribute('src', '/api/assets?path=.assets%2Fa.png')
    rerender(<MarkdownView content="![照片](../.assets/a.png)" notePath="项目/记录.md" assets={{ '../.assets/a.png': 'data:image/png;base64,abc' }} lineNumbers={false} exporting />)
    expect(screen.getByAltText('照片')).toHaveAttribute('src', 'data:image/png;base64,abc')
  })

  it('renders paired underline tags and still strips every other html tag', () => {
    const { container, rerender } = render(<MarkdownView content={'普通 <u>下划线</u> 文字\n\n**<u>重点</u>**\n\n前文 <u>没有结束\n\n<u onclick="alert(1)">危险</u>\n\n<script>alert(1)</script>'} notePath="笔记.md" lineNumbers={false} />)
    expect([...container.querySelectorAll('u')].map(node => node.textContent)).toEqual(['下划线', '重点'])
    expect(container.querySelector('strong u')).toHaveTextContent('重点')
    expect(container).toHaveTextContent('没有结束')
    expect(container.querySelector('[onclick]')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('alert')
    rerender(<MarkdownView content="<u>导出</u>" notePath="笔记.md" lineNumbers={false} exporting />)
    expect(container.querySelector('u')).toHaveTextContent('导出')
  })

  it('renders GFM tables and prevents executable source HTML', () => {
    const { container } = render(<MarkdownView content={'| 名称 | 数量 |\n| --- | --- |\n| 示例 | 2 |\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))'} notePath="test.md" lineNumbers={false} />)
    expect(screen.getByRole('table')).toHaveTextContent('示例')
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('危险链接')).not.toHaveAttribute('href', 'javascript:alert(1)')
  })

  it('renders excalidraw references as drawings and embeds them when exporting', () => {
    const edit = vi.fn()
    const { rerender } = render(<MarkdownView content="![架构](../.assets/a.excalidraw)" notePath="项目/记录.md" lineNumbers={false} onEditDrawing={edit} />)
    fireEvent.click(screen.getByRole('button', { name: '.assets/a.excalidraw' }))
    expect(edit).toHaveBeenCalledWith('.assets/a.excalidraw')
    rerender(<MarkdownView content="![架构](../.assets/a.excalidraw)" notePath="项目/记录.md" assets={{ '../.assets/a.excalidraw': 'data:application/vnd.excalidraw+json;base64,abc' }} lineNumbers={false} exporting />)
    expect(screen.getByRole('button', { name: 'data:application/vnd.excalidraw+json;base64,abc' })).toBeInTheDocument()
    rerender(<MarkdownView content="![架构](../.assets/missing.excalidraw)" notePath="项目/记录.md" lineNumbers={false} exporting />)
    expect(screen.getByText('[绘图缺失：架构]')).toBeInTheDocument()
  })

  it('renders draw.io references and embeds them when exporting', () => {
    const edit = vi.fn()
    const { rerender } = render(<MarkdownView content="![流程](../图表/流程.drawio)" notePath="项目/记录.md" lineNumbers={false} onEditDrawing={edit} />)
    fireEvent.click(screen.getByRole('button', { name: '图表/流程.drawio' }))
    expect(edit).toHaveBeenCalledWith('图表/流程.drawio')
    rerender(<MarkdownView content="![流程](../图表/流程.drawio)" notePath="项目/记录.md" assets={{ '../图表/流程.drawio': 'data:application/vnd.jgraph.mxfile;base64,abc' }} lineNumbers={false} exporting />)
    expect(screen.getByRole('button', { name: 'data:application/vnd.jgraph.mxfile;base64,abc' })).toBeInTheDocument()
    rerender(<MarkdownView content="![流程](../图表/missing.drawio)" notePath="项目/记录.md" lineNumbers={false} exporting />)
    expect(screen.getByText('[绘图缺失：流程]')).toBeInTheDocument()
  })

  it('renders mermaid diagrams in the active theme and uses the light theme while exporting', async () => {
    const diagram = '```mermaid\ngraph LR\nA-->B\n```'
    const { container } = render(<MarkdownView content={diagram} notePath="笔记.md" lineNumbers={false} dark />)
    expect(container.querySelector('.mermaid-block')).toHaveAttribute('data-rendering', 'true')
    await waitFor(() => expect(container.querySelector('.mermaid-block svg')).toBeInTheDocument())
    expect(container.querySelector('[data-rendering]')).toBeNull()
    expect(initializeMermaid).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' }))

    initializeMermaid.mockClear()
    const exported = render(<MarkdownView content={'```mermaid\ngraph TD\nC-->D\n```'} notePath="笔记.md" lineNumbers={false} dark exporting />)
    await waitFor(() => expect(exported.container.querySelector('.mermaid-block svg')).toBeInTheDocument())
    expect(initializeMermaid).toHaveBeenCalledWith(expect.objectContaining({ theme: 'default' }))
  })

  it('opens a mermaid diagram preview with zoom and download', async () => {
    const downloads: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this) })
    try {
      const { rerender } = render(<MarkdownView content={'```mermaid\ngraph LR\nA-->B\n```'} notePath="笔记.md" lineNumbers={false} />)
      const opener = await screen.findByRole('button', { name: '预览图表' })
      fireEvent.click(opener)
      const dialog = screen.getByRole('dialog', { name: '图表预览' })
      const inlineId = opener.querySelector('svg')?.id
      const previewId = dialog.querySelector('.diagram-preview svg')?.id
      expect(inlineId).toBeTruthy()
      expect(previewId).toBeTruthy()
      expect(previewId).not.toBe(inlineId)
      expect(opener.innerHTML).toContain('url(#arrow)')
      expect(opener.innerHTML).not.toContain('arrow-preview')
      expect(dialog.querySelector('.diagram-preview svg')?.innerHTML).toMatch(/url\(#arrow-preview\d+\)/)
      expect(within(dialog).queryByRole('button', { name: '复制图片' })).not.toBeInTheDocument()
      fireEvent.click(within(dialog).getByRole('button', { name: '放大' }))
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('125%')
      fireEvent.click(within(dialog).getByRole('button', { name: '缩小' }))
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('100%')
      fireEvent.keyDown(document, { key: '+' })
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('125%')
      fireEvent.click(within(dialog).getByRole('button', { name: '下载图表' }))
      await waitFor(() => expect(downloads).toHaveLength(1))
      expect(downloads[0].download).toBe('图表.svg')
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      rerender(<MarkdownView content={'```mermaid\ngraph LR\nA-->B\n```'} notePath="笔记.md" lineNumbers={false} exporting />)
      expect(screen.queryByRole('button', { name: '预览图表' })).not.toBeInTheDocument()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('falls back to the source block when a mermaid diagram cannot be rendered', async () => {
    const { container } = render(<MarkdownView content={'```mermaid\nBAD\n```'} notePath="笔记.md" lineNumbers={false} />)
    await waitFor(() => expect(container.querySelector('.mermaid-error')).toHaveTextContent('Parse error on line 1'))
    expect(container.querySelector('.code-block')).toHaveTextContent('BAD')
    expect(container.querySelector('.mermaid-block')).toBeNull()
    await waitFor(() => expect(container.querySelector('[data-rendering]')).toBeNull())
  })

  it('keeps highlighted code mounted across unrelated parent rerenders', async () => {
    const content = '```ts\nconst n = 1\n```'
    const { container, rerender } = render(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} noteTitles={{ 'a.md': '甲' }} />)
    await waitFor(() => expect(container.querySelector('.code-highlight')).toBeInTheDocument())
    const highlight = container.querySelector('.code-highlight')
    rerender(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} noteTitles={{ 'a.md': '甲', 'b.md': '乙' }} />)
    expect(container.querySelector('.code-highlight')).toBe(highlight)
    expect(container.querySelector('[data-rendering]')).toBeNull()
  })

  it('turns a single newline into a line break only in strict mode, including emphasis and code blocks', () => {
    const content = '飒飒撒**重点**\n111\n\n```\n丙\n丁\n```'
    const { container, rerender } = render(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} />)
    const paragraph = container.querySelector('p')
    expect(paragraph?.querySelector('br')).toBeNull()
    expect(paragraph).toHaveTextContent('飒飒撒重点')
    expect(paragraph).toHaveTextContent('111')
    expect(container.querySelector('.code-block')).toHaveTextContent('丙')
    expect(container.querySelector('.code-block')).toHaveTextContent('丁')
    rerender(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} strictLineBreaks />)
    expect(container.querySelector('p strong')).toHaveTextContent('重点')
    expect(container.querySelector('p')?.innerHTML).toMatch(/重点[\s\S]*<br\s*\/?>[\s\S]*111/)
    expect(container.querySelector('.code-block br')).toBeNull()
    expect(container.querySelector('.code-block')).toHaveTextContent('丙')
    expect(container.querySelector('.code-block')).toHaveTextContent('丁')
  })

  it('opens an image preview with zoom, copy, and download', async () => {
    const write = vi.fn(async (items: Array<{ data: Record<string, Blob | Promise<Blob>> }>) => {
      const blob = await items[0].data['image/png']
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.type).toBe('image/png')
    })
    const fetchMock = vi.fn(async () => ({ ok: true, headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'image/png' : null }, blob: async () => new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' }) }))
    const createObjectURL = vi.fn(() => 'blob:preview')
    const revokeObjectURL = vi.fn()
    const previousCreate = URL.createObjectURL
    const previousRevoke = URL.revokeObjectURL
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Blob | Promise<Blob>>) {} })
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
    const downloads: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this) })
    try {
      render(<MarkdownView content={'![照片](../.assets/a.png)\n\n![封面](../.assets/b.jpg)'} notePath="项目/记录.md" lineNumbers={false} />)
      fireEvent.click(screen.getByRole('button', { name: '预览图片：照片' }))
      const dialog = screen.getByRole('dialog', { name: '图片预览：照片' })
      expect(within(dialog).getByRole('img', { name: '照片' })).toHaveAttribute('src', '/api/assets?path=.assets%2Fa.png')
      expect(dialog).toHaveTextContent('a.png')

      fireEvent.click(within(dialog).getByRole('button', { name: '放大' }))
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('125%')
      fireEvent.click(within(dialog).getByRole('button', { name: '缩小' }))
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('100%')
      fireEvent.wheel(dialog, { deltaY: -100 })
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('125%')
      fireEvent.click(within(dialog).getByRole('button', { name: /重置缩放/ }))
      fireEvent.keyDown(document, { key: '+' })
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('125%')
      fireEvent.keyDown(document, { key: '0' })
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('100%')
      fireEvent.doubleClick(within(dialog).getByRole('img', { name: '照片' }))
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('200%')
      fireEvent.doubleClick(within(dialog).getByRole('img', { name: '照片' }))
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('100%')

      const zoomIn = within(dialog).getByRole('button', { name: '放大' })
      for (let count = 0; count < 8; count++) fireEvent.click(zoomIn)
      expect(zoomIn).toBeDisabled()
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('400%')
      fireEvent.click(within(dialog).getByRole('button', { name: /重置缩放/ }))
      const zoomOut = within(dialog).getByRole('button', { name: '缩小' })
      for (let count = 0; count < 8; count++) fireEvent.click(zoomOut)
      expect(zoomOut).toBeDisabled()
      expect(within(dialog).getByRole('button', { name: /重置缩放/ })).toHaveTextContent('25%')
      fireEvent.click(within(dialog).getByRole('button', { name: /重置缩放/ }))
      fireEvent.click(zoomIn)

      const photo = within(dialog).getByRole('img', { name: '照片' })
      fireEvent.mouseDown(photo, { button: 0, clientX: 10, clientY: 12 })
      fireEvent.mouseMove(photo, { clientX: 46, clientY: 30 })
      fireEvent.mouseUp(photo, { button: 0, clientX: 46, clientY: 30 })
      expect(photo.getAttribute('style')).toContain('translate(36px, 18px)')
      expect(photo.getAttribute('style')).toContain('scale(1.25)')

      fireEvent.click(within(dialog).getByRole('button', { name: '复制图片' }))
      expect(await within(dialog).findByRole('status')).toHaveTextContent('已复制图片')
      expect(write).toHaveBeenCalledOnce()
      fireEvent.click(within(dialog).getByRole('button', { name: '下载图片' }))
      await waitFor(() => expect(downloads).toHaveLength(1))
      expect(downloads[0].download).toBe('a.png')
      expect(downloads[0].href).toContain('blob:preview')
      expect(createObjectURL).toHaveBeenCalledOnce()

      fireEvent.click(within(dialog).getByRole('img', { name: '照片' }))
      expect(dialog).toBeInTheDocument()
      fireEvent.click(dialog.querySelector('.image-preview-stage')!)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '预览图片：封面' }))
      const cover = screen.getByRole('dialog', { name: '图片预览：封面' })
      expect(within(cover).getByRole('img', { name: '封面' })).toHaveAttribute('src', '/api/assets?path=.assets%2Fb.jpg')
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    } finally {
      if (previousCreate) URL.createObjectURL = previousCreate
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (previousRevoke) URL.revokeObjectURL = previousRevoke
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('keeps broken images and exports static, and does not navigate away from an image link', () => {
    const { rerender } = render(<MarkdownView content="[![照片](../.assets/a.png)](https://example.com/page)" notePath="项目/记录.md" lineNumbers={false} />)
    const image = screen.getByRole('button', { name: '预览图片：照片' })
    expect(fireEvent.click(image)).toBe(false)
    expect(screen.getByRole('dialog', { name: '图片预览：照片' })).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/page')
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }))

    fireEvent.error(image)
    fireEvent.click(image)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    rerender(<MarkdownView content="![照片](https://example.com/a.png)" notePath="项目/记录.md" lineNumbers={false} exporting />)
    expect(screen.getByAltText('照片')).not.toHaveAttribute('role')
    expect(screen.queryByRole('button', { name: '预览图片：照片' })).not.toBeInTheDocument()
  })

  it('reports when a remote image cannot be copied or downloaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Blob | Promise<Blob>>) {} })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: vi.fn(async (items: Array<{ data: Record<string, Promise<Blob>> }>) => { await items[0].data['image/png'] }) } })
    const downloads: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this) })
    try {
      render(<MarkdownView content="![猫](https://example.com/pics/cat.jpg)" notePath="笔记.md" lineNumbers={false} />)
      fireEvent.click(screen.getByRole('button', { name: '预览图片：猫' }))
      const dialog = screen.getByRole('dialog', { name: '图片预览：猫' })
      fireEvent.click(within(dialog).getByRole('button', { name: '复制图片' }))
      expect(await within(dialog).findByRole('status')).toHaveTextContent('无法复制这张图片')
      fireEvent.click(within(dialog).getByRole('button', { name: '下载图片' }))
      expect(await within(dialog).findByRole('status')).toHaveTextContent('无法下载这张图片')
      expect(downloads).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('falls back to the original address when a local image cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const downloads: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this) })
    try {
      render(<MarkdownView content="![照片](../.assets/a.png)" notePath="项目/记录.md" lineNumbers={false} />)
      fireEvent.click(screen.getByRole('button', { name: '预览图片：照片' }))
      fireEvent.click(screen.getByRole('button', { name: '下载图片' }))
      await waitFor(() => expect(downloads).toHaveLength(1))
      expect(downloads[0].download).toBe('a.png')
      expect(downloads[0].href).toContain('/api/assets?path=.assets%2Fa.png')
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it('names downloads from the asset path, remote file, or image description', () => {
    expect(imageDownloadName('/api/assets?path=.assets%2F%E7%85%A7%E7%89%87.png', '别名')).toBe('照片.png')
    expect(imageDownloadName('https://example.com/pics/cat.jpg?x=1', '猫')).toBe('cat.jpg')
    expect(imageDownloadName('data:image/png;base64,abc', '封面')).toBe('封面.png')
    expect(imageDownloadName('https://example.com/download', '')).toBe('图片.png')
  })

  it('renders a note reference as a card and opens it from the marker', () => {
    const navigate = vi.fn()
    const content = '[旧标题](../文档/介绍.md "echo-ref")\n\n[普通链接](other.md "see")\n\n[缺失](gone.md "echo-ref")'
    const { container, rerender } = render(<MarkdownView content={content} notePath="项目/记录.md" lineNumbers={false} noteTitles={{ '文档/介绍.md': '介绍' }} onNavigate={navigate} />)
    expect(screen.getByRole('button', { name: '介绍' })).toBeInTheDocument()
    expect(container.querySelector('.note-ref.missing')).toHaveTextContent('gone')
    expect(container.querySelector('.note-ref.missing')).toHaveAttribute('title', '笔记不存在')
    expect(screen.getByRole('link', { name: '普通链接' })).toHaveAttribute('href', 'other.md')
    fireEvent.click(screen.getAllByRole('button', { name: '打开引用的笔记' })[0])
    expect(navigate).toHaveBeenCalledWith('文档/介绍.md')
    fireEvent.click(screen.getByRole('button', { name: '介绍' }))
    expect(navigate).toHaveBeenLastCalledWith('文档/介绍.md')
    rerender(<MarkdownView content={'[旧标题](介绍.md "echo-ref")'} notePath="项目/记录.md" lineNumbers={false} noteTitles={{ '项目/介绍.md': '介绍' }} exporting />)
    expect(screen.queryByRole('button', { name: '打开引用的笔记' })).toBeNull()
    expect(container.querySelector('.note-ref-title')).toHaveTextContent('介绍')
  })

  it('opens internal Markdown links through the note navigator', () => {
    const navigate = vi.fn()
    render(<MarkdownView content="[另一篇](../文档/介绍.md#标题)" notePath="项目/记录.md" lineNumbers={false} onNavigate={navigate} />)
    fireEvent.click(screen.getByRole('link'))
    expect(navigate).toHaveBeenCalledWith('文档/介绍.md')
    expect(resolveNotePath('项目/记录.md', '../.assets/图片%20一.png')).toBe('.assets/图片 一.png')
  })

  it('anchors preview blocks to their source line and can host an annotation layer', () => {
    const content = '段落一\n\n> 引用\n\n- 列表项\n\n| 名称 |\n| --- |\n| 值 |\n\n```ts\nconst a = 1\n```\n'
    const { container, rerender } = render(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} annotations={<i>标记</i>} />)
    expect(container.querySelector('p')?.getAttribute('data-source-line')).toBe('1')
    expect(container.querySelector('blockquote')?.getAttribute('data-source-line')).toBe('3')
    expect(container.querySelector('li')?.getAttribute('data-source-line')).toBe('5')
    expect(container.querySelector('.markdown-table-wrap')?.getAttribute('data-source-line')).toBe('7')
    expect(container.querySelector('.code-block')?.getAttribute('data-source-line')).toBe('11')
    expect(screen.getByText('标记')).toBeInTheDocument()
    rerender(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} exporting annotations={<i>标记</i>} />)
    expect(container.querySelector('[data-source-line]')).toBeNull()
    expect(screen.queryByText('标记')).not.toBeInTheDocument()
  })

  it('keeps the text link until automatic link cards are enabled', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<MarkdownView content="[卧室](https://renj.io)." notePath="笔记.md" lineNumbers={false} />)
    expect(screen.getByRole('link', { name: '卧室' })).toHaveAttribute('href', 'https://renj.io')
    expect(document.querySelector('.link-card')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders a cached thumbnail card and refreshes only when asked', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const refreshed = init?.method === 'POST'
      return new Response(JSON.stringify({ url: 'https://renj.io/', title: refreshed ? '新标题' : '页面标题', site: 'renj.io', hasImage: true, image: '/api/link-previews/image?id=abc' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<MarkdownView content="[卧室](https://renj.io)." notePath="笔记.md" lineNumbers={false} autoParseLinks />)
    const card = await screen.findByRole('link', { name: /卧室/ })
    expect(card).toHaveAttribute('href', 'https://renj.io')
    expect(card).toHaveAttribute('target', '_blank')
    expect(card.querySelector('img')).toHaveAttribute('src', '/api/link-previews/image?id=abc&v=1')
    expect(card).toHaveTextContent('renj.io')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rerender(<MarkdownView content="[卧室](https://renj.io)." notePath="笔记.md" lineNumbers={false} autoParseLinks />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '刷新链接' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('link', { name: /卧室/ }).querySelector('img')).toHaveAttribute('src', '/api/link-previews/image?id=abc&v=2')
    const post = fetchMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'POST')
    expect(post?.[0]).toBe('/api/link-previews')
    expect((post?.[1] as RequestInit).body).toBe(JSON.stringify({ url: 'https://renj.io' }))
    fireEvent.error(screen.getByRole('link', { name: /卧室/ }).querySelector('img')!)
    expect(screen.getByRole('link', { name: /卧室/ })).toHaveTextContent('https://renj.io')
    expect(document.querySelector('.link-card.has-image')).toBeNull()
  })

  it('shows a small card with title and address when a page has no thumbnail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'https://renj.io/', title: '页面标题', site: 'renj.io', hasImage: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const { container } = render(<MarkdownView content="[卧室](https://renj.io)." notePath="笔记.md" lineNumbers={false} autoParseLinks />)
    const card = await screen.findByRole('link', { name: /卧室/ })
    expect(card).toHaveAttribute('href', 'https://renj.io')
    expect(card).toHaveTextContent('https://renj.io')
    expect(container.querySelector('.link-card.compact.has-title')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByText('页面标题')).not.toBeInTheDocument()
  })

  it('uses the page title when the link text is the address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'https://example.com/page', title: '页面标题', site: 'example.com', hasImage: true, image: '/api/link-previews/image?id=page' }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    render(<MarkdownView content="https://example.com/page" notePath="笔记.md" lineNumbers={false} autoParseLinks />)
    const card = await screen.findByRole('link', { name: /页面标题/ })
    expect(card).toHaveAttribute('href', 'https://example.com/page')
    expect(card).toHaveTextContent('example.com')
  })

  it('shares one cached preview between repeated links', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: 'https://renj.io/', title: '页面', site: 'renj.io', hasImage: true, image: '/api/link-previews/image?id=abc' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MarkdownView content={'[甲](https://renj.io)\n\n[乙](https://renj.io)'} notePath="笔记.md" lineNumbers={false} autoParseLinks />)
    expect(await screen.findByRole('link', { name: /甲/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /乙/ })).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByRole('button', { name: '刷新链接' })[0])
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('link', { name: /甲/ }).querySelector('img')).toHaveAttribute('src', expect.stringContaining('v=2'))
    expect(screen.getByRole('link', { name: /乙/ }).querySelector('img')).toHaveAttribute('src', expect.stringContaining('v=2'))
  })

  it('keeps the markdown title when preview lookup fails and uses ordinary links while exporting', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: '无法访问链接' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<MarkdownView content="[卧室](https://renj.io)" notePath="笔记.md" lineNumbers={false} autoParseLinks />)
    const card = await screen.findByRole('link', { name: /卧室/ })
    expect(card).toHaveTextContent('https://renj.io')
    expect(document.querySelector('.link-card.compact.has-title')).toBeInTheDocument()
    rerender(<MarkdownView content="[卧室](https://renj.io)" notePath="笔记.md" lineNumbers={false} autoParseLinks exporting />)
    expect(screen.getByRole('link', { name: '卧室' })).toHaveAttribute('href', 'https://renj.io')
    expect(document.querySelector('.link-card')).toBeNull()
  })

  it('does not turn unsafe, local, or image links into cards', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<MarkdownView content={'[危险链接](javascript:alert(1))\n\n[另一篇](介绍.md)\n\n[![照片](../.assets/a.png)](https://example.com/page)'} notePath="笔记.md" lineNumbers={false} autoParseLinks />)
    expect(screen.getByText('危险链接')).not.toHaveAttribute('href', 'javascript:alert(1)')
    expect(decodeURIComponent(screen.getByRole('link', { name: '另一篇' }).getAttribute('href') || '')).toBe('介绍.md')
    expect(screen.getByRole('button', { name: '预览图片：照片' })).toHaveAttribute('src', '/api/assets?path=.assets%2Fa.png')
    expect(document.querySelector('.link-card')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
