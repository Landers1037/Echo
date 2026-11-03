import type { DiffLine } from '../versionDiff'
import './VersionDiffView.css'

export function VersionDiffView({ lines, leftLabel, rightLabel }: { lines: DiffLine[]; leftLabel: string; rightLabel: string }) {
  return <div className="version-diff" role="region" aria-label={`${leftLabel} 与 ${rightLabel} 的差异`}>
    <div className="version-diff-meta"><span>{leftLabel}</span><span aria-hidden="true">→</span><span>{rightLabel}</span></div>
    <pre className="version-diff-body">{lines.map((line, index) => <div key={index} className={`version-diff-line is-${line.type}`}><span className="version-diff-gutter" aria-hidden="true"><span>{line.left ?? ''}</span><span>{line.right ?? ''}</span></span><span className="version-diff-mark" aria-hidden="true">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span><code>{line.text || ' '}</code></div>)}</pre>
  </div>
}
