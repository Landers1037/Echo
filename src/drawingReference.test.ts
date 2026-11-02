import { describe, expect, it } from 'vitest'
import { removeAllDrawingReferences, removeDrawingReference } from './drawingReference'

describe('drawingReference', () => {
  it('removes a single angled or plain drawing image by path', () => {
    const note = '笔记/记录.md'
    expect(removeAllDrawingReferences('前言\n\n![图](../.assets/a.excalidraw)\n\n后记', note, '.assets/a.excalidraw'))
      .toBe('前言\n\n后记')
    expect(removeAllDrawingReferences('![流程](<../图表/有 空格.drawio>)\n正文', note, '图表/有 空格.drawio'))
      .toBe('正文')
  })

  it('keeps unrelated images and other drawings', () => {
    const content = '![照片](../.assets/a.png)\n![A](../.assets/a.excalidraw)\n![B](../图表/b.drawio)'
    expect(removeAllDrawingReferences(content, '笔记/记录.md', '.assets/a.excalidraw'))
      .toBe('![照片](../.assets/a.png)\n![B](../图表/b.drawio)')
  })

  it('removes one occurrence by source range', () => {
    const content = '![一](a.excalidraw)\n![二](a.excalidraw)'
    const start = content.indexOf('![二]')
    const end = start + '![二](a.excalidraw)'.length
    expect(removeDrawingReference(content, 'note.md', 'a.excalidraw', { start, end })).toBe('![一](a.excalidraw)')
  })
})
