export type TextRange = { from: number; to: number }

export function findUniqueRange(doc: string, search: string): TextRange | { error: string } {
  if (search === '') return { error: '查找内容为空' }
  const from = doc.indexOf(search)
  if (from < 0) return { error: '找不到匹配文本' }
  if (doc.indexOf(search, from + 1) >= 0) return { error: '匹配不唯一' }
  return { from, to: from + search.length }
}
