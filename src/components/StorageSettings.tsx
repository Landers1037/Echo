import { useEffect, useState } from 'react'
import { Database, Download, FileText, Image, LoaderCircle, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api, json } from '../api'
import type { AssetCleanup, StorageUsage, UnusedAssets } from '../types'

type ArchiveFormat = 'zip' | 'tar'

type Props = {
  assetsDir: string
  draftAssetsDir: string
  scanExcludes: string[]
  draftScanExcludes: string[]
  onDirectoryChange: (value: string) => void
  onExcludesChange: (value: string[]) => void
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

function attachmentName(header: string | null) {
  if (!header) return ''
  const encoded = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header)
  if (encoded?.[1]) {
    try {
      const name = decodeURIComponent(encoded[1].trim())
      if (name) return name
    } catch { /* use the plain filename */ }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header)
  if (quoted) return quoted[1]
  return /filename\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim() || ''
}

function exportFileName(header: string | null, root: string, format: ArchiveFormat) {
  const fromHeader = attachmentName(header)
  if (fromHeader && !/[\\/]/.test(fromHeader)) return fromHeader
  const base = (root.split(/[\\/]/).filter(Boolean).pop() || '笔记库').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || '笔记库'
  return `${base}.${format}`
}

function saveDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function StorageSettings({ assetsDir, draftAssetsDir, scanExcludes, draftScanExcludes, onDirectoryChange, onExcludesChange, beforeAction, onBusyChange }: Props) {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [usageError, setUsageError] = useState('')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [format, setFormat] = useState<ArchiveFormat>('zip')
  const [unused, setUnused] = useState<UnusedAssets | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [exportError, setExportError] = useState('')
  const [exportNotice, setExportNotice] = useState('')
  const busy = working || exporting
  const changedDirectory = draftAssetsDir !== assetsDir
  const changedExcludes = draftScanExcludes.join('\n') !== scanExcludes.join('\n')
  const pendingSave = changedDirectory || changedExcludes

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

  async function exportRepository() {
    setExporting(true); onBusyChange(true); setExportError(''); setExportNotice('')
    try {
      await beforeAction()
      const response = await fetch(`/api/storage/export?format=${format}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error || `导出失败 (${response.status})`)
      }
      const name = exportFileName(response.headers.get('Content-Disposition'), usage?.root || '', format)
      saveDownload(await response.blob(), name)
      setExportNotice(`已导出 ${name}`)
    } catch (cause) { setExportError((cause as Error).message) }
    finally { setExporting(false); onBusyChange(false) }
  }

  return <>
    <div className="settings-page-heading"><h3>存储设置</h3><button type="button" className="icon-button" aria-label="刷新存储占用" disabled={loading || busy} onClick={() => void refreshUsage()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    <div className="storage-usage" aria-label="存储占用" aria-busy={loading}>
      <div className="storage-stat"><Database size={17} /><span>数据库占用</span><strong>{usage ? bytesLabel(usage.databaseBytes) : '—'}</strong><small>配置、分类和提醒</small></div>
      <div className="storage-stat"><FileText size={17} /><span>笔记文件占用</span><strong>{usage ? bytesLabel(usage.noteBytes) : '—'}</strong><small>{usage ? `${usage.noteCount} 篇笔记` : '等待统计'}</small></div>
      <div className="storage-stat"><Image size={17} /><span>图片资源占用</span><strong>{usage ? bytesLabel(usage.assetBytes) : '—'}</strong><small>{usage ? `${usage.assetCount} 张图片` : '等待统计'}</small></div>
    </div>
    {usageError && <p className="form-error" role="alert">{usageError}</p>}
    {usage && <div className="storage-root"><span>笔记库根目录</span><code>{usage.root}</code></div>}
    <section className="settings-section"><h4>图片资源目录</h4><label className="field-label" htmlFor="assets-dir">资源目录</label><input id="assets-dir" value={draftAssetsDir} onChange={event => onDirectoryChange(event.target.value)} required placeholder=".assets" /><p className="field-help">相对于笔记库的目录。保存更改后会迁移已有图片，并更新笔记引用。</p></section>
    <section className="settings-section"><h4>扫描排除</h4><label className="field-label" htmlFor="scan-excludes">排除规则</label><textarea id="scan-excludes" className="scan-excludes" value={draftScanExcludes.join('\n')} onChange={event => onExcludesChange(event.target.value.split('\n'))} placeholder={'node_modules\ndist\n*.log'} spellCheck={false} /><p className="field-help">一行一条，写法与 .gitignore 类似。node_modules 会跳过任意层级的同名目录；/build 只跳过笔记库根下的 build；*.log 跳过匹配的文件。目录被排除后不再进入其子目录。保存后，目录树、搜索、任务和存储扫描都会跳过这些路径。</p></section>
    <section className="settings-section storage-cleanup"><h4>清理未引用图片</h4><p className="field-help">检查整个笔记库的图片引用，保留回收站笔记仍在使用的图片。扫描排除中的笔记不会被检查，只被这些笔记引用的图片会被视为未引用。</p>
      {pendingSave && <p className="field-help">{changedDirectory && changedExcludes ? '资源目录和排除规则尚未保存，请先保存设置后再检查。' : changedDirectory ? '资源目录尚未保存，请先保存设置后再检查。' : '排除规则尚未保存，请先保存设置后再检查。'}</p>}
      <button type="button" className="button" disabled={busy || pendingSave} onClick={() => void scan()}>{working ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}检查未引用图片</button>
      {unused && <div className="unused-assets">
        <p>{unused.files.length ? `发现 ${unused.files.length} 张未引用图片，共 ${bytesLabel(unused.bytes)}` : '没有未引用的图片。'}</p>
        {unused.files.length > 0 && <><ul aria-label="未引用图片列表">{unused.files.map(file => <li key={file.path}><span title={file.path}>{file.path}</span><small>{bytesLabel(file.size)}</small></li>)}</ul>
          {confirming ? <div className="cleanup-confirm"><p>将永久删除以上 {unused.files.length} 张图片，此操作无法撤销。</p><div><button type="button" className="button" onClick={() => setConfirming(false)} disabled={busy}>取消清理</button><button type="button" className="button danger" onClick={() => void cleanup()} disabled={busy || pendingSave}><Trash2 size={14} />确认清理</button></div></div> : <button type="button" className="button danger" disabled={busy || pendingSave} onClick={() => setConfirming(true)}><Trash2 size={14} />清理 {unused.files.length} 张图片</button>}
        </>}
      </div>}
      {notice && <p className="storage-notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
    <section className="settings-section storage-export"><h4>导出笔记库</h4><p className="field-help">将当前笔记库下载为 ZIP 或 TAR，包含笔记、绘图、图片、配置、回收站和数据库。扫描排除中的路径不会打进压缩包。</p>
      {pendingSave && <p className="field-help">设置尚未保存，请先保存后再导出。</p>}
      <div className="storage-export-row"><div className="note-width-tabs" role="tablist" aria-label="导出格式"><button type="button" role="tab" aria-selected={format === 'zip'} onClick={() => setFormat('zip')}>ZIP</button><button type="button" role="tab" aria-selected={format === 'tar'} onClick={() => setFormat('tar')}>TAR</button></div><button type="button" className="button primary" disabled={busy || pendingSave} aria-busy={exporting} onClick={() => void exportRepository()}>{exporting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{exporting ? '正在导出…' : '导出笔记库'}</button></div>
      {exportNotice && <p className="storage-notice" role="status">{exportNotice}</p>}
      {exportError && <p className="form-error" role="alert">{exportError}</p>}
    </section>
  </>
}
