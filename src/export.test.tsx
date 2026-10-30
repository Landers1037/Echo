import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteToDocx } from './exportDocx'
import { exportNotes } from './export'

vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre class="shiki"><code>${code}</code></pre>` }))
vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: async (id: string) => ({ svg: `<svg id="${id}" class="mermaid-export"></svg>` }) } }))
vi.mock('./exportDocx', () => ({ noteToDocx: vi.fn(async (note: { path: string }) => new Blob([`docx:${note.path}`])) }))

afterEach(() => vi.restoreAllMocks())

describe('note export', () => {
  it('saves pending edits before taking a self-contained HTML snapshot', async () => {
    const events: string[] = []
    let exported: Blob | undefined
    const createObjectURL = vi.fn((blob: Blob) => { exported = blob; return 'blob:export' })
    vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => {
      events.push('snapshot')
      return new Response(JSON.stringify({ notes: [{ path: '工作/记录.md', title: '记录', content: '# 正文\n\n![图](../.assets/a.png)', metadata: { tags: ['工作'], group: '项目' }, revision: 'a', modified: '', assets: { '../.assets/a.png': 'data:image/png;base64,abc' } }], missing: [], external: [] }), { headers: { 'Content-Type': 'application/json' } })
    }))
    await exportNotes({ paths: ['工作/记录.md'], format: 'html', lineNumbers: false, beforeExport: async () => { events.push('saved') }, onWarning: async () => true })
    expect(events).toEqual(['saved', 'snapshot'])
    expect(createObjectURL).toHaveBeenCalledOnce()
    const html = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exported!) })
    expect(html).toContain('data:image/png;base64,abc')
    expect(html).toContain('class="export-path"')
    expect(html).toContain('工作/记录.md')
    expect(html).toContain('#工作')
    expect(html).toContain('项目')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('/api/assets')
    vi.unstubAllGlobals()
  })

  it('embeds rendered mermaid diagrams in the exported HTML', async () => {
    let exported: Blob | undefined
    vi.stubGlobal('URL', class extends URL { static createObjectURL = (blob: Blob) => { exported = blob; return 'blob:export' }; static revokeObjectURL = vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notes: [{ path: '记录.md', title: '记录', content: '# 正文\n\n```mermaid\ngraph LR\n  A-->B\n```\n', metadata: { tags: [], group: '' }, revision: 'a', modified: '', assets: {} }], missing: [], external: [] }), { headers: { 'Content-Type': 'application/json' } })))
    await exportNotes({ paths: ['记录.md'], format: 'html', lineNumbers: false, beforeExport: async () => {}, onWarning: async () => true })
    const html = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exported!) })
    expect(html).toContain('class="mermaid-block"')
    expect(html).toContain('class="mermaid-export"')
    expect(html).not.toContain('graph LR')
    vi.unstubAllGlobals()
  })

  it('keeps a single newline as a break in exported HTML when strict line breaks are enabled', async () => {
    let exported: Blob | undefined
    vi.stubGlobal('URL', class extends URL { static createObjectURL = (blob: Blob) => { exported = blob; return 'blob:export' }; static revokeObjectURL = vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notes: [{ path: '记录.md', title: '记录', content: '甲**乙**\n丙', metadata: { tags: [], group: '' }, revision: 'a', modified: '', assets: {} }], missing: [], external: [] }), { headers: { 'Content-Type': 'application/json' } })))
    await exportNotes({ paths: ['记录.md'], format: 'html', lineNumbers: false, strictLineBreaks: true, beforeExport: async () => {}, onWarning: async () => true })
    const html = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exported!) })
    expect(html).toMatch(/乙[\s\S]*<br\s*\/?>[\s\S]*丙/)
    vi.unstubAllGlobals()
  })

  it('omits the markdown path from the PDF print document', async () => {
    const writes: string[] = []
    const printWindow = {
      closed: false,
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
      document: {
        open: vi.fn(),
        write: vi.fn((html: string) => { writes.push(html) }),
        close: vi.fn(),
        createElement: document.createElement.bind(document),
        body: document.createElement('body'),
        fonts: { ready: Promise.resolve() },
        images: [],
      },
    }
    vi.spyOn(window, 'open').mockReturnValue(printWindow as unknown as Window)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notes: [{ path: '1/222.md', title: '在 Echo，留住每一个想法', content: '正文', metadata: { tags: [], group: '' }, revision: 'a', modified: '', assets: {} }], missing: [], external: [] }), { headers: { 'Content-Type': 'application/json' } })))
    await exportNotes({ paths: ['1/222.md'], format: 'pdf', lineNumbers: false, beforeExport: async () => {}, onWarning: async () => true })
    const html = writes.at(-1) || ''
    expect(html).toContain('在 Echo，留住每一个想法')
    expect(html).not.toContain('class="export-path"')
    expect(html).toContain('@bottom-left{content:""}')
    expect(html).toContain('counter(page)')
    expect(html).not.toContain('>1/222.md<')
    vi.unstubAllGlobals()
  })

  it('does not export if saving fails', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(exportNotes({ paths: ['记录.md'], format: 'md', lineNumbers: false, beforeExport: async () => { throw new Error('保存冲突') }, onWarning: async () => true })).rejects.toThrow('保存冲突')
    expect(fetcher).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('downloads one Word document from the export snapshot', async () => {
    let exported: Blob | undefined
    let downloadName = ''
    vi.stubGlobal('URL', class extends URL { static createObjectURL = (blob: Blob) => { exported = blob; return 'blob:export' }; static revokeObjectURL = vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).format).toBe('snapshot')
      return new Response(JSON.stringify({ notes: [{ path: '工作/记录.md', title: '记录', content: '正文', metadata: { tags: [], group: '' }, revision: 'a', modified: '', assets: {} }], missing: [], external: [] }), { headers: { 'Content-Type': 'application/json' } })
    }))
    await exportNotes({ paths: ['工作/记录.md'], format: 'docx', lineNumbers: false, beforeExport: async () => {}, onWarning: async () => true })
    expect(downloadName).toBe('记录.docx')
    const docx = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exported!) })
    expect(docx).toBe('docx:工作/记录.md')
    vi.unstubAllGlobals()
  })

  it('packs each note into its own docx inside a zip', async () => {
    let exported: Blob | undefined
    let downloadName = ''
    vi.stubGlobal('URL', class extends URL { static createObjectURL = (blob: Blob) => { exported = blob; return 'blob:export' }; static revokeObjectURL = vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notes: [{ path: '工作/记录.md', title: '记录', content: '正文', metadata: { tags: [], group: '' }, revision: 'a', modified: '', assets: {} }, { path: '其他.md', title: '其他', content: '另一篇', metadata: { tags: [], group: '' }, revision: 'b', modified: '', assets: {} }], missing: [], external: [] }), { headers: { 'Content-Type': 'application/json' } })))
    await exportNotes({ paths: ['工作/记录.md', '其他.md'], format: 'docx', lineNumbers: false, beforeExport: async () => {}, onWarning: async () => true })
    expect(downloadName).toBe('Echo-Word.zip')
    const zipped = await new Promise<ArrayBuffer>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(exported!) })
    const files = unzipSync(new Uint8Array(zipped))
    expect(Object.keys(files).sort()).toEqual(['其他.docx', '工作/记录.docx'].sort())
    expect(strFromU8(files['工作/记录.docx'])).toBe('docx:工作/记录.md')
    expect(strFromU8(files['其他.docx'])).toBe('docx:其他.md')
    vi.unstubAllGlobals()
  })

  it('asks before exporting a Word document when local images are missing', async () => {
    vi.mocked(noteToDocx).mockClear()
    const warning = vi.fn(async () => false)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: '资源缺失', missing: ['a.png'], external: [] }), { status: 422 }))
    vi.stubGlobal('fetch', fetcher)
    await exportNotes({ paths: ['记录.md'], format: 'docx', lineNumbers: false, beforeExport: async () => {}, onWarning: warning })
    expect(warning).toHaveBeenCalledWith({ missing: ['a.png'], external: [] })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(noteToDocx).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('allows cancellation when local images are missing', async () => {
    const warning = vi.fn(async () => false)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: '资源缺失', missing: ['a.png'], external: [] }), { status: 422 }))
    vi.stubGlobal('fetch', fetcher)
    await exportNotes({ paths: ['记录.md'], format: 'bundle', lineNumbers: false, beforeExport: async () => {}, onWarning: warning })
    expect(warning).toHaveBeenCalledWith({ missing: ['a.png'], external: [] })
    expect(fetcher).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
