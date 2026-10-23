import { describe, expect, it } from 'vitest'
import { parseNoteHeadings } from './noteOutline'

describe('note heading navigation', () => {
  it('keeps levels one to five, source lines and duplicate titles', () => {
    expect(parseNoteHeadings('# 总览\n\n## 计划\n### 计划\n#### 细节\n##### 检查\n###### 不收录\n')).toEqual([
      { line: 1, depth: 1, title: '总览' },
      { line: 3, depth: 2, title: '计划' },
      { line: 4, depth: 3, title: '计划' },
      { line: 5, depth: 4, title: '细节' },
      { line: 6, depth: 5, title: '检查' },
    ])
  })

  it('excludes frontmatter, fenced code, indented code and HTML blocks', () => {
    const content = ['---', 'title: |', '  # 文件头', '---', '```md', '# 围栏代码', '```', '', '    ## 缩进代码', '', '<div>', '# HTML 内容', '</div>', '', '# 真正的标题'].join('\n')
    expect(parseNoteHeadings(content)).toEqual([{ line: 15, depth: 1, title: '真正的标题' }])
  })

  it('reads setext and nested headings, removes inline markup and handles empty headings', () => {
    const content = ['主标题', '======', '', '## **加粗**、[链接](other.md)、`代码` &amp; ![图片](a.png)', '', '> ### 引用标题', '', '#'].join('\n')
    expect(parseNoteHeadings(content)).toEqual([
      { line: 1, depth: 1, title: '主标题' },
      { line: 4, depth: 2, title: '加粗、链接、代码 & 图片' },
      { line: 6, depth: 3, title: '引用标题' },
      { line: 8, depth: 1, title: '未命名标题' },
    ])
  })
})
