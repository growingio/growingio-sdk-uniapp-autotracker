import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppTracker, type AppRuntimeHost } from '../../src/platform/index.js'
import { APP_QUEUE_PERSIST_DELAY_MS } from '../../src/core/storage/index.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'

type NetworkNotification = Readonly<{ networkType?: unknown; isConnected?: unknown }>
type NotificationMode = 'normal' | 'missing' | 'throws' | 'silent'

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

/** 通过真实 App 网络、存储、请求适配器装配 SDK，仅替换宿主能力。 */
function app(platform: string, mode: NotificationMode, initialNetwork = 'none', storage = new Map<string, string>()) {
  let networkType = initialNetwork
  let statusCode = 204
  let listener: ((value: NetworkNotification) => void) | undefined
  const received: ProtocolEvent[] = []
  const host: AppRuntimeHost = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, value) },
    removeStorageSync: key => { storage.delete(key) },
    getDeviceInfo: () => ({ platform }),
    getSystemInfoSync: () => ({ deviceOrientation: 'portrait' }),
    getAppBaseInfo: () => ({ appVersion: '1.0.0', packageName: 'app.recovery', bundleName: 'app.recovery', bundleId: 'app.recovery' }),
    getNetworkType: vi.fn<AppRuntimeHost['getNetworkType']>(options => { options.success({ networkType }) }),
    ...(mode === 'missing' ? {} : { onNetworkStatusChange: (next: (value: NetworkNotification) => void) => {
      if (mode === 'throws') throw new Error('subscription_unavailable')
      listener = next
    } }),
    request: vi.fn<AppRuntimeHost['request']>(options => {
      if (networkType === 'none') { options.fail({ errMsg: 'request:fail offline' }); return }
      if (statusCode < 300) received.push(...JSON.parse(options.data) as ProtocolEvent[])
      options.success({ statusCode })
    }),
  }
  let session = 0
  const tracker = createAppTracker(host, { sdkVersion: '0.1.0', deviceIdFactory: () => 'recovery-device', sessionIdFactory: () => `session-${++session}` })
  return {
    tracker, host, storage, received,
    setStatus: (value: number) => { statusCode = value },
    reconnect: () => {
      networkType = 'wifi'
      if (mode === 'normal') listener?.({ networkType, isConnected: true })
    },
    disconnect: () => {
      networkType = 'none'
      if (mode === 'normal') listener?.({ networkType, isConnected: false })
    },
  }
}

