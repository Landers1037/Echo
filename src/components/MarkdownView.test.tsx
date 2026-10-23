import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownView, resolveNotePath } from './MarkdownView'

vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre class="shiki"><code><span class="line">${code.replace(/</g, '&lt;')}</span></code></pre>` }))
afterEach(cleanup)

describe('Markdown rendering', () => {
  it('marks each navigable heading with its source line and keeps exports free of navigation attributes', () => {
    const content = '---\ntitle: 示例\n---\n# 重复\n\n## 重复\n\n##### 五级\n\n###### 六级\n'
    const { container, rerender } = render(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} />)
    expect([...container.querySelectorAll('[data-heading-line]')].map(heading => [heading.tagName, heading.getAttribute('data-heading-line')])).toEqual([['H1', '4'], ['H2', '6'], ['H5', '8']])
    expect(screen.getByRole('heading', { name: '六级' })).not.toHaveAttribute('data-heading-line')
    const heading = container.querySelector('h1')!
    heading.focus()
    rerender(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} />)
    expect(heading).toHaveFocus()
    rerender(<MarkdownView content={content} notePath="笔记.md" lineNumbers={false} exporting />)
    expect(container.querySelector('[data-heading-line]')).toBeNull()
    expect(container.querySelector('h1')).not.toHaveAttribute('tabindex')
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

  it('renders GFM tables and prevents executable source HTML', () => {
    const { container } = render(<MarkdownView content={'| 名称 | 数量 |\n| --- | --- |\n| 示例 | 2 |\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))'} notePath="test.md" lineNumbers={false} />)
    expect(screen.getByRole('table')).toHaveTextContent('示例')
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('危险链接')).not.toHaveAttribute('href', 'javascript:alert(1)')
  })

  it('opens internal Markdown links through the note navigator', () => {
    const navigate = vi.fn()
    render(<MarkdownView content="[另一篇](../文档/介绍.md#标题)" notePath="项目/记录.md" lineNumbers={false} onNavigate={navigate} />)
    fireEvent.click(screen.getByRole('link'))
    expect(navigate).toHaveBeenCalledWith('文档/介绍.md')
    expect(resolveNotePath('项目/记录.md', '../.assets/图片%20一.png')).toBe('.assets/图片 一.png')
  })
})
