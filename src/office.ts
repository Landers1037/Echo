import type { LibraryDocumentType, OfficeTreeType, TreeEntry } from './types'

export function isOfficePath(path: string) {
  return /\.(?:docx|pptx|xlsx)$/i.test(path)
}

export function isHtmlPath(path: string) {
  return /\.html?$/i.test(path)
}

export function isLibraryDocumentPath(path: string) {
  return isOfficePath(path) || isHtmlPath(path)
}

export function officeTreeType(path: string): OfficeTreeType | null {
  const match = path.match(/\.(docx|pptx|xlsx)$/i)
  return match ? match[1].toLowerCase() as OfficeTreeType : null
}

export function isOfficeTreeType(type: TreeEntry['type']): type is OfficeTreeType {
  return type === 'docx' || type === 'pptx' || type === 'xlsx'
}

export function isHtmlTreeType(type: TreeEntry['type']): type is 'html' {
  return type === 'html'
}

export function isLibraryDocumentTreeType(type: TreeEntry['type']): type is LibraryDocumentType {
  return isOfficeTreeType(type) || type === 'html'
}

export function collectOfficePaths(entries: TreeEntry[], result: string[] = []) {
  for (const entry of entries) {
    if (isLibraryDocumentTreeType(entry.type)) result.push(entry.path)
    if (entry.children?.length) collectOfficePaths(entry.children, result)
  }
  return result
}

export function officeDisplayName(path: string) {
  return path.split('/').pop()?.replace(/\.(?:docx|pptx|xlsx|html|htm)$/i, '') || path
}
