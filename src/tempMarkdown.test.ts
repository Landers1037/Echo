import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempMarkdown, isTempMarkdownPath, listTempMarkdownPaths, pruneTempMarkdownStorage, readTempMarkdown, removeTempMarkdown, tempMarkdownLabel, tempMarkdownPath, TempMarkdownQuotaError } from './tempMarkdown'

beforeEach(() => localStorage.clear())

describe('temporary markdown storage', () => {
  it('stores each drop separately, even when the file name is reused', () => {
    const first = createTempMarkdown('重复.md', '# 第一份\n')
    const second = createTempMarkdown('重复.md', '# 第二份\n')
    expect(first.id).not.toBe(second.id)
    expect(isTempMarkdownPath(tempMarkdownPath(first.id))).toBe(true)
    expect(isTempMarkdownPath('笔记.md')).toBe(false)
    expect(isTempMarkdownPath('temp-md:')).toBe(false)
    expect(readTempMarkdown(tempMarkdownPath(first.id))).toMatchObject({ name: '重复.md', content: '# 第一份\n' })
    expect(readTempMarkdown(tempMarkdownPath(second.id))?.content).toBe('# 第二份\n')
    expect(tempMarkdownLabel(tempMarkdownPath(first.id))).toBe('重复')
    expect(listTempMarkdownPaths()).toEqual(expect.arrayContaining([tempMarkdownPath(first.id), tempMarkdownPath(second.id)]))
  })

  it('removes one preview without touching the other and drops anything left outside the open tabs', () => {
    const kept = createTempMarkdown('保留.md', '保留')
    const closed = createTempMarkdown('关闭.md', '关闭')
    removeTempMarkdown(tempMarkdownPath(closed.id))
    expect(readTempMarkdown(tempMarkdownPath(closed.id))).toBeNull()
    expect(localStorage.getItem(`echo:temp-md:${closed.id}`)).toBeNull()
    localStorage.setItem('echo:temp-md:orphan', JSON.stringify({ id: 'orphan', name: '孤儿.md', content: '孤儿', createdAt: '' }))
    pruneTempMarkdownStorage([tempMarkdownPath(kept.id), '测试.md'])
    expect(readTempMarkdown(tempMarkdownPath(kept.id))?.content).toBe('保留')
    expect(localStorage.getItem('echo:temp-md:orphan')).toBeNull()
    expect(listTempMarkdownPaths()).toEqual([tempMarkdownPath(kept.id)])
  })

  it('ignores unreadable entries and reports a friendly error when storage is full', () => {
    localStorage.setItem('echo:temp-md:bad', '{')
    expect(readTempMarkdown('temp-md:bad')).toBeNull()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => createTempMarkdown('太大.md', 'x')).toThrow(TempMarkdownQuotaError)
    expect(() => createTempMarkdown('太大.md', 'x')).toThrow('浏览器存储空间不足，无法预览该 Markdown 文件。')
    setItem.mockRestore()
  })
})
