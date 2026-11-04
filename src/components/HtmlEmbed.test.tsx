import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HtmlEmbed } from './HtmlEmbed'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HtmlEmbed', () => {
  it('loads HTML into a sandboxed blob iframe', async () => {
    const createObjectURL = vi.fn(() => 'blob:html-demo')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => '<!doctype html><html><body>demo</body></html>',
    })))

    const { unmount } = render(<HtmlEmbed path="demos/小球.html" alt="小球" />)
    await waitFor(() => expect(screen.getByTitle('小球')).toHaveAttribute('src', 'blob:html-demo'))
    expect(screen.getByTitle('小球')).toHaveAttribute('sandbox', 'allow-scripts')
    expect(createObjectURL).toHaveBeenCalledOnce()
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:html-demo')
  })

  it('exports with srcdoc from embedded data URLs', async () => {
    const html = '<!doctype html><title>x</title>'
    const embedded = `data:text/html;base64,${btoa(html)}`
    render(<HtmlEmbed path="demos/x.html" alt="x" exporting embedded={embedded} />)
    await waitFor(() => expect(screen.getByTitle('x')).toHaveAttribute('srcdoc', html))
  })
})
