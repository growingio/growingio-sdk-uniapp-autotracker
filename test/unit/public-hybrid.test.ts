import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeExecutor, hybridFlush } from '../support/unimp-host.js'
import type { GioPluginRuntime } from '../../index.js'

beforeEach(() => { vi.useFakeTimers(); vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('public advanced and uniMP entry', () => {
  it('initializes Native mode without probing App storage, requests or system APIs and ignores component lifecycle', async () => {
    const native = new NativeExecutor()
    const host: Record<string, unknown> = { requireNativePlugin: vi.fn(() => ({ invoke: native.request.bind(native) })) }
    for (const name of ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'request', 'getDeviceInfo', 'getSystemInfoSync', 'getAppBaseInfo', 'getNetworkType']) {
      Object.defineProperty(host, name, { get: () => { throw Error(`Native must not read ${name}`) } })
    }
    vi.stubGlobal('uni', host)
    const { gdp } = await import('../../index.js')
    const hooks: Record<string, Function>[] = []
    const ready = vi.fn(); const error = vi.fn()
    const hybridOptions = { transport: 'native-module' as const, penetrateHybrid: true, onReady: ready, onError: error }
    let tracker!: GioPluginRuntime
    expect(gdp('getGioInfo')).toBeNull()
    expect(gdp('registerPlugins', [{ name: 'gioHybridAdapter', options: hybridOptions }, { name: 'custom', install: value => { tracker = value } }])).toBe(true)
    hybridOptions.penetrateHybrid = false
    expect(gdp('init', 'account', 'source', { runtime: 'unimp', appId: '__UNI__test', idMapping: true, uniVue: { mixin: value => hooks.push(value as Record<string, Function>) } })).toBe(true)
    expect(native.calls).toHaveLength(0)
    const hook = hooks[0]!
    hook.onShow!.call({ $mpType: 'component' }, {})
    expect(native.calls).toHaveLength(0)
    const app = { $mpType: 'app' }
    hook.onLaunch!.call(app, { path: 'pages/home' }); hook.onShow!.call(app, {})
    const page = { $mpType: 'page', $page: { route: 'pages/home' } }
    hook.onLoad!.call(page, { q: '中文' }); hook.onShow!.call(page, {})
    native.reply(); await hybridFlush()
    expect(tracker.ready()).toBe(true); expect(ready).toHaveBeenCalledOnce()
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ canWriteIdentity: true }))
    expect(gdp('getGioInfo')).toBeNull(); expect(gdp('identify', 'not-local')).toBe(false)
    expect(gdp('setLocation', 1, 2)).toBe(false); await hybridFlush()
    expect(error).toHaveBeenCalledWith({ code: 'location_owned_by_host', phase: 'queue', outcome: 'not_sent' })
    native.reply(); await hybridFlush()
    expect(gdp('track', 'custom')).toBe(true); await hybridFlush(); native.reply(); await hybridFlush()
    expect(native.events.map(event => event.eventType)).toEqual(['PAGE', 'CUSTOM'])
    const longRoute = `pages/${'nested/'.repeat(100)}detail`
    const nestedPage = { $mpType: 'page', $page: { route: longRoute } }
    hook.onLoad!.call(nestedPage, {}); hook.onShow!.call(nestedPage, {}); await hybridFlush(); native.reply(); await hybridFlush()
    expect(native.events.at(-1)).toMatchObject({ eventType: 'PAGE', path: longRoute })
    expect(gdp('init', 'account', 'source', { runtime: 'unimp', appId: '__UNI__test', uniVue: { mixin: () => undefined } })).toBe(false)
    hook.onHide!.call(app)
  })

  it('retains registration after synchronous errors and rejects conflicts before creating any tracker', async () => {
    const host = { requireNativePlugin: vi.fn() }; vi.stubGlobal('uni', host)
    const { gdp } = await import('../../index.js')
    const raw = gdp as (command: unknown, ...args: unknown[]) => unknown
    const uniVue = { mixin: vi.fn() }
    expect(raw('init', 'a', 's', { runtime: 'other', uniVue })).toBe(false)
    expect(gdp('init', 'a', 's', { runtime: 'unimp', appId: 'a', uniVue })).toBe(false)
    expect(gdp('registerPlugins', [{ name: 'gioHybridAdapter', options: { onReady: () => { throw Error('private') } } }])).toBe(true)
    for (const conflict of [{ appId: '' }, { serverUrl: null }, { sessionExpires: 1 }, { appChannel: 'x' }, { appVersion: null }, { forceLogin: false }, { keepAlive: 5 }, { uploadInterval: 1000 }]) {
      expect(raw('init', 'a', 's', { runtime: 'unimp', appId: 'a', uniVue, ...conflict })).toBe(false)
    }
    expect(raw('init', 'a', 's', { runtime: 'app', uniVue })).toBe(false)
    expect(host.requireNativePlugin).not.toHaveBeenCalled(); expect(uniVue.mixin).not.toHaveBeenCalled()
    expect(gdp('init', 'a', 's', { runtime: 'unimp', appId: 'a', uniVue })).toBe(true)
    expect(gdp('registerPlugins', [{ name: 'later', install: () => undefined }])).toBe(false)
  })

  it('accepts JS configuration when the host module is missing and reports the later handshake failure', async () => {
    vi.stubGlobal('uni', undefined)
    const { gdp } = await import('../../index.js')
    const hooks: Record<string, Function>[] = []; const error = vi.fn()
    gdp('registerPlugins', [{ name: 'gioHybridAdapter', options: { onError: error } }])
    expect(gdp('init', 'a', 's', { runtime: 'unimp', appId: 'guest', uniVue: { mixin: value => hooks.push(value as Record<string, Function>) } })).toBe(true)
    hooks[0]!.onShow!.call({ $mpType: 'app' }, {})
    expect(error).not.toHaveBeenCalled(); await hybridFlush()
    expect(error).toHaveBeenCalledExactlyOnceWith({ code: 'module_missing', phase: 'handshake', method: 'hello', outcome: 'not_sent' })
    hooks[0]!.onHide!.call({ $mpType: 'app' })
  })

  it('propagates safe callback diagnostics through the actual platform factory', async () => {
    const native = new NativeExecutor(); const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('uni', { requireNativePlugin: () => ({ invoke: native.request.bind(native) }) })
    const { gdp } = await import('../../index.js'); const hooks: Record<string, Function>[] = []
    gdp('registerPlugins', [{ name: 'gioHybridAdapter', options: { onReady: () => { throw Error('private') } } }])
    gdp('init', 'account', 'source', { runtime: 'unimp', appId: '__UNI__test', uniVue: { mixin: value => hooks.push(value as Record<string, Function>) } })
    hooks[0]!.onShow!.call({ $mpType: 'app' }, {}); native.reply(); await hybridFlush()
    expect(warning).toHaveBeenCalledWith('[GrowingIO]: callback_error')
    hooks[0]!.onHide!.call({ $mpType: 'app' })
  })

  it('routes identify and embedded H5 snapshots through the unchanged App facade', async () => {
    const requests: unknown[] = []; const storage = new Map<string, unknown>(); const hooks: Record<string, Function>[] = []
    vi.stubGlobal('uni', {
      getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: unknown) => storage.set(key, value), removeStorageSync: (key: string) => storage.delete(key),
      getDeviceInfo: () => ({ platform: 'android', osVersion: '14' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}),
      getNetworkType: (options: { success: (value: unknown) => void }) => options.success({ networkType: 'wifi' }),
      request: (options: { data: string; success: (value: unknown) => void }) => { requests.push(JSON.parse(options.data)); options.success({ statusCode: 204 }) },
    })
    const { gdp } = await import('../../index.js'); let tracker!: GioPluginRuntime
    gdp('registerPlugins', [{ name: 'capture', install: value => { tracker = value } }])
    gdp('init', 'a', 's', { uniVue: { mixin: value => hooks.push(value as Record<string, Function>) }, forceLogin: true })
    hooks[0]!.onShow!.call({}, { path: 'home' }); await tracker.whenReady()
    expect(gdp('track', 'waiting')).toBe(true); expect(requests).toEqual([]); expect(gdp('getGioInfo')).toBeNull()
    expect(gdp('identify', 'app-assigned')).toBe(true)
    expect(new URLSearchParams(gdp('getGioInfo')!).get('giou')).toBe('app-assigned')
    expect(requests).toHaveLength(1)
  })
})
