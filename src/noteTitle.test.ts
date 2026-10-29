import { describe, expect, it } from 'vitest'
import { applyNoteTitle, displayedNoteTitle } from './noteTitle'

describe('note title', () => {
  it('reads the first heading after frontmatter and falls back when it is missing', () => {
    expect(displayedNoteTitle('---\ntitle: "# 假标题"\n---\n# 真正的标题\n', '文件名')).toBe('真正的标题')
    expect(displayedNoteTitle('只有正文', '文件名')).toBe('文件名')
    expect(displayedNoteTitle('# \n', '文件名')).toBe('')
  })

  it('replaces only the first level-one heading and keeps the rest of the note', () => {
    expect(applyNoteTitle('# 旧标题\n\n正文\n\n# 另一个\n', '新标题')).toBe('# 新标题\n\n正文\n\n# 另一个\n')
    expect(applyNoteTitle('## 小节\n', '新标题')).toBe('# 新标题\n\n## 小节\n')
    expect(applyNoteTitle('', '新标题')).toBe('# 新标题\n\n')
  })

  it('preserves frontmatter, a byte order mark and windows line endings', () => {
    const content = '\uFEFF---\necho:\n  tags: [工作]\n---\r\n# 旧标题\r\n\r\n正文\r\n'
    expect(applyNoteTitle(content, ' 新标题 ')).toBe('\uFEFF---\necho:\n  tags: [工作]\n---\r\n# 新标题\r\n\r\n正文\r\n')
    expect(applyNoteTitle('\uFEFF---\necho:\n  group: 日记\n---\r\n正文\r\n', '补上标题')).toBe('\uFEFF---\necho:\n  group: 日记\n---\r\n# 补上标题\r\n\r\n正文\r\n')
  })
})
