import { useState } from 'react'
import { ApiError, apiURL, buildApiOrigin, defaultApiHost, defaultApiPort, getApiBase } from '../api'

export type ConnectionDraft = { host: string; port: string; custom: boolean }

export function loadConnectionDraft(): ConnectionDraft {
  const base = getApiBase()
  if (!base) return { host: defaultApiHost(), port: defaultApiPort(), custom: false }
  try {
    const url = new URL(base)
    return { host: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80'), custom: true }
  } catch {
    return { host: defaultApiHost(), port: defaultApiPort(), custom: false }
  }
}

export function connectionOrigin(draft: ConnectionDraft): string {
  if (!draft.custom) return ''
  return buildApiOrigin(draft.host, draft.port)
}

export function connectionChanged(draft: ConnectionDraft): boolean {
  return connectionOrigin(draft) !== getApiBase()
}

export async function testConnection(draft: ConnectionDraft): Promise<string> {
  const origin = draft.custom ? buildApiOrigin(draft.host, draft.port) : ''
  const url = origin ? `${origin}/api/settings` : apiURL('/api/settings')
  const response = await fetch(url)
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new ApiError(response.status, data)
  }
  return origin || `${window.location.protocol}//${defaultApiHost()}:${defaultApiPort()}`
}

export function ConnectionSettings({ draft, disabled, onChange }: { draft: ConnectionDraft; disabled: boolean; onChange: (draft: ConnectionDraft) => void }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState('')
  const [failed, setFailed] = useState(false)
  const defaults = { host: defaultApiHost(), port: defaultApiPort() }

  async function test() {
    setTesting(true)
    setFailed(false)
    setResult('正在连接…')
    try {
      const target = await testConnection(draft)
      setResult(`连接成功：${target}`)
    } catch (error) {
      setFailed(true)
      setResult((error as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return <>
    <div className="settings-page-heading">
      <h3>对接配置</h3>
      <button className="font-size-reset" type="button" disabled={disabled || !draft.custom} onClick={() => { setResult(''); setFailed(false); onChange({ host: defaults.host, port: defaults.port, custom: false }) }}>恢复默认</button>
    </div>
    <p className="field-help">指定笔记 API 后端的地址。默认同当前页面（本进程启动时打开的 IP 与端口）。可将本进程仅作静态页，把请求指向另一台或另一端口的 Echo。</p>
    <section className="settings-section">
      <h4>后端地址</h4>
      <div className="connection-fields">
        <div>
          <label className="field-label" htmlFor="connection-host">主机</label>
          <input id="connection-host" value={draft.custom ? draft.host : defaults.host} spellCheck={false} autoComplete="off" placeholder={defaults.host} disabled={disabled} onChange={event => onChange({ ...draft, host: event.target.value, custom: true })} />
        </div>
        <div>
          <label className="field-label" htmlFor="connection-port">端口</label>
          <input id="connection-port" inputMode="numeric" value={draft.custom ? draft.port : defaults.port} spellCheck={false} autoComplete="off" placeholder={defaults.port} disabled={disabled} onChange={event => onChange({ ...draft, port: event.target.value, custom: true })} />
        </div>
      </div>
      <p className="field-help">{draft.custom ? `当前将使用 http://${draft.host}:${draft.port}` : `当前使用默认地址 http://${defaults.host}:${defaults.port}`}</p>
      <div className="setting-row">
        <p className="field-help">用当前填写的地址试一次，不会保存设置。</p>
        <button className="button" type="button" onClick={() => void test()} disabled={disabled || testing}>{testing ? '正在连接…' : '测试连接'}</button>
      </div>
      {result && <p className={failed ? 'form-error' : 'field-help'} role="status">{result}</p>}
    </section>
  </>
}
