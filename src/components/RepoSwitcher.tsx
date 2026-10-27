import { useEffect, useRef, useState } from 'react'
import { FolderPlus, LoaderCircle, Pencil, X } from 'lucide-react'
import { api, json, query } from '../api'
import type { Repository, RepositoryList } from '../types'
import { Modal } from './UI'

function folderName(path: string) {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts.at(-1) || path
}

function labelOf(item: Repository) {
  return item.name.trim() || folderName(item.path)
}

type Props = {
  onClose: () => void
  onPrepare: () => Promise<void>
  onSwitched: () => void
}

export function RepoSwitcher({ onClose, onPrepare, onSwitched }: Props) {
  const [items, setItems] = useState<Repository[]>([])
  const [current, setCurrent] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const skipBlur = useRef(false)

  useEffect(() => {
    let canceled = false
    void api<RepositoryList>('/repositories').then(list => {
      if (canceled) return
      setItems(list.items || [])
      setCurrent(list.current)
    }).catch(cause => { if (!canceled) setError((cause as Error).message) }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [])

  function apply(list: RepositoryList) {
    setItems(list.items || [])
    setCurrent(list.current)
  }

  async function choose(path: string) {
    setBusy(true); setStatus('正在切换仓库…'); setError('')
    try {
      await onPrepare()
      const result = await api<RepositoryList>('/repositories/switch', json('POST', { path }))
      if (result.switched) { onSwitched(); return }
      apply(result)
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false); setStatus('') }
  }

  async function pick() {
    setBusy(true); setStatus('正在打开文件夹选择器…'); setError('')
    try {
      await onPrepare()
      const result = await api<RepositoryList>('/repositories/pick', json('POST', {}))
      if (result.canceled) return
      if (result.switched) { onSwitched(); return }
      apply(result)
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false); setStatus('') }
  }

  async function remove(path: string) {
    setBusy(true); setError('')
    try { apply(await api<RepositoryList>(`/repositories?path=${query(path)}`, json('DELETE'))) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  async function rename(path: string, name: string) {
    if (editing !== path) return
    const next = name.trim()
    const previous = items.find(item => item.path === path)?.name || ''
    setEditing(null)
    if (next === previous) return
    setBusy(true); setError('')
    try { apply(await api<RepositoryList>('/repositories', json('PUT', { path, name: next }))) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  return <Modal title="切换仓库" onClose={onClose} actions={<button type="button" className="button repo-add" aria-label="新增仓库" disabled={busy || loading} onClick={() => void pick()}><FolderPlus size={14} />新增仓库</button>}>
    <p className="field-help">最近使用的仓库会保留在这里，最多 5 个。切换前会先保存当前笔记。</p>
    {loading ? <p className="field-help" aria-busy="true"><LoaderCircle size={14} className="spin" />正在读取仓库…</p> : <div className="repo-list" aria-busy={busy}>
      {items.map(item => {
        const label = labelOf(item)
        const active = item.path === current
        return <div className={`repo-row ${active ? 'current' : ''}`} key={item.path}>
          <div className="repo-copy">
            {editing === item.path ? <><input className="repo-name-input" aria-label="仓库名称" value={draft} autoFocus disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null) }
              if (event.key === 'Enter') { event.preventDefault(); skipBlur.current = true; void rename(item.path, draft) }
            }} onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return } void rename(item.path, draft) }} /><span className="repo-path">{item.path}</span></> : active ? <><strong>{label}<span className="repo-badge">当前</span></strong><span className="repo-path">{item.path}</span></> : <button type="button" className="repo-switch" aria-label={`切换到 ${label}`} disabled={busy} onClick={() => void choose(item.path)}><strong>{label}</strong><span className="repo-path">{item.path}</span></button>}
          </div>
          <div className="repo-actions">
            {editing !== item.path && <button type="button" className="icon-button" aria-label={`编辑仓库名称 ${label}`} disabled={busy} onClick={() => { setDraft(item.name || label); setEditing(item.path) }}><Pencil size={14} /></button>}
            {!active && <button type="button" className="icon-button" aria-label={`移除仓库 ${label}`} title="从最近记录中移除" disabled={busy} onClick={() => void remove(item.path)}><X size={14} /></button>}
          </div>
        </div>
      })}
      {!items.length && <p className="field-help">还没有可切换的仓库。</p>}
    </div>}
    {status && <p className="field-help" role="status">{busy && <LoaderCircle size={14} className="spin" />}{status}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>
}
