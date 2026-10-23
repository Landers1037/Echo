import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun, Palette, Sparkles, NotebookPen, HardDrive } from 'lucide-react'
import { Modal, Switch } from './UI'
import { StorageSettings } from './StorageSettings'
import type { Settings } from '../types'
import './SettingsPanel.css'

const accents = ['#72967b', '#5885b5', '#9379b7', '#bd8065', '#bd7790', '#a38d52']
const sections = [{ id: 'appearance', label: '外观设置', icon: Palette }, { id: 'notes', label: '笔记设置', icon: NotebookPen }, { id: 'storage', label: '存储设置', icon: HardDrive }] as const

export function SettingsPanel({ settings, onPreview, onSave, onClose, beforeStorageAction }: { settings: Settings; onPreview: (appearance: Pick<Settings, 'theme' | 'accent'> | null) => void; onSave: (settings: Settings) => Promise<void>; onClose: () => void; beforeStorageAction: () => Promise<void> }) {
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [section, setSection] = useState<typeof sections[number]['id']>('appearance')
  const [storageBusy, setStorageBusy] = useState(false)
  const locked = busy || storageBusy
  const patch = (part: Partial<Settings>) => setDraft(value => ({ ...value, ...part }))
  useEffect(() => { onPreview({ theme: draft.theme, accent: draft.accent }) }, [draft.theme, draft.accent, onPreview])
  useEffect(() => () => onPreview(null), [onPreview])
  return <Modal title="设置" onClose={() => { if (!locked) onClose() }} wide className="settings-modal">
    <form className="settings-form" onSubmit={async e => { e.preventDefault(); if (locked) return; setBusy(true); setError(''); try { await onSave(draft); onClose() } catch (err) { setError((err as Error).message) } finally { setBusy(false) } }}>
      <div className="settings-layout">
        <nav className="settings-menu" aria-label="设置菜单">{sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={section === id ? 'page' : undefined} aria-controls="settings-details" className={section === id ? 'active' : ''} onClick={() => setSection(id)} disabled={locked}><Icon size={17} /><span>{label}</span></button>)}</nav>
        <div className="settings-details" id="settings-details"><fieldset className="settings-fields" disabled={locked}>
          {section === 'appearance' && <>
            <div className="settings-page-heading"><h3>外观设置</h3></div>
            <section className="settings-section"><h4>主题</h4><div className="theme-options">{([['light', '明亮', Sun], ['dark', '暗黑', Moon], ['system', '跟随系统', Monitor]] as const).map(([value, label, Icon]) => <button type="button" key={value} aria-pressed={draft.theme === value} className={`theme-option ${draft.theme === value ? 'selected' : ''}`} onClick={() => patch({ theme: value })}><Icon size={22} /><span>{label}</span></button>)}</div>
              <label className="field-label">强调色</label><div className="accent-options">{accents.map(accent => <button type="button" key={accent} aria-label={`强调色 ${accent}`} aria-pressed={draft.accent === accent} className={`accent-dot ${draft.accent === accent ? 'selected' : ''}`} style={{ background: accent }} onClick={() => patch({ accent })} />)}<label className="custom-accent" title="自定义强调色"><input type="color" aria-label="自定义强调色" value={draft.accent} onChange={e => patch({ accent: e.target.value })} /><span>自定义</span></label></div>
            </section>
            <section className="settings-section"><h4><Sparkles size={15} />交互效果</h4><div className="setting-row"><div><strong>界面动画</strong><p>为切换与展开添加自然过渡，遵循系统动态效果偏好。</p></div><Switch label="界面动画" checked={draft.animations} onChange={animations => patch({ animations })} /></div></section>
          </>}
          {section === 'notes' && <>
            <div className="settings-page-heading"><h3>笔记设置</h3></div>
            <section className="settings-section"><h4>编辑与预览</h4><div className="setting-row"><span>源码编辑器行号</span><Switch label="源码编辑器行号" checked={draft.editorLineNumbers} onChange={editorLineNumbers => patch({ editorLineNumbers })} /></div><div className="setting-row"><span>预览代码块行号</span><Switch label="预览代码块行号" checked={draft.previewLineNumbers} onChange={previewLineNumbers => patch({ previewLineNumbers })} /></div></section>
          </>}
          {section === 'storage' && <StorageSettings assetsDir={settings.assetsDir} draftAssetsDir={draft.assetsDir} onDirectoryChange={assetsDir => patch({ assetsDir })} beforeAction={beforeStorageAction} onBusyChange={setStorageBusy} />}
        </fieldset></div>
      </div>
      <div className="settings-save-bar">{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={locked}>取消</button><button type="submit" className="button primary" disabled={locked}>{busy ? '正在保存…' : '保存设置'}</button></div></div>
    </form>
  </Modal>
}
