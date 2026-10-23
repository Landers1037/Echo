import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportNotes } from './export'

vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre class="shiki"><code>${code}</code></pre>` }))

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
    expect(html).toContain('#工作')
    expect(html).toContain('项目')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('/api/assets')
    vi.unstubAllGlobals()
  })

  it('does not export if saving fails', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(exportNotes({ paths: ['记录.md'], format: 'md', lineNumbers: false, beforeExport: async () => { throw new Error('保存冲突') }, onWarning: async () => true })).rejects.toThrow('保存冲突')
    expect(fetcher).not.toHaveBeenCalled()
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
