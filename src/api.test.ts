import { afterEach, describe, expect, it } from 'vitest'
import { API_BASE_KEY, apiURL, buildApiOrigin, getApiBase, resolveApiPath, setApiBase } from './api'

describe('api base helpers', () => {
  afterEach(() => {
    localStorage.removeItem(API_BASE_KEY)
  })

  it('defaults to same-origin relative URLs', () => {
    expect(getApiBase()).toBe('')
    expect(apiURL('/settings')).toBe('/api/settings')
    expect(apiURL('/api/events')).toBe('/api/events')
    expect(resolveApiPath('/api/link-previews/image?id=abc')).toBe('/api/link-previews/image?id=abc')
  })

  it('stores a normalized origin and prefixes absolute API URLs', () => {
    setApiBase('http://192.168.1.8:9000/')
    expect(getApiBase()).toBe('http://192.168.1.8:9000')
    expect(apiURL('/notes')).toBe('http://192.168.1.8:9000/api/notes')
    expect(apiURL('/api/events')).toBe('http://192.168.1.8:9000/api/events')
    expect(resolveApiPath('/api/assets?path=a.png')).toBe('http://192.168.1.8:9000/api/assets?path=a.png')
    expect(resolveApiPath('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
  })

  it('clears the override and rejects non-http schemes', () => {
    setApiBase('http://127.0.0.1:9090')
    setApiBase('')
    expect(getApiBase()).toBe('')
    expect(() => setApiBase('ftp://127.0.0.1:21')).toThrow(/http/)
  })

  it('builds an origin from host and port', () => {
    expect(buildApiOrigin('192.168.1.8', '9000')).toBe('http://192.168.1.8:9000')
    expect(buildApiOrigin('::1', '8080')).toBe('http://[::1]:8080')
    expect(() => buildApiOrigin('', '8080')).toThrow(/主机/)
    expect(() => buildApiOrigin('127.0.0.1', '0')).toThrow(/端口/)
  })
})
