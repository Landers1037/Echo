import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun, Palette, Sparkles, Code2, Image } from 'lucide-react'
import { Modal, Switch } from './UI'
import type { Settings } from '../types'

const accents = ['#72967b', '#5885b5', '#9379b7', '#bd8065', '#bd7790', '#a38d52']
export function SettingsPanel({ settings, onPreview, onSave, onClose }: { settings: Settings; onPreview: (appearance: Pick<Settings, 'theme' | 'accent'> | null) => void; onSave: (settings: Settings) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const patch = (part: Partial<Settings>) => setDraft(value => ({ ...value, ...part }))
  useEffect(() => { onPreview({ theme: draft.theme, accent: draft.accent }) }, [draft.theme, draft.accent, onPreview])
  useEffect(() => () => onPreview(null), [onPreview])
  return <Modal title="设置" onClose={() => { if (!busy) onClose() }} wide>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await onSave(draft); onClose() } catch (err) { setError((err as Error).message) } finally { setBusy(false) } }}>
      <div className="settings-section"><h3><Palette size={16} />外观</h3><div className="theme-options">{([['light', '明亮', Sun], ['dark', '暗黑', Moon], ['system', '跟随系统', Monitor]] as const).map(([value, label, Icon]) => <button type="button" key={value} aria-pressed={draft.theme === value} className={`theme-option ${draft.theme === value ? 'selected' : ''}`} onClick={() => patch({ theme: value })}><Icon size={22} /><span>{label}</span></button>)}</div>
        <label className="field-label">强调色</label><div className="accent-options">{accents.map(accent => <button type="button" key={accent} aria-label={`强调色 ${accent}`} aria-pressed={draft.accent === accent} className={`accent-dot ${draft.accent === accent ? 'selected' : ''}`} style={{ background: accent }} onClick={() => patch({ accent })} />)}<label className="custom-accent" title="自定义强调色"><input type="color" aria-label="自定义强调色" value={draft.accent} onChange={e => patch({ accent: e.target.value })} /><span>自定义</span></label></div>
      </div>
      <div className="settings-section"><h3><Sparkles size={16} />交互效果</h3><div className="setting-row"><div><strong>界面动画</strong><p>为切换与展开添加自然过渡，遵循系统动态效果偏好。</p></div><Switch label="界面动画" checked={draft.animations} onChange={animations => patch({ animations })} /></div></div>
      <div className="settings-section"><h3><Code2 size={16} />编辑与预览</h3><div className="setting-row"><span>源码编辑器行号</span><Switch label="源码编辑器行号" checked={draft.editorLineNumbers} onChange={editorLineNumbers => patch({ editorLineNumbers })} /></div><div className="setting-row"><span>预览代码块行号</span><Switch label="预览代码块行号" checked={draft.previewLineNumbers} onChange={previewLineNumbers => patch({ previewLineNumbers })} /></div></div>
      <div className="settings-section"><h3><Image size={16} />图片资源</h3><label className="field-label" htmlFor="assets-dir">资源目录</label><input id="assets-dir" value={draft.assetsDir} onChange={e => patch({ assetsDir: e.target.value })} required placeholder=".assets" /><p className="field-help">相对于笔记库的目录。更改后迁移已有图片并更新笔记引用，请在完成前保持应用打开。</p></div>
      {error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button></div>
    </form>
  </Modal>
}
