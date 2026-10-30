export const anchorTextLimit = 80
export const annotationColors = ['#e3b341', '#e38b8b', '#7dba8d', '#7aa2e3', '#c49be0', '#e0a15a'] as const
export const annotationStrokePixels = [2, 4, 8] as const

export type AnchorCandidate = { line: number; text: string }
export type AnchorBox = { left: number; top: number; width: number }

export function anchorFingerprint(text: string) {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, anchorTextLimit).join('')
}

export function highlightStyleName(color: string) {
  return `echo-annotation-${color.replace('#', '').toLowerCase()}`
}

// Same-line matches prefer the last candidate so an inner block wins over its container.
export function locateAnchor<T extends AnchorCandidate>(anchors: readonly T[], anchorLine: number, anchorText: string): T | null {
  const fingerprint = anchorFingerprint(anchorText)
  let sameLine: T | null = null
  for (const anchor of anchors) {
    if (anchor.line === anchorLine && anchorFingerprint(anchor.text) === fingerprint) sameLine = anchor
  }
  if (sameLine) return sameLine
  let best: T | null = null
  let bestDistance = Infinity
  for (const anchor of anchors) {
    if (anchorFingerprint(anchor.text) !== fingerprint) continue
    const distance = Math.abs(anchor.line - anchorLine)
    if (distance < bestDistance) {
      best = anchor
      bestDistance = distance
    }
  }
  return best
}

export function resolveHighlight(text: string, start: number, end: number, quote: string) {
  if (!quote) return null
  if (start >= 0 && end <= text.length && end > start && text.slice(start, end) === quote) return { start, end }
  let index = text.indexOf(quote)
  if (index < 0) return null
  let best = index
  let bestDistance = Math.abs(index - Math.max(0, start))
  while ((index = text.indexOf(quote, index + Math.max(quote.length, 1))) >= 0) {
    const distance = Math.abs(index - start)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return { start: best, end: best + quote.length }
}

export function blockText(block: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(block)
  return range.toString()
}

export function rangeToOffsets(block: HTMLElement, range: Range) {
  if (!containsBoundary(block, range.startContainer) || !containsBoundary(block, range.endContainer)) return null
  const start = boundaryOffset(block, range.startContainer, range.startOffset)
  const end = boundaryOffset(block, range.endContainer, range.endOffset)
  if (start == null || end == null || end <= start) return null
  const quote = range.toString()
  if (!quote.trim()) return null
  return { start, end, quote }
}

export function offsetsToRange(block: HTMLElement, start: number, end: number) {
  if (start < 0 || end <= start) return null
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let seen = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const length = text.data.length
    if (!startNode && seen + length >= start) {
      startNode = text
      startOffset = start - seen
    }
    if (seen + length >= end) {
      endNode = text
      endOffset = end - seen
      break
    }
    seen += length
  }
  if (!startNode || !endNode) return null
  const next = document.createRange()
  next.setStart(startNode, startOffset)
  next.setEnd(endNode, endOffset)
  return next
}

export function toAnchorPoint(root: AnchorBox, blockTop: number, clientX: number, clientY: number): [number, number] {
  const width = root.width || 1
  return [(clientX - root.left) / width, (clientY - blockTop) / width]
}

export function fromAnchorPoint(root: AnchorBox, blockTop: number, point: [number, number]) {
  return { x: root.left + point[0] * root.width, y: blockTop + point[1] * root.width }
}

export function strokeWidthRatio(pixels: number, rootWidth: number) {
  const width = rootWidth || 1
  return Math.min(0.2, Math.max(0.0001, pixels / width))
}

function containsBoundary(block: HTMLElement, node: Node) {
  return block === node || block.contains(node)
}

function boundaryOffset(block: HTMLElement, container: Node, offset: number) {
  const probe = document.createRange()
  probe.selectNodeContents(block)
  try { probe.setEnd(container, offset) } catch { return null }
  return probe.toString().length
}
