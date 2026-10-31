import { useEffect, useState } from 'react'
import { Database, GitBranch, LoaderCircle, RefreshCw, Check } from 'lucide-react'
import { api, json } from '../api'
import type { VersionRepoStatus } from '../types'
import { Switch } from './UI'

type Props = {
  enabled: boolean
  autoDaily: boolean
  disabled: boolean
  onEnabledChange: (value: boolean) => void
  onAutoDailyChange: (value: boolean) => void
  beforeAction: () => Promise<void>
  onBusyChange: (busy: boolean) => void
}

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024, index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`
}

export function VersionRepoSettings({ enabled, autoDaily, disabled, onEnabledChange, onAutoDailyChange, beforeAction, onBusyChange }: Props) {
  const [status, setStatus] = useState<VersionRepoStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function refresh() {
    setLoading(true)
    setError('')
    try { setStatus(await api<VersionRepoStatus>('/version-repo/status')) }
    catch (cause) { setError((cause as Error).message); setStatus(null) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    let canceled = false
    void api<VersionRepoStatus>('/version-repo/status').then(value => { if (!canceled) setStatus(value) }).catch(cause => { if (!canceled) setError((cause as Error).message) }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [])

  async function initRepo() {
    setWorking(true); onBusyChange(true); setError(''); setNotice('')
    try {
      await beforeAction()
      const next = await api<VersionRepoStatus>('/version-repo/init', json('POST', {}))
      setStatus(next)
      setNotice('版本仓库已初始化。')
    } catch (cause) { setError((cause as Error).message) }
    finally { setWorking(false); onBusyChange(false) }
  }

  return <>
    <div className="settings-page-heading"><h3>仓库设置</h3><button type="button" className="icon-button" aria-label="刷新版本仓库状态" disabled={loading || working || disabled} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    <section className="settings-section"><h4>笔记版本仓库</h4>
      <div className="setting-row"><div><strong>启用版本仓库</strong><p>为笔记保存可切换、可删除的历史快照。数据保存在笔记库的 .echo 目录中。</p></div><Switch label="启用版本仓库" checked={enabled} onChange={onEnabledChange} /></div>
      <div className="setting-row"><div><strong>每日自动提交</strong><p>开启后，每天为有改动的笔记自动创建一版。无改动则跳过。</p></div><Switch label="每日自动提交" checked={enabled && autoDaily} onChange={value => { if (enabled) onAutoDailyChange(value) }} /></div>
    </section>
    <section className="settings-section"><h4>仓库状态</h4>
      <div className="storage-usage" aria-label="版本仓库状态" aria-busy={loading}>
        <div className="storage-stat"><GitBranch size={17} /><span>初始化</span><strong>{status ? (status.initialized ? '已就绪' : '未初始化') : '—'}</strong><small>{status?.initialized ? '可提交与切换版本' : '需要先初始化'}</small></div>
        <div className="storage-stat"><Database size={17} /><span>版本条目</span><strong>{status ? status.versionCount : '—'}</strong><small>{status ? `${status.objectCount} 个对象 · ${bytesLabel(status.objectBytes)}` : '等待统计'}</small></div>
        <div className="storage-stat"><Check size={17} /><span>待提交笔记</span><strong>{status ? status.dirtyNotes : '—'}</strong><small>{status?.lastCreatedAt ? `最近 ${new Date(status.lastCreatedAt).toLocaleString('zh-CN')}` : '尚无版本'}</small></div>
      </div>
      {!status?.initialized && <p className="field-help">初始化会在当前笔记库中创建版本数据库与对象目录，不会改动现有笔记内容。</p>}
      <button type="button" className="button primary" disabled={disabled || working || !!status?.initialized} onClick={() => void initRepo()}>{working ? <LoaderCircle size={14} className="spin" /> : <GitBranch size={14} />}{status?.initialized ? '已初始化' : working ? '正在初始化…' : '初始化版本仓库'}</button>
      {notice && <p className="storage-notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  </>
}
