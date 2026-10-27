import { vi } from 'vitest'
import type { MiniProgramTarget } from '../../src/types/index.js'
import type { MiniProgramHost } from '../../src/platform/miniprogram.js'
import { createMiniProgramTracker } from '../../src/platform/miniprogram.js'

export const miniTargets: readonly MiniProgramTarget[] = ['mp-weixin', 'mp-alipay']

export function miniHost(target: MiniProgramTarget) {
  const appId = target === 'mp-weixin' ? 'wx1234567890abcdef' : '2026102700000001'
  const values = new Map<string, unknown>()
  const sent: Array<Readonly<Record<string, unknown>>> = []
  const interceptors = new Map<string, Record<string, (options: unknown) => void>>()
  const host = {
    getSystemInfoSync: () => ({ uniPlatform: target, platform: 'android', version: '10.0', language: 'zh_CN', pixelRatio: 3, screenWidth: 390, screenHeight: 844, brand: 'fixture', model: 'phone' }),
    getAccountInfoSync: () => ({ miniProgram: { appId, version: '1.2.0' } }),
    getStorageSync: vi.fn((key: string) => values.get(key)),
    setStorageSync: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeStorageSync: vi.fn((key: string) => { values.delete(key) }),
    getNetworkType: (options: Parameters<MiniProgramHost['getNetworkType']>[0]) => options.success({ networkType: 'wifi' }),
    request: vi.fn<MiniProgramHost['request']>((options) => {
      sent.push(...JSON.parse(options.data))
      options.success({ statusCode: 204 }); options.complete()
      return { abort: vi.fn() }
    }),
    addInterceptor: (name: string, hooks: Record<string, (options: unknown) => void>) => { interceptors.set(name, hooks) },
  }
  let session = 0
  const create = () => createMiniProgramTracker(host, target, {
    sdkVersion: '0.1.0', deviceIdFactory: () => 'fixture-device', sessionIdFactory: () => `session-${++session}`,
  })
  const tracker = create()
  const init = (extra: Record<string, unknown> = {}) => tracker.init({ accountId: 'account', dataSourceId: 'source', appId, ...extra })
  const show = () => {
    tracker.onAppLaunch({ path: 'pages/home', query: 'entry=1', scene: '1001', referralPage: 'external-app' })
    tracker.onAppShow({ path: 'pages/home', query: 'entry=1', scene: '1001', referralPage: 'external-app' })
    tracker.onPageLoad({ instanceId: 'home-1', route: 'pages/home', query: 'page=1', referralPage: null })
    tracker.onPageShow('home-1', '首页')
  }
  return { host, appId, values, sent, interceptors, create, tracker, init, show }
}
