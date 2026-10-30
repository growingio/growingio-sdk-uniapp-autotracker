import { describe, expect, it } from 'vitest'

import { appEntrySnapshot, createAppLifecycleBridge } from '../../src/adapters/uniapp.js'

describe('appEntrySnapshot', () => {
  it('preserves an existing query string and turns documented scalar query objects into an encoded snapshot', () => {
    expect(appEntrySnapshot({ path: '/pages/home', query: 'from=push' })).toStrictEqual({ path: '/pages/home', query: 'from=push' })
    expect(appEntrySnapshot({ path: '/pages/home', query: { name: '张 三', active: false, page: 0, nested: { ignored: true } } }))
      .toStrictEqual({ path: '/pages/home', query: 'name=%E5%BC%A0%20%E4%B8%89&active=false&page=0' })
  })

  it('does not retain unknown host objects and delegates all three App hooks', () => {
    const calls: unknown[] = []
    const bridge = createAppLifecycleBridge({
      onAppLaunch: (entry) => { calls.push(['launch', entry]); return true },
      onAppShow: (entry) => { calls.push(['show', entry]); return false },
      onAppHide: () => { calls.push(['hide']); return true },
    })
    expect(bridge.onLaunch({ path: '', query: [] })).toBe(true)
    expect(bridge.onShow(null)).toBe(false)
    expect(bridge.onHide()).toBe(true)
    expect(calls).toStrictEqual([
      ['launch', { path: null, query: null }], ['show', { path: null, query: null }], ['hide'],
    ])
  })

  it('keeps valid query entries when a string cannot be URI encoded or a value getter throws', () => {
    const query = { valid: '中文😀', broken: '\ud800', '\udfff': 'bad-key', get throwing() { throw new Error('host getter') }, zero: 0 }
    expect(appEntrySnapshot({ path: '/home', query })).toEqual({ path: '/home', query: 'valid=%E4%B8%AD%E6%96%87%F0%9F%98%80&zero=0' })
  })

  it('falls back to an empty query when the host cannot enumerate the query object', () => {
    const query = new Proxy({}, { ownKeys() { throw new Error('host proxy') } })
    expect(appEntrySnapshot({ path: '/home', query })).toEqual({ path: '/home', query: null })
  })
})
