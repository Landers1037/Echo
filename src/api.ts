export class ApiError extends Error {
  constructor(public status: number, public data: Record<string, unknown>) { super(String(data.error || `请求失败 (${status})`)) }
}

export const API_BASE_KEY = 'echo:api-base'

export function getApiBase(): string {
  try {
    const value = localStorage.getItem(API_BASE_KEY)?.trim() ?? ''
    if (!value) return ''
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

export function setApiBase(origin: string): void {
  const trimmed = origin.trim()
  if (!trimmed) {
    localStorage.removeItem(API_BASE_KEY)
    return
  }
  const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http 或 https')
  localStorage.setItem(API_BASE_KEY, parsed.origin)
}

/** Build an API URL. `path` may be `/api/...` or a suffix like `/settings` (prefixed with `/api`). */
export function apiURL(path: string): string {
  const normalized = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`
  const base = getApiBase()
  return base ? `${base}${normalized}` : normalized
}

/** Prefix a server-returned relative `/api/...` path when a custom API base is set. */
export function resolveApiPath(path: string): string {
  if (!path || path.startsWith('data:') || /^https?:\/\//i.test(path)) return path
  if (path.startsWith('/api')) return apiURL(path)
  return path
}

export function defaultApiHost(): string {
  return window.location.hostname || '127.0.0.1'
}

export function defaultApiPort(): string {
  if (window.location.port) return window.location.port
  return window.location.protocol === 'https:' ? '443' : '80'
}

export function buildApiOrigin(host: string, port: string): string {
  const hostname = host.trim()
  const portText = port.trim()
  if (!hostname) throw new Error('请填写主机地址')
  if (!portText) throw new Error('请填写端口')
  const portNumber = Number(portText)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('端口必须是 1 到 65535 之间的数字')
  return new URL(`http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${portNumber}`).origin
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiURL(path), {
    ...options,
    headers: { ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }))
    throw new ApiError(response.status, data)
  }
  return response.status === 204 ? undefined as T : response.json()
}

export const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
export const query = (path: string) => encodeURIComponent(path)
