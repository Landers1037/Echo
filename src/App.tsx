import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MotionConfig, AnimatePresence, motion } from 'motion/react'
import { PanelLeft, ChevronRight, Download, Bell, Sun, Moon, Check, Cloud, LoaderCircle, FileText, Plus, FolderOpen, FolderPlus, Tag, MoreHorizontal, Pencil, ArrowRightLeft, Trash2, X, AlertTriangle, RotateCcw, Copy, CheckCheck, BookOpen, ListTree, Maximize2, PenTool, Bot, Workflow, Highlighter, Eye, EyeOff } from 'lucide-react'
import { api, ApiError, json, query } from './api'
import type { Note, NoteSummary, TreeEntry, Settings, SettingsPreview, Task, Reminder, TrashEntry, Drawing, Plan, PlanDraft, CustomTask, CustomTaskDraft, AgentConfig, AgentConfigInput, AnnotationList } from './types'
import { Sidebar } from './components/Sidebar'
import { RepoSwitcher } from './components/RepoSwitcher'
import { Logo } from './components/Logo'
import { SettingsPanel } from './components/SettingsPanel'
import { Modal } from './components/UI'
import { Select } from './components/Select'
import { Editor } from './components/Editor'
import { NotePicker } from './components/NotePicker'
import { drawioReferenceMarkdown, noteReferenceMarkdown } from './noteReference'
import type { EditorController } from './components/Editor'
import { AgentPanel } from './components/AgentPanel'
import { saveAgentConfig } from './agent/client'
import { MarkdownView } from './components/MarkdownView'
import { NoteOutline } from './components/NoteOutline'
import { AnnotationLayer } from './components/annotations/AnnotationLayer'
import { AnnotationToolbar } from './components/annotations/AnnotationToolbar'
import { useAnnotations } from './components/annotations/useAnnotations'
import { NoteTitle } from './components/NoteTitle'
import { applyNoteTitle } from './noteTitle'
import { NoteTabs } from './components/NoteTabs'
import { TasksView } from './components/TasksView'
import { planScheduleLabel, PlansView } from './components/PlansView'
import { exportNotes } from './export'
import { DrawingModal } from './components/Drawing'
import { DrawioModal } from './components/Drawio'

const uiStyleIds: Settings['uiStyle'][] = ['sage', 'paper', 'mono', 'soft', 'glass', 'ink']
const noteWidthIds: Settings['noteWidth'][] = ['default', 'medium', 'large']
const defaults: Settings = { theme: 'system', uiStyle: 'sage', accent: '#72967b', animations: true, editorFontSize: 14, editorLineNumbers: true, previewLineNumbers: false, multiTabs: false, sourceSplitPreview: false, strictLineBreaks: false, noteWidth: 'default', assetsDir: '.assets', shortcuts: {} }
function completeSettings(value?: Partial<Settings> | null): Settings {
  const shortcuts = value?.shortcuts && typeof value.shortcuts === 'object' ? value.shortcuts : {}
  const uiStyle = uiStyleIds.includes(value?.uiStyle as Settings['uiStyle']) ? value!.uiStyle! : defaults.uiStyle
  const noteWidth = noteWidthIds.includes(value?.noteWidth as Settings['noteWidth']) ? value!.noteWidth! : defaults.noteWidth
  return { ...defaults, ...value, shortcuts, uiStyle, noteWidth }
}
const MAX_TABS = 10
const tabsKey = 'echo:tabs'
function readTabs(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(tabsKey) || '[]')
    if (!Array.isArray(parsed)) return []
    const paths = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return paths.filter((path, index) => paths.indexOf(path) === index).slice(-MAX_TABS)
  } catch { return [] }
}
function pushTab(list: string[], path: string) {
  if (list.includes(path)) return list
  return [...list, path].slice(-MAX_TABS)
}
function affectsPath(path: string, item: string) { return path === item || path.startsWith(`${item}/`) }
function retargetPath(path: string, from: string, to: string) {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length)
  return path
}
function neighborTab(list: string[], path: string, keep: (path: string) => boolean) {
  const index = list.indexOf(path)
  const after = index < 0 ? [] : list.slice(index + 1)
  const before = index < 0 ? [...list].reverse() : [...list.slice(0, index)].reverse()
  return [...after, ...before].find(keep)
}
type Prompt = { title: string; label?: string; value?: string; description?: string; confirm?: string; danger?: boolean }
type Toast = { id: number; text: string; error?: boolean }
const draftKey = (path: string) => `echo:draft:${path}`
function clearRepositorySession() {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key && (key === 'echo:last-note' || key === tabsKey || key.startsWith('echo:draft:'))) keys.push(key)
  }
  keys.forEach(key => localStorage.removeItem(key))
}
function cachedSettings(): Settings { try { return completeSettings(JSON.parse(localStorage.getItem('echo:settings') || '{}')) } catch { return completeSettings() } }

