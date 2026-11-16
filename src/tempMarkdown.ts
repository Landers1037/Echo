export type TempMarkdownFile = { id: string; name: string; content: string; createdAt: string }

export const tempMarkdownPathPrefix = 'temp-md:'
export const tempMarkdownStoragePrefix = 'echo:temp-md:'

export class TempMarkdownQuotaError extends Error {
  constructor() {
    super('浏览器存储空间不足，无法预览该 Markdown 文件。')
    this.name = 'TempMarkdownQuotaError'
  }
}

export function isTempMarkdownPath(path: string) {
  return path.startsWith(tempMarkdownPathPrefix) && path.length > tempMarkdownPathPrefix.length
}

export function tempMarkdownPath(id: string) {
  return tempMarkdownPathPrefix + id
}

function storageKey(id: string) {
  return tempMarkdownStoragePrefix + id
}

function newTempId() {
  const uuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)
  if (uuid) return uuid()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function asTempFile(id: string, value: unknown): TempMarkdownFile | null {
  if (!value || typeof value !== 'object') return null
  const file = value as Partial<TempMarkdownFile>
  if (typeof file.name !== 'string' || typeof file.content !== 'string') return null
  return { id, name: file.name || '未命名.md', content: file.content, createdAt: typeof file.createdAt === 'string' ? file.createdAt : '' }
}

export function createTempMarkdown(name: string, content: string): TempMarkdownFile {
  const id = newTempId()
  const file: TempMarkdownFile = { id, name: name.trim() || '未命名.md', content, createdAt: new Date().toISOString() }
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(file))
  } catch {
    throw new TempMarkdownQuotaError()
  }
  return file
}

export function readTempMarkdown(path: string): TempMarkdownFile | null {
  if (!isTempMarkdownPath(path)) return null
  const id = path.slice(tempMarkdownPathPrefix.length)
  try {
    const raw = localStorage.getItem(storageKey(id))
    if (!raw) return null
    return asTempFile(id, JSON.parse(raw))
  } catch {
    return null
  }
}

export function removeTempMarkdown(path: string) {
  if (!isTempMarkdownPath(path)) return
  localStorage.removeItem(storageKey(path.slice(tempMarkdownPathPrefix.length)))
}

export function listTempMarkdownPaths() {
  const paths: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith(tempMarkdownStoragePrefix)) paths.push(tempMarkdownPath(key.slice(tempMarkdownStoragePrefix.length)))
  }
  return paths
}

export function pruneTempMarkdownStorage(activeTabs: readonly string[]) {
  const keep = new Set(activeTabs.filter(isTempMarkdownPath))
  for (const path of listTempMarkdownPaths()) {
    if (!keep.has(path)) removeTempMarkdown(path)
  }
}

export function tempMarkdownLabel(path: string) {
  const name = readTempMarkdown(path)?.name || '临时预览'
  return name.replace(/\.md$/i, '') || name
}

export async function readDroppedText(file: Blob & { name?: string }) {
  if (typeof file.text === 'function') return file.text()
  if (typeof file.arrayBuffer === 'function') return new TextDecoder().decode(await file.arrayBuffer())
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name || '文件'}。`))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  })
}
