import type { OfficeTreeType, TreeEntry } from './types'

export function isOfficePath(path: string) {
  return /\.(?:docx|pptx|xlsx)$/i.test(path)
}

export function officeTreeType(path: string): OfficeTreeType | null {
  const match = path.match(/\.(docx|pptx|xlsx)$/i)
  return match ? match[1].toLowerCase() as OfficeTreeType : null
}

export function isOfficeTreeType(type: TreeEntry['type']): type is OfficeTreeType {
  return type === 'docx' || type === 'pptx' || type === 'xlsx'
}

export function collectOfficePaths(entries: TreeEntry[], result: string[] = []) {
  for (const entry of entries) {
    if (isOfficeTreeType(entry.type)) result.push(entry.path)
    if (entry.children?.length) collectOfficePaths(entry.children, result)
  }
  return result
}

export function officeDisplayName(path: string) {
  return path.split('/').pop()?.replace(/\.(?:docx|pptx|xlsx)$/i, '') || path
}
