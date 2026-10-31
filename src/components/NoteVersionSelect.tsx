import { Select } from './Select'
import type { NoteVersion } from '../types'

type Props = {
  versions: NoteVersion[]
  currentId: string
  disabled?: boolean
  onSelect: (versionId: string) => void
}

export function NoteVersionSelect({ versions, currentId, disabled, onSelect }: Props) {
  const options = versions.length
    ? versions.map(item => ({ value: item.id, label: item.label }))
    : [{ value: '', label: '暂无版本', disabled: true }]
  const value = versions.some(item => item.id === currentId) ? currentId : (versions[0]?.id || '')
  return <Select aria-label="笔记版本" compact value={value} options={options} disabled={disabled || !versions.length} onChange={onSelect} className="note-version-select" />
}
