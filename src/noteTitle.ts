// 笔记标题与服务端 readNote 相同：跳过 YAML 文件头后，采用第一条以「# 」开头的行。
function linesAfter(content: string) {
  if (!content) return []
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') {
      lines.push(content.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < content.length) lines.push(content.slice(start))
  return lines
}

export function splitNoteFrontmatter(content: string) {
  const bom = content.charCodeAt(0) === 0xfeff ? '\uFEFF' : ''
  const source = bom ? content.slice(1) : content
  const lines = linesAfter(source)
  if (lines.length === 0 || lines[0].trim() !== '---') return { prefix: bom, body: source }
  let pos = lines[0].length
  for (let index = 1; index < lines.length; index++) {
    const marker = lines[index].trim()
    if (marker === '---' || marker === '...') {
      const end = pos + lines[index].length
      return { prefix: bom + source.slice(0, end), body: source.slice(end) }
    }
    pos += lines[index].length
  }
  return { prefix: bom, body: source }
}

export function displayedNoteTitle(content: string, fallback: string) {
  const { body } = splitNoteFrontmatter(content)
  for (const line of body.split('\n')) {
    const text = line.replace(/\r$/, '')
    if (text.startsWith('# ')) return text.slice(2).trim()
  }
  return fallback
}

export function applyNoteTitle(content: string, title: string) {
  const safe = title.replace(/[\r\n]+/g, ' ').trim()
  if (!safe) return content
  const { prefix, body } = splitNoteFrontmatter(content)
  const lines = body.split('\n')
  const index = lines.findIndex(line => line.replace(/\r$/, '').startsWith('# '))
  if (index >= 0) {
    const cr = lines[index].endsWith('\r') ? '\r' : ''
    lines[index] = `# ${safe}${cr}`
    return prefix + lines.join('\n')
  }
  const newline = body.includes('\r\n') ? '\r\n' : '\n'
  const heading = `# ${safe}${newline}`
  if (body.length === 0) return `${prefix}${heading}${newline}`
  if (body.startsWith('\n') || body.startsWith('\r\n')) return prefix + heading + body
  return `${prefix}${heading}${newline}${body}`
}
