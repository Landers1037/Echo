export type TableAlign = 'left' | 'center' | 'right' | 'none'

export type ParsedTable = {
  startLine: number
  endLine: number
  header: string[]
  aligns: TableAlign[]
  rows: string[][]
}

export type TableEditAction =
  | { type: 'insertRow'; at: number }
  | { type: 'insertColumn'; at: number }
  | { type: 'deleteRow'; index: number }
  | { type: 'deleteColumn'; index: number }

const rowLine = /^\s*\|.*\|\s*$/
const separatorCell = /^\s*:?-{3,}:?\s*$/

function splitRow(line: string): string[] {
  const trimmed = line.trim()
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const body = inner.endsWith('|') ? inner.slice(0, -1) : inner
  return body.split('|').map(cell => cell.trim())
}

function isSeparatorRow(cells: string[]) {
  return cells.length > 0 && cells.every(cell => separatorCell.test(cell))
}

function parseAlign(cell: string): TableAlign {
  const value = cell.trim()
  const left = value.startsWith(':')
  const right = value.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'none'
}

function formatAlign(align: TableAlign) {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  if (align === 'left') return ':---'
  return '---'
}

function padColumns(cells: string[], columns: number) {
  const next = cells.slice(0, columns)
  while (next.length < columns) next.push('')
  return next
}

function serializeRow(cells: string[]) {
  return `| ${cells.map(cell => cell.replace(/\n/g, ' ')).join(' | ')} |`
}

export function serializeTable(table: Pick<ParsedTable, 'header' | 'aligns' | 'rows'>) {
  const columns = Math.max(1, table.header.length)
  const header = padColumns(table.header, columns)
  const aligns = padColumns(table.aligns.map(formatAlign), columns).map((_, index) => formatAlign(table.aligns[index] || 'none'))
  const rows = table.rows.map(row => padColumns(row, columns))
  return [serializeRow(header), serializeRow(aligns), ...rows.map(serializeRow)].join('\n')
}

export function parseTableAt(content: string, startLine: number): ParsedTable | null {
  const lines = content.split('\n')
  const index = startLine - 1
  if (index < 0 || index >= lines.length) return null
  if (!rowLine.test(lines[index])) return null
  const header = splitRow(lines[index])
  if (!header.length) return null
  if (index + 1 >= lines.length) return null
  const separator = splitRow(lines[index + 1])
  if (!isSeparatorRow(separator)) return null
  const columns = Math.max(header.length, separator.length)
  const aligns = padColumns(separator, columns).map(parseAlign)
  const rows: string[][] = []
  let end = index + 1
  for (let cursor = index + 2; cursor < lines.length; cursor++) {
    const line = lines[cursor]
    if (!rowLine.test(line)) break
    const cells = splitRow(line)
    if (isSeparatorRow(cells)) break
    rows.push(padColumns(cells, columns))
    end = cursor
  }
  return {
    startLine,
    endLine: end + 1,
    header: padColumns(header, columns),
    aligns,
    rows,
  }
}

function replaceTable(content: string, table: ParsedTable, next: Pick<ParsedTable, 'header' | 'aligns' | 'rows'>) {
  const lines = content.split('\n')
  const serialized = serializeTable(next).split('\n')
  lines.splice(table.startLine - 1, table.endLine - table.startLine + 1, ...serialized)
  return lines.join('\n')
}

export function applyTableEdit(content: string, startLine: number, action: TableEditAction): string | null {
  const table = parseTableAt(content, startLine)
  if (!table) return null
  const columns = table.header.length

  if (action.type === 'insertRow') {
    const at = Math.max(0, Math.min(table.rows.length, action.at))
    const rows = [...table.rows]
    rows.splice(at, 0, Array.from({ length: columns }, () => ''))
    return replaceTable(content, table, { header: table.header, aligns: table.aligns, rows })
  }

  if (action.type === 'insertColumn') {
    const at = Math.max(0, Math.min(columns, action.at))
    const insert = <T,>(cells: T[], value: T) => {
      const next = [...cells]
      next.splice(at, 0, value)
      return next
    }
    return replaceTable(content, table, {
      header: insert(table.header, ''),
      aligns: insert(table.aligns, 'none' as TableAlign),
      rows: table.rows.map(row => insert(row, '')),
    })
  }

  if (action.type === 'deleteRow') {
    if (action.index < 0 || action.index >= table.rows.length) return null
    const rows = table.rows.filter((_, index) => index !== action.index)
    return replaceTable(content, table, { header: table.header, aligns: table.aligns, rows })
  }

  if (action.type === 'deleteColumn') {
    if (columns <= 1) return null
    if (action.index < 0 || action.index >= columns) return null
    const remove = <T,>(cells: T[]) => cells.filter((_, index) => index !== action.index)
    return replaceTable(content, table, {
      header: remove(table.header),
      aligns: remove(table.aligns),
      rows: table.rows.map(remove),
    })
  }

  return null
}
