import { afterEach, describe, expect, it } from 'vitest'
import { anchorFingerprint, blockText, fromAnchorPoint, locateAnchor, offsetsToRange, rangeToOffsets, resolveHighlight, strokeWidthRatio, toAnchorPoint } from './anchor'

afterEach(() => { document.body.replaceChildren() })

describe('annotation anchors', () => {
  it('collapses whitespace and keeps the first 80 characters', () => {
    expect(anchorFingerprint('  第一段\n\n还在  ')).toBe('第一段 还在')
    expect(anchorFingerprint('字'.repeat(90))).toHaveLength(80)
  })

  it('stays on the matching line and otherwise follows the nearest identical paragraph', () => {
    const anchors = [
      { line: 2, text: '新段落' },
      { line: 4, text: '外层 原来的句子' },
      { line: 4, text: '里面的句子' },
      { line: 8, text: '原来的句子' },
      { line: 20, text: '原来的句子' },
    ]
    expect(locateAnchor(anchors, 4, '里面的句子')).toBe(anchors[2])
    expect(locateAnchor(anchors, 2, '  原来的句子  ')?.line).toBe(8)
    expect(locateAnchor(anchors, 2, '找不到')).toBeNull()
  })

  it('round-trips a point relative to its paragraph and the content width', () => {
    const root = { left: 20, top: 40, width: 200 }
    const point = toAnchorPoint(root, 80, 70, 110)
    expect(point).toEqual([0.25, 0.15])
    expect(fromAnchorPoint(root, 80, point)).toEqual({ x: 70, y: 110 })
    expect(strokeWidthRatio(4, 200)).toBeCloseTo(0.02)
  })

  it('keeps a highlight when the quoted text is still in the paragraph', () => {
    expect(resolveHighlight('甲乙丙丁', 0, 2, '甲乙')).toEqual({ start: 0, end: 2 })
    expect(resolveHighlight('前文甲乙丙', 4, 6, '甲乙')).toEqual({ start: 2, end: 4 })
    expect(resolveHighlight('甲乙，还有甲乙', 0, 2, '甲乙')).toEqual({ start: 0, end: 2 })
    expect(resolveHighlight('没有这段', 0, 2, '甲乙')).toBeNull()
  })

  it('converts a selection inside nested text back into the same range', () => {
    const block = document.createElement('p')
    const strong = document.createElement('strong')
    strong.textContent = '丙丁'
    block.append('甲乙', strong, '戊')
    document.body.append(block)
    const range = document.createRange()
    range.setStart(block.firstChild!, 1)
    range.setEnd(strong.firstChild!, 2)
    expect(blockText(block)).toBe('甲乙丙丁戊')
    expect(rangeToOffsets(block, range)).toEqual({ start: 1, end: 4, quote: '乙丙丁' })
    expect(offsetsToRange(block, 1, 4)?.toString()).toBe('乙丙丁')
    expect(rangeToOffsets(block, document.createRange())).toBeNull()
  })
})
