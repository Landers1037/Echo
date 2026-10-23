import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'

export type NoteHeading = { line: number; depth: number; title: string }
type MarkdownNode = {
  type: string
  depth?: number
  value?: string
  alt?: string | null
  children?: MarkdownNode[]
  position?: { start: { line: number } }
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter)

function headingText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value || ''
  if (node.type === 'image' || node.type === 'imageReference') return node.alt || ''
  if (node.type === 'break') return ' '
  return node.children?.map(headingText).join('') || ''
}

export function parseNoteHeadings(content: string): NoteHeading[] {
  const headings: NoteHeading[] = []
  function visit(node: MarkdownNode) {
    if (node.type === 'heading' && node.depth && node.depth <= 5 && node.position) {
      headings.push({ line: node.position.start.line, depth: node.depth, title: headingText(node).replace(/\s+/g, ' ').trim() || '未命名标题' })
      return
    }
    node.children?.forEach(visit)
  }
  visit(parser.parse(content))
  return headings
}
