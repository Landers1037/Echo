import { ApiError, api, json, query } from '../api'
import type { AgentConfig, AgentConfigInput, AgentEvent, AgentMessage, AgentMode, Conversation } from '../types'

export function getAgentConfig() {
  return api<AgentConfig>('/agent/config')
}

export function saveAgentConfig(input: AgentConfigInput) {
  return api<AgentConfig>('/agent/config', json('PUT', input))
}

export function testAgentConnection(input: { baseURL?: string; apiKey?: string; model?: string }) {
  return api<{ ok: boolean; reply: string }>('/agent/test', json('POST', input))
}

export function listConversations() {
  return api<Conversation[]>('/agent/conversations')
}

export function getConversation(id: string) {
  return api<{ conversation: Conversation; messages: AgentMessage[] }>(`/agent/conversations?id=${query(id)}`)
}

export function createConversation(mode: AgentMode, notePath = '') {
  return api<Conversation>('/agent/conversations', json('POST', { mode, notePath }))
}

export function renameConversation(id: string, title: string) {
  return api<Conversation>('/agent/conversations', json('PUT', { id, title }))
}

export function deleteConversation(id: string) {
  return api<{ ok: boolean }>(`/agent/conversations?id=${query(id)}`, json('DELETE'))
}

export function setMessageOutcome(id: string, outcome: 'accepted' | 'rejected', detail = '') {
  return api<{ ok: boolean }>('/agent/messages/outcome', json('PATCH', { id, outcome, detail }))
}

export type ChatRequest = { conversationId?: string; mode: AgentMode; message: string; note?: { path: string; content: string } }

export async function* streamChat(body: ChatRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }))
    throw new ApiError(response.status, data)
  }
  if (!response.body) throw new Error('浏览器不支持流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (!data) continue
      yield JSON.parse(data) as AgentEvent
    }
    if (done) break
  }
}
