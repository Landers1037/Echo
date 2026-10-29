export const NOTE_REF_TITLE = 'echo-ref'

function encodeSegment(part: string) {
  return encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

export function relativeNoteHref(from: string, to: string) {
  const left = from.split('/').slice(0, -1)
  const right = to.split('/').filter(part => part.length > 0)
  while (left.length && right.length && left[0] === right[0]) {
    left.shift()
    right.shift()
  }
  return [...left.map(() => '..'), ...right].map(part => part === '..' ? part : encodeSegment(part)).join('/')
}

function linkLabel(title: string, path: string) {
  const fallback = (path.split('/').pop() || path).replace(/\.md$/i, '')
  const text = title.replace(/[\r\n]+/g, ' ').replace(/[\[\]]/g, '').replace(/\\/g, '\\\\').replace(/\s+/g, ' ').trim()
  return text || fallback.replace(/[\[\]]/g, '').replace(/\\/g, '\\\\')
}

export function noteReferenceMarkdown(fromPath: string, target: { path: string; title: string }) {
  return `[${linkLabel(target.title, target.path)}](${relativeNoteHref(fromPath, target.path)} "${NOTE_REF_TITLE}")`
}

export function drawioReferenceMarkdown(fromPath: string, targetPath: string) {
  const file = targetPath.split('/').pop() || targetPath
  return `![${linkLabel(file.replace(/\.drawio$/i, ''), targetPath)}](${relativeNoteHref(fromPath, targetPath)})`
}
