import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Annotation, AnnotationHighlight, AnnotationStroke } from '../../types'
import { anchorFingerprint, blockText, fromAnchorPoint, highlightStyleName, locateAnchor, offsetsToRange, rangeToOffsets, resolveHighlight, strokeWidthRatio, toAnchorPoint } from './anchor'
import type { AnnotationDraft, AnnotationToolName } from './useAnnotations'
import './Annotations.css'

type Draft = { block: HTMLElement; anchorLine: number; anchorText: string; points: [number, number][] }
type SelectionDraft = { anchorLine: number; anchorText: string; start: number; end: number; quote: string; top: number; left: number; writing: boolean; comment: string }
type StrokeView = { id: string; color: string; width: number; points: [number, number][] }
type HighlightView = { id: string; color: string; comment: string; bubble: { x: number; y: number } | null; rects: { x: number; y: number; width: number; height: number }[] }
type AnchorElement = { line: number; text: string; element: HTMLElement }

const highlightSupported = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && Boolean(CSS.highlights)

export function AnnotationLayer({ items, tool, color, strokePixels, onCreate, onUpdate, onDelete, onStaleChange }: {
  items: Annotation[]
  tool: AnnotationToolName | null
  color: string
  strokePixels: number
  onCreate: (draft: AnnotationDraft) => Promise<Annotation>
  onUpdate: (id: string, comment: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onStaleChange?: (ids: string[]) => void
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const hits = useRef<{ id: string; range: Range }[]>([])
  const owned = useRef<Range[]>([])
  const reported = useRef('')
  const [strokes, setStrokes] = useState<StrokeView[]>([])
  const [highlights, setHighlights] = useState<HighlightView[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selection, setSelection] = useState<SelectionDraft | null>(null)
  const [editor, setEditor] = useState<{ id: string; value: string } | null>(null)
  const readOnly = tool == null

  useEffect(() => {
    const layer = layerRef.current
    const root = layer?.parentElement
    if (!layer || !root) return
    const measure = () => {
      const anchors = collectAnchors(root)
      const rootRect = root.getBoundingClientRect()
      const layerRect = layer.getBoundingClientRect()
      const nextStrokes: StrokeView[] = []
      const nextHighlights: HighlightView[] = []
      const nextHits: { id: string; range: Range }[] = []
      const stale: string[] = []
      clearHighlights(owned.current)
      owned.current = []
      for (const item of items) {
        const anchor = locateAnchor(anchors, item.anchorLine, item.anchorText)
        if (!anchor) { stale.push(item.id); continue }
        if (item.kind === 'stroke') {
          const data = item.data as AnnotationStroke
          if (!data.points?.length) { stale.push(item.id); continue }
          nextStrokes.push({ id: item.id, color: item.color, width: data.width * rootRect.width, points: toLayerPoints(rootRect, layerRect, anchor.element, data.points) })
          continue
        }
        const data = item.data as AnnotationHighlight
        const resolved = resolveHighlight(blockText(anchor.element), data.start, data.end, data.quote)
        const range = resolved ? offsetsToRange(anchor.element, resolved.start, resolved.end) : null
        if (!range) { stale.push(item.id); continue }
        const rects = highlightSupported ? [] : clientRects(range, layerRect)
        const end = range.getBoundingClientRect()
        nextHighlights.push({
          id: item.id,
          color: item.color,
          comment: item.comment,
          rects,
          bubble: end.width || end.height ? { x: end.right - layerRect.left, y: end.top - layerRect.top } : null,
        })
        nextHits.push({ id: item.id, range })
        paintHighlight(range, item.color, owned.current)
      }
      hits.current = nextHits
      setStrokes(nextStrokes)
      setHighlights(nextHighlights)
      const key = stale.join('\n')
      if (reported.current !== key) {
        reported.current = key
        onStaleChange?.(stale)
      }
    }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(root)
    const mutations = new MutationObserver(records => {
      if (records.every(record => layer.contains(record.target))) return
      measure()
    })
    mutations.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      resize.disconnect()
      mutations.disconnect()
      clearHighlights(owned.current)
      owned.current = []
    }
  }, [items, onStaleChange])

  useEffect(() => { if (tool !== 'highlight') setSelection(null) }, [tool])
  useEffect(() => {
    if (tool !== 'highlight') return
    const onUp = () => {
      const layer = layerRef.current
      const root = layer?.parentElement
      if (!layer || !root) return
      const selected = document.getSelection()
      if (!selected || selected.isCollapsed || selected.rangeCount === 0) return
      const range = selected.getRangeAt(0)
      const start = sourceBlock(range.startContainer, root)
      const end = sourceBlock(range.endContainer, root)
      if (!start || start !== end) { setSelection(null); return }
      const offsets = rangeToOffsets(start, range)
      const line = Number(start.dataset.sourceLine)
      if (!offsets || !Number.isInteger(line)) { setSelection(null); return }
      const rect = range.getBoundingClientRect()
      const layerRect = layer.getBoundingClientRect()
      setSelection({ anchorLine: line, anchorText: anchorFingerprint(blockText(start)), ...offsets, top: rect.bottom - layerRect.top + 6, left: Math.max(0, rect.left - layerRect.left), writing: false, comment: '' })
    }
    document.addEventListener('pointerup', onUp)
    return () => document.removeEventListener('pointerup', onUp)
  }, [tool])

  useEffect(() => {
    if (tool !== 'eraser') return
    const root = layerRef.current?.parentElement
    if (!root) return
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.annotation-stroke, .annotation-bubble, .annotation-popover')) return
      const hit = hits.current.find(item => rectsContain(item.range.getClientRects(), event.clientX, event.clientY))
      if (hit) { event.preventDefault(); event.stopPropagation(); void onDelete(hit.id) }
    }
    root.addEventListener('click', onClick, true)
    return () => root.removeEventListener('click', onClick, true)
  }, [tool, onDelete, highlights])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (tool !== 'pen' || event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('.annotation-popover, .annotation-bubble')) return
    const root = event.currentTarget.parentElement
    if (!root) return
    const block = blockAtPoint(root, event.clientX, event.clientY)
    const line = Number(block?.dataset.sourceLine)
    if (!block || !Number.isInteger(line)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = toAnchorPoint(root.getBoundingClientRect(), block.getBoundingClientRect().top, event.clientX, event.clientY)
    setDraft({ block, anchorLine: line, anchorText: anchorFingerprint(blockText(block)), points: [point] })
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draft || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const root = event.currentTarget.parentElement
    if (!root) return
    const point = toAnchorPoint(root.getBoundingClientRect(), draft.block.getBoundingClientRect().top, event.clientX, event.clientY)
    setDraft(current => {
      if (!current) return current
      const last = current.points[current.points.length - 1]
      if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.002) return current
      return { ...current, points: [...current.points, point] }
    })
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draft) return
    const root = event.currentTarget.parentElement
    const finished = draft
    setDraft(null)
    if (!root) return
    const ratio = strokeWidthRatio(strokePixels, root.getBoundingClientRect().width)
    void onCreate({ kind: 'stroke', anchorLine: finished.anchorLine, anchorText: finished.anchorText, color, data: { points: finished.points, width: ratio }, comment: '' }).catch(() => {})
  }

  async function createHighlight() {
    if (!selection) return
    const next = selection
    setSelection(null)
    document.getSelection()?.removeAllRanges()
    await onCreate({ kind: 'highlight', anchorLine: next.anchorLine, anchorText: next.anchorText, color, data: { start: next.start, end: next.end, quote: next.quote }, comment: next.comment }).catch(() => {})
  }

  const draftPoints = draft && layerRef.current?.parentElement ? toLayerPoints(layerRef.current.parentElement.getBoundingClientRect(), layerRef.current.getBoundingClientRect(), draft.block, draft.points) : []
  const activeEditor = editor ? highlights.find(item => item.id === editor.id) : undefined

  return <div ref={layerRef} className={`annotation-layer${tool === 'pen' ? ' is-pen' : tool === 'eraser' ? ' is-eraser' : ' is-idle'}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
    <svg className="annotation-strokes" aria-hidden="true">
      {strokes.map(stroke => <StrokeShape key={stroke.id} stroke={stroke} eraser={tool === 'eraser'} onDelete={() => void onDelete(stroke.id)} />)}
      {draftPoints.length > 0 && <StrokeShape stroke={{ id: 'draft', color, width: strokePixels, points: draftPoints }} />}
    </svg>
    {highlights.map(item => <span key={item.id}>
      {item.rects.map((rect, index) => <span key={index} className="annotation-highlight-rect" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, background: item.color }} />)}
      {item.bubble && (!readOnly || item.comment) && <button type="button" className="annotation-bubble" style={{ left: item.bubble.x, top: item.bubble.y, color: item.color }} aria-label={item.comment ? '查看批注' : '添加批注'} onPointerDown={event => event.stopPropagation()} onClick={() => setEditor({ id: item.id, value: item.comment })}>{item.comment ? '注' : '+'}</button>}
    </span>)}
    {activeEditor && activeEditor.bubble && editor && <form className="annotation-popover" style={{ left: activeEditor.bubble.x, top: activeEditor.bubble.y + 18 }} onPointerDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (readOnly) return; void onUpdate(editor.id, editor.value).then(() => setEditor(null)).catch(() => {}) }}>
      {readOnly ? <p>{activeEditor.comment}</p> : <>
        <label className="field-label" htmlFor={`annotation-${activeEditor.id}`}>批注</label>
        <textarea id={`annotation-${activeEditor.id}`} value={editor.value} maxLength={2000} onChange={event => setEditor({ id: activeEditor.id, value: event.target.value })} />
        <div className="annotation-popover-actions">
          <button type="button" className="button danger" onClick={() => { const id = activeEditor.id; setEditor(null); void onDelete(id) }}>删除</button>
          <button type="submit" className="button primary">保存</button>
        </div>
      </>}
      {readOnly && <button type="button" className="button" onClick={() => setEditor(null)}>关闭</button>}
    </form>}
    {selection && <div className="annotation-popover" style={{ left: selection.left, top: selection.top }} onPointerDown={event => event.stopPropagation()}>
      {selection.writing ? <>
        <label className="field-label" htmlFor="annotation-new-comment">批注</label>
        <textarea id="annotation-new-comment" autoFocus value={selection.comment} maxLength={2000} onChange={event => setSelection({ ...selection, comment: event.target.value })} />
        <div className="annotation-popover-actions">
          <button type="button" className="button" onClick={() => setSelection({ ...selection, writing: false, comment: '' })}>取消</button>
          <button type="button" className="button primary" onClick={() => void createHighlight()}>保存高亮</button>
        </div>
      </> : <div className="annotation-popover-actions">
        <button type="button" className="button primary" onClick={() => void createHighlight()}>高亮</button>
        <button type="button" className="button" onClick={() => setSelection({ ...selection, writing: true })}>添加批注</button>
      </div>}
    </div>}
  </div>
}

function StrokeShape({ stroke, eraser = false, onDelete }: { stroke: StrokeView; eraser?: boolean; onDelete?: () => void }) {
  const [first, ...rest] = stroke.points
  if (!first) return null
  const handlers = eraser ? { onPointerDown: (event: ReactPointerEvent) => { event.preventDefault(); event.stopPropagation(); onDelete?.() } } : {}
  if (!rest.length) return <circle className="annotation-stroke" cx={first[0]} cy={first[1]} r={Math.max(stroke.width / 2, 1)} fill={stroke.color} {...handlers} />
  return <polyline className="annotation-stroke" points={stroke.points.map(point => point.join(',')).join(' ')} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" {...handlers} />
}

function collectAnchors(root: HTMLElement): AnchorElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-source-line]')].flatMap(element => {
    if (element.closest('.annotation-layer')) return []
    const line = Number(element.dataset.sourceLine)
    if (!Number.isInteger(line) || line < 1) return []
    return [{ line, text: blockText(element), element }]
  })
}

function sourceBlock(node: Node, root: HTMLElement) {
  const element = node instanceof Element ? node : node.parentElement
  const block = element?.closest<HTMLElement>('[data-source-line]')
  if (!block || !root.contains(block) || block.closest('.annotation-layer')) return null
  return block
}

function blockAtPoint(root: HTMLElement, x: number, y: number) {
  let best: HTMLElement | null = null
  let bestArea = Infinity
  for (const anchor of collectAnchors(root)) {
    const rect = anchor.element.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
    const area = Math.max(rect.width * rect.height, 1)
    if (area <= bestArea) { best = anchor.element; bestArea = area }
  }
  if (best) return best
  let nearest: HTMLElement | null = null
  let nearestDistance = Infinity
  for (const anchor of collectAnchors(root)) {
    const rect = anchor.element.getBoundingClientRect()
    const distance = y < rect.top ? rect.top - y : Math.max(0, y - rect.bottom)
    if (distance < nearestDistance) { nearest = anchor.element; nearestDistance = distance }
  }
  return nearest
}

function toLayerPoints(root: DOMRect, layer: DOMRect, block: HTMLElement, points: [number, number][]) {
  const blockTop = block.getBoundingClientRect().top
  return points.map(point => {
    const client = fromAnchorPoint(root, blockTop, point)
    return [client.x - layer.left, client.y - layer.top] as [number, number]
  })
}

function clientRects(range: Range, layer: DOMRect) {
  return [...range.getClientRects()].map(rect => ({ x: rect.left - layer.left, y: rect.top - layer.top, width: rect.width, height: rect.height }))
}

function rectsContain(rects: DOMRectList, x: number, y: number) {
  return [...rects].some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
}

function paintHighlight(range: Range, color: string, owned: Range[]) {
  if (!highlightSupported) return
  const name = highlightStyleName(color)
  let highlight = CSS.highlights.get(name)
  if (!highlight) {
    highlight = new Highlight()
    CSS.highlights.set(name, highlight)
  }
  highlight.add(range)
  owned.push(range)
}

function clearHighlights(ranges: Range[]) {
  if (!highlightSupported) return
  for (const range of ranges) {
    for (const highlight of CSS.highlights.values()) highlight.delete(range)
  }
}
