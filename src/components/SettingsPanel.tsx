import { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, Sun, Palette, Sparkles, NotebookPen, HardDrive, Keyboard } from 'lucide-react'
import { Modal, Switch } from './UI'
import { StorageSettings } from './StorageSettings'
import type { Settings, SettingsPreview } from '../types'
import { canonicalShortcut, findConflict, formatShortcut, isBindableShortcut, keyFromEvent, resolveShortcuts, shortcutActions, shortcutGroups, withShortcut } from '../shortcuts'
import './SettingsPanel.css'

const accents = ['#72967b', '#5885b5', '#9379b7', '#bd8065', '#bd7790', '#a38d52']
const sections = [{ id: 'appearance', label: '外观设置', icon: Palette }, { id: 'notes', label: '笔记设置', icon: NotebookPen }, { id: 'shortcuts', label: '快捷键设置', icon: Keyboard }, { id: 'storage', label: '存储设置', icon: HardDrive }] as const

export function SettingsPanel({ settings, onPreview, onSave, onClose, beforeStorageAction }: { settings: Settings; onPreview: (appearance: SettingsPreview | null) => void; onSave: (settings: Settings) => Promise<void>; onClose: () => void; beforeStorageAction: () => Promise<void> }) {
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [section, setSection] = useState<typeof sections[number]['id']>('appearance')
  const [storageBusy, setStorageBusy] = useState(false)
  const locked = busy || storageBusy
  const patch = (part: Partial<Settings>) => setDraft(value => ({ ...value, ...part }))
  useEffect(() => { onPreview({ theme: draft.theme, accent: draft.accent, editorFontSize: draft.editorFontSize }) }, [draft.theme, draft.accent, draft.editorFontSize, onPreview])
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
            <section className="settings-section"><h4>编辑器字体</h4>
              <div className="setting-row"><label htmlFor="editor-font-size">默认字体大小</label><div className="font-size-value"><output htmlFor="editor-font-size">{draft.editorFontSize} px</output><button className="font-size-reset" type="button" onClick={() => patch({ editorFontSize: 14 })} disabled={draft.editorFontSize === 14}>恢复默认</button></div></div>
              <input className="font-size-slider" id="editor-font-size" type="range" min={12} max={32} step={1} value={draft.editorFontSize} aria-valuetext={`${draft.editorFontSize} 像素`} aria-describedby="editor-font-size-help" onChange={e => patch({ editorFontSize: Number(e.target.value) })} />
              <p className="field-help" id="editor-font-size-help">12–32 px，默认 14 px。同时应用于所有笔记的源码和预览。</p>
              <div className="editor-font-preview" aria-label="编辑器字体预览" style={{ fontSize: draft.editorFontSize }}><span># 记录每一个想法</span><span>让文字以舒适的大小呈现。</span></div>
            </section>
            <section className="settings-section"><h4>编辑与预览</h4><div className="setting-row"><span>源码编辑器行号</span><Switch label="源码编辑器行号" checked={draft.editorLineNumbers} onChange={editorLineNumbers => patch({ editorLineNumbers })} /></div><div className="setting-row"><span>预览代码块行号</span><Switch label="预览代码块行号" checked={draft.previewLineNumbers} onChange={previewLineNumbers => patch({ previewLineNumbers })} /></div><div className="setting-row"><div><strong>源码模式分栏预览</strong><p>源码模式左侧编辑，右侧实时显示 Markdown。预览标签仍为整页预览。</p></div><Switch label="源码模式分栏预览" checked={draft.sourceSplitPreview} onChange={sourceSplitPreview => patch({ sourceSplitPreview })} /></div><div className="setting-row"><div><strong>严格换行模式</strong><p>开启后，预览里的一次换行就会换行。关闭时仍按 Markdown 默认规则，单次换行保持在同一段中。</p></div><Switch label="严格换行模式" checked={draft.strictLineBreaks} onChange={strictLineBreaks => patch({ strictLineBreaks })} /></div></section>
            <section className="settings-section"><h4>标签页</h4><div className="setting-row"><div><strong>多笔记 Tab</strong><p>同时打开多篇笔记，最多 10 个，超出时自动关闭最早打开的。</p></div><Switch label="多笔记 Tab" checked={draft.multiTabs} onChange={multiTabs => patch({ multiTabs })} /></div></section>
          </>}
          {section === 'shortcuts' && <ShortcutSettings shortcuts={draft.shortcuts ?? {}} disabled={locked} onChange={shortcuts => patch({ shortcuts })} />}
          {section === 'storage' && <StorageSettings assetsDir={settings.assetsDir} draftAssetsDir={draft.assetsDir} onDirectoryChange={assetsDir => patch({ assetsDir })} beforeAction={beforeStorageAction} onBusyChange={setStorageBusy} />}
        </fieldset></div>
      </div>
      <div className="settings-save-bar">{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={locked}>取消</button><button type="submit" className="button primary" disabled={locked}>{busy ? '正在保存…' : '保存设置'}</button></div></div>
    </form>
  </Modal>
}

