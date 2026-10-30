import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { noteToDocx } from './exportDocx'
import type { ExportSnapshot } from './types'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function note(content: string, assets: Record<string, string> = {}): ExportSnapshot['notes'][number] {
  return { path: '记录.md', title: '导出标题', content, metadata: { tags: ['工作'], group: '项目' }, revision: 'a', modified: '', assets }
}

async function documentXml(blob: Blob) {
  const zipped = await new Promise<ArrayBuffer>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob) })
  return strFromU8(unzipSync(new Uint8Array(zipped))['word/document.xml'])
}

describe('docx conversion', () => {
  it('writes the title, metadata and a strict line break, and hides frontmatter', async () => {
    const blob = await noteToDocx(note('---\ntitle: 隐藏\n---\n甲\n丙\n\n<u>下划线</u>'), { strictLineBreaks: true })
    const xml = await documentXml(blob)
    expect(xml).toContain('导出标题')
    expect(xml).toContain('项目')
    expect(xml).toContain('#工作')
    expect(xml).toContain('<w:br')
    expect(xml).toContain('下划线')
    expect(xml).toContain('<w:u ')
    expect(xml).not.toContain('隐藏')
  })

  it('keeps exporting when an svg only has percentage dimensions', async () => {
    const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="min-width:320px;min-height:180px"><rect width="320" height="180"/></svg>')
    await expect(noteToDocx(note('![图标](icon.svg)', { 'icon.svg': svg }), { strictLineBreaks: false })).resolves.toBeInstanceOf(Blob)
  })

  it('replaces a missing drawing with a text placeholder and embeds a local image', async () => {
    const blob = await noteToDocx(note('![草图](图.excalidraw)\n\n![点](a.png)', { 'a.png': png }), { strictLineBreaks: false })
    const xml = await documentXml(blob)
    expect(xml).toContain('[绘图缺失：草图]')
    expect(xml).toContain('<a:blip')
  })
})
