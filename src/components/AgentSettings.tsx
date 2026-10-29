import { useState } from 'react'
import { testAgentConnection } from '../agent/client'
import type { AgentConfig } from '../types'
import { Switch } from './UI'

export function AgentSettings({ draft, apiKey, disabled, onChange, onKeyChange }: { draft: AgentConfig; apiKey: string; disabled: boolean; onChange: (patch: Partial<AgentConfig>) => void; onKeyChange: (key: string) => void }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState('')
  const [failed, setFailed] = useState(false)
  async function test() {
    setTesting(true)
    setFailed(false)
    setResult('正在连接…')
    try {
      const response = await testAgentConnection({ baseURL: draft.baseURL, apiKey: apiKey.trim(), model: draft.model, timeoutSeconds: draft.timeoutSeconds })
      setResult(response.reply ? `连接成功：${response.reply}` : '连接成功。')
    } catch (error) {
      setFailed(true)
      setResult((error as Error).message)
    } finally {
      setTesting(false)
    }
  }
  return <>
    <div className="settings-page-heading"><h3>Agent 设置</h3></div>
    <p className="field-help">使用 OpenAI 兼容接口。密钥保存在当前笔记库的 .echo/agent.json，会随笔记库一起被复制或同步。</p>
    <section className="settings-section">
      <div className="setting-row"><div><strong>启用 Agent</strong><p>开启后，可在右侧打开笔记助手。笔记模式能修改当前笔记，聊天模式只对话。</p></div><Switch label="启用 Agent" checked={draft.enabled} onChange={enabled => onChange({ enabled })} /></div>
    </section>
    <section className="settings-section">
      <h4>接口</h4>
      <label className="field-label" htmlFor="agent-base-url">API 地址</label>
      <input id="agent-base-url" value={draft.baseURL} spellCheck={false} autoComplete="off" placeholder="https://api.openai.com/v1" onChange={event => onChange({ baseURL: event.target.value })} />
      <label className="field-label" htmlFor="agent-api-key">API Key</label>
      <input id="agent-api-key" type="password" value={apiKey} spellCheck={false} autoComplete="off" placeholder={draft.hasKey ? `已配置 ${draft.apiKeyHint}，留空则不修改` : 'sk-...'} onChange={event => onKeyChange(event.target.value)} />
      <label className="field-label" htmlFor="agent-model">模型</label>
      <input id="agent-model" value={draft.model} spellCheck={false} autoComplete="off" onChange={event => onChange({ model: event.target.value })} />
      <label className="field-label" htmlFor="agent-timeout">超时时间（秒）</label>
      <input id="agent-timeout" type="number" min={5} max={600} step={1} value={draft.timeoutSeconds} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) onChange({ timeoutSeconds: value }) }} />
      <p className="field-help">等待模型开始响应的时间，5–600 秒，默认 90 秒。开始输出后不再计时。</p>
    </section>
    <section className="settings-section">
      <h4>上下文</h4>
      <label className="field-label" htmlFor="agent-context">上下文长度</label>
      <input id="agent-context" type="number" min={1024} max={2000000} step={1} value={draft.contextTokens} onChange={event => onChange({ contextTokens: Number(event.target.value) })} />
      <label className="field-label" htmlFor="agent-output">最大输出</label>
      <input id="agent-output" type="number" min={1} max={128000} step={1} value={draft.maxOutputTokens} onChange={event => onChange({ maxOutputTokens: Number(event.target.value) })} />
      <label className="field-label" htmlFor="agent-temperature">温度（0–2）</label>
      <input id="agent-temperature" type="number" min={0} max={2} step={0.1} value={draft.temperature} onChange={event => onChange({ temperature: Number(event.target.value) })} />
      <p className="field-help">上下文长度包含系统提示、当前笔记和历史对话。历史会从最新的消息往前保留，放不下的旧消息会被丢掉。</p>
    </section>
    <section className="settings-section">
      <label className="field-label" htmlFor="agent-system">系统提示词</label>
      <textarea id="agent-system" rows={5} value={draft.systemPrompt} onChange={event => onChange({ systemPrompt: event.target.value })} />
      <div className="setting-row"><p className="field-help">用当前填写的地址、密钥和模型试一次，不会保存设置。</p><button className="button" type="button" onClick={() => void test()} disabled={disabled || testing}>{testing ? '正在连接…' : '测试连接'}</button></div>
      {result && <p className={failed ? 'form-error' : 'field-help'} role="status">{result}</p>}
    </section>
  </>
}
