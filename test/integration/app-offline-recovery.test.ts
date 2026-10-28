import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppTracker, type AppRuntimeHost } from '../../src/platform/index.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'

type NetworkNotification = Readonly<{ networkType?: unknown; isConnected?: unknown }>
type NotificationMode = 'normal' | 'missing' | 'throws' | 'silent'

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

/** 通过真实 App 网络、存储、请求适配器装配 SDK，仅替换宿主能力。 */
function app(platform: string, mode: NotificationMode, initialNetwork = 'none') {
  let networkType = initialNetwork
  let listener: ((value: NetworkNotification) => void) | undefined
  const storage = new Map<string, string>()
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
      received.push(...JSON.parse(options.data) as ProtocolEvent[])
      options.success({ statusCode: 204 })
    }),
  }
  let session = 0
  const tracker = createAppTracker(host, { sdkVersion: '0.1.0', deviceIdFactory: () => 'recovery-device', sessionIdFactory: () => `session-${++session}` })
  return {
    tracker, host, storage, received,
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
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.received.filter(event => event.eventType === 'CUSTOM')).toEqual(cached)
    expect(f.tracker.queuedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('前台只保留一个恢复检查，切后台停止检查，回前台自动补发', async () => {
    const f = app(platform, 'silent')
    const query = vi.mocked(f.host.getNetworkType)
    f.tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '' })
    for (let index = 0; index < 20; index++) f.tracker.track('offline_event', { index })
    await vi.advanceTimersByTimeAsync(0)
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
    await vi.advanceTimersByTimeAsync(0)
    expect(f.received.filter(event => event.eventType === 'CUSTOM')).toHaveLength(20)
    expect(f.tracker.queuedEvents()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
