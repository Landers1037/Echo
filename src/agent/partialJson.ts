export type PartialString = { value: string; complete: boolean }

type ReadString = PartialString & { end: number }

const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

function readString(source: string, start: number): ReadString | null {
  if (source[start] !== '"') return null
  let value = ''
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      if (index + 1 >= source.length) return { value, complete: false, end: source.length }
      const next = source[index + 1]
      if (next === 'u') {
        if (index + 6 > source.length) return { value, complete: false, end: source.length }
        const hex = source.slice(index + 2, index + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, complete: false, end: source.length }
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 6
        continue
      }
      value += escapes[next] ?? next
      index += 2
      continue
    }
    if (char === '"') return { value, complete: true, end: index + 1 }
    value += char
    index++
  }
  return { value, complete: false, end: source.length }
}

function skipSpace(source: string, index: number) {
  while (index < source.length && /\s/.test(source[index])) index++
  return index
}

function findValue(source: string, field: string) {
  let index = 0
  while (index < source.length) {
    if (source[index] !== '"') { index++; continue }
    const key = readString(source, index)
    if (!key?.complete) return -1
    if (key.value === field) {
      let cursor = skipSpace(source, key.end)
      if (source[cursor] === ':') return skipSpace(source, cursor + 1)
    }
    index = key.end
  }
  return -1
}

export function extractStringField(source: string, field: string): PartialString | null {
  const start = findValue(source, field)
  if (start < 0 || source[start] !== '"') return null
  const value = readString(source, start)
  return value ? { value: value.value, complete: value.complete } : null
}

export type PartialEdit = { search: string; searchComplete: boolean; replace: string; replaceComplete: boolean }

function scanContainer(source: string, start: number) {
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let index = start
  while (index < source.length) {
    if (source[index] === '"') {
      const text = readString(source, index)
      if (!text?.complete) return source.length
      index = text.end
      continue
    }
    if (source[index] === open) depth++
    else if (source[index] === close) {
      depth--
      if (depth === 0) return index + 1
    }
    index++
  }
  return source.length
}

export function extractEdits(source: string): PartialEdit[] {
  const start = findValue(source, 'edits')
  if (start < 0 || source[start] !== '[') return []
  const edits: PartialEdit[] = []
  let index = start + 1
  while (index < source.length) {
    index = skipSpace(source, index)
    if (index >= source.length || source[index] === ']') break
    if (source[index] === ',') { index++; continue }
    if (source[index] !== '{') break
    const end = scanContainer(source, index)
    const slice = source.slice(index, end)
    const search = extractStringField(slice, 'search')
    const replace = extractStringField(slice, 'replace')
    edits.push({
      search: search?.value ?? '',
      searchComplete: Boolean(search?.complete),
      replace: replace?.value ?? '',
      replaceComplete: Boolean(replace?.complete),
    })
    if (end <= index) break
    index = end
  }
  return edits
}
