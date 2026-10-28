import { describe, expect, it } from 'vitest'
import { extractEdits, extractStringField } from './partialJson'

describe('partial JSON', () => {
  it('reads a complete and an unfinished string field', () => {
    expect(extractStringField('{"text":"你好"}', 'text')).toEqual({ value: '你好', complete: true })
    expect(extractStringField('{"text":"你好', 'text')).toEqual({ value: '你好', complete: false })
    expect(extractStringField('{"content":"a\\"b\\n"}', 'content')).toEqual({ value: 'a"b\n', complete: true })
  })

  it('extracts edits as their search text completes', () => {
    expect(extractEdits('{"edits":[{"search":"你好","replace":"你')).toEqual([
      { search: '你好', searchComplete: true, replace: '你', replaceComplete: false },
    ])
    expect(extractEdits('{"edits":[{"search":"你好","replace":"你好，世界"},{"search":"第二')).toEqual([
      { search: '你好', searchComplete: true, replace: '你好，世界', replaceComplete: true },
      { search: '第二', searchComplete: false, replace: '', replaceComplete: false },
    ])
  })
})
