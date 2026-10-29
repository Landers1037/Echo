import { describe, expect, it } from 'vitest'
import { noteReferenceMarkdown, relativeNoteHref } from './noteReference'

describe('note references', () => {
  it('builds a relative link for sibling, child and parent notes', () => {
    expect(relativeNoteHref('项目/记录.md', '项目/介绍.md')).toBe(encodeURIComponent('介绍.md'))
    expect(relativeNoteHref('记录.md', '文档/介绍.md')).toBe(`${encodeURIComponent('文档')}/${encodeURIComponent('介绍.md')}`)
    expect(relativeNoteHref('文档/子/记录.md', '文档/介绍.md')).toBe(`../${encodeURIComponent('介绍.md')}`)
  })

  it('encodes spaces and parentheses so the link stays valid', () => {
    expect(relativeNoteHref('记录.md', 'my note (1).md')).toBe('my%20note%20%281%29.md')
    expect(noteReferenceMarkdown('项目/记录.md', { path: '项目/my note (1).md', title: '草稿' })).toBe('[草稿](my%20note%20%281%29.md "echo-ref")')
  })

  it('drops brackets and escapes backslashes in the visible label', () => {
    expect(noteReferenceMarkdown('a.md', { path: 'b.md', title: '见 [设计]\r\n稿\\尾' })).toBe('[见 设计 稿\\\\尾](b.md "echo-ref")')
    expect(noteReferenceMarkdown('目录/a.md', { path: '目录/b.md', title: '   ' })).toBe('[b](b.md "echo-ref")')
  })
})
