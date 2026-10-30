import { describe, expect, it } from 'vitest'

import { createPageLifecycleBridge } from '../../src/adapters/uniapp.js'

describe('createPageLifecycleBridge', () => {
  it('freezes one serializable onLoad snapshot and delegates later lifecycle hooks with the same instance id', () => {
    const calls: unknown[] = []
    const bridge = createPageLifecycleBridge({
      onPageLoad: (value) => { calls.push(['load', value]); return true },
      onPageShow: (...value) => { calls.push(['show', ...value]); return true },
      onPageHide: (value) => { calls.push(['hide', value]); return true },
      onPageUnload: (value) => { calls.push(['unload', value]); return true },
    }, 'detail#1')

    expect(bridge.onLoad('pages/detail/index', { id: 42, source: 'card' }, 'pages/home/index')).toBe(true)
    expect(bridge.onShow('Detail')).toBe(true)
    expect(bridge.onHide()).toBe(true)
    expect(bridge.onUnload()).toBe(true)
    expect(calls).toStrictEqual([
      ['load', { instanceId: 'detail#1', route: 'pages/detail/index', query: 'id=42&source=card', referralPage: 'pages/home/index' }],
      ['show', 'detail#1', 'Detail'], ['hide', 'detail#1'], ['unload', 'detail#1'],
    ])
  })

  it('rejects a missing instance or route without producing a page lifecycle call', () => {
    const calls: unknown[] = []
    const bridge = createPageLifecycleBridge({
      onPageLoad: () => { calls.push('load'); return true }, onPageShow: () => true, onPageHide: () => true, onPageUnload: () => true,
    }, '')
    expect(bridge.onLoad('', {})).toBe(false)
    expect(calls).toStrictEqual([])
  })

  it('converts a tab item tap into a constrained click call without exposing the host object', () => {
    const calls: unknown[] = []
    const bridge = createPageLifecycleBridge({
      onPageLoad: () => true, onPageShow: () => true, onPageHide: () => true, onPageUnload: () => true,
      autoTrack: (call) => { calls.push(call); return true },
    }, 'home#1')
    expect(bridge.onTabItemTap({ index: 0, text: 'Home', pagePath: 'pages/home/index', extra: { unsafe: true } })).toBe(true)
    for (const index of [-1, 1.5, NaN, Infinity, 2147483646, '0', {}]) expect(bridge.onTabItemTap({ index })).toBe(false)
    expect(bridge.onTabItemTap({ index: 0, pagePath: {} })).toBe(false)
    expect(bridge.onTabItemTap({ get index() { throw new Error('host') } })).toBe(false)
    expect(calls).toStrictEqual([
      { schemaVersion: 2, source: 'tabbar', kind: 'click', xpath: '#onTabItemTap', index: 1, textValue: 'Home', hyperlink: 'pages/home/index' },
    ])
  })
})
