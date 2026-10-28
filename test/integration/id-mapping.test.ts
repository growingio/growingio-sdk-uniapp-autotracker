import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GioGdpInitOptions } from '../../index.js'
import type { TrackerRuntime } from '../../src/core/growingIO.js'
import type { AppRuntimeHost } from '../../src/platform/index.js'
import { miniCases, miniHost, miniTargets } from '../support/miniprogram-host.js'
import { mountAutoTrackSfc } from '../support/autotrack-fixture.js'

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

/** 挂载真实身份页；初始身份只有 userId，模拟关闭映射时留下的账号。 */
async function identityDemo(target: typeof appTargets[number], idMapping = true) {
  vi.stubGlobal('__GIO_AUTOTRACK_VERIFICATION__', true)
  vi.stubGlobal('document', { activeElement: null })
  const { host, received } = environment(target)
  const { gdp, tracker } = await start(host, idMapping, undefined, true)
  await tracker.whenReady()
  tracker.onAppShow({ path: 'pages/user/user', query: '' })
  tracker.onPageLoad({ instanceId: 'user', route: 'pages/user/user', query: '', referralPage: null })
  tracker.onPageShow('user', '用户身份')
  expect(gdp('setUserId', 'demo-user-001')).toBe(true)
  const { dispatchAutoTrack } = await import('../../autotrack.js')
  const source = readFileSync(new URL('../../demo/pages/user/user.vue', import.meta.url), 'utf8')
  const fixture = mountAutoTrackSfc(source, (probe, event) => dispatchAutoTrack(probe as Parameters<typeof dispatchAutoTrack>[0], event))
  /** 执行页面中实际编译的设置按钮监听器。 */
  function click() {
    const button = fixture.elements().find(element => element.props['data-title'] === '设置用户身份')!
    return (button.props.onClick as (event: unknown) => unknown)({ currentTarget: { type: 'button', dataset: {} } })
  }
  return { gdp, received, fixture, click }
}

describe.each(appTargets)('%s 实际 Demo 身份按钮', target => {
  it('自动点击使用更新前身份，按钮执行后的业务事件使用新 userKey', async () => {
    const { gdp, received, fixture, click } = await identityDemo(target)
    try {
      const before = received.length
      click()
      const clickEvent = received.slice(before).find(event => event.eventType === 'VIEW_CLICK')!
      expect(clickEvent).toMatchObject({ xpath: '#setUser', userId: 'demo-user-001' })
      expect(clickEvent).not.toHaveProperty('userKey')
      expect(gdp('track', 'after_identity_handler')).toBe(true)
      expect(received.at(-1)).toMatchObject({ eventName: 'after_identity_handler', userId: 'demo-user-001', userKey: 'demo-key' })
    } finally { fixture.unmount() }
  })

  it.each([false, true])('idMapping=%s 时设置按钮生成使用新身份的核对事件', async idMapping => {
    const { received, fixture, click } = await identityDemo(target, idMapping)
    try {
      const before = received.length
      expect(click()).toBe(true)
      const events = received.slice(before).filter(event => event.eventName === 'review_identity_set')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ userId: 'demo-user-001' })
      expect(events[0]!.userKey).toBe(idMapping ? 'demo-key' : undefined)
      if (!idMapping) expect(events[0]).not.toHaveProperty('userKey')
      expect(fixture.instance).toHaveProperty('result', expect.stringContaining('review_identity_set 已入队'))
    } finally { fixture.unmount() }
  })

  it('空 userId 的核对事件不再携带登录身份', async () => {
    const { received, fixture, click } = await identityDemo(target)
    try {
      Object.assign(fixture.instance, { userId: '' })
      expect(click()).toBe(true)
      const event = received.find(event => event.eventName === 'review_identity_set')!
      expect(event).toBeDefined()
      expect(event).not.toHaveProperty('userId')
      expect(event).not.toHaveProperty('userKey')
    } finally { fixture.unmount() }
  })

  it('身份参数被拒绝时不发送设置成功的核对事件', async () => {
    const { received, fixture, click } = await identityDemo(target)
    try {
      Object.assign(fixture.instance, { userId: '\ud800' })
      expect(click()).toBe(false)
      expect(received.some(event => event.eventName === 'review_identity_set')).toBe(false)
      expect(fixture.instance).toHaveProperty('result', expect.stringContaining('身份未更新'))
    } finally { fixture.unmount() }
  })

  it('停采时仍更新身份，并明确提示核对事件未入队', async () => {
    const { gdp, received, fixture, click } = await identityDemo(target)
    try {
      expect(gdp('setOptions', { dataCollect: false })).toBe(true)
      const before = received.length
      expect(click()).toBe(false)
      expect(received).toHaveLength(before)
      expect(fixture.instance).toHaveProperty('result', expect.stringContaining('身份已更新，但核对事件未入队'))
      expect(gdp('setOptions', { dataCollect: true })).toBe(true)
      expect(gdp('track', 'after_collection_resume')).toBe(true)
      expect(received.at(-1)).toMatchObject({ userId: 'demo-user-001', userKey: 'demo-key' })
    } finally { fixture.unmount() }
  })
})
