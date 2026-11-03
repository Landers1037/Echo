import { describe, expect, it } from 'vitest'
import { applyTableEdit, parseTableAt, serializeTable } from './markdownTable'

const sample = [
  '# 标题',
  '',
  '| 列一 | 列二 | 列三 |',
  '| --- | :---: | ---: |',
  '| 内容 | 内容 | 内容 |',
  '| a | b | c |',
  '',
  '段落',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n')

describe('markdownTable', () => {
  it('parses a GFM table at a source line including alignments', () => {
    const table = parseTableAt(sample, 3)
    expect(table).toEqual({
      startLine: 3,
      endLine: 6,
      header: ['列一', '列二', '列三'],
      aligns: ['none', 'center', 'right'],
      rows: [
        ['内容', '内容', '内容'],
        ['a', 'b', 'c'],
      ],
    })
  })

  it('locates a later table without touching the first', () => {
    const table = parseTableAt(sample, 10)
    expect(table?.header).toEqual(['A', 'B'])
    expect(table?.rows).toEqual([['1', '2']])
    expect(applyTableEdit(sample, 10, { type: 'insertColumn', at: 1 })).toContain('| A |  | B |')
    expect(applyTableEdit(sample, 10, { type: 'insertColumn', at: 1 })).toContain('| 列一 | 列二 | 列三 |')
  })

  it('inserts rows and columns at the requested index', () => {
    const withRow = applyTableEdit(sample, 3, { type: 'insertRow', at: 1 })!
    expect(parseTableAt(withRow, 3)?.rows).toEqual([
      ['内容', '内容', '内容'],
      ['', '', ''],
      ['a', 'b', 'c'],
    ])

    const withColumn = applyTableEdit(sample, 3, { type: 'insertColumn', at: 1 })!
    const table = parseTableAt(withColumn, 3)!
    expect(table.header).toEqual(['列一', '', '列二', '列三'])
    expect(table.aligns).toEqual(['none', 'none', 'center', 'right'])
    expect(table.rows[0]).toEqual(['内容', '', '内容', '内容'])
  })

  it('deletes body rows and columns while protecting the last column', () => {
    const deletedRow = applyTableEdit(sample, 3, { type: 'deleteRow', index: 0 })!
    expect(parseTableAt(deletedRow, 3)?.rows).toEqual([['a', 'b', 'c']])

    const emptyBody = applyTableEdit(deletedRow, 3, { type: 'deleteRow', index: 0 })!
    expect(parseTableAt(emptyBody, 3)?.rows).toEqual([])
    expect(serializeTable(parseTableAt(emptyBody, 3)!)).toContain('| 列一 | 列二 | 列三 |')

    expect(applyTableEdit(sample, 3, { type: 'deleteRow', index: -1 })).toBeNull()
    expect(applyTableEdit(sample, 3, { type: 'deleteColumn', index: 1 })!).toContain('| 列一 | 列三 |')
    const oneColumn = applyTableEdit(applyTableEdit(sample, 3, { type: 'deleteColumn', index: 2 })!, 3, { type: 'deleteColumn', index: 1 })!
    expect(parseTableAt(oneColumn, 3)?.header).toEqual(['列一'])
    expect(applyTableEdit(oneColumn, 3, { type: 'deleteColumn', index: 0 })).toBeNull()
  })

  it('returns null when the source line is not a table', () => {
    expect(parseTableAt(sample, 1)).toBeNull()
    expect(applyTableEdit(sample, 8, { type: 'insertRow', at: 0 })).toBeNull()
  })
})
