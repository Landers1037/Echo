import { describe, expect, it } from 'vitest'
import { NoteAiSession, type SessionEditor } from './editorSession'

class FakeDoc implements SessionEditor {
  highlights: { from: number; to: number }[] = []
  locked = false
  constructor(public doc: string) {}
  getDoc() { return this.doc }
  replace(from: number, to: number, insert: string) { this.doc = this.doc.slice(0, from) + insert + this.doc.slice(to) }
  setHighlights(ranges: { from: number; to: number }[]) { this.highlights = ranges }
  setLocked(locked: boolean) { this.locked = locked }
}

describe('note AI session', () => {
  it('streams a replacement and can reject it', () => {
    const doc = new FakeDoc('# 标题\n\n你好世界')
    const session = new NoteAiSession(doc)
    session.begin()
    session.apply('t1', 'edit_note', '{"edits":[{"search":"你好世界","replace":"你"}')
    expect(doc.doc).toBe('# 标题\n\n你')
    expect(doc.highlights).toEqual([{ from: 6, to: 7 }])
    session.apply('t1', 'edit_note', '{"edits":[{"search":"你好世界","replace":"你好，Echo"}]}')
    expect(doc.doc).toBe('# 标题\n\n你好，Echo')
    session.resolve('reject')
    expect(doc.doc).toBe('# 标题\n\n你好世界')
    expect(doc.locked).toBe(false)
    expect(doc.highlights).toEqual([])
  })

  it('applies two edits from the original text and keeps them on accept', () => {
    const doc = new FakeDoc('甲乙丙')
    const session = new NoteAiSession(doc)
    session.begin()
    session.apply('t1', 'edit_note', '{"edits":[{"search":"甲","replace":"A"},{"search":"丙","replace":"C"}]}')
    expect(doc.doc).toBe('A乙C')
    session.resolve('accept')
    expect(doc.doc).toBe('A乙C')
  })

  it('reports a search that is not unique and still applies the other edit', () => {
    const doc = new FakeDoc('你好，你好')
    const session = new NoteAiSession(doc)
    session.begin()
    session.apply('t1', 'edit_note', '{"edits":[{"search":"你好","replace":"您好"},{"search":"，","replace":"！"}]}')
    expect(session.finish().failures).toContain('匹配不唯一')
    expect(doc.doc).toBe('你好！你好')
  })

  it('appends and rewrites from partial arguments', () => {
    const doc = new FakeDoc('正文')
    const session = new NoteAiSession(doc)
    session.begin()
    session.apply('append', 'append_to_note', '{"text":"\\n尾"}')
    expect(doc.doc).toBe('正文\n尾')
    session.apply('rewrite', 'rewrite_note', '{"content":"新"}')
    expect(doc.doc).toBe('新')
    session.apply('rewrite', 'rewrite_note', '{"content":"新的笔记"}')
    expect(doc.doc).toBe('新的笔记')
    session.resolve('reject')
    expect(doc.doc).toBe('正文')
  })
})
