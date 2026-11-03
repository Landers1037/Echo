import { describe, expect, it } from 'vitest'
import { prepareDiagramPreview } from './Mermaid'

describe('prepareDiagramPreview', () => {
  it('keeps foreignObject HTML that XML parsing would strip, fits the viewport, and retargets style ids', () => {
    const svg = [
      '<svg class="diagram" id="echo-mermaid-1" viewBox="0 0 400 800" width="400" height="800" style="max-width:100%">',
      '<style>#echo-mermaid-1 .edgePath .path{stroke:#333;fill:none}#echo-mermaid-1 .node rect{fill:#eee}</style>',
      '<defs><marker id="arrow"></marker></defs>',
      '<g id="cluster"><rect width="100" height="40"></rect></g>',
      '<foreignObject width="120" height="40"><div xmlns="http://www.w3.org/1999/xhtml">业务层<br/>服务</div></foreignObject>',
      '<path class="edgePath" marker-end="url(#arrow)" d="M0 0 L10 10"></path>',
      '</svg>',
    ].join('')

    const preview = prepareDiagramPreview(svg, 200, 200)
    expect(preview).toContain('foreignObject')
    expect(preview).toContain('业务层')
    expect(preview).toMatch(/<br\s*\/?>/i)
    expect(preview).toMatch(/width="100"/)
    expect(preview).toMatch(/height="200"/)
    expect(preview).toMatch(/id="echo-mermaid-1-preview\d+"/)
    expect(preview).toMatch(/url\(#arrow-preview\d+\)/)
    expect(preview).toMatch(/#echo-mermaid-1-preview\d+ \.edgePath \.path\{stroke:#333;fill:none\}/)
    expect(preview).not.toContain('#echo-mermaid-1 ')
  })

  it('returns the original markup when no svg root is present', () => {
    expect(prepareDiagramPreview('<div>nope</div>')).toBe('<div>nope</div>')
  })
})