export default function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [tree, setTree] = useState<TreeEntry[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [customTasks, setCustomTasks] = useState<CustomTask[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [note, setNote] = useState<Note | null>(null)
  const [tabs, setTabs] = useState<string[]>(readTabs)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [settings, setSettings] = useState<Settings>(cachedSettings)
  const [appearancePreview, setAppearancePreview] = useState<SettingsPreview | null>(null)
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches)
  const [view, setView] = useState<'note' | 'plans' | 'board'>('note')
  const [mode, setMode] = useState<'source' | 'preview'>('source')
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [fullscreenPreview, setFullscreenPreview] = useState(false)
  const outlineButton = useRef<HTMLButtonElement>(null)
  const fullscreenButton = useRef<HTMLButtonElement>(null)
  const sourceArea = useRef<HTMLDivElement>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => !matchMedia('(max-width: 760px)').matches)
  const [revealEntry, setRevealEntry] = useState<{ path: string } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(Number(localStorage.getItem('echo:sidebar-width')) || 270)
  const [search, setSearch] = useState('')
  const [searchPaths, setSearchPaths] = useState<string[] | null>(null)
  const [group, setGroup] = useState<string | null>(null)
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<'settings' | 'categories' | 'classification' | 'export' | 'trash' | 'reminders' | 'repositories' | null>(null)
  const [manage, setManage] = useState<{ path: string; type: 'folder' | 'note' | 'drawing' } | null>(null)
  const [manageVisible, setManageVisible] = useState<boolean | null>(null)
  const [drawing, setDrawing] = useState<{ path: string; editing: boolean } | null>(null)
  const [notePicker, setNotePicker] = useState<{ resolve: (value: string | null) => void } | null>(null)
  const [drawioPicker, setDrawioPicker] = useState<{ resolve: (value: string | null) => void } | null>(null)
  const [drawingVersion, setDrawingVersion] = useState(0)
  const flushDrawing = useRef<(() => Promise<void>) | null>(null)
  const registerDrawingFlush = useCallback((flush: (() => Promise<void>) | null) => { flushDrawing.current = flush }, [])
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const promptResolve = useRef<(value: string | null) => void>(() => {})
  const [conflict, setConflict] = useState<Note | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState('')
  const [classTags, setClassTags] = useState('')
  const [classGroup, setClassGroup] = useState('')
  const [classBatch, setClassBatch] = useState(false)
  const [categoryTab, setCategoryTab] = useState<'groups' | 'tags'>('groups')
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [exportFormat, setExportFormat] = useState<'md' | 'bundle' | 'html' | 'pdf' | 'docx'>('html')
  const [exportScope, setExportScope] = useState<'current' | 'selected' | 'filtered'>('current')
  const [exportNotePath, setExportNotePath] = useState<string | null>(null)
  const [openingDirectory, setOpeningDirectory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  const [agentOpen, setAgentOpen] = useState(false)
  const [agentWidth, setAgentWidth] = useState(() => { const value = Number(localStorage.getItem('echo:agent-width')); return value >= 280 && value <= 560 ? value : 340 })
  const [agentPending, setAgentPendingState] = useState(false)
  const [, setEditorEpoch] = useState(0)
  const noteRef = useRef(note); noteRef.current = note
  const settingsRef = useRef(settings); settingsRef.current = settings
  const tabsRef = useRef(tabs); tabsRef.current = tabs
  const contentRef = useRef(content); contentRef.current = content
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const conflictRef = useRef(conflict); conflictRef.current = conflict
  const flight = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)
  const previewRef = useRef<HTMLDivElement>(null)
  const uploadsInFlight = useRef(0)
  const leavingRepository = useRef(false)
  const editorController = useRef<EditorController | null>(null)
  const agentInterrupt = useRef<() => void>(() => {})
  const agentPendingRef = useRef(false)
  const registerAgentInterrupt = useCallback((interrupt: () => void) => { agentInterrupt.current = interrupt }, [])
  const setAgentPending = useCallback((pending: boolean) => { agentPendingRef.current = pending; setAgentPendingState(pending) }, [])
  const leaveRepository = () => {
    if (leavingRepository.current) return
    leavingRepository.current = true
    clearRepositorySession()
    location.reload()
  }
  const leaveRepositoryRef = useRef(leaveRepository)
  leaveRepositoryRef.current = leaveRepository
  const appearance = appearancePreview || settings
  const dark = appearance.theme === 'dark' || (appearance.theme === 'system' && systemDark)
  const toast = useCallback((text: string, error = false) => { const id = Date.now() + Math.random(); setToasts(v => [...v.slice(-3), { id, text, error }]); setTimeout(() => setToasts(v => v.filter(t => t.id !== id)), error ? 8000 : 4200) }, [])
  const run = (action: () => Promise<unknown>) => { void action().catch(error => toast((error as Error).message, true)) }
  const ask = (p: Prompt) => new Promise<string | null>(resolve => { promptResolve.current = resolve; setPromptValue(p.value || ''); setPrompt(p) })
  const closePrompt = (value: string | null) => { setPrompt(null); promptResolve.current(value) }
  const acceptNote = useCallback((next: Note) => {
    noteRef.current = next; contentRef.current = next.content; dirtyRef.current = false; setNote(next); setContent(next.content); setDirty(false); setSaveError(''); localStorage.setItem('echo:last-note', next.path)
    if (!settingsRef.current.multiTabs) return
    const open = pushTab(tabsRef.current, next.path)
    if (open === tabsRef.current) return
    tabsRef.current = open; setTabs(open)
  }, [])
  const refresh = useCallback(async () => {
    const results = await Promise.all([api<NoteSummary[]>('/notes'), api<TreeEntry[]>('/tree'), api<string[]>('/groups'), api<string[]>('/tags'), api<Task[]>('/tasks'), api<Reminder[]>('/reminders'), api<Plan[]>('/plans'), api<CustomTask[]>('/custom-tasks')])
    if (!mounted.current) return
    setNotes(results[0] || []); setTree(results[1] || []); setGroups(results[2] || []); setTags(results[3] || []); setTasks(results[4] || []); setReminders(results[5] || []); setPlans(results[6] || []); setCustomTasks(results[7] || [])
    return results[0] || []
  }, [])
  const saveActive = useCallback(async (force = false): Promise<void> => {
    if (flight.current) { await flight.current; if (dirtyRef.current) return saveActive(force); return }
    const current = noteRef.current
    if (agentPendingRef.current || !current || !dirtyRef.current) return
    if (conflictRef.current && !force) { setConflict(conflictRef.current); throw new Error('请先解决笔记版本冲突。') }
    const snapshot = contentRef.current
    const operation = (async () => {
      setSaving(true); setSaveError('')
      try {
        const saved = await api<Note>('/notes', json('PUT', { path: current.path, content: snapshot, revision: current.revision, force }))
        if (noteRef.current?.path === current.path) {
          noteRef.current = saved; setNote(saved)
          const stillDirty = contentRef.current !== snapshot
          dirtyRef.current = stillDirty; setDirty(stillDirty)
          if (!stillDirty) localStorage.removeItem(draftKey(current.path))
          else localStorage.setItem(draftKey(current.path), JSON.stringify({ content: contentRef.current, revision: saved.revision }))
        }
        void refresh().catch(() => {})
      } catch (err) {
        setSaveError((err as Error).message)
        if (err instanceof ApiError && err.status === 409 && err.data.current) { setConflict(err.data.current as Note); conflictRef.current = err.data.current as Note }
        throw err
      } finally { setSaving(false) }
    })()
    flight.current = operation
    try { await operation } finally { flight.current = null }
    if (dirtyRef.current && noteRef.current?.path === current.path) await saveActive(force)
  }, [refresh])
  async function prepareRepositorySwitch() {
    agentInterrupt.current()
    await saveActive()
    if (flushDrawing.current) await flushDrawing.current()
  }
  const loadNote = useCallback(async (path: string, save = true) => {
    if (noteRef.current?.path !== path || agentPendingRef.current) agentInterrupt.current()
    if (save) await saveActive()
    const next = await api<Note>(`/notes?path=${query(path)}`)
    acceptNote(next); setView('note'); if (matchMedia('(max-width: 760px)').matches) setSidebarOpen(false)
    const stored = localStorage.getItem(draftKey(path))
    if (stored) { try { const draft = JSON.parse(stored); if (draft.content !== next.content) { contentRef.current = draft.content; dirtyRef.current = true; setContent(draft.content); setDirty(true); if (draft.revision !== next.revision) { setConflict(next); conflictRef.current = next } else toast('已恢复未保存的本地草稿。') } else localStorage.removeItem(draftKey(path)) } catch { localStorage.removeItem(draftKey(path)) } }
    return next
  }, [acceptNote, saveActive, toast])
  const refreshCurrent = useRef<() => void>(() => {})
  refreshCurrent.current = () => {
    void refresh().catch(() => {})
    const current = noteRef.current
    if (current && !dirtyRef.current && !flight.current) void api<Note>(`/notes?path=${query(current.path)}`).then(next => { if (noteRef.current?.path === next.path && !dirtyRef.current && !flight.current && noteRef.current.revision !== next.revision) acceptNote(next) }).catch(() => {})
  }
  useEffect(() => {
    mounted.current = true
    void (async () => {
      try {
        const [loaded, agentLoaded] = await Promise.all([api<Settings>('/settings'), api<AgentConfig>('/agent/config').catch(() => null)])
        if (!mounted.current) return
        setAgentConfig(agentLoaded)
        if (agentLoaded?.enabled && localStorage.getItem('echo:agent-open') === '1') setAgentOpen(true)
        const loadedSettings = completeSettings(loaded)
        settingsRef.current = loadedSettings
        setSettings(loadedSettings)
        const list = await refresh()
        if (!mounted.current) return
        if (loadedSettings.multiTabs) {
          const paths = new Set((list || []).map(item => item.path))
          const open = tabsRef.current.filter(path => paths.has(path))
          if (open.length !== tabsRef.current.length) { tabsRef.current = open; setTabs(open) }
        }
        const last = localStorage.getItem('echo:last-note')
        const path = list?.find(item => item.path === last)?.path || list?.[0]?.path
        if (path) await loadNote(path, false)
      } catch (e) { setFatal((e as Error).message) } finally { setLoading(false) }
    })()
    const events = new EventSource('/api/events')
    let timer: number | undefined
    const changed = () => { clearTimeout(timer); timer = window.setTimeout(() => refreshCurrent.current(), 250) }
    // 切换完成后再保存会把旧笔记写进新仓库，因此这里只退出并重新加载。发起切换的窗口会先保存。
    events.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as { type?: string }
        if (data?.type === 'switched') { leaveRepositoryRef.current(); return }
      } catch { /* 非 JSON 事件仍按内容变更处理 */ }
      changed()
    }
    events.addEventListener('changed', changed); events.addEventListener('reminder', changed)
    const focus = () => refreshCurrent.current()
    window.addEventListener('focus', focus)
    const poll = window.setInterval(focus, 30000)
    return () => { mounted.current = false; events.close(); clearTimeout(timer); clearInterval(poll); window.removeEventListener('focus', focus) }
  }, [refresh, loadNote])
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemDark(media.matches); media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)')
    const change = () => setSidebarOpen(!media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.documentElement.dataset.style = appearance.uiStyle || 'sage'; document.documentElement.style.setProperty('--accent', appearance.accent) }, [dark, appearance.accent, appearance.uiStyle])
  useEffect(() => { document.documentElement.dataset.animations = String(settings.animations); document.documentElement.dataset.noteWidth = settings.noteWidth; localStorage.setItem('echo:settings', JSON.stringify(settings)) }, [settings])
  useEffect(() => { localStorage.setItem(tabsKey, JSON.stringify(tabs)) }, [tabs])
  useEffect(() => { if (!dirty || conflict || conflictRef.current || agentPending) return; const id = setTimeout(() => { void saveActive().catch(() => {}) }, 800); return () => clearTimeout(id) }, [content, dirty, conflict, agentPending, saveActive])
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = '' } }
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveActive().catch(err => toast(err.message, true)) } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')?.focus()) } }
    window.addEventListener('beforeunload', before); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('beforeunload', before); window.removeEventListener('keydown', key) }
  }, [saveActive, toast])
  useEffect(() => { if (!search) { setSearchPaths(null); return } let canceled = false; const id = setTimeout(() => { void api<NoteSummary[]>(`/notes?q=${query(search)}`).then(list => { if (!canceled) setSearchPaths(list.map(n => n.path)) }).catch(() => {}) }, 180); return () => { canceled = true; clearTimeout(id) } }, [search, notes])
  const notified = useRef(new Set<string>())
  useEffect(() => {
    const pending = reminders.filter(r => !r.acknowledged && !notified.current.has(r.id))
    if (!pending.length) return
    pending.forEach(r => notified.current.add(r.id))
    void (async () => {
      const claimed: Reminder[] = []
      for (const reminder of pending) { try { if ((await api<{ claimed: boolean }>('/reminders/ack', json('POST', { id: reminder.id }))).claimed) claimed.push(reminder) } catch { notified.current.delete(reminder.id) } }
      if (claimed.length) { toast(`${claimed.length} 项计划已到提醒时间，可在右上角提醒中心查看。`); if ('Notification' in window && Notification.permission === 'granted') new Notification('Echo · 计划提醒', { body: claimed.length === 1 ? claimed[0].text : `${claimed.length} 项计划需要关注。`, tag: 'echo-reminders' }) }
    })()
  }, [reminders, toast])
  const changeContent = (value: string) => { setContent(value); contentRef.current = value; setDirty(true); dirtyRef.current = true; setSaveError(''); if (noteRef.current) { try { localStorage.setItem(draftKey(noteRef.current.path), JSON.stringify({ content: value, revision: noteRef.current.revision })) } catch { toast('本地草稿空间不足，请及时保存笔记。', true) } } }
  function saveNoteTitle(title: string) {
    const current = noteRef.current
    if (!current) return
    const nextContent = applyNoteTitle(contentRef.current, title)
    const next = { ...current, title }
    noteRef.current = next
    setNote(next)
    setNotes(items => items.map(item => item.path === current.path ? { ...item, title } : item))
    if (nextContent !== contentRef.current) changeContent(nextContent)
    void saveActive().catch(error => toast(error.message, true))
  }
  function scrollPreviewHeading(line: number) {
    const heading = previewRef.current?.querySelector<HTMLElement>(`[data-heading-line="${line}"]`)
    heading?.scrollIntoView({ block: 'start', behavior: settings.animations && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' })
    if (mode !== 'source') heading?.focus({ preventScroll: true })
  }
  function navigateHeading(line: number) {
    if (mode === 'source') {
      sourceArea.current?.querySelector('.cm-editor')?.dispatchEvent(new CustomEvent('echo:goto-line', { detail: line, bubbles: true }))
      if (settings.sourceSplitPreview) scrollPreviewHeading(line)
    } else scrollPreviewHeading(line)
    if (matchMedia('(max-width: 760px)').matches) setOutlineOpen(false)
  }
  function closeOutline() { setOutlineOpen(false); outlineButton.current?.focus() }
  function closeFullscreenPreview() { setFullscreenPreview(false); fullscreenButton.current?.focus() }
  async function createNote(parent = '') {
    const value = await ask({ title: '新建笔记', label: parent ? '笔记名称' : '笔记路径', value: '未命名笔记.md', description: parent ? `创建位置：${parent}\n填写笔记名称，可用 / 创建多层目录。` : '支持用 / 创建多层目录，例如：工作/项目想法.md', confirm: '创建笔记' })
    if (!value?.trim()) return
    const name = value.trim().replace(/\\/g, '/')
    const relative = /\.md$/i.test(name) ? name : `${name}.md`
    const path = parent ? `${parent}/${relative}` : relative
    await saveActive()
    const next = await api<Note>('/notes', json('POST', { path, content: '' }))
    acceptNote(next); setMode('source'); setView('note')
    if (!parent || matchMedia('(max-width: 760px)').matches) setSidebarOpen(false)
    await refresh(); setRevealEntry({ path: next.path }); toast('笔记已创建。')
  }
  async function newFolder(parent = '') {
    const value = await ask({ title: parent ? '新建目录' : '新建文件夹', label: parent ? '目录名称' : '文件夹路径', description: parent ? `创建位置：${parent}\n填写子目录名称，可用 / 创建多层目录。` : '例如：工作/项目资料', confirm: parent ? '创建目录' : '创建文件夹' })
    if (!value?.trim()) return
    const name = value.trim().replace(/\\/g, '/')
    const path = parent ? `${parent}/${name}` : name
    await api('/folders', json('POST', { path })); await refresh(); setRevealEntry({ path }); toast('目录已创建。')
  }
  async function createDrawing(parent = '') {
    const value = await ask({ title: '新建绘图', label: parent ? '绘图名称' : '绘图路径', value: '未命名绘图.excalidraw', description: parent ? `创建位置：${parent}\n填写绘图名称，可用 / 创建多层目录。` : '支持用 / 创建多层目录，例如：工作/架构图.excalidraw', confirm: '创建绘图' })
    if (!value?.trim()) return
    const name = value.trim().replace(/\\/g, '/')
    const relative = /\.excalidraw$/i.test(name) ? name : `${name}.excalidraw`
    const path = parent ? `${parent}/${relative}` : relative
    const created = await api<Drawing>('/drawings', json('POST', { path }))
    await refresh(); setRevealEntry({ path: created.path }); setDrawing({ path: created.path, editing: true })
    if (matchMedia('(max-width: 760px)').matches) setSidebarOpen(false)
    toast('绘图已创建。')
  }
  async function createDrawio(parent = '') {
    const value = await ask({ title: '新建 Draw.io', label: parent ? '绘图名称' : '绘图路径', value: '未命名图表.drawio', description: parent ? `创建位置：${parent}\n填写绘图名称，可用 / 创建多层目录。` : '支持用 / 创建多层目录，例如：工作/流程图.drawio', confirm: '创建 Draw.io' })
    if (!value?.trim()) return
    const name = value.trim().replace(/\\/g, '/')
    const relative = /\.drawio$/i.test(name) ? name : `${name}.drawio`
    const path = parent ? `${parent}/${relative}` : relative
    const created = await api<Drawing>('/drawings', json('POST', { path }))
    await refresh(); setRevealEntry({ path: created.path }); setDrawing({ path: created.path, editing: true })
    if (matchMedia('(max-width: 760px)').matches) setSidebarOpen(false)
    toast('Draw.io 图表已创建。')
  }
  function editDrawing(path: string) {
    if (document.fullscreenElement) { setFullscreenPreview(false); void document.exitFullscreen().catch(() => {}) }
    setDrawing({ path, editing: true })
  }
  async function insertDrawing() {
    const notePath = noteRef.current?.path
    if (!notePath) throw new Error('请先新建笔记。')
    const created = await api<Drawing>('/drawings', json('POST', { notePath }))
    if (!created.markdownPath) throw new Error('绘图引用缺失。')
    setDrawing({ path: created.path, editing: true })
    return created.markdownPath
  }
  function clearActive() { editorController.current = null; noteRef.current = null; contentRef.current = ''; dirtyRef.current = false; setNote(null); setContent(''); setDirty(false); setSaveError('') }
  async function closeTab(path: string) {
    if (!tabsRef.current.includes(path)) return
    const closingActive = noteRef.current?.path === path
    if (closingActive) agentInterrupt.current()
    if (closingActive) await saveActive()
    const current = tabsRef.current
    if (!current.includes(path)) return
    const neighbor = neighborTab(current, path, item => item !== path)
    if (closingActive && neighbor) await loadNote(neighbor, false)
    const remaining = tabsRef.current.filter(item => item !== path)
    tabsRef.current = remaining
    setTabs(remaining)
    if (!closingActive || neighbor) return
    localStorage.removeItem(draftKey(path))
    clearActive()
  }
  async function manageAction(action: 'rename' | 'move' | 'delete') {
    if (!manage) return
    const item = manage
    setManage(null)
    if (flushDrawing.current) await flushDrawing.current()
    const resource = item.type === 'note' ? 'notes' : item.type === 'drawing' ? 'drawings' : 'folders'
    if (action === 'delete') {
      if (await ask({ title: '移至回收站', description: `${item.path}${item.type === 'folder' ? ' 及其内容' : ''}将移至回收站，可随时恢复。`, confirm: '移至回收站', danger: true }) === null) return
      if (noteRef.current && affectsPath(noteRef.current.path, item.path)) agentInterrupt.current()
      await saveActive()
      await api(`/${resource}?path=${query(item.path)}`, json('DELETE'))
      setDrawing(current => current && affectsPath(current.path, item.path) ? null : current)
      const removed = (path: string) => affectsPath(path, item.path)
      const previous = tabsRef.current
      const remaining = previous.filter(path => !removed(path))
      tabsRef.current = remaining
      setTabs(remaining)
      previous.filter(removed).forEach(path => localStorage.removeItem(draftKey(path)))
      const active = noteRef.current?.path
      if (active && removed(active)) {
        const neighbor = neighborTab(previous, active, path => !removed(path))
        if (settingsRef.current.multiTabs && neighbor) {
          try { await loadNote(neighbor, false) } catch (error) { clearActive(); throw error }
        } else clearActive()
      }
      setSelected(paths => paths.filter(path => !removed(path)))
      await refresh()
      toast('已移至回收站。')
      return
    }
    const value = await ask({ title: action === 'rename' ? '重命名' : '移动位置', label: '完整路径', value: item.path, description: '填写相对于笔记库的路径，引用将自动更新。', confirm: '保存' })
    if (!value?.trim() || value === item.path) return
    await saveActive()
    let target = value.trim()
    if (item.type === 'note' && !/\.md$/i.test(target)) target = `${target}.md`
    if (item.type === 'drawing') {
      const ext = /\.drawio$/i.test(item.path) ? '.drawio' : '.excalidraw'
      if (!target.toLowerCase().endsWith(ext)) target = target.replace(/\.(?:drawio|excalidraw)$/i, '') + ext
    }
    const current = item.type === 'note' ? await api<Note>(`/notes?path=${query(item.path)}`) : item.type === 'drawing' ? await api<Drawing>(`/drawings?path=${query(item.path)}`) : null
    await api(`/${resource}/move`, json('POST', { path: item.path, target, revision: current?.revision }))
    setDrawing(currentDrawing => currentDrawing ? { ...currentDrawing, path: retargetPath(currentDrawing.path, item.path, target) } : currentDrawing)
    const mapped = tabsRef.current.map(path => retargetPath(path, item.path, target))
    const unique = mapped.filter((path, index) => mapped.indexOf(path) === index)
    tabsRef.current = unique
    setTabs(unique)
    const active = noteRef.current?.path
    if (active) await loadNote(retargetPath(active, item.path, target), false)
    setSelected([])
    await refresh()
    toast('路径已更新。')
  }
  function openClassification(batch = false) { run(async () => { await saveActive(); const current = noteRef.current; setClassBatch(batch); setClassTags(batch ? '' : current?.metadata.tags.join(', ') || ''); setClassGroup(batch ? '' : current?.metadata.group || ''); setDialog('classification') }) }
  async function applyClassification() { await saveActive(); const paths = classBatch ? selected : note ? [note.path] : []; const updated = await api<Note[]>('/notes/batch', json('POST', { paths, tags: [...new Set(classTags.split(/[,，\n]/).map(s => s.trim()).filter(Boolean))], group: classGroup, revisions: Object.fromEntries(notes.filter(n => paths.includes(n.path)).map(n => [n.path, n.path === noteRef.current?.path ? noteRef.current.revision : n.revision])) })); const active = updated.find(n => n.path === noteRef.current?.path); if (active) acceptNote(active); await refresh(); setDialog(null); toast('标签与分组已更新。') }
  async function categoryAction(kind: 'groups' | 'tags', name?: string, remove = false) { await saveActive(); if (remove && name) { if (await ask({ title: `删除${kind === 'groups' ? '分组' : '标签'}`, description: `删除“${name}”将移除对应分类，笔记文件会保留。`, confirm: '删除', danger: true }) === null) return; await api(`/${kind}?name=${query(name)}`, json('DELETE')) } else { const newName = await ask({ title: `${name ? '重命名' : '新增'}${kind === 'groups' ? '分组' : '标签'}`, label: '名称', value: name, confirm: '保存' }); if (!newName?.trim()) return; await api(`/${kind}`, json(name ? 'PUT' : 'POST', name ? { name, newName: newName.trim() } : { name: newName.trim() })) } await refresh(); if (noteRef.current) await loadNote(noteRef.current.path, false) }
  async function updateTask(task: Task, patch: Partial<Task>) { await saveActive(); const latest = await api<Task[]>('/tasks'); const fresh = latest.find(t => t.id === task.id && t.notePath === task.notePath); if (!fresh) throw new Error('任务已被修改，请刷新后重试。'); const updated = await api<Note>('/tasks', json('PUT', { ...patch, notePath: fresh.notePath, line: fresh.line, id: fresh.id, revision: fresh.revision })); if (updated.path === noteRef.current?.path) acceptNote(updated); await refresh() }
  async function savePlan(plan: PlanDraft) { await api<Plan>('/plans', json(plan.id ? 'PUT' : 'POST', plan)); await refresh() }
  async function deletePlan(plan: Plan) { await api(`/plans?id=${query(plan.id)}`, json('DELETE')); await refresh() }
  async function saveCustomTask(task: CustomTaskDraft) { await api<CustomTask>('/custom-tasks', json(task.id ? 'PUT' : 'POST', task)); await refresh() }
  async function deleteCustomTask(task: CustomTask) { await api(`/custom-tasks?id=${query(task.id)}`, json('DELETE')); await refresh() }
  async function upload(file: File) { const path = noteRef.current?.path; if (!path) throw new Error('请先新建笔记。'); uploadsInFlight.current++; try { const body = new FormData(); body.append('file', file); const result = await api<{ markdownPath: string }>(`/assets?notePath=${query(path)}`, { method: 'POST', body }); return result.markdownPath } finally { uploadsInFlight.current-- } }
  async function openLocalDirectory() {
    if (openingDirectory) return
    setOpeningDirectory(true)
    try { await api('/storage/open', json('POST')); toast('已打开笔记库目录。') }
    finally { setOpeningDirectory(false) }
  }
  async function prepareStorageAction() { if (uploadsInFlight.current) throw new Error('图片正在上传，请完成后再检查清理。'); await saveActive(); if (uploadsInFlight.current) throw new Error('图片正在上传，请完成后再检查清理。') }
  async function saveSettings(next: Settings) { await saveActive(); const result = completeSettings(await api<Settings>('/settings', json('PUT', next))); settingsRef.current = result; setSettings(result); await refresh(); if (noteRef.current) await loadNote(noteRef.current.path, false); toast('设置已保存。') }
  async function saveAgent(input: AgentConfigInput) {
    const saved = await saveAgentConfig(input)
    setAgentConfig(saved)
    if (!saved.enabled) { agentInterrupt.current(); setAgentOpen(false); localStorage.setItem('echo:agent-open', '0') }
  }
  function resolveAgentEdits(action: 'accept' | 'reject') {
    if (action === 'reject') {
      const current = noteRef.current
      if (current && contentRef.current === current.content) { dirtyRef.current = false; setDirty(false); setSaveError(''); localStorage.removeItem(draftKey(current.path)) }
      return
    }
    void saveActive().catch(err => toast(err.message, true))
  }
  function toggleAgent() {
    setAgentOpen(open => {
      const next = !open
      localStorage.setItem('echo:agent-open', next ? '1' : '0')
      return next
    })
  }
  const annotations = useAnnotations(note?.path, toast)
  useEffect(() => { if (mode !== 'preview') annotations.closeTool() }, [mode, annotations.closeTool])
  useEffect(() => {
    if (!manage || manage.type !== 'note') { setManageVisible(null); return }
    if (annotations.state?.path === manage.path) { setManageVisible(annotations.state.visible); return }
    let alive = true
    setManageVisible(null)
    void api<AnnotationList>(`/annotations?path=${query(manage.path)}`).then(list => { if (alive) setManageVisible(list.visible) }).catch(() => { if (alive) setManageVisible(null) })
    return () => { alive = false }
  }, [manage, annotations.state?.path, annotations.state?.visible])
  const filtered = notes.filter(n => (group === null || n.metadata.group === group) && filterTags.every(t => n.metadata.tags.includes(t)) && (!search || (searchPaths ? searchPaths.includes(n.path) : `${n.title} ${n.path}`.toLowerCase().includes(search.toLowerCase()))))
  const noteTitles = useMemo(() => Object.fromEntries(notes.map(item => [item.path, item.title || item.path.replace(/\.md$/i, '')])), [notes])
  const exportPaths = exportNotePath ? [exportNotePath] : exportScope === 'current' ? note ? [note.path] : [] : exportScope === 'selected' ? selected : filtered.map(n => n.path)
  async function doExport() { setBusy(true); try { await exportNotes({ paths: exportPaths, format: exportFormat, lineNumbers: settings.previewLineNumbers, strictLineBreaks: settings.strictLineBreaks, beforeExport: saveActive, onWarning: async warning => (await ask({ title: '导出资源提示', description: [...(warning.missing.length ? [`缺失资源：${warning.missing.join('、')}`] : []), ...(warning.external.length ? [`包含 ${warning.external.length} 张外链图片，离线时可能无法显示。`] : [])].join('\n'), confirm: '继续导出' })) !== null }); setDialog(null); toast(exportFormat === 'pdf' ? '打印视图已打开，请选择“另存为 PDF”。' : '导出已完成。') } finally { setBusy(false) } }
  const selectedCount = selected.length
  const showAnnotations = Boolean(annotations.state?.visible && note && annotations.state.path === note.path)
  const annotationLayer = (readOnly: boolean) => showAnnotations && annotations.state ? <AnnotationLayer items={annotations.state.items} tool={readOnly || !annotations.toolOpen ? null : annotations.tool} color={annotations.color} strokePixels={annotations.strokePixels} onCreate={annotations.create} onUpdate={annotations.update} onDelete={annotations.remove} onStaleChange={annotations.setStaleIds} /> : null
  if (loading || fatal) return <div className="loading-screen"><Logo /><h1>echo.</h1>{fatal ? <><p role="alert">{fatal}</p><button className="button primary" onClick={() => location.reload()}>重新连接</button></> : <><LoaderCircle className="spin" size={20} /><p>正在打开你的本地空间…</p></>}</div>
  return <MotionConfig skipAnimations={!settings.animations} reducedMotion={settings.animations ? 'user' : 'always'} transition={{ duration: settings.animations ? .18 : 0 }}>
    <div className="app-shell" style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      <Sidebar notes={notes} tree={tree} groups={groups} tags={tags} active={note?.path || ''} view={view} open={sidebarOpen} revealEntry={revealEntry} search={search} setSearch={setSearch} searchPaths={searchPaths} group={group} setGroup={setGroup} filterTags={filterTags} setFilterTags={setFilterTags} selected={selected} setSelected={setSelected} onSelect={path => run(() => loadNote(path))} onView={next => run(async () => { await saveActive(); setView(next); if (matchMedia('(max-width: 760px)').matches) setSidebarOpen(false); await refresh() })} onCreate={() => run(createNote)} onFolder={() => run(newFolder)} onCreateDrawing={() => run(() => createDrawing())} onDraw={() => run(() => createDrawio())} onOpenDrawing={editDrawing} activeDrawing={drawing?.path || ''} onManage={(path, type) => setManage({ path, type })} onOpenDirectory={() => run(openLocalDirectory)} openingDirectory={openingDirectory} onSettings={() => setDialog('settings')} onTrash={() => run(async () => { setTrash(await api<TrashEntry[]>('/trash')); setDialog('trash') })} onRepositories={() => setDialog('repositories')} onCategories={() => setDialog('categories')} onClose={() => setSidebarOpen(false)} />
      <div className="sidebar-resizer" hidden={!sidebarOpen} role="separator" aria-label="调整目录宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const width = Math.max(220, Math.min(430, sidebarWidth + (e.key === 'ArrowRight' ? 10 : -10))); setSidebarWidth(width); localStorage.setItem('echo:sidebar-width', String(width)) } }} onPointerDown={e => { const start = e.clientX, width = sidebarWidth; e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.onpointermove = event => setSidebarWidth(Math.max(220, Math.min(430, width + event.clientX - start))); e.currentTarget.onpointerup = event => { const value = Math.max(220, Math.min(430, width + event.clientX - start)); localStorage.setItem('echo:sidebar-width', String(value)); e.currentTarget.onpointermove = null; e.currentTarget.onpointerup = null } }} />
      <main className="main-panel"><header className="topbar"><div className="topbar-left"><button className="icon-button" aria-label={sidebarOpen ? '折叠目录' : '展开目录'} title={sidebarOpen ? '折叠目录' : '展开目录'} aria-expanded={sidebarOpen} aria-controls="note-sidebar" onClick={() => setSidebarOpen(open => !open)}><PanelLeft size={18} /></button><div className="breadcrumb"><span>我的空间</span><ChevronRight size={13} /><span>{view === 'note' ? note?.path || '全部笔记' : view === 'plans' ? '计划与提醒' : '任务看板'}</span></div></div><div className="topbar-actions">{view === 'note' && note && <button className={`save-status ${dirty ? 'unsaved' : 'saved'}`} title={saveError || 'Ctrl+S 保存'} onClick={() => run(saveActive)}>{saving ? <LoaderCircle size={13} className="spin" /> : saveError ? <AlertTriangle size={13} /> : dirty ? <Cloud size={14} /> : <CheckCheck size={14} />}<span>{saving ? '保存中' : saveError ? '保存失败' : dirty ? '待保存' : '已保存'}</span></button>}{agentConfig?.enabled && <button className="icon-button" aria-label={agentOpen ? '关闭 Agent' : '打开 Agent'} title="笔记 Agent" aria-expanded={agentOpen} onClick={toggleAgent}><Bot size={17} /></button>}<button className="icon-button" aria-label={dark ? '切换明亮模式' : '切换暗黑模式'} onClick={() => run(() => saveSettings({ ...settings, theme: dark ? 'light' : 'dark' }))}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button><button className="icon-button notification-button" aria-label="提醒中心" onClick={() => setDialog('reminders')}><Bell size={17} />{reminders.length > 0 && <i />}</button><span className="topbar-divider" /><button className="button export-button" onClick={() => { setExportNotePath(null); setExportScope(selected.length ? 'selected' : note ? 'current' : 'filtered'); setDialog('export') }}><Download size={15} /><span>导出</span></button></div></header>
      {settings.multiTabs && view === 'note' && tabs.length > 0 && <NoteTabs tabs={tabs} active={note?.path || ''} dirty={dirty} onSelect={path => { if (path !== noteRef.current?.path) run(() => loadNote(path)) }} onClose={path => run(() => closeTab(path))} />}
      {selectedCount > 0 && <div className="selection-bar"><span>已选择 {selectedCount} 篇笔记</span><button onClick={() => openClassification(true)}>批量设置分类</button><button onClick={() => { setExportNotePath(null); setExportScope('selected'); setDialog('export') }}>导出所选</button><button className="icon-button" aria-label="取消选择" onClick={() => setSelected([])}><X size={14} /></button></div>}
      {view === 'note' ? note ? <div className="note-workspace"><section className="note-heading"><div className="note-title-row"><NoteTitle key={note.path} title={note.title || note.path.replace(/\.md$/i, '')} onSave={saveNoteTitle} /><button className="icon-button" aria-label="笔记操作" onClick={() => setManage({ path: note.path, type: 'note' })}><MoreHorizontal size={19} /></button></div><div className="note-meta"><button className="meta-button" onClick={() => openClassification()}><FolderOpen size={13} />{note.metadata.group || '未分组'}<ChevronRight size={11} /></button><span className="meta-divider" />{note.metadata.tags.map(tag => <button className="tag" key={tag} onClick={() => setFilterTags(filterTags.includes(tag) ? filterTags.filter(t => t !== tag) : [...filterTags, tag])}># {tag}</button>)}<button className="tag-add" onClick={() => openClassification()}><Plus size={12} />{note.metadata.tags.length ? '编辑标签' : '添加标签'}</button></div>{note.metadataError && <p className="form-error">文件头格式有误：{note.metadataError}。请在源码中修复后修改分类。</p>}</section>
        <div className="mode-bar"><div className="mode-tabs" role="tablist" aria-label="编辑模式"><button role="tab" aria-selected={mode === 'source'} className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')}><span>〈/〉</span>源码</button><button role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><BookOpen size={13} />预览</button></div><button ref={fullscreenButton} type="button" className="outline-toggle" aria-label="全屏预览" onClick={() => setFullscreenPreview(true)}><Maximize2 size={15} />全屏</button>{mode === 'preview' && <button type="button" className="outline-toggle" aria-label="标注" aria-expanded={annotations.toolOpen} onClick={() => { void annotations.toggleTool().catch(() => {}) }}><Highlighter size={15} />标注</button>}<button ref={outlineButton} type="button" className="outline-toggle" aria-label="导航" aria-expanded={outlineOpen} aria-controls="note-outline" onClick={() => setOutlineOpen(open => !open)}><ListTree size={15} />导航</button></div>
        <div className="note-body">
          {outlineOpen && <NoteOutline key={note.path} content={content} onNavigate={navigateHeading} onClose={closeOutline} />}
          <div className={`note-content${settings.sourceSplitPreview && mode === 'source' ? ' split-preview' : ''}`}>
            <div ref={sourceArea} className="editor-area" style={{ display: mode === 'source' ? undefined : 'none' }}><Editor key={note.path} value={content} onChange={changeContent} fontSize={appearance.editorFontSize} lineNumbers={settings.editorLineNumbers} dark={dark} shortcuts={settings.shortcuts} onUpload={upload} onDrawingInsert={async () => { try { return await insertDrawing() } catch (error) { toast((error as Error).message, true); return '' } }} onNoteReference={() => new Promise(resolve => setNotePicker(current => { current?.resolve(null); return { resolve } }))} onDrawioReference={() => new Promise(resolve => setDrawioPicker(current => { current?.resolve(null); return { resolve } }))} onSave={() => run(saveActive)} onReady={controller => { editorController.current = controller; setEditorEpoch(value => value + 1) }} /></div><div ref={previewRef} className={`preview-area${annotations.toolOpen && mode === 'preview' ? ' annotating' : ''}`} style={{ display: mode === 'preview' || (settings.sourceSplitPreview && mode === 'source') ? undefined : 'none' }}>{annotations.toolOpen && mode === 'preview' && <AnnotationToolbar tool={annotations.tool} setTool={annotations.setTool} color={annotations.color} setColor={annotations.setColor} strokePixels={annotations.strokePixels} setStrokePixels={annotations.setStrokePixels} canUndo={annotations.undoCount > 0} onUndo={() => { void annotations.undo().catch(() => {}) }} onDone={annotations.closeTool} staleCount={annotations.staleIds.length} onClearStale={() => { void annotations.removeMany(annotations.staleIds) }} />}<MarkdownView content={content} notePath={note.path} noteTitles={noteTitles} fontSize={appearance.editorFontSize} lineNumbers={settings.previewLineNumbers} drawingVersion={drawingVersion} dark={dark} strictLineBreaks={settings.strictLineBreaks} onEditDrawing={editDrawing} onNavigate={path => run(() => loadNote(path))} onToggleTask={(line, checked) => run(async () => { await saveActive(); const latest = await api<Task[]>('/tasks'); const task = latest.find(t => t.notePath === note.path && t.line === line); if (!task) throw new Error('任务位置发生变化，请重试。'); await updateTask(task, { status: checked ? 'done' : 'todo' }) })} annotations={annotationLayer(false)} /></div>
          </div>
        </div>
        {fullscreenPreview && createPortal(<FullscreenPreview title={note.title || note.path.replace(/\.md$/i, '')} onClose={closeFullscreenPreview}><MarkdownView content={content} notePath={note.path} noteTitles={noteTitles} fontSize={appearance.editorFontSize} lineNumbers={settings.previewLineNumbers} drawingVersion={drawingVersion} dark={dark} strictLineBreaks={settings.strictLineBreaks} onEditDrawing={editDrawing} onNavigate={path => run(() => loadNote(path))} onToggleTask={(line, checked) => run(async () => { await saveActive(); const latest = await api<Task[]>('/tasks'); const task = latest.find(t => t.notePath === note.path && t.line === line); if (!task) throw new Error('任务位置发生变化，请重试。'); await updateTask(task, { status: checked ? 'done' : 'todo' }) })} annotations={annotationLayer(true)} /></FullscreenPreview>, document.body)}
        <footer className="statusbar"><span><span className="local-dot" /><time dateTime={note.modified} title="最后更新">{new Date(note.modified).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time></span><div><span>{content.replace(/\s/g, '').length.toLocaleString()} 字符</span><span>{content.split('\n').length} 行</span><span>UTF-8</span></div></footer></div> : <div className="empty-state"><div className="empty-symbol"><BookOpen size={36} strokeWidth={1.3} /></div><h1>留一点空间，给新的想法。</h1><p>选择一篇笔记，或开始记录你的第一份灵感。</p><button className="button primary" onClick={() => run(createNote)}><Plus size={16} />新建笔记</button></div> : view === 'plans' ? <PlansView plans={plans} onSave={savePlan} onDelete={deletePlan} /> : <TasksView tasks={tasks} customTasks={customTasks} onUpdateTask={updateTask} onNavigate={task => run(async () => { await loadNote(task.notePath); setMode('source'); setTimeout(() => { const editor = document.querySelector('.cm-editor'); editor?.dispatchEvent(new CustomEvent('echo:goto-line', { detail: task.line, bubbles: true })) }, 50) })} onSaveCustom={saveCustomTask} onDeleteCustom={deleteCustomTask} />}
      </main>
      {agentConfig?.enabled && agentOpen && <div className="agent-resizer" role="separator" aria-label="调整 Agent 宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; const width = Math.max(280, Math.min(560, agentWidth + (event.key === 'ArrowLeft' ? 16 : -16))); setAgentWidth(width); localStorage.setItem('echo:agent-width', String(width)) }} onPointerDown={event => { const start = event.clientX; const width = agentWidth; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.onpointermove = move => setAgentWidth(Math.max(280, Math.min(560, width + start - move.clientX))); event.currentTarget.onpointerup = move => { const value = Math.max(280, Math.min(560, width + start - move.clientX)); setAgentWidth(value); localStorage.setItem('echo:agent-width', String(value)); event.currentTarget.onpointermove = null; event.currentTarget.onpointerup = null } }} />}
      {agentConfig?.enabled && <AgentPanel open={agentOpen} width={agentWidth} note={note ? { path: note.path, title: note.title || note.path.replace(/\.md$/i, '') } : null} getNoteContent={() => contentRef.current} editor={editorController.current} onPendingChange={setAgentPending} onEnsureSource={() => setMode('source')} onEditsResolved={resolveAgentEdits} onRegisterInterrupt={registerAgentInterrupt} onCollapse={() => { setAgentOpen(false); localStorage.setItem('echo:agent-open', '0') }} />}
    </div>
    <AnimatePresence>{dialog === 'settings' && <SettingsPanel settings={settings} systemDark={systemDark} agent={agentConfig} onPreview={setAppearancePreview} onSave={saveSettings} onSaveAgent={saveAgent} beforeStorageAction={prepareStorageAction} onClose={() => { setAppearancePreview(null); setDialog(null) }} />}
    {dialog === 'repositories' && <RepoSwitcher onClose={() => setDialog(null)} onPrepare={prepareRepositorySwitch} onSwitched={() => leaveRepositoryRef.current()} />}
    {manage && <Modal title={manage.type === 'note' ? '笔记操作' : manage.type === 'drawing' ? '绘图操作' : '文件夹操作'} onClose={() => setManage(null)}><p className="field-help">{manage.path}</p><div className="dialog-stack">{manage.type === 'folder' && <><button className="button" onClick={() => { const parent = manage.path; setManage(null); run(() => newFolder(parent)) }}><FolderPlus size={16} />新建目录</button><button className="button" onClick={() => { const parent = manage.path; setManage(null); run(() => createNote(parent)) }}><FileText size={16} />新建笔记</button><button className="button" onClick={() => { const parent = manage.path; setManage(null); run(() => createDrawing(parent)) }}><PenTool size={16} />新建绘图</button><button className="button" onClick={() => { const parent = manage.path; setManage(null); run(() => createDrawio(parent)) }}><Workflow size={16} />新建 Draw.io</button></>}<button className="button" onClick={() => run(() => manageAction('rename'))}><Pencil size={16} />重命名</button><button className="button" onClick={() => run(() => manageAction('move'))}><ArrowRightLeft size={16} />移动位置</button>{manage.type === 'note' && <><button className="button" onClick={() => run(async () => { const path = manage.path; setManage(null); await loadNote(path); openClassification() })}><Tag size={16} />标签与分组</button><button className="button" onClick={() => { setExportNotePath(manage.path); setExportScope('current'); setManage(null); setDialog('export') }}><Download size={16} />导出该笔记</button>{manageVisible != null && <button className="button" onClick={() => { const next = !manageVisible; void annotations.setNoteVisible(manage.path, next).then(() => setManageVisible(next)).catch(() => {}) }}>{manageVisible ? <EyeOff size={16} /> : <Eye size={16} />}{manageVisible ? '隐藏标注' : '显示标注'}</button>}</>}<button className="button danger" onClick={() => run(() => manageAction('delete'))}><Trash2 size={16} />移至回收站</button></div></Modal>}
    {dialog === 'classification' && <Modal title={classBatch ? `设置 ${selectedCount} 篇笔记的分类` : '标签与分组'} onClose={() => setDialog(null)}><form onSubmit={e => { e.preventDefault(); run(applyClassification) }}><label className="field-label" htmlFor="note-group">分组</label><div className="inline-field"><Select id="note-group" value={classGroup} onChange={setClassGroup} options={[{ value: '', label: '未分组' }, ...groups.map(value => ({ value, label: value }))]} /><button type="button" className="button" onClick={() => run(async () => { const name = await ask({ title: '新增分组', label: '分组名称', confirm: '创建' }); if (!name?.trim()) return; await api('/groups', json('POST', { name: name.trim() })); await refresh(); setClassGroup(name.trim()) })}><Plus size={15} />新增</button></div><label className="field-label" htmlFor="note-tags">标签</label><input id="note-tags" value={classTags} onChange={e => setClassTags(e.target.value)} placeholder="用逗号分隔，例如：灵感, 工作" /><div className="tag-suggestions">{tags.map(t => <button type="button" className="tag" key={t} onClick={() => setClassTags(v => [...new Set([...v.split(/[,，]/).map(s => s.trim()).filter(Boolean), t])].join(', '))}># {t}</button>)}</div><p className="field-help">{classBatch ? '将替换所选笔记的标签和分组。' : '分组不会移动文件，一篇笔记可设置多个标签。'}</p><div className="modal-actions"><button type="button" className="button" onClick={() => setDialog(null)}>取消</button><button className="button primary" type="submit">保存分类</button></div></form></Modal>}
    {dialog === 'categories' && <Modal title="管理分类" onClose={() => setDialog(null)}><div className="category-tabs"><button className={categoryTab === 'groups' ? 'active' : ''} onClick={() => setCategoryTab('groups')}>分组</button><button className={categoryTab === 'tags' ? 'active' : ''} onClick={() => setCategoryTab('tags')}>标签</button><button className="button" onClick={() => run(() => categoryAction(categoryTab))}><Plus size={14} />新增</button></div><div className="category-list">{(categoryTab === 'groups' ? groups : tags).map(name => <div className="category-row" key={name}><span>{categoryTab === 'groups' ? <FolderOpen size={15} /> : <Tag size={15} />}{name}</span><div><button className="icon-button" aria-label={`重命名 ${name}`} onClick={() => run(() => categoryAction(categoryTab, name))}><Pencil size={14} /></button><button className="icon-button danger" aria-label={`删除 ${name}`} onClick={() => run(() => categoryAction(categoryTab, name, true))}><Trash2 size={14} /></button></div></div>)}{!(categoryTab === 'groups' ? groups : tags).length && <p className="field-help">还没有分类，点击新增开始整理。</p>}</div></Modal>}
    {dialog === 'export' && <Modal title="导出笔记" onClose={() => { if (!busy) setDialog(null) }}><label className="field-label" htmlFor={exportNotePath ? undefined : 'export-scope'}>{exportNotePath ? '导出笔记' : '导出范围'}</label>{exportNotePath ? <p className="field-help">{exportNotePath}</p> : <Select id="export-scope" value={exportScope} onChange={value => setExportScope(value as typeof exportScope)} options={[{ value: 'current', label: '当前笔记', disabled: !note }, { value: 'selected', label: '所选笔记（' + selected.length + ' 篇）', disabled: !selected.length }, { value: 'filtered', label: '当前分组 / 标签 / 搜索结果（' + filtered.length + ' 篇）' }]} />}<label className="field-label">导出格式</label><div className="export-options">{([['md', 'Markdown', '原始 .md 文件，不含图片资源'], ['bundle', 'Markdown 资源包', '保留目录和元数据，包含本地图片'], ['html', 'HTML 网页', '独立网页，内嵌本地图片与高亮样式'], ['pdf', 'PDF 文档', '专用打印排版，浏览器另存为 PDF'], ['docx', 'Word 文档', '可编辑的 .docx，多篇打包为 ZIP']] as const).map(([value, label, help]) => <button key={value} className={`export-format ${exportFormat === value ? 'selected' : ''}`} onClick={() => setExportFormat(value)} disabled={value === 'md' && exportPaths.length !== 1}><FileText size={19} /><span><strong>{label}</strong><small>{help}</small></span>{exportFormat === value && <Check size={16} />}</button>)}</div><p className="field-help">将导出 {exportPaths.length} 篇笔记。导出前自动保存；外链图片需要联网显示。</p><div className="modal-actions"><button className="button" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="button primary" disabled={busy || !exportPaths.length || (exportFormat === 'md' && exportPaths.length !== 1)} onClick={() => run(doExport)}>{busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{busy ? '准备导出…' : '开始导出'}</button></div></Modal>}
    {dialog === 'trash' && <Modal title="回收站" onClose={() => setDialog(null)} wide><p className="field-help">移除的笔记和文件夹保留在这里，恢复时不会覆盖同名文件。</p><div className="category-list">{trash.map(item => <div className="category-row" key={item.id}><div><strong>{item.path}</strong><small>{new Date(item.deletedAt).toLocaleString('zh-CN')}</small></div><button className="button" onClick={() => run(async () => { await api('/trash/restore', json('POST', { id: item.id })); setTrash(await api<TrashEntry[]>('/trash')); await refresh(); toast('已恢复。') })}><RotateCcw size={14} />恢复</button></div>)}{!trash.length && <div className="tasks-empty"><Trash2 size={24} /><p>回收站是空的</p></div>}</div></Modal>}
    {dialog === 'reminders' && <Modal title="提醒中心" onClose={() => setDialog(null)} wide><div className="setting-row"><p className="field-help">网页打开时显示通知，关闭期间的到期计划在重新打开后补提醒。</p><button className="button" onClick={() => run(async () => { if (!('Notification' in window)) { toast('此浏览器不支持系统通知。', true); return } const permission = await Notification.requestPermission(); toast(permission === 'granted' ? '已开启浏览器通知。' : '未开启系统通知，应用内提醒仍然有效。') })}><Bell size={14} />开启浏览器通知</button></div><div className="category-list">{reminders.slice().reverse().map(item => { const plan = plans.find(entry => entry.id === item.planId); const detail = plan ? planScheduleLabel(plan) : item.notePath || '计划提醒'; return <button className="reminder-row" key={item.id} onClick={() => { setView('plans'); setDialog(null) }}><Bell size={16} /><span><strong>{item.text}</strong><small>{detail} · {new Date(item.due).toLocaleString('zh-CN')}</small></span><ChevronRight size={14} /></button> })}{!reminders.length && <div className="tasks-empty"><Bell size={25} /><p>还没有到期提醒</p></div>}</div></Modal>}
    {conflict && <Modal title="笔记存在版本冲突" onClose={() => setConflict(null)} wide><p className="field-help">磁盘上的笔记已变化。你的草稿仍保存在浏览器中，请选择如何处理。</p><div className="conflict-grid"><div className="conflict-column"><strong>当前草稿</strong><pre>{content}</pre></div><div className="conflict-column"><strong>磁盘版本</strong><pre>{conflict.content}</pre></div></div><div className="modal-actions wrap"><button className="button" onClick={() => run(async () => { const disk = conflict; const path = `${disk.path.replace(/\.md$/i, '')}-草稿-${Date.now()}.md`; await api('/notes', json('POST', { path, content: contentRef.current })); localStorage.removeItem(draftKey(disk.path)); setConflict(null); conflictRef.current = null; acceptNote(disk); await refresh(); toast('草稿已另存为新笔记，当前显示磁盘版本。') })}><Copy size={14} />另存草稿副本</button><button className="button" onClick={() => { localStorage.removeItem(draftKey(conflict.path)); acceptNote(conflict); setConflict(null); conflictRef.current = null }}>使用磁盘版本</button><button className="button danger" onClick={() => run(async () => { await saveActive(true); setConflict(null); conflictRef.current = null; toast('已用草稿覆盖磁盘版本。') })}>覆盖磁盘版本</button></div></Modal>}
    {drawing && (/\.drawio$/i.test(drawing.path)
      ? <DrawioModal key={drawing.path} path={drawing.path} dark={dark} onClose={() => { setDrawing(null); setDrawingVersion(version => version + 1) }} onConflict={() => toast('绘图已被其他窗口或外部程序修改，未覆盖磁盘内容。', true)} onError={message => toast(message, true)} onRegisterFlush={registerDrawingFlush} />
      : <DrawingModal key={drawing.path} path={drawing.path} editing={drawing.editing} dark={dark} onClose={() => { setDrawing(null); setDrawingVersion(version => version + 1) }} onConflict={() => toast('绘图已被其他窗口或外部程序修改，未覆盖磁盘内容。', true)} onError={message => toast(message, true)} onRegisterFlush={registerDrawingFlush} />)}
    {prompt && <Modal title={prompt.title} onClose={() => closePrompt(null)}><form onSubmit={e => { e.preventDefault(); closePrompt(prompt.label ? promptValue : 'confirmed') }}>{prompt.description && <p className="field-help preserve-lines">{prompt.description}</p>}{prompt.label && <><label className="field-label" htmlFor="prompt-input">{prompt.label}</label><input id="prompt-input" autoFocus value={promptValue} onChange={e => setPromptValue(e.target.value)} required /></>}<div className="modal-actions"><button className="button" type="button" onClick={() => closePrompt(null)}>取消</button><button className={`button ${prompt.danger ? 'danger' : 'primary'}`} type="submit">{prompt.confirm || '确定'}</button></div></form></Modal>}
    {notePicker && <NotePicker tree={tree} notes={notes} exclude={note?.path || ''} onSelect={path => { const current = noteRef.current?.path; const target = notes.find(item => item.path === path); notePicker.resolve(current && target ? noteReferenceMarkdown(current, { path: target.path, title: target.title }) : null); setNotePicker(null) }} onClose={() => { notePicker.resolve(null); setNotePicker(null) }} />}
    {drawioPicker && <NotePicker kind="drawio" tree={tree} notes={notes} exclude="" onSelect={path => { const current = noteRef.current?.path; drawioPicker.resolve(current ? drawioReferenceMarkdown(current, path) : null); setDrawioPicker(null) }} onClose={() => { drawioPicker.resolve(null); setDrawioPicker(null) }} />}
    </AnimatePresence>
    <div className="toast-stack" aria-live="polite"><AnimatePresence>{toasts.map(t => <motion.div key={t.id} className={`toast ${t.error ? 'toast-error' : 'toast-success'}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>{t.error ? <AlertTriangle size={17} /> : <Check size={17} />}<span>{t.text}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setToasts(v => v.filter(item => item.id !== t.id))}><X size={14} /></button></motion.div>)}</AnimatePresence></div>
  </MotionConfig>
}

function FullscreenPreview({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const node = ref.current
    const onChange = () => { if (!document.fullscreenElement) close.current() }
    document.addEventListener('fullscreenchange', onChange)
    void node?.requestFullscreen?.().catch(() => {})
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement === node) void document.exitFullscreen().catch(() => {})
    }
  }, [])
  return createPortal(<div ref={ref} className="fullscreen-preview" role="region" aria-label="全屏预览">
    <div className="fullscreen-preview-bar"><h2>{title}</h2><button type="button" className="outline-toggle" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => close.current()); else close.current() }}><X size={15} />退出全屏</button></div>
    <div className="preview-area">{children}</div>
  </div>, document.body)
}
