import { describe, expect, it } from 'vitest'
import { API_BASE_KEY, setApiBase } from '../api'
import { connectionChanged, connectionOrigin, loadConnectionDraft } from './ConnectionSettings'

describe('ConnectionSettings helpers', () => {
  it('treats empty storage as the page default', () => {
    localStorage.removeItem(API_BASE_KEY)
    const draft = loadConnectionDraft()
    expect(draft.custom).toBe(false)
    expect(connectionOrigin(draft)).toBe('')
    expect(connectionChanged(draft)).toBe(false)
  })

  it('loads a custom origin and detects changes', () => {
    setApiBase('http://192.168.1.8:9000')
    const draft = loadConnectionDraft()
    expect(draft).toEqual({ host: '192.168.1.8', port: '9000', custom: true })
    expect(connectionOrigin(draft)).toBe('http://192.168.1.8:9000')
    expect(connectionChanged({ ...draft, port: '9001' })).toBe(true)
    localStorage.removeItem(API_BASE_KEY)
  })
})
