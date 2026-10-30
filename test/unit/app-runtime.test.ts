import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppTracker } from '../../src/platform/index.js'
import { dispatchAutoTrack } from '../../src/plugins/gioEventAutoTracking/index.js'

describe('createAppTracker', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('网络类型慢回调不阻塞首个 VISIT，回调完成后更新后续事件', async () => {
    vi.useFakeTimers()
    const payloads: string[] = []
    const readNetwork = vi.fn((options: { success: (result: { networkType: string }) => void }) => {
      setTimeout(() => options.success({ networkType: 'wifi' }), 800)
    })
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}),
      getNetworkType: readNetwork,
      request: options => { payloads.push(options.data); options.success({ statusCode: 204 }) },
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(tracker.ready()).toBe(true)
    expect(payloads.flatMap(payload => JSON.parse(payload))).toMatchObject([{ eventType: 'VISIT', networkState: 'UNKNOWN' }])
    expect(readNetwork).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(800)
    expect(readNetwork).toHaveBeenCalledOnce()
    tracker.track('after_network_reply')
    expect(payloads.flatMap(payload => JSON.parse(payload)).at(-1)).toMatchObject({ eventType: 'CUSTOM', networkState: 'WIFI' })
  })

  it('网络查询不回调时也立即就绪，Native 明确断网仍保留事件', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('plus', { networkinfo: { CONNECTION_NONE: 1, getCurrentType: () => 1 } })
    const request = vi.fn((options: { success: (result: { statusCode: number }) => void }) => options.success({ statusCode: 204 }))
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}),
      getNetworkType: () => undefined, request,
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(tracker.ready()).toBe(true)
    expect(tracker.queuedEvents()).toMatchObject([{ eventType: 'VISIT', networkState: 'UNKNOWN' }])
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(request).not.toHaveBeenCalled()
    expect(tracker.queuedEvents()).toHaveLength(1)
  })

  it.each(['missing', 'throws'] as const)('首读未完成时回前台不会丢失网络重查，订阅 %s', async (subscription) => {
    vi.useFakeTimers()
    vi.stubGlobal('plus', { networkinfo: { CONNECTION_NONE: 1, getCurrentType: () => 1 } })
    let networkType = 'none'
    const payloads: string[] = []
    const readNetwork = vi.fn((options: { success: (result: { networkType: string }) => void }) => {
      const observedType = networkType
      setTimeout(() => options.success({ networkType: observedType }), 800)
    })
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}),
      getNetworkType: readNetwork,
      ...(subscription === 'throws' ? { onNetworkStatusChange: () => { throw new Error('subscription failed') } } : {}),
      request: options => { payloads.push(options.data); options.success({ statusCode: 204 }) },
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(tracker.ready()).toBe(true)
    expect(readNetwork).toHaveBeenCalledOnce()
    tracker.track('offline_event')
    tracker.onAppHide()
    networkType = 'wifi'
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onAppHide()
    tracker.onAppShow({ path: '/home', query: '' })
    expect(payloads).toEqual([])
    await vi.advanceTimersByTimeAsync(1_600)
    expect(readNetwork).toHaveBeenCalledTimes(2)
    expect(payloads.flatMap(payload => JSON.parse(payload))).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: 'offline_event', networkState: 'UNKNOWN' }),
    ]))
    expect(tracker.queuedEvents()).toEqual([])
    tracker.track('after_recovery')
    expect(JSON.parse(payloads.at(-1)!)).toMatchObject([{ eventName: 'after_recovery', networkState: 'WIFI' }])
  })

  it.each(['missing', 'throws'] as const)('网络订阅 %s 时，离线启动后返回前台主动重查并补发', async (subscription) => {
    vi.useFakeTimers()
    let networkType = 'none'
    let reads = 0
    const payloads: string[] = []
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}),
      getNetworkType: options => { reads++; options.success({ networkType }) },
      ...(subscription === 'throws' ? { onNetworkStatusChange: () => { throw new Error('subscription failed') } } : {}),
      request: options => { payloads.push(options.data); options.success({ statusCode: 204 }) },
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    tracker.track('offline_event')
    expect(payloads).toEqual([])
    const previousReads = reads
    tracker.onAppHide()
    networkType = 'wifi'
    tracker.onAppShow({ path: '/home', query: '' })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBeGreaterThan(previousReads)
    expect(payloads.flatMap(payload => JSON.parse(payload))).toEqual(expect.arrayContaining([expect.objectContaining({ eventName: 'offline_event' })]))
    expect(tracker.queuedEvents()).toEqual([])
  })

  it('同步查询完成到 Promise 回调之间的新断网通知不会被旧读数覆盖', async () => {
    vi.useFakeTimers()
    let listener!: (result: { networkType: string; isConnected: boolean }) => void
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}),
      getNetworkType: options => options.success({ networkType: 'wifi' }), onNetworkStatusChange: next => { listener = next },
      request: options => { options.success({ statusCode: 204 }) },
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    await vi.advanceTimersByTimeAsync(0)
    tracker.onAppHide()
    tracker.onAppShow({ path: '/home', query: '' })
    listener({ networkType: 'none', isConnected: false })
    await vi.advanceTimersByTimeAsync(0)
    tracker.track('offline_after_query')
    expect(tracker.queuedEvents().find(event => event.eventName === 'offline_after_query')).toMatchObject({ networkState: 'UNKNOWN' })
  })

  it('断网冷启动先持久化，恢复为未知网络类型但明确联网时补发', async () => {
    const values = new Map<string, string>()
    let listener!: (result: { networkType: string; isConnected: boolean }) => void
    const request = vi.fn((options: { data: string; success: (value: { statusCode: number }) => void }) => options.success({ statusCode: 204 }))
    const tracker = createAppTracker({
      getStorageSync: key => values.get(key), setStorageSync: (key, value) => { values.set(key, value) }, removeStorageSync: key => { values.delete(key) },
      getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}),
      getNetworkType: options => options.success({ networkType: 'none' }), onNetworkStatusChange: next => { listener = next }, request,
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.track('offline_event')
    await tracker.whenReady()
    await vi.waitFor(() => expect([...values.values()].some(value => value.includes('offline_event'))).toBe(true))
    expect(request).not.toHaveBeenCalled()
    expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'CUSTOM'])
    listener({ networkType: 'unknown', isConnected: true })
    expect(request).toHaveBeenCalledOnce()
    expect(JSON.parse(request.mock.calls[0]![0].data).map((event: { networkState: string }) => event.networkState)).toEqual(['UNKNOWN', 'UNKNOWN'])
    expect(tracker.queuedEvents()).toEqual([])
  })

  it('initializes an explicit collector and sends events when App has no URL or Object.hasOwn', async () => {
    vi.useFakeTimers()
    const payloads: string[] = []
    const urls: string[] = []
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({ screenWidth: 390, screenHeight: 844, devicePixelRatio: 3 }), getAppBaseInfo: () => ({}),
      getNetworkType: (options) => { options.success({ networkType: 'wifi' }) },
      request: (options) => { urls.push(options.url); payloads.push(options.data); options.success({ statusCode: 204 }) },
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1' })
    const originalHasOwn = Object.hasOwn
    let ready = false
    let acceptedChange = false
    let changedOptions = false
    try {
      // 使用真实 App 装配链路，模拟没有 ES2022 Object.hasOwn 的宿主。
      Object.hasOwn = undefined as unknown as typeof Object.hasOwn
      vi.stubGlobal('URL', undefined)
      vi.stubGlobal('__GIO_AUTOTRACK_VERIFICATION__', true)
      tracker.registerPlugins({ name: 'gioEventAutoTracking' })
      expect(tracker.init({ accountId: 'account', dataSourceId: 'source', serverUrl: 'collector.example/' })).toBe(true)
      tracker.onAppShow({ path: '/home', query: '' })
      tracker.onPageLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
      tracker.onPageShow('home#1', null)
      ready = await tracker.whenReady()
      acceptedChange = dispatchAutoTrack({ schemaVersion: 2, source: 'template', kind: 'change', eventName: 'onSwitchChange', elementType: 'switch', trackValue: true }, {
        currentTarget: { id: 'subscription', dataset: {} }, detail: { value: false },
      })
      changedOptions = tracker.setOptions({ dataCollect: false })
    } finally {
      Object.hasOwn = originalHasOwn
      vi.unstubAllGlobals()
    }
    expect(ready).toBe(true)
    expect(tracker.failed()).toBe(false)
    expect(acceptedChange).toBe(true)
    expect(changedOptions).toBe(true)
    expect(urls).toEqual(Array(3).fill(expect.stringMatching(/^https:\/\/collector\.example\/v3\/projects\/account\/collect\?stm=\d+&compress=0$/)))
    expect(payloads.flatMap((payload) => JSON.parse(payload))).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'VISIT', screenWidth: 1170, screenHeight: 2532, deviceType: 'PHONE' }),
      expect.objectContaining({ eventType: 'PAGE' }),
      expect.objectContaining({ eventType: 'VIEW_CHANGE', xpath: 'subscription#onSwitchChange', textValue: 'false' }),
    ]))
  })

  it('assembles App ports and reads configured appVersion only after init config is available', async () => {
    vi.useFakeTimers()
    const requests: string[] = []
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android', platformVersion: '14', screenWidth: 1080, screenHeight: 1920, brand: 'Google', model: 'Pixel', deviceType: 'PHONE' }),
      getSystemInfoSync: () => ({ deviceOrientation: 'portrait', windowWidth: 390, windowHeight: 844 }),
      getAppBaseInfo: () => ({ packageName: 'com.example.app', appName: 'Example', version: '' }),
      getNetworkType: (options) => { options.success({ networkType: 'wifi' }) },
      request: (options) => { requests.push(options.url); options.success({ statusCode: 204 }) },
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1' })

    expect(tracker.init({ accountId: 'account', dataSourceId: 'source', appVersion: 'fallback' })).toBe(true)
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    expect(requests).toHaveLength(1)
    expect(tracker.queuedEvents()).toStrictEqual([])
    expect(dispatchAutoTrack({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'save' })).toBe(false)
  })

  it('uses synchronously available network metadata in the first VISIT', async () => {
    vi.useFakeTimers()
    const payloads: string[] = []
    const tracker = createAppTracker({
      getStorageSync: () => undefined, setStorageSync: () => undefined, removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'harmonyos', deviceBrand: 'huawei', deviceModel: 'BRA-AL00' }),
      getSystemInfoSync: () => ({ deviceOrientation: 'portrait', windowWidth: 390, windowHeight: 844 }),
      getAppBaseInfo: () => ({ bundleName: 'com.example.harmony' }),
      getNetworkType: (options) => { options.success({ networkType: 'wifi' }) },
      request: (options) => { payloads.push(options.data); options.success({ statusCode: 204 }) },
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1' })

    expect(tracker.init({ accountId: 'account', dataSourceId: 'source' })).toBe(true)
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    expect(JSON.parse(payloads[0] ?? '')[0]).toMatchObject({
      eventType: 'VISIT', networkState: 'WIFI', deviceBrand: 'huawei', deviceModel: 'BRA-AL00',
    })
  })
})
