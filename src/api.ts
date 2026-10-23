export class ApiError extends Error {
  constructor(public status: number, public data: Record<string, unknown>) { super(String(data.error || `请求失败 (${status})`)) }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
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
