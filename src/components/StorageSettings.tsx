import { useEffect, useState } from 'react'
import { Database, FileText, Image, LoaderCircle, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api, json } from '../api'
import type { AssetCleanup, StorageUsage, UnusedAssets } from '../types'

type Props = {
  assetsDir: string
  draftAssetsDir: string
  onDirectoryChange: (value: string) => void
  beforeAction: () => Promise<void>
  onBusyChange: (busy: boolean) => void
}

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024, index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`
}

export function StorageSettings({ assetsDir, draftAssetsDir, onDirectoryChange, beforeAction, onBusyChange }: Props) {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [usageError, setUsageError] = useState('')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [unused, setUnused] = useState<UnusedAssets | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const changedDirectory = draftAssetsDir !== assetsDir

  useEffect(() => {
    let canceled = false
    void api<StorageUsage>('/storage').then(value => { if (!canceled) setUsage(value) }).catch(cause => { if (!canceled) setUsageError((cause as Error).message) }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [])

  async function refreshUsage() {
    setLoading(true); setUsageError('')
    try { setUsage(await api<StorageUsage>('/storage')) } catch (cause) { setUsageError((cause as Error).message) }
    finally { setLoading(false) }
  }

  async function scan() {
    setWorking(true); onBusyChange(true); setError(''); setNotice(''); setUnused(null); setConfirming(false)
    try {
      await beforeAction()
      setUnused(await api<UnusedAssets>('/storage/unused-assets'))
      await refreshUsage()
    } catch (cause) { setError((cause as Error).message) }
    finally { setWorking(false); onBusyChange(false) }
  }

  async function cleanup() {
    if (!unused) return
    setWorking(true); onBusyChange(true); setError(''); setNotice('')
    try {
      await beforeAction()
      const result = await api<AssetCleanup>('/storage/cleanup', json('POST', { token: unused.token }))
      setNotice(`已清理 ${result.removedCount} 张图片，释放 ${bytesLabel(result.removedBytes)}。`)
      if (result.failed.length) setError(`${result.failed.length} 张图片未能清理：${result.failed.join('；')}`)
      await refreshUsage()
    } catch (cause) { setError((cause as Error).message) }
    finally { setUnused(null); setConfirming(false); setWorking(false); onBusyChange(false) }
  }

  return <>
    <div className="settings-page-heading"><h3>存储设置</h3><button type="button" className="icon-button" aria-label="刷新存储占用" disabled={loading || working} onClick={() => void refreshUsage()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    <div className="storage-usage" aria-label="存储占用" aria-busy={loading}>
      <div className="storage-stat"><Database size={17} /><span>数据库占用</span><strong>{usage ? bytesLabel(usage.databaseBytes) : '—'}</strong><small>配置、分类和提醒</small></div>
      <div className="storage-stat"><FileText size={17} /><span>笔记文件占用</span><strong>{usage ? bytesLabel(usage.noteBytes) : '—'}</strong><small>{usage ? `${usage.noteCount} 篇笔记` : '等待统计'}</small></div>
      <div className="storage-stat"><Image size={17} /><span>图片资源占用</span><strong>{usage ? bytesLabel(usage.assetBytes) : '—'}</strong><small>{usage ? `${usage.assetCount} 张图片` : '等待统计'}</small></div>
    </div>
    {usageError && <p className="form-error" role="alert">{usageError}</p>}
    {usage && <div className="storage-root"><span>笔记库根目录</span><code>{usage.root}</code></div>}
    <section className="settings-section"><h4>图片资源目录</h4><label className="field-label" htmlFor="assets-dir">资源目录</label><input id="assets-dir" value={draftAssetsDir} onChange={event => onDirectoryChange(event.target.value)} required placeholder=".assets" /><p className="field-help">相对于笔记库的目录。保存更改后会迁移已有图片，并更新笔记引用。</p></section>
    <section className="settings-section storage-cleanup"><h4>清理未引用图片</h4><p className="field-help">检查整个笔记库的图片引用，保留回收站笔记仍在使用的图片。</p>
      {changedDirectory && <p className="field-help">资源目录尚未保存，请先保存设置后再检查。</p>}
      <button type="button" className="button" disabled={working || changedDirectory} onClick={() => void scan()}>{working ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}检查未引用图片</button>
      {unused && <div className="unused-assets">
        <p>{unused.files.length ? `发现 ${unused.files.length} 张未引用图片，共 ${bytesLabel(unused.bytes)}` : '没有未引用的图片。'}</p>
        {unused.files.length > 0 && <><ul aria-label="未引用图片列表">{unused.files.map(file => <li key={file.path}><span title={file.path}>{file.path}</span><small>{bytesLabel(file.size)}</small></li>)}</ul>
          {confirming ? <div className="cleanup-confirm"><p>将永久删除以上 {unused.files.length} 张图片，此操作无法撤销。</p><div><button type="button" className="button" onClick={() => setConfirming(false)} disabled={working}>取消清理</button><button type="button" className="button danger" onClick={() => void cleanup()} disabled={working || changedDirectory}><Trash2 size={14} />确认清理</button></div></div> : <button type="button" className="button danger" disabled={working || changedDirectory} onClick={() => setConfirming(true)}><Trash2 size={14} />清理 {unused.files.length} 张图片</button>}
        </>}
      </div>}
      {notice && <p className="storage-notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  </>
}
