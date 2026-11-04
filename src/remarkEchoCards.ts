import { visit } from 'unist-util-visit'
import type { Heading, PhrasingContent, Root, RootContent } from 'mdast'

export const ECHO_CARD_KINDS = ['card', 'htabs', 'vtabs', 'accordion', 'carousel'] as const
export type EchoCardKind = (typeof ECHO_CARD_KINDS)[number]

export const ECHO_CARD_TEMPLATES: Record<EchoCardKind, string> = {
  card: '\n:::card[卡片标题]\n在这里编写卡片内容。\n:::\n',
  htabs: '\n:::htabs\n## 标签一\n第一页内容\n\n## 标签二\n第二页内容\n:::\n',
  vtabs: '\n:::vtabs\n## 侧栏一\n第一页内容\n\n## 侧栏二\n第二页内容\n:::\n',
  accordion: '\n:::accordion\n## 分区一\n展开后的内容\n\n## 分区二\n另一段折叠内容\n:::\n',
  carousel: '\n:::carousel\n## 幻灯一\n第一页内容\n\n## 幻灯二\n第二页内容\n:::\n',
}

type DirectiveNode = {
  type: 'containerDirective'
  name: string
  attributes?: Record<string, string | null | undefined> | null
  children: RootContent[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

type PanelNode = {
  type: 'echoCardPanel'
  data: { hName: 'div'; hProperties: Record<string, unknown> }
  children: RootContent[]
}

function isEchoCardKind(name: string): name is EchoCardKind {
  return (ECHO_CARD_KINDS as readonly string[]).includes(name)
}

function plainText(node: { type?: string; value?: string; children?: unknown[] } | null | undefined): string {
  if (!node) return ''
  if (typeof node.value === 'string') return node.value
  if (!Array.isArray(node.children)) return ''
  return node.children.map(child => plainText(child as { type?: string; value?: string; children?: unknown[] })).join('')
}

function takeDirectiveLabel(node: DirectiveNode) {
  const fromAttrs = (node.attributes?.title || '').trim()
  const first = node.children[0] as (RootContent & { data?: { directiveLabel?: boolean } }) | undefined
  if (first?.data?.directiveLabel) {
    node.children = node.children.slice(1)
    return plainText(first).trim() || fromAttrs
  }
  return fromAttrs
}

export function splitEchoCardPanels(children: RootContent[]): { title: string; children: RootContent[] }[] {
  const panels: { title: string; children: RootContent[] }[] = []
  let current: { title: string; children: RootContent[] } | null = null
  for (const child of children) {
    if (child.type === 'heading' && (child as Heading).depth === 2) {
      current = { title: plainText(child).trim() || '未命名', children: [] }
      panels.push(current)
      continue
    }
    if (!current) {
      current = { title: '未命名', children: [] }
      panels.push(current)
    }
    current.children.push(child)
  }
  return panels.length ? panels : [{ title: '未命名', children: [] }]
}

function headingNode(title: string, depth: 2 | 3 = 2): Heading {
  return {
    type: 'heading',
    depth,
    children: [{ type: 'text', value: title }] as PhrasingContent[],
  }
}

function panelNode(title: string, children: RootContent[]): PanelNode {
  return {
    type: 'echoCardPanel',
    data: {
      hName: 'div',
      hProperties: {
        className: ['echo-card-panel'],
        'data-title': title,
      },
    },
    children,
  }
}

function flattenDirective(node: DirectiveNode): RootContent[] {
  if (node.name === 'card') {
    const title = takeDirectiveLabel(node)
    return title ? [headingNode(title), ...node.children] : [...node.children]
  }
  const panels = splitEchoCardPanels(node.children)
  const next: RootContent[] = []
  for (const panel of panels) {
    next.push(headingNode(panel.title))
    next.push(...panel.children)
  }
  return next
}

function transformDirective(node: DirectiveNode) {
  const kind = node.name
  if (kind === 'card') {
    const title = takeDirectiveLabel(node)
    node.data = {
      hName: 'div',
      hProperties: {
        className: ['echo-card', 'echo-card--card'],
        'data-echo-card': 'card',
        ...(title ? { 'data-title': title } : {}),
      },
    }
    return
  }
  takeDirectiveLabel(node)
  const panels = splitEchoCardPanels(node.children)
  node.data = {
    hName: 'div',
    hProperties: {
      className: ['echo-card', `echo-card--${kind}`],
      'data-echo-card': kind,
    },
  }
  ;(node as { children: RootContent[] }).children = panels.map(panel => panelNode(panel.title, panel.children) as unknown as RootContent)
}

/** Turns `:::card` / `:::htabs` / … containers into preview-ready divs, or flattens them for DOCX. */
export function remarkEchoCards(options?: { flatten?: boolean }) {
  const flatten = options?.flatten ?? false
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (!parent || typeof index !== 'number') return
      if (node.type !== 'containerDirective') return
      const directive = node as unknown as DirectiveNode
      if (!isEchoCardKind(directive.name)) return
      if (flatten) {
        const replacement = flattenDirective(directive)
        parent.children.splice(index, 1, ...replacement)
        return index + replacement.length
      }
      transformDirective(directive)
    })
  }
}
