import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownView, resolveNotePath } from './MarkdownView'

const { initializeMermaid, renderMermaid } = vi.hoisted(() => ({
  initializeMermaid: vi.fn(),
  renderMermaid: vi.fn(async (id: string, code: string) => {
    if (code.includes('BAD')) throw new Error('Parse error on line 1')
    return { svg: `<svg class="diagram" id="${id}"></svg>` }
  }),
}))

vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre class="shiki"><code><span class="line">${code.replace(/</g, '&lt;')}</span></code></pre>` }))
vi.mock('mermaid', () => ({ default: { initialize: initializeMermaid, render: (id: string, code: string) => renderMermaid(id, code) } }))
vi.mock('./Drawing', () => ({ DrawingEmbed: ({ path, onEdit }: { path: string; onEdit?: (path: string) => void }) => <button type="button" onClick={() => onEdit?.(path)}>{path}</button> }))
afterEach(cleanup)

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

  it('falls back to the source block when a mermaid diagram cannot be rendered', async () => {
    const { container } = render(<MarkdownView content={'```mermaid\nBAD\n```'} notePath="笔记.md" lineNumbers={false} />)
    await waitFor(() => expect(container.querySelector('.mermaid-error')).toHaveTextContent('Parse error on line 1'))
    expect(container.querySelector('.code-block')).toHaveTextContent('BAD')
    expect(container.querySelector('.mermaid-block')).toBeNull()
    await waitFor(() => expect(container.querySelector('[data-rendering]')).toBeNull())
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

  it('opens internal Markdown links through the note navigator', () => {
    const navigate = vi.fn()
    render(<MarkdownView content="[另一篇](../文档/介绍.md#标题)" notePath="项目/记录.md" lineNumbers={false} onNavigate={navigate} />)
    fireEvent.click(screen.getByRole('link'))
    expect(navigate).toHaveBeenCalledWith('文档/介绍.md')
    expect(resolveNotePath('项目/记录.md', '../.assets/图片%20一.png')).toBe('.assets/图片 一.png')
  })
})
