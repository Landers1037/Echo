export type DiffLine = { type: 'equal' | 'add' | 'del'; text: string; left?: number; right?: number }

/** Line-based LCS diff for note snapshot comparison. */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = splitLines(before)
  const right = splitLines(after)
  const n = left.length
  const m = right.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0, j = 0, leftNo = 1, rightNo = 1
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      lines.push({ type: 'equal', text: left[i], left: leftNo++, right: rightNo++ })
      i++; j++
      continue
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: left[i], left: leftNo++ })
      i++
    } else {
      lines.push({ type: 'add', text: right[j], right: rightNo++ })
      j++
    }
  }
  while (i < n) lines.push({ type: 'del', text: left[i++], left: leftNo++ })
  while (j < m) lines.push({ type: 'add', text: right[j++], right: rightNo++ })
  return lines
}

function splitLines(value: string) {
  if (value === '') return [] as string[]
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}
