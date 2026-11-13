import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackerRuntime } from '../../src/core/growingIO.js'
import { miniCases, miniHost, miniTargets } from '../support/miniprogram-host.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe.each(miniTargets)('%s delivery recovery', target => {
  it('revalidates the real appId after asynchronous public initialization fails', async () => {
    vi.resetModules()
    const f = miniHost(target)
    f.values.set('_growing_uid_', 123)
    vi.stubGlobal('uni', f.host)
    const { default: gdp } = await import('../../index.js')
    let tracker!: TrackerRuntime
    const app = { mixin: vi.fn() }
    gdp('registerPlugins', [{ name: 'review', install: value => { tracker = value } }])
    expect(gdp('init', 'account', 'source', { uniVue: app, appId: f.appId })).toBe(true)
    expect(await tracker.whenReady()).toBe(false)
    f.values.set('_growing_uid_', 'repaired-device')
    expect(gdp('init', 'account', 'source', { uniVue: app, appId: 'wrong-app' })).toBe(false)
    expect(tracker.canRetryInit()).toBe(true)
    expect(gdp('init', 'account', 'source', { uniVue: app, appId: f.appId })).toBe(true)
    expect(await tracker.whenReady()).toBe(true)
    const hooks = app.mixin.mock.calls[0]![0] as Record<string, (this: object, value?: unknown) => void>
    hooks.onShow!.call({ $mpType: 'app' }, { path: 'pages/home', scene: 1001 })
    expect(tracker.queuedEvents()[0]).toMatchObject({ domain: f.appId, deviceId: 'repaired-device' })
    expect(app.mixin).toHaveBeenCalledTimes(1)
  })

  it('rejects another Vue application or changed platform during an initialization retry', async () => {
    vi.resetModules()
    const f = miniHost(target)
    f.values.set('_growing_uid_', 123)
    vi.stubGlobal('uni', f.host)
    const { default: gdp } = await import('../../index.js')
    let tracker!: TrackerRuntime
    const app = { mixin: vi.fn() }, other = { mixin: vi.fn() }
    gdp('registerPlugins', [{ name: 'review', install: value => { tracker = value } }])
    gdp('init', 'account', 'source', { uniVue: app, appId: f.appId })
    await tracker.whenReady()
    f.values.set('_growing_uid_', 'repaired-device')
    expect(gdp('init', 'account', 'source', { uniVue: other, appId: f.appId })).toBe(false)
    const system = f.host.getSystemInfoSync()
    const anotherTarget = target === 'mp-weixin' ? 'mp-alipay' : 'mp-weixin'
    vi.spyOn(f.host, 'getSystemInfoSync').mockReturnValue({ ...system, uniPlatform: anotherTarget })
    expect(gdp('init', 'account', 'source', { uniVue: app, appId: miniCases[anotherTarget].appId })).toBe(false)
    expect(other.mixin).not.toHaveBeenCalled()
    expect(tracker.canRetryInit()).toBe(true)
  })

  it('recovers an offline foreground queue without a network notification', async () => {
    const f = miniHost(target)
    let online = false
    const readNetwork = vi.spyOn(f.host, 'getNetworkType').mockImplementation(options => options.success({ networkType: online ? 'wifi' : 'none' }))
    f.init({ uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.tracker.track('before_reconnect')).toBe(true)
    expect(f.sent).toEqual([])
    online = true
    expect(f.tracker.track('after_reconnect')).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.sent.map(event => event.eventType)).toEqual(['VISIT', 'PAGE', 'CUSTOM', 'CUSTOM'])
    expect(f.tracker.queuedEvents()).toEqual([])
    const reads = readNetwork.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readNetwork).toHaveBeenCalledTimes(reads)
  })

  it('does not poll a hidden offline app and resumes its queue on the next foreground', async () => {
    const f = miniHost(target)
    let online = false
    const readNetwork = vi.spyOn(f.host, 'getNetworkType').mockImplementation(options => options.success({ networkType: online ? 'wifi' : 'none' }))
    f.init({ uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    await vi.advanceTimersByTimeAsync(0)
    f.tracker.onPageHide('home-1')
    f.tracker.onAppHide()
    const reads = readNetwork.mock.calls.length
    online = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readNetwork).toHaveBeenCalledTimes(reads)
    expect(f.sent).toEqual([])
    f.tracker.onAppShow({ path: 'pages/home', query: '', scene: '1001' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sent.map(event => event.eventType)).toEqual(['VISIT', 'PAGE', 'APP_CLOSED'])
    expect(f.tracker.queuedEvents()).toEqual([])
  })

  it.each(['page-first', 'app-first'] as const)('closes on the last visible detail page with %s hide ordering', async order => {
    const f = miniHost(target)
    f.init({ uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    f.tracker.onPageHide('home-1')
    f.tracker.onPageLoad({ instanceId: 'detail', route: 'pages/detail', query: 'sku=42', referralPage: null })
    f.tracker.onPageShow('detail', '详情')
    if (order === 'page-first') f.tracker.onPageHide('detail')
    f.tracker.onAppHide()
    if (order === 'app-first') f.tracker.onPageHide('detail')
    expect(f.sent.at(-1)).toMatchObject({ eventType: 'APP_CLOSED', path: 'pages/detail', query: 'sku=42', title: '详情' })
    expect(f.sent.filter(event => event.eventType === 'PAGE')).toHaveLength(2)
  })

  it('preserves the last visible snapshot when that page unloads before app hide', async () => {
    const f = miniHost(target)
    f.init({ uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    f.tracker.onPageHide('home-1')
    f.tracker.onPageLoad({ instanceId: 'detail', route: 'pages/detail', query: 'sku=42', referralPage: null })
    f.tracker.onPageShow('detail', '详情')
    f.tracker.onPageUnload('detail')
    f.tracker.onAppHide()
    expect(f.sent.at(-1)).toMatchObject({ eventType: 'APP_CLOSED', path: 'pages/detail', query: 'sku=42', title: '详情' })
  })
})
