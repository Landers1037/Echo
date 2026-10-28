import { describe, expect, it } from 'vitest'
import { findUniqueRange } from './noteEdits'

describe('note edit lookup', () => {
  const doc = '你好世界\n你好'

  it('finds one exact match', () => {
    expect(findUniqueRange(doc, '世界')).toEqual({ from: 2, to: 4 })
  })

  it('rejects an empty, missing, or repeated search', () => {
    expect(findUniqueRange(doc, '')).toEqual({ error: '查找内容为空' })
    expect(findUniqueRange(doc, '不存在')).toEqual({ error: '找不到匹配文本' })
    expect(findUniqueRange(doc, '你好')).toEqual({ error: '匹配不唯一' })
    expect(findUniqueRange('aaa', 'aa')).toEqual({ error: '匹配不唯一' })
  })
})
