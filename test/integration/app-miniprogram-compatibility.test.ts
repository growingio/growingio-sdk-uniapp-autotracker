import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackerRuntime } from '../../src/core/growingIO.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'
import type { AppRuntimeHost } from '../../src/platform/index.js'

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.resetModules()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe.each([['android', 'Android'], ['ios', 'iOS'], ['harmonyos', 'HarmonyOS']])('%s compatibility with mini support installed', (platform, wirePlatform) => {
  it.each([false, true])('preserves App wire fields, storage and immediate upload with an explicit target: %s', async explicit => {
    const stored = new Map<string, string>(), received: ProtocolEvent[] = []
    const host: AppRuntimeHost = {
      getStorageSync: key => stored.get(key), setStorageSync: (key, value) => { stored.set(key, value) }, removeStorageSync: key => { stored.delete(key) },
      getDeviceInfo: () => ({ platform: ` ${platform} `, screenWidth: 390, screenHeight: 844, devicePixelRatio: 3 }),
      getSystemInfoSync: () => ({ deviceOrientation: 'portrait' }),
      getAppBaseInfo: () => ({ appVersion: '1.0', appName: 'App', packageName: 'com.fixture', bundleId: 'com.fixture', bundleName: 'com.fixture', ...(explicit ? { uniPlatform: platform === 'harmonyos' ? 'app-harmony' : 'app-plus' } : {}) }),
      getNetworkType: options => options.success({ networkType: 'wifi' }),
      request: options => { received.push(...JSON.parse(options.data)); options.success({ statusCode: 204 }) },
    }
    vi.stubGlobal('uni', host)
    const { gdp } = await import('../../index.js')
    const call = gdp as (command: unknown, ...args: unknown[]) => boolean
    let tracker!: TrackerRuntime
    const mixin = vi.fn()
    expect(gdp('registerPlugins', [{ name: 'capture', install: value => { tracker = value } }])).toBe(true)
    // These mini-only inputs were ignored by App before this adaptation.
    expect(call('init', 'account', 'source', { uniVue: { mixin }, appId: '__UNI__IGNORED', keepAlive: null, uploadInterval: NaN, appChannel: 'app-store' })).toBe(true)
    expect(await tracker.whenReady()).toBe(true)
    const hooks = mixin.mock.calls[0]![0] as Record<string, (this: unknown, value?: unknown) => void>
    const app = {}, page = { $mpType: 'page', $page: { route: '/pages/home' }, gioPageTitle: '首页' }
    hooks.onLaunch!.call(app, { path: '/entry', query: { a: 1 } }); hooks.onShow!.call(app, { path: '/entry', query: { a: 1 } })
    hooks.onLoad!.call(page, { wxShoppingListScene: 1001, zero: 0 }); hooks.onShow!.call(page)
    expect(received.map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
    expect(received[0]).toMatchObject({ platform: wirePlatform, appName: 'App', appState: 'FOREGROUND', domain: 'com.fixture', path: '/entry', query: 'a=1', appChannel: 'app-store' })
    expect(received[1]).toMatchObject({ orientation: 'PORTRAIT', query: 'wxShoppingListScene=1001&zero=0' })
    const session = received[0]!.sessionId
    expect(gdp('setUserId', 'a')).toBe(true); expect(gdp('setUserId', 'b')).toBe(true)
    expect(received.slice(2).map(event => event.eventType)).toEqual(['VISIT'])
    hooks.onHide!.call(page); hooks.onHide!.call(app)
    expect(received.at(-1)).toMatchObject({ eventType: 'APP_CLOSED', appState: 'BACKGROUND' })
    const changedUserSession = received.at(-1)!.sessionId
    expect(changedUserSession).not.toBe(session)
    vi.setSystemTime(Date.now() + 30000)
    hooks.onShow!.call(app, { path: '/hot' }); hooks.onShow!.call(page)
    expect(received.at(-1)).toMatchObject({ eventType: 'PAGE', sessionId: changedUserSession })
    hooks.onHide!.call(page); hooks.onHide!.call(app)
    vi.setSystemTime(Date.now() + 30001)
    const beforeShow = received.length
    hooks.onShow!.call(app, { path: '/new' }); hooks.onShow!.call(page)
    expect(received.slice(beforeShow).map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
    expect(received.at(-1)!.sessionId).not.toBe(changedUserSession)
    expect(gdp('setOptions', { dataCollect: false })).toBe(true)
    const read = vi.fn()
    expect(gdp('track', 'denied', { get secret() { return read() } })).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(gdp('setOptions', { dataCollect: true })).toBe(true)
    expect(received.slice(-2).map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
    expect(tracker.queuedEvents()).toEqual([])
    for (let index = 0; index < 6; index++) await Promise.resolve()
    expect([...stored.keys()].sort()).toEqual(['gio:v1:source:identity', 'gio:v1:source:meta', 'gio:v1:source:queue:v1', 'gio:v1:source:session'])
    expect(received.every(event => !('operatingSystem' in event))).toBe(true)
  })
})
