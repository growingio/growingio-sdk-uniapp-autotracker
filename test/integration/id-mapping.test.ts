import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GioGdpInitOptions } from '../../index.js'
import type { TrackerRuntime } from '../../src/core/growingIO.js'
import type { AppRuntimeHost } from '../../src/platform/index.js'
import { miniCases, miniHost, miniTargets } from '../support/miniprogram-host.js'

const appTargets = ['android', 'ios', 'harmonyos'] as const
const targets = [...appTargets, ...miniTargets]

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('gdp', undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

/** 通过真实公开入口启动新运行期；宿主存储由调用方保留以模拟重启。 */
async function start(host: AppRuntimeHost | ReturnType<typeof miniHost>['host'], idMapping: boolean, appId?: string, autoTrack = false) {
  vi.resetModules()
  vi.stubGlobal('uni', host)
  const { gdp } = await import('../../index.js')
  let tracker!: TrackerRuntime
  expect(gdp('registerPlugins', [
    ...(autoTrack ? [{ name: 'gioEventAutoTracking' as const }] : []),
    { name: 'capture', install: value => { tracker = value } },
  ])).toBe(true)
  const options: GioGdpInitOptions = { uniVue: { mixin: vi.fn() }, idMapping, ...(appId ? { appId } : {}) }
  expect(gdp('init', 'account', 'source', options)).toBe(true)
  return { gdp, tracker, options }
}

/** 各平台保留独立存储与实际请求报文，允许在同一宿主上重启 SDK。 */
function environment(target: typeof targets[number]) {
  const miniTarget = miniTargets.find(value => value === target)
  if (miniTarget) {
    const mini = miniHost(miniTarget)
    return { host: mini.host, received: mini.sent, appId: miniCases[miniTarget].appId }
  }
  const values = new Map<string, string>()
  const received: Array<Readonly<Record<string, unknown>>> = []
  const host: AppRuntimeHost = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => { values.set(key, value) },
    removeStorageSync: key => { values.delete(key) },
    getDeviceInfo: () => ({ platform: target }),
    getSystemInfoSync: () => ({ deviceOrientation: 'portrait' }),
    getAppBaseInfo: () => ({ appVersion: '1.0.0' }),
    getNetworkType: options => options.success({ networkType: 'wifi' }),
    request: options => { received.push(...JSON.parse(options.data)); options.success({ statusCode: 204 }) },
  }
  return { host, received, appId: undefined }
}

describe.each(targets)('%s idMapping 公开命令到上传报文', target => {
  it('修改首次 init 配置并重启后，false → true → false 正确控制 userKey', async () => {
    const { host, received, appId } = environment(target)
    let deviceId: unknown

    for (const [index, idMapping] of [false, true, false].entries()) {
      const { gdp, tracker } = await start(host, idMapping, appId)
      // 首次初始化尚未完成时提交身份，覆盖异步恢复后的命令重放。
      expect(gdp('setUserId', 'mapping-user', 'email')).toBe(true)
      expect(await tracker.whenReady()).toBe(true)
      tracker.onAppShow({ path: 'pages/user/user', query: '' })
      tracker.onPageLoad({ instanceId: 'user', route: 'pages/user/user', query: '', referralPage: null })
      tracker.onPageShow('user', '用户身份')
      expect(gdp('track', 'mapping_before_update', { index })).toBe(true)
      expect(gdp('setUserId', 'mapping-user', 'phone')).toBe(true)
      expect(gdp('setUserAttributes', { mode: idMapping })).toBe(true)
      expect(gdp('track', 'mapping_after_update', { index })).toBe(true)
      tracker.onAppHide()

      const events = received.filter(event => event.eventName === 'mapping_before_update' || event.eventName === 'mapping_after_update' || event.eventType === 'LOGIN_USER_ATTRIBUTES').slice(-3)
      expect(events).toHaveLength(3)
      expect(events.map(event => event.userId)).toEqual(['mapping-user', 'mapping-user', 'mapping-user'])
      expect(events.map(event => event.userKey)).toEqual(idMapping ? ['email', 'phone', 'phone'] : [undefined, undefined, undefined])
      if (!idMapping) for (const event of events) expect(event).not.toHaveProperty('userKey')
      deviceId ??= events[0]!.deviceId
      expect(events.every(event => event.deviceId === deviceId)).toBe(true)
      expect(tracker.queuedEvents()).toEqual([])
      // 等待身份写入完成后再启动下一运行期。
      for (let pending = 0; pending < 20; pending++) await Promise.resolve()
      vi.clearAllTimers()
    }
  })

  it.each([
    ['init', false], ['init', true], ['setOptions', false], ['setOptions', true],
  ] as const)('%s 尝试切换初始值 %s 时拒绝修改，并保留原 userKey 策略', async (method, initial) => {
    const { host, received, appId } = environment(target)
    const { gdp, tracker, options } = await start(host, initial, appId)
    await tracker.whenReady()
    tracker.onAppShow({ path: 'pages/user/user', query: '' })
    const call = gdp as (command: unknown, ...args: unknown[]) => boolean
    expect(method === 'init'
      ? gdp('init', 'account', 'source', { ...options, idMapping: !initial })
      : call('setOptions', { idMapping: !initial })).toBe(false)
    if (method === 'setOptions') expect(call('setOptions', { dataCollect: false, idMapping: !initial })).toBe(false)
    expect(gdp('setUserId', 'mapping-user', 'email')).toBe(true)
    expect(gdp('track', 'after_rejected_switch')).toBe(true)
    tracker.onAppHide()
    const event = received.find(event => event.eventName === 'after_rejected_switch')!
    expect(event).toMatchObject({ userId: 'mapping-user' })
    expect(event.userKey).toBe(initial ? 'email' : undefined)
    if (!initial) expect(event).not.toHaveProperty('userKey')
  })
})
