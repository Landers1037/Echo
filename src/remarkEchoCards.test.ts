import { describe, expect, it } from 'vitest'
import remarkDirective from 'remark-directive'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Root, RootContent } from 'mdast'
import { remarkEchoCards, splitEchoCardPanels } from './remarkEchoCards'

function process(content: string, flatten = false) {
  const processor = unified().use(remarkParse).use(remarkDirective).use(remarkEchoCards, { flatten })
  return processor.runSync(processor.parse(content)) as Root
}

describe('splitEchoCardPanels', () => {
  it('groups children by level-2 headings', () => {
    const children = [
      { type: 'heading', depth: 2, children: [{ type: 'text', value: '一' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'A' }] },
      { type: 'heading', depth: 2, children: [{ type: 'text', value: '二' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'B' }] },
    ] as RootContent[]
    expect(splitEchoCardPanels(children)).toEqual([
      { title: '一', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'A' }] }] },
      { title: '二', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'B' }] }] },
    ])
  })

  it('uses a placeholder panel when content precedes the first heading', () => {
    const children = [
      { type: 'paragraph', children: [{ type: 'text', value: '前言' }] },
      { type: 'heading', depth: 2, children: [{ type: 'text', value: '正文' }] },
    ] as RootContent[]
    const panels = splitEchoCardPanels(children)
    expect(panels[0]?.title).toBe('未命名')
    expect(panels[1]?.title).toBe('正文')
  })
})

describe('remarkEchoCards', () => {
  it('turns a titled card into an echo-card div', () => {
    const tree = process(':::card[概览]\n你好\n:::\n')
    const card = tree.children[0] as RootContent & { data?: { hProperties?: Record<string, unknown> }; children: RootContent[] }
    expect(card.data?.hProperties).toMatchObject({
      'data-echo-card': 'card',
      'data-title': '概览',
    })
    expect(card.children[0]?.type).toBe('paragraph')
  })

  it('splits tab panels by h2 headings', () => {
    const tree = process(':::htabs\n## 甲\n一\n\n## 乙\n二\n:::\n')
    const card = tree.children[0] as RootContent & {
      data?: { hProperties?: Record<string, unknown> }
      children: Array<{ data?: { hProperties?: Record<string, unknown> } }>
    }
    expect(card.data?.hProperties?.['data-echo-card']).toBe('htabs')
    expect(card.children).toHaveLength(2)
    expect(card.children[0]?.data?.hProperties?.['data-title']).toBe('甲')
    expect(card.children[1]?.data?.hProperties?.['data-title']).toBe('乙')
  })

  it('leaves unknown directives untouched', () => {
    const tree = process(':::note\n提示\n:::\n')
    const node = tree.children[0] as { type: string; name?: string; data?: unknown }
    expect(node.type).toBe('containerDirective')
    expect(node.name).toBe('note')
    expect(node.data).toBeUndefined()
  })

  it('flattens cards into headings for export', () => {
    const tree = process(':::card[标题]\n正文\n:::\n', true)
    expect(tree.children[0]).toMatchObject({ type: 'heading', depth: 2 })
    expect(tree.children[1]?.type).toBe('paragraph')
  })

  it('flattens multi-panel cards into sequential headings', () => {
    const tree = process(':::accordion\n## 一\nA\n\n## 二\nB\n:::\n', true)
    const headings = tree.children.filter(child => child.type === 'heading')
    expect(headings).toHaveLength(2)
  })
})