describe.each(['android', 'ios', 'harmonyos'])('%s App 自动补发', platform => {
  it('宿主容量不足时保留内存和已落盘事件，存储恢复后可保存完整积压', async () => {
    const f = app(platform, 'normal')
    let quotaReached = true
    const write = f.host.setStorageSync
    f.host.setStorageSync = (key, value) => {
      if (quotaReached && key.endsWith(':queue:v1') && Buffer.byteLength(value) > 2 * 1024 * 1024) {
        throw new Error('storage quota full')
      }
      write(key, value)
    }
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    const saved = f.tracker.queuedEvents()
    const attributes = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_${index}`, '中😀'.repeat(500)]))
    for (let index = 0; index < 20; index++) expect(f.tracker.track('offline_event', { ...attributes, index })).toBe(true)
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    expect(f.tracker.queuedEvents()).toHaveLength(21)
    const persisted = f.storage.get('gio:v1:source:queue:v1')!
    const persistedEvents = JSON.parse(persisted).entries.map((entry: { event: ProtocolEvent }) => entry.event)
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(persistedEvents.length).toBeLessThan(21)
    expect(persistedEvents.slice(0, saved.length)).toEqual(saved)
    quotaReached = false
    expect(f.tracker.track('storage_recovered')).toBe(true)
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    expect(JSON.parse(f.storage.get('gio:v1:source:queue:v1')!).entries.map((entry: { event: ProtocolEvent }) => entry.event))
      .toEqual(f.tracker.queuedEvents())
    expect(f.received).toEqual([])
  })

  it.each(['count', 'bytes'] as const)('超过原 %s 总量限制后继续落盘，冷启动后按批次完整补发', async limit => {
    const f = app(platform, 'normal')
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    const attributes = limit === 'bytes'
      ? Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_${index}`, '中😀'.repeat(500)]))
      : {}
    const count = limit === 'count' ? 260 : 20
    for (let index = 0; index < count; index++) {
      expect(f.tracker.track('offline_event', { ...attributes, index })).toBe(true)
    }
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    const cached = f.tracker.queuedEvents()
    expect(cached).toHaveLength(count + 1)
    const persisted = f.storage.get('gio:v1:source:queue:v1')!
    expect(JSON.parse(persisted).entries.map((entry: { event: ProtocolEvent }) => entry.event)).toEqual(cached)
    if (limit === 'bytes') expect(Buffer.byteLength(persisted)).toBeGreaterThan(2 * 1024 * 1024)
    expect(f.received).toEqual([])

    const restarted = app(platform, 'normal', 'none', f.storage)
    restarted.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    expect(await restarted.tracker.whenReady()).toBe(true)
    expect(restarted.tracker.queuedEvents()).toEqual(cached)
    restarted.reconnect()
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    expect(restarted.received).toEqual(cached)
    expect(restarted.tracker.queuedEvents()).toEqual([])
    const requests = vi.mocked(restarted.host.request).mock.calls
    expect(requests.length).toBeGreaterThan(1)
    for (const [request] of requests) {
      expect(JSON.parse(request.data).length).toBeLessThanOrEqual(50)
      expect(Buffer.byteLength(request.data)).toBeLessThanOrEqual(512 * 1024)
    }
    expect(JSON.parse(f.storage.get('gio:v1:source:queue:v1')!).entries).toEqual([])
  })

  it.each<NotificationMode>(['normal', 'missing', 'throws', 'silent'])('网络通知 %s 时，不操作页面也能在联网后补发缓存', async mode => {
    const f = app(platform, mode)
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppLaunch({ path: 'pages/home', query: '' })
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    expect(f.tracker.track('offline_event')).toBe(true)
    const cached = f.tracker.queuedEvents()
    expect(cached.filter(event => event.eventType === 'CUSTOM').map(event => event.eventName)).toEqual(['offline_event'])
    expect(f.received).toEqual([])

    f.reconnect()
    // 恢复后只推进 SDK 定时器，不制造新事件，也不调用 App.onShow。
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.received.filter(event => event.eventType === 'CUSTOM').map(event => event.eventName)).toEqual(['offline_event'])
    expect(f.received).toEqual(cached)
    expect(f.tracker.queuedEvents()).toEqual([])
    const reads = vi.mocked(f.host.getNetworkType).mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(f.host.getNetworkType).toHaveBeenCalledTimes(reads)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('断网通知也缺失时，请求失败会重新检查网络并保留事件直到联网', async () => {
    const f = app(platform, 'silent', 'wifi')
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    await vi.advanceTimersByTimeAsync(0)
    f.disconnect()
    f.tracker.track('offline_event')
    const cached = f.tracker.queuedEvents()
    expect(cached).toHaveLength(1)
    const requests = vi.mocked(f.host.request).mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.host.request).toHaveBeenCalledTimes(requests)
    expect(f.tracker.queuedEvents()).toEqual(cached)
    const persisted = JSON.parse(f.storage.get('gio:v1:source:queue:v1')!)
    expect(persisted.entries[0].retryCount).toBe(0)
    f.reconnect()
    await vi.advanceTimersByTimeAsync(2_000 + APP_QUEUE_PERSIST_DELAY_MS)
    expect(f.received.filter(event => event.eventType === 'CUSTOM')).toEqual(cached)
    expect(f.tracker.queuedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['首次前台前', '首次前台后'])('关闭采集冷启动，%s同意后才补发落盘队列', async (phase) => {
    const f = app(platform, 'normal')
    const config = { accountId: 'account', dataSourceId: 'source' }
    const entry = { path: 'pages/home', query: '' }
    expect(f.tracker.init(config)).toBe(true)
    expect(await f.tracker.whenReady()).toBe(true)
    f.tracker.onAppShow(entry)
    expect(f.tracker.track('cached_event')).toBe(true)
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    const cached = f.tracker.queuedEvents()
    expect(cached.map(event => event.eventName ?? event.eventType)).toEqual(['VISIT', 'cached_event'])

    const restarted = app(platform, 'normal', 'wifi', f.storage)
    expect(restarted.tracker.init({ ...config, dataCollect: false })).toBe(true)
    expect(await restarted.tracker.whenReady()).toBe(true)
    if (phase === '首次前台后') restarted.tracker.onAppShow(entry)
    expect(restarted.received).toEqual([])
    expect(restarted.tracker.queuedEvents()).toEqual(cached)
    expect(restarted.tracker.setOptions({ dataCollect: true })).toBe(true)
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    expect(restarted.received.slice(0, cached.length)).toEqual(cached)
    expect(restarted.tracker.queuedEvents()).toEqual([])
    expect(JSON.parse(restarted.storage.get('gio:v1:source:queue:v1')!).entries).toEqual([])
  })

  it.each([503, 429, 408, 401, 403, 404])('服务端持续返回 %s 时不丢弃事件，重启后服务恢复仍能补发', async (status) => {
    const f = app(platform, 'normal', 'wifi')
    f.setStatus(status)
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    f.tracker.track('server_down_event')
    await vi.advanceTimersByTimeAsync(0)
    const cached = f.tracker.queuedEvents()
    // 800ms 起指数退避，30 秒内已远超旧策略的 1 次发送加 2 次重试。
    await vi.advanceTimersByTimeAsync(30_000)
    expect(vi.mocked(f.host.request).mock.calls.length).toBeGreaterThan(3)
    expect(f.tracker.queuedEvents()).toEqual(cached)
    expect(JSON.parse(f.storage.get('gio:v1:source:queue:v1')!).entries.map((entry: { event: ProtocolEvent }) => entry.event)).toEqual(cached)
    expect(f.received).toEqual([])

    const restarted = app(platform, 'normal', 'wifi', f.storage)
    restarted.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    expect(await restarted.tracker.whenReady()).toBe(true)
    // 恢复的持久队列在就绪后立即补发，不需要等待页面或新事件。
    await vi.advanceTimersByTimeAsync(0)
    expect(restarted.received).toEqual(cached)
    expect(restarted.tracker.queuedEvents()).toEqual([])
  })

  it.each([400, 422])('批次被 %s 拒绝时拆批定位坏事件，单条累计被拒 3 次后丢弃，同批正常事件照常送达', async (statusCode) => {
    const f = app(platform, 'normal')
    const poisonRequests = vi.fn()
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    for (const name of ['before', 'poison', 'after']) f.tracker.track(name)
    f.host.request = vi.fn<AppRuntimeHost['request']>(options => {
      const events = JSON.parse(options.data) as ProtocolEvent[]
      if (events.some(event => event.eventName === 'poison')) { poisonRequests(); options.success({ statusCode }); return }
      f.received.push(...events)
      options.success({ statusCode: 204 })
    })
    f.reconnect()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.received.map(event => event.eventName ?? event.eventType)).toEqual(expect.arrayContaining(['VISIT', 'before', 'after']))
    expect(f.received.some(event => event.eventName === 'poison')).toBe(false)
    expect(f.tracker.queuedEvents()).toEqual([])
    // 整批 1 次 + 拆分后含坏事件的半批 1 次 + 单条 3 次。
    expect(poisonRequests).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    expect(JSON.parse(f.storage.get('gio:v1:source:queue:v1')!).entries).toEqual([])
  })

  it('413 与原生 Android 一致删除对应批次，后续事件照常发送', async () => {
    const f = app(platform, 'normal', 'wifi')
    f.setStatus(413)
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    f.tracker.track('oversized_batch')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.tracker.queuedEvents()).toEqual([])
    f.setStatus(204)
    f.tracker.track('after_413')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.received.map(event => event.eventName)).toEqual(['after_413'])
  })

  it('前台只保留一个恢复检查，切后台停止检查，回前台自动补发', async () => {
    const f = app(platform, 'silent')
    const query = vi.mocked(f.host.getNetworkType)
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    for (let index = 0; index < 20; index++) f.tracker.track('offline_event', { index })
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    expect(vi.getTimerCount()).toBe(1)
    const reads = query.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(query).toHaveBeenCalledTimes(reads + 1)
    expect(vi.getTimerCount()).toBe(1)
    f.tracker.onAppHide()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(query).toHaveBeenCalledTimes(reads + 1)
    f.reconnect()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    await vi.advanceTimersByTimeAsync(APP_QUEUE_PERSIST_DELAY_MS)
    expect(f.received.filter(event => event.eventType === 'CUSTOM')).toHaveLength(20)
    expect(f.tracker.queuedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