function ShortcutSettings({ shortcuts, disabled, onChange }: { shortcuts: Record<string, string>; disabled: boolean; onChange: (shortcuts: Record<string, string>) => void }) {
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ actionId: string; shortcut: string; name: string } | null>(null)
  const shortcutsRef = useRef(shortcuts)
  const onChangeRef = useRef(onChange)
  shortcutsRef.current = shortcuts
  onChangeRef.current = onChange
  const resolved = resolveShortcuts(shortcuts)
  useEffect(() => { if (disabled) setRecording(null) }, [disabled])
  useEffect(() => {
    if (!recording || disabled) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (event.repeat) return
      if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { setRecording(null); setError(''); return }
      const shortcut = keyFromEvent(event)
      if (!shortcut || !isBindableShortcut(shortcut)) {
        setError(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ? '这个按键无法用作快捷键。' : '请使用带 Ctrl、Cmd、Alt 或 Shift 的组合键。')
        return
      }
      const conflict = findConflict(recording, shortcut, shortcutsRef.current)
      if (conflict?.type === 'reserved') { setError(`${formatShortcut(shortcut)} 已被“${conflict.label}”占用，请换一个按键。`); return }
      if (conflict?.type === 'action') { setRecording(null); setError(''); setPending({ actionId: recording, shortcut, name: conflict.name }); return }
      onChangeRef.current(withShortcut(shortcutsRef.current, recording, shortcut))
      setRecording(null)
      setError('')
      setPending(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [disabled, recording])

  function confirmPending() {
    if (!pending) return
    const wanted = canonicalShortcut(pending.shortcut)
    let next = shortcuts
    for (const action of shortcutActions) {
      const current = resolveShortcuts(next)[action.id]
      if (action.id !== pending.actionId && current && canonicalShortcut(current) === wanted) next = withShortcut(next, action.id, '')
    }
    onChange(withShortcut(next, pending.actionId, pending.shortcut))
    setPending(null)
  }

  const recordingAction = shortcutActions.find(action => action.id === recording)
  return <>
    <div className="settings-page-heading"><h3>快捷键设置</h3><button className="font-size-reset" type="button" onClick={() => { setRecording(null); setPending(null); setError(''); onChange({}) }} disabled={disabled || Object.keys(shortcuts).length === 0}>全部恢复默认</button></div>
    <p className="field-help">为编辑器操作指定快捷键。组合键需要包含 Ctrl、Cmd、Alt 或 Shift，保存后生效。</p>
    {recordingAction && <p className="shortcut-banner" role="status">请按下新的快捷键，Esc 取消。正在设置“{recordingAction.name}”。</p>}
    {error && <p className="shortcut-banner shortcut-error" role="alert">{error}</p>}
    {pending && <p className="shortcut-banner" role="alert">{formatShortcut(pending.shortcut)} 已被“{pending.name}”使用。<button type="button" onClick={confirmPending}>禁用并继续</button><button type="button" onClick={() => setPending(null)}>保留原快捷键</button></p>}
    {shortcutGroups.map(group => <section className="settings-section" key={group.id}><h4>{group.label}</h4><div className="shortcut-list">{shortcutActions.filter(action => action.group === group.id).map(action => {
      const shortcut = resolved[action.id] ?? ''
      const recordingRow = recording === action.id
      return <div className={recordingRow ? 'shortcut-row recording' : 'shortcut-row'} key={action.id}>
        <span className="shortcut-name">{action.name}</span>
        <ShortcutKeys shortcut={shortcut} recording={recordingRow} />
        <div className="shortcut-actions">
          <button type="button" aria-pressed={recordingRow} aria-label={recordingRow ? `取消修改${action.name}快捷键` : `修改${action.name}快捷键`} onClick={() => { setError(''); setPending(null); setRecording(current => current === action.id ? null : action.id) }}>{recordingRow ? '取消' : '修改'}</button>
          <button type="button" aria-label={`禁用${action.name}快捷键`} disabled={!shortcut} onClick={() => { setRecording(current => current === action.id ? null : current); setError(''); onChange(withShortcut(shortcuts, action.id, '')) }}>禁用</button>
          <button type="button" aria-label={`恢复${action.name}默认快捷键`} disabled={!Object.prototype.hasOwnProperty.call(shortcuts, action.id)} onClick={() => { setRecording(current => current === action.id ? null : current); setError(''); onChange(withShortcut(shortcuts, action.id, action.defaultKey)) }}>恢复默认</button>
        </div>
      </div>
    })}</div></section>)}
  </>
}

function ShortcutKeys({ shortcut, recording }: { shortcut: string; recording: boolean }) {
  if (recording) return <span className="shortcut-keys"><span className="shortcut-empty">请按键…</span></span>
  if (!shortcut) return <span className="shortcut-keys"><span className="shortcut-empty">未设置</span></span>
  return <span className="shortcut-keys">{formatShortcut(shortcut).split(' + ').map((part, index) => <kbd key={`${part}-${index}`}>{part}</kbd>)}</span>
}
