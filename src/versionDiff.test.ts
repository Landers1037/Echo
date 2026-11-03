import { describe, expect, it } from 'vitest'
import { diffLines } from './versionDiff'

describe('diffLines', () => {
  it('marks added and deleted lines', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nx\nc\n')
    expect(lines.map(line => [line.type, line.text])).toEqual([
      ['equal', 'a'],
      ['del', 'b'],
      ['add', 'x'],
      ['equal', 'c'],
      ['equal', ''],
    ])
  })

  it('handles empty sides', () => {
    expect(diffLines('', 'one\n')).toEqual([
      { type: 'add', text: 'one', right: 1 },
      { type: 'add', text: '', right: 2 },
    ])
    expect(diffLines('gone\n', '')).toEqual([
      { type: 'del', text: 'gone', left: 1 },
      { type: 'del', text: '', left: 2 },
    ])
  })
})
