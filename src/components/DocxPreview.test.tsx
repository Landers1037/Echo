import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocxPreview } from './DocxPreview'

const destroy = vi.fn()
const load = vi.fn(async () => undefined)
const getScale = vi.fn(() => 1)
const setScale = vi.fn()
const fitWidth = vi.fn()

vi.mock('@silurus/ooxml/docx', () => ({
  DocxScrollViewer: vi.fn(function MockViewer(this: {
    destroy: () => void
    load: typeof load
    getScale: typeof getScale
    setScale: typeof setScale
    fitWidth: typeof fitWidth
  }, host: HTMLElement) {
    host.setAttribute('data-docx-host', '1')
    this.destroy = destroy
    this.load = load
    this.getScale = getScale
    this.setScale = setScale
    this.fitWidth = fitWidth
  }),
}))

vi.mock('@silurus/ooxml/math', () => ({ math: { kind: 'math' } }))

describe('DocxPreview', () => {
  beforeEach(() => {
    destroy.mockClear()
    load.mockClear()
    getScale.mockClear().mockReturnValue(1)
    setScale.mockClear()
    fitWidth.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 })))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('loads a document into the scroll viewer', async () => {
    const onError = vi.fn()
    render(<DocxPreview path="资料/说明.docx" onClose={() => {}} onError={onError} />)
    expect(screen.getByText('说明')).toBeInTheDocument()
    expect(screen.getByText(/只读预览/)).toBeInTheDocument()
    await waitFor(() => expect(load).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/api/documents?path=%E8%B5%84%E6%96%99%2F%E8%AF%B4%E6%98%8E.docx')
    expect(onError).not.toHaveBeenCalled()
  })

  it('shows a friendly error when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    render(<DocxPreview path="gone.docx" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })

  it('zooms the document from the toolbar', async () => {
    render(<DocxPreview path="资料/说明.docx" onClose={() => {}} />)
    await waitFor(() => expect(load).toHaveBeenCalled())
    const zoom = within(screen.getByRole('group', { name: '文档缩放' }))
    await waitFor(() => expect(zoom.getByLabelText('放大')).not.toBeDisabled())
    fireEvent.click(zoom.getByLabelText('放大'))
    expect(setScale).toHaveBeenCalled()
    fireEvent.click(zoom.getByLabelText('适应宽度'))
    expect(fitWidth).toHaveBeenCalled()
  })
})
