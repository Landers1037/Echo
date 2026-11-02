function decodeSafe(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function resolveNotePath(notePath: string, target: string): string {
  const decoded = decodeSafe(target.split('#')[0].split('?')[0])
  const root = decoded.startsWith('/') ? [] : notePath.split('/').slice(0, -1)
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') root.pop()
    else root.push(part)
  }
  return root.join('/')
}

function isDrawingHref(src: string) {
  const clean = decodeSafe(src).split('#')[0].split('?')[0]
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(clean)) return false
  return /\.(?:drawio|excalidraw)$/i.test(clean)
}

const DRAWING_IMAGE_RE = /!\[([^\]]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\)/g

function pointsToDrawing(notePath: string, href: string, drawingPath: string) {
  const clean = decodeSafe(href.trim())
  if (!isDrawingHref(clean)) return false
  return resolveNotePath(notePath, clean) === drawingPath
}

function collapseHole(content: string, start: number, end: number) {
  let from = start
  let to = end
  if ((from === 0 || content[from - 1] === '\n') && (to === content.length || content[to] === '\n')) {
    if (to < content.length && content[to] === '\n') to += 1
    else if (from > 0 && content[from - 1] === '\n') from -= 1
  }
  return content.slice(0, from) + content.slice(to)
}

/** Remove one drawing image by source offsets when available. */
export function removeDrawingReference(content: string, notePath: string, drawingPath: string, range?: { start: number; end: number }) {
  if (range && range.start >= 0 && range.end > range.start && range.end <= content.length) {
    return collapseHole(content, range.start, range.end)
  }
  return removeAllDrawingReferences(content, notePath, drawingPath)
}

/** Remove every markdown image in this note that points at the drawing path. */
export function removeAllDrawingReferences(content: string, notePath: string, drawingPath: string) {
  DRAWING_IMAGE_RE.lastIndex = 0
  const ranges: { start: number; end: number }[] = []
  for (const match of content.matchAll(DRAWING_IMAGE_RE)) {
    const href = match[2] || match[3] || ''
    if (!pointsToDrawing(notePath, href, drawingPath) || match.index == null) continue
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  let next = content
  for (let index = ranges.length - 1; index >= 0; index--) {
    next = collapseHole(next, ranges[index].start, ranges[index].end)
  }
  return next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}
