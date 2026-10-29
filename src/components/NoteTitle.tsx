import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Pencil } from 'lucide-react'

export function NoteTitle({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const skipSave = useRef(false)

  useEffect(() => { if (!editing) setDraft(title) }, [title, editing])
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function begin() {
    skipSave.current = false
    setDraft(title)
    setEditing(true)
  }
  function cancel() {
    skipSave.current = true
    setDraft(title)
    setEditing(false)
  }
  function commit(value: string) {
    if (skipSave.current) return
    skipSave.current = true
    const next = value.trim()
    setEditing(false)
    if (!next || next === title) {
      setDraft(title)
      return
    }
    onSave(next)
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.key === 'Process' || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    commit(event.currentTarget.value)
  }

  return <div className={`note-title-main${editing ? ' is-editing' : ''}`}>
    <h1 className="note-title">{editing ? <input ref={inputRef} className="note-title-input" aria-label="笔记标题" value={draft} style={{ width: `${Math.max([...draft].length, 1) + 0.4}em` }} autoComplete="off" spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={event => commit(event.currentTarget.value)} onKeyDown={onKeyDown} /> : title}</h1>
    {!editing && <button type="button" className="icon-button note-title-edit" aria-label="编辑标题" title="编辑标题" onClick={begin}><Pencil size={15} strokeWidth={1.7} /></button>}
  </div>
}
