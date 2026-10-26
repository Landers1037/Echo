export type ShortcutGroup = 'heading' | 'text' | 'block'

export type ShortcutAction = {
  id: string
  name: string
  group: ShortcutGroup
  defaultKey: string
}

export const shortcutGroups: { id: ShortcutGroup; label: string }[] = [
  { id: 'heading', label: '标题' },
  { id: 'text', label: '文本格式' },
  { id: 'block', label: '块与列表' },
]

const headingLevels = ['一', '二', '三', '四', '五', '六']

export const shortcutActions: ShortcutAction[] = [
  ...headingLevels.map((level, index) => ({ id: `heading${index + 1}`, name: `${level}级标题`, group: 'heading' as const, defaultKey: `Mod-${index + 1}` })),
  { id: 'bold', name: '加粗', group: 'text', defaultKey: 'Mod-b' },
  { id: 'italic', name: '斜体', group: 'text', defaultKey: 'Mod-i' },
  { id: 'strikethrough', name: '删除线', group: 'text', defaultKey: 'Mod-Shift-x' },
  { id: 'underline', name: '下划线', group: 'text', defaultKey: 'Mod-u' },
  { id: 'inlineCode', name: '行内代码', group: 'text', defaultKey: 'Mod-e' },
  { id: 'codeBlock', name: '多行代码块', group: 'block', defaultKey: 'Mod-Shift-k' },
  { id: 'quote', name: '引用块', group: 'block', defaultKey: 'Mod-Shift-q' },
  { id: 'orderedList', name: '有序列表', group: 'block', defaultKey: 'Mod-Shift-7' },
  { id: 'unorderedList', name: '无序列表', group: 'block', defaultKey: 'Mod-Shift-8' },
]

const reservedLabels: Record<string, string> = {
  'Mod-s': '保存',
  'Mod-k': '搜索',
  'Mod-f': '查找',
  'Mod-z': '撤销',
  'Mod-y': '重做',
  'Mod-Shift-z': '重做',
  'Mod-a': '全选',
  'Mod-c': '复制',
  'Mod-v': '粘贴',
  'Mod-x': '剪切',
}

export const reservedShortcuts = Object.keys(reservedLabels)
const modifiers = new Set(['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'])
const bindableShortcut = /^((?:Mod|Ctrl|Alt|Shift|Meta)-)+[^\s-]+$/
const modifierKeys = new Set(['Control', 'Shift', 'Alt', 'Meta'])

export type ShortcutConflict =
  | { type: 'reserved'; label: string }
  | { type: 'action'; id: string; name: string }

export function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(`${navigator.platform} ${navigator.userAgent}`)
}

export function resolveShortcuts(overrides?: Record<string, string> | null): Record<string, string> {
  const source = overrides ?? {}
  return Object.fromEntries(shortcutActions.map(action => [action.id, Object.prototype.hasOwnProperty.call(source, action.id) ? source[action.id] : action.defaultKey]))
}

export function withShortcut(overrides: Record<string, string>, actionId: string, shortcut: string): Record<string, string> {
  const action = shortcutActions.find(item => item.id === actionId)
  const next = { ...overrides }
  if (!action || shortcut === action.defaultKey) delete next[actionId]
  else next[actionId] = shortcut
  return next
}

export function isBindableShortcut(shortcut: string) {
  return shortcut.length > 0 && shortcut.length <= 40 && bindableShortcut.test(shortcut)
}

export function canonicalShortcut(shortcut: string, mac = isMac()) {
  const parts = shortcut.split('-')
  const key = parts.pop() ?? ''
  const used = new Set(parts.filter(part => modifiers.has(part)))
  const ordered: string[] = []
  if (mac ? used.has('Mod') || used.has('Meta') : used.has('Mod') || used.has('Ctrl')) ordered.push('Mod')
  if (mac && used.has('Ctrl')) ordered.push('Ctrl')
  if (!mac && used.has('Meta')) ordered.push('Meta')
  if (used.has('Alt')) ordered.push('Alt')
  if (used.has('Shift')) ordered.push('Shift')
  ordered.push(key.length === 1 ? key.toLowerCase() : key)
  return ordered.join('-')
}

export function formatShortcut(shortcut: string, mac = isMac()) {
  if (!shortcut) return '未设置'
  const parts = shortcut.split('-')
  return parts.map((part, index) => {
    if (index === parts.length - 1) return part === 'Space' ? 'Space' : part.length === 1 ? part.toUpperCase() : part
    if (part === 'Mod') return mac ? 'Cmd' : 'Ctrl'
    if (part === 'Meta') return mac ? 'Cmd' : 'Win'
    if (part === 'Alt') return mac ? 'Option' : 'Alt'
    return part
  }).join(' + ')
}

export function findConflict(actionId: string, shortcut: string, overrides?: Record<string, string> | null, mac = isMac()): ShortcutConflict | null {
  if (!shortcut) return null
  const canonical = canonicalShortcut(shortcut, mac)
  for (const reserved of reservedShortcuts) {
    if (canonicalShortcut(reserved, mac) === canonical) return { type: 'reserved', label: reservedLabels[reserved] }
  }
  const resolved = resolveShortcuts(overrides)
  for (const action of shortcutActions) {
    if (action.id === actionId || !resolved[action.id]) continue
    if (canonicalShortcut(resolved[action.id], mac) === canonical) return { type: 'action', id: action.id, name: action.name }
  }
  return null
}

export function bindingFor(overrides: Record<string, string> | undefined, actionId: string, mac = isMac()) {
  const shortcut = resolveShortcuts(overrides)[actionId] ?? ''
  if (!isBindableShortcut(shortcut) || findConflict(actionId, shortcut, overrides, mac)?.type === 'reserved') return ''
  return shortcut
}

export function shortcutBindings(overrides?: Record<string, string> | null, mac = isMac()) {
  const used = new Set<string>()
  const bindings: { id: string; key: string }[] = []
  for (const action of shortcutActions) {
    const key = bindingFor(overrides ?? undefined, action.id, mac)
    if (!key) continue
    const canonical = canonicalShortcut(key, mac)
    if (used.has(canonical)) continue
    used.add(canonical)
    bindings.push({ id: action.id, key })
  }
  return bindings
}

const punctuation: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.',
}
const namedKeys = new Set(['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

function physicalKey(event: KeyboardEvent) {
  const code = event.code || ''
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (digit) return digit[1]
  if (code === 'Space') return 'Space'
  if (punctuation[code]) return punctuation[code]
  if (/^F\d{1,2}$/.test(code) || namedKeys.has(code)) return code
  if (code === 'NumpadEnter') return 'Enter'
  if (!event.key || event.key === 'Unidentified' || modifierKeys.has(event.key)) return null
  return event.key.length === 1 ? event.key.toLowerCase() : event.key
}

export function keyFromEvent(event: KeyboardEvent, mac = isMac()) {
  if (event.isComposing || event.key === 'Dead') return null
  if (!(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return null
  if (modifierKeys.has(event.key)) return null
  const key = physicalKey(event)
  if (!key) return null
  const parts: string[] = []
  if (mac ? event.metaKey : event.ctrlKey) parts.push('Mod')
  if (mac && event.ctrlKey) parts.push('Ctrl')
  if (!mac && event.metaKey) parts.push('Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (!parts.length) return null
  parts.push(key)
  return parts.join('-')
}
