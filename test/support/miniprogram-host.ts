import { vi } from 'vitest'
import type { MiniProgramTarget } from '../../src/types/index.js'
import type { MiniProgramHost } from '../../src/platform/miniprogram.js'
import { createMiniProgramTracker } from '../../src/platform/miniprogram.js'

/** 独立于生产配置的预期表，防止错误平台映射在实现与断言中同时通过。 */
export const miniCases = {
  'mp-weixin': { platform: 'MinP', name: 'Weixin', prefix: '', global: 'wx', appId: 'wx1234567890abcdef' },
  'mp-alipay': { platform: 'alip', name: 'Alipay', prefix: 'alip_', global: 'my', appId: '2026102700000001' },
  'mp-baidu': { platform: 'baidup', name: 'Baidu', prefix: 'baidup_', global: 'swan', appId: 'baidu-fixture' },
  'mp-toutiao': { platform: 'bytedance', name: 'Bytedance', prefix: 'bytedance_', global: 'tt', appId: 'tt-fixture' },
  'mp-qq': { platform: 'qq', name: 'QQ', prefix: 'qq_', global: 'qq', appId: 'qq-fixture' },
  'mp-kuaishou': { platform: 'kuaishoup', name: 'KuaiShou', prefix: 'ks_', global: 'ks', appId: 'ks-fixture' },
  'mp-jd': { platform: 'jdp', name: 'JingDong', prefix: 'jd_', global: 'jd', appId: 'jd-fixture' },
  'mp-xhs': { platform: 'xhsp', name: 'XiaoHongShu', prefix: 'xhs_', global: 'xhs', appId: 'xhs-fixture' },
} as const
export const miniTargets = Object.keys(miniCases) as MiniProgramTarget[]

export function miniHost(target: MiniProgramTarget) {
  const appId = miniCases[target].appId
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
