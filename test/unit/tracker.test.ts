import { storageKeys } from '../../src/core/storage/index.js'
import { readIdentityRecord } from '../../src/core/userStore.js'
import { testAutoTrackProfile } from '../support/autotrack-fixture.js'
import { describe, expect, it } from 'vitest'

import type { AppSystemContext, LoggerPort, NetworkPort, NetworkState, StorageArea, StoragePort, StorageRead, StorageWrite, TransportPort } from '../../src/types/index.js'
import type { UploaderRuntime } from '../../src/core/uploader.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'
import { TrackerRuntime } from '../../src/core/growingIO.js'

class MemoryStorage implements StoragePort {
  public readonly persistentQueue = true
  private readonly values = new Map<string, string>()

  public async read(_area: StorageArea, key: string): Promise<StorageRead> {
    const value = this.values.get(key)
    return value === undefined ? { kind: 'missing' } : { kind: 'value', value }
  }

  public async write(_area: StorageArea, key: string, value: string): Promise<StorageWrite> {
    this.values.set(key, value)
    return { kind: 'ok' }
  }

  public async remove(_area: StorageArea, key: string): Promise<StorageWrite> {
    this.values.delete(key)
    return { kind: 'ok' }
  }
}

const system: AppSystemContext = {
  platform: 'Android', platformVersion: '14', domain: 'com.example.app', appState: 'FOREGROUND', appName: 'Example',
  networkState: 'WIFI', screenWidth: 1080, screenHeight: 1920, deviceBrand: 'Google', deviceModel: 'Pixel',
  deviceType: 'PHONE', appVersion: '1.0.0', language: 'zh-CN', sdkVersion: '0.1.0',
}

/** 创建可调时间、同意状态和能力配置的运行时，供跨模块状态流程验证。 */
function createTracker(dataCollect = true, autoTracking = false, debug = false, logger?: LoggerPort) {
  let now = 100
  const tracker = new TrackerRuntime({
    autoTrackProfile: testAutoTrackProfile,
    storage: new MemoryStorage(), systemContext: { load: async () => system }, clock: { now: () => now },
    timezone: { getOffsetMinutes: () => -480 }, deviceIdFactory: () => 'device-1',
    sessionIdFactory: (() => { let id = 0; return () => `session-${++id}` })(), orientation: () => 'PORTRAIT', logger,
  })
  if (autoTracking) expect(tracker.registerPlugins({ name: 'gioEventAutoTracking' })).toBe(true)
  expect(tracker.init({ accountId: 'account', dataSourceId: 'source', dataCollect, debug })).toBe(true)
  return { tracker, setNow: (value: number) => { now = value } }
}

describe('TrackerRuntime', () => {
  it.each(['missing', 'stale', 'newer'] as const)('序号记录 %s 时不重复使用恢复队列中已经分配的序号', async (mode) => {
    const storage = new MemoryStorage()
    const keys = storageKeys('source')
    const { tracker: first } = createTracker()
    first.onAppShow({ path: '/home', query: '' })
    await first.whenReady()
    first.track('cached_event')
    const event = { ...first.queuedEvents()[1]!, eventSequenceId: 90 }
    await storage.write('queue', keys.queue, JSON.stringify({ version: 1, revision: 1, entries: [{ requestId: 'q1', event, retryCount: 0 }] }))
    if (mode !== 'missing') await storage.write('state', keys.meta,
      JSON.stringify({ version: 1, expiresAt: null, value: { eventSequenceId: mode === 'newer' ? 100 : 2 } }))
    const second = new TrackerRuntime({
      storage, systemContext: { load: async () => system }, clock: { now: () => 100 },
      timezone: { getOffsetMinutes: () => 0 }, deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-new', orientation: () => 'PORTRAIT',
    })
    second.init({ accountId: 'account', dataSourceId: 'source' })
    second.onAppLaunch({ path: '/home', query: '' })
    second.onAppShow({ path: '/home', query: '' })
    await second.whenReady()
    second.track('after_recovery')
    expect(second.queuedEvents().map(event => event.eventSequenceId)).toEqual([90, mode === 'newer' ? 101 : 91, mode === 'newer' ? 102 : 92])
  })

  it('starts fresh click deduplication when consent creates a replacement PAGE', async () => {
    const { tracker, setNow } = createTracker(true, true)
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onPageLoad({ instanceId: 'home', route: 'pages/home', query: '', referralPage: null })
    tracker.onPageShow('home', 'Home')
    await tracker.whenReady()
    const probe = { schemaVersion: 2, source: 'template', kind: 'click', eventName: 'save' } as const
    const event = { type: 'tap', timeStamp: 100, currentTarget: { id: 'buy' } }
    expect(tracker.autoTrack(probe, event)).toBe(true)
    expect(tracker.setDataCollect(false)).toBe(true)
    setNow(1_000)
    expect(tracker.setDataCollect(true)).toBe(true)
    expect(tracker.autoTrack(probe, { ...event, timeStamp: 101 })).toBe(true)
    expect(tracker.autoTrack(probe, event)).toBe(false)
    expect(tracker.queuedEvents().filter(event => event.eventType === 'VIEW_CLICK')).toMatchObject([
      { sessionId: 'session-1', timestamp: 100 },
      { sessionId: 'session-2', timestamp: 1_000 },
    ])
  })
  it('App 事件在调用时立即发送并输出事件日志，不等待聚合定时器', async () => {
    const logs: string[] = []
    const requests: ProtocolEvent[][] = []
    const tracker = new TrackerRuntime({
      storage: new MemoryStorage(), systemContext: { load: async () => system }, clock: { now: () => 100 },
      timezone: { getOffsetMinutes: () => 0 }, deviceIdFactory: () => 'device', sessionIdFactory: () => 'session',
      orientation: () => 'PORTRAIT',
      logger: { info: () => undefined, success: () => undefined, warn: () => undefined, error: () => undefined, debug: message => { logs.push(message) } },
      upload: {
        transport: { dispatch: (request, done) => { requests.push(JSON.parse(request.body)); done({ kind: 'success', status: 204 }) } },
        runtime: { now: () => 100, random: () => 0.5, setTimeout: () => 1, clearTimeout: () => undefined },
      },
    })
    tracker.init({ accountId: 'account', dataSourceId: 'source', debug: true })
    tracker.onAppLaunch({ path: '/home', query: '' })
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    expect(requests.flat().map(event => event.eventType)).toEqual(['VISIT'])
    tracker.track('immediate_event')
    expect(requests.flat().map(event => event.eventType)).toEqual(['VISIT', 'CUSTOM'])
    expect(logs.filter(line => line.startsWith('[GrowingIO Debug]: [')).map(line => JSON.parse(line.slice('[GrowingIO Debug]: '.length))).flat()).toMatchObject([
      { eventType: 'VISIT' }, { eventType: 'CUSTOM', eventName: 'immediate_event' },
    ])
  })

  it.each([[30_200, false], [30_201, true]] as const)('uses observed background duration while hydration is pending: show=%i renewed=%s', async (returnAt, renewed) => {
    let now = 100
    let complete: (context: AppSystemContext) => void = () => { throw new Error('hydration_not_started') }
    let sessionNumber = 0
    const tracker = new TrackerRuntime({
      storage: new MemoryStorage(), systemContext: { load: () => new Promise(resolve => { complete = resolve }) },
      clock: { now: () => now }, timezone: { getOffsetMinutes: () => 0 }, deviceIdFactory: () => 'device',
      sessionIdFactory: () => `session-${++sessionNumber}`, orientation: () => 'PORTRAIT',
    })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppLaunch({ path: '/home', query: '' })
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onPageLoad({ instanceId: 'home', route: 'pages/home', query: '', referralPage: null })
    now = 101
    tracker.onPageShow('home', 'Home')
    now = 200
    tracker.onAppHide()
    now = returnAt
    tracker.onAppShow({ path: '/home', query: '' })
    now = 50_000
    complete(system)
    await tracker.whenReady()
    expect(tracker.queuedEvents()).toMatchObject([
      { eventType: 'VISIT', timestamp: 50_000, sessionId: 'session-1' },
      { eventType: 'PAGE', timestamp: 50_000, sessionId: 'session-1' },
      { eventType: 'APP_CLOSED', timestamp: 50_000, sessionId: 'session-1' },
      ...(renewed ? [{ eventType: 'VISIT', timestamp: 50_000, sessionId: 'session-2' }] : []),
    ])
    expect(tracker.queuedEvents()).toHaveLength(renewed ? 4 : 3)
  })
  it('50 条启动业务调用不会挤掉 App 和首屏生命周期', async () => {
    const { tracker } = createTracker()
    for (let i = 0; i < 50; i++) expect(tracker.track(`early_${i}`)).toBe(true)
    expect(tracker.track('overflow')).toBe(false)
    expect(tracker.onAppLaunch({ path: '/home', query: '' })).toBe(true)
    expect(tracker.onAppShow({ path: '/home', query: '' })).toBe(true)
    expect(tracker.onPageLoad({ instanceId: 'home', route: 'pages/home', query: '', referralPage: null })).toBe(true)
    expect(tracker.onPageShow('home', '首页')).toBe(true)
    await tracker.whenReady()
    const events = tracker.queuedEvents()
    expect(events.map(event => event.eventType)).toEqual(['VISIT', ...Array(50).fill('CUSTOM'), 'PAGE'])
    expect(events.filter(event => event.eventType === 'CUSTOM').map(event => event.eventName)).toEqual(Array.from({ length: 50 }, (_, i) => `early_${i}`))
    expect(new Set(events.map(event => event.sessionId)).size).toBe(1)
    expect(tracker.track('after_ready')).toBe(true)
  })

  it.each(['hydrating', 'before-show', 'ready'] as const)('rejects invalid custom names before reading attributes or reserving a buffer slot: %s', async (phase) => {
    const { tracker } = createTracker()
    if (phase !== 'hydrating') await tracker.whenReady()
    if (phase === 'ready') tracker.onAppShow({ path: '/home', query: '' })
    let reads = 0
    const properties = { get value() { reads++; return 'business' } }
    for (let index = 0; index < 60; index++) expect(tracker.track('invalid name', properties)).toBe(false)
    for (const name of [null, undefined, '', 0, {}, '1event', 'a'.repeat(101), 'event\n', 'event\r', 'event\u2028']) expect(tracker.track(name, properties)).toBe(false)
    expect(reads).toBe(0)
    expect(tracker.track('valid_event')).toBe(true)
    if (phase !== 'ready') tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    expect(tracker.queuedEvents().map(event => event.eventType === 'CUSTOM' ? event.eventName : event.eventType)).toEqual(['VISIT', 'valid_event'])
  })

  it('属性在初始化期间、等待首个会话期间和就绪后具有相同语义', async () => {
    const run = async (phase: 'hydrating' | 'before-show' | 'ready') => {
      const { tracker } = createTracker()
      if (phase !== 'hydrating') await tracker.whenReady()
      if (phase === 'ready') tracker.onAppShow({ path: '/home', query: '' })
      const properties = { missing: undefined as string | undefined, invalid: NaN, infinite: Infinity, invalidDate: new Date(NaN), date: new Date(0), list: [undefined, null, false, 0] }
      expect(tracker.track('attributes', properties)).toBe(true)
      expect(tracker.setUserAttributes({ missing: undefined })).toBe(true)
      properties.missing = 'later'
      if (phase !== 'ready') tracker.onAppShow({ path: '/home', query: '' })
      await tracker.whenReady()
      return tracker.queuedEvents().filter(event => ['CUSTOM', 'LOGIN_USER_ATTRIBUTES'].includes(event.eventType)).map(event => event.attributes)
    }
    const expected = [{ missing: '', date: '1970-01-01T00:00:00.000Z', list: '||||false||0' }, { missing: '' }]
    for (const phase of ['hydrating', 'before-show', 'ready'] as const) expect(await run(phase)).toEqual(expected)
  })

  it('关闭采集时不读取属性 getter，开启时隔离 getter 异常', async () => {
    const { tracker } = createTracker(false)
    let reads = 0
    const properties = { get value() { reads++; throw new Error('业务 getter') } }
    expect(tracker.track('hidden', properties)).toBe(false)
    expect(tracker.setUserAttributes(properties)).toBe(false)
    expect(reads).toBe(0)
    tracker.setDataCollect(true)
    expect(tracker.track('visible', properties)).toBe(false)
    expect(reads).toBe(1)
    await tracker.whenReady()
  })

  it.each(['user', 'collection'])('后台 %s 更新后的前台恢复仍生成超时 VISIT', async (reason) => {
    const { tracker, setNow } = createTracker()
    tracker.setUserId('A')
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    tracker.onAppHide()
    if (reason === 'user') tracker.setUserId('B')
    else { tracker.setDataCollect(false); tracker.setDataCollect(true) }
    const background = tracker.queuedEvents().at(-1)!
    expect(background).toMatchObject({ eventType: 'VISIT', appState: 'BACKGROUND' })
    setNow(30_101)
    tracker.onAppShow({ path: '/home', query: '' })
    const foreground = tracker.queuedEvents().at(-1)!
    expect(foreground).toMatchObject({ eventType: 'VISIT', appState: 'FOREGROUND' })
    expect(foreground.sessionId).not.toBe(background.sessionId)
  })

  it('首次显示前连续切换身份不会提前创建会话，首个 VISIT 使用最终身份', async () => {
    const { tracker } = createTracker()
    tracker.setUserId('A')
    tracker.setUserId('B')
    await tracker.whenReady()
    expect(tracker.queuedEvents()).toEqual([])
    tracker.onAppLaunch({ path: '/home', query: '' })
    tracker.onAppShow({ path: '/home', query: '' })
    expect(tracker.queuedEvents()).toMatchObject([{ eventType: 'VISIT', userId: 'B', sessionId: 'session-1', path: '/home' }])
  })

  it('reports bootstrap failure when runtime setup throws after hydration', async () => {
    const errors: string[] = []
    const tracker = new TrackerRuntime({
      storage: new MemoryStorage(), systemContext: { load: async () => system }, clock: { now: () => 100 },
      timezone: { getOffsetMinutes: () => -480 }, deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1',
      orientation: () => 'PORTRAIT',
      network: { current: async () => 'WIFI', isConnected: () => true, subscribe: () => { throw new TypeError('host setup failed') } },
      logger: { info: () => undefined, success: () => undefined, warn: () => undefined, debug: () => undefined, error: (message) => errors.push(message) },
    })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await expect(tracker.whenReady()).resolves.toBe(false)
    expect(tracker.ready()).toBe(false)
    expect(tracker.failed()).toBe(true)
    expect(errors).toEqual(['[GrowingIO]：SDK初始化失败，运行时初始化异常!'])
  })

  it('emits fixed lifecycle diagnostics and only emits event JSON when debug is enabled', async () => {
    const logs: string[] = []
    const logger: LoggerPort = {
      info: (message) => logs.push(`info:${message}`), success: (message) => logs.push(`success:${message}`),
      warn: (message) => logs.push(`warn:${message}`), error: (message) => logs.push(`error:${message}`),
      debug: (message, data) => logs.push(`debug:${message}${data === undefined ? '' : ` ${String(data)}`}`),
    }
    const requests: string[] = []
    const transport: TransportPort = {
      dispatch: (_request, done) => {
        requests.push('sent')
        done({ kind: 'success', status: 204 })
      },
    }
    const tracker = new TrackerRuntime({
      autoTrackProfile: testAutoTrackProfile,
      storage: new MemoryStorage(), systemContext: { load: async () => system }, clock: { now: () => 100 },
      timezone: { getOffsetMinutes: () => -480 }, deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1',
      orientation: () => 'PORTRAIT', logger,
      upload: { transport, runtime: { now: () => 123, random: () => 0.5, setTimeout: () => 1, clearTimeout: () => undefined } },
    })
    expect(tracker.init({ accountId: 'account', dataSourceId: 'source', dataCollect: true, debug: true })).toBe(true)
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    tracker.onAppHide()
    expect(logs).toContain('info:[GrowingIO]：Gio uni-app SDK 初始化中...')
    expect(logs).toContain('success:[GrowingIO]：Gio uni-app SDK 初始化完成！')
    expect(logs).toContain('debug:App: onShow 100')
    const debugEventLogs = logs.filter((line) => line.startsWith('debug:[GrowingIO Debug]: ['))
    expect(debugEventLogs).toHaveLength(2)
    expect(JSON.parse(debugEventLogs[0]!.slice('debug:[GrowingIO Debug]: '.length))).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: 'VISIT' })]),
    )
    expect(JSON.parse(debugEventLogs[1]!.slice('debug:[GrowingIO Debug]: '.length))).toMatchObject([{ eventType: 'APP_CLOSED' }])
    expect(requests).toStrictEqual(['sent', 'sent'])
  })

  it('logs App and Page lifecycle timestamps even while collection is disabled', async () => {
    const logs: string[] = []
    const logger: LoggerPort = {
      info: (message) => logs.push(`info:${message}`), success: (message) => logs.push(`success:${message}`),
      warn: (message) => logs.push(`warn:${message}`), error: (message) => logs.push(`error:${message}`),
      debug: (message) => logs.push(`debug:${message}`),
    }
    const { tracker } = createTracker(false, false, true, logger)
    tracker.onAppLaunch({ path: '/launch', query: '' })
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onPageLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
    tracker.onPageShow('home#1', null)
    tracker.onPageHide('home#1')
    tracker.onPageUnload('home#1')
    await tracker.whenReady()

    expect(logs).toEqual(expect.arrayContaining([
      'debug:App: onLaunch 100',
      'debug:App: onShow 100',
      'debug:Page: pages/home/index # onLoad 100',
      'debug:Page: home#1 # onShow 100',
      'debug:Page: home#1 # onHide 100',
      'debug:Page: home#1 # onUnload 100',
    ]))
  })

  it('identifies click and change actions in autotrack diagnostics', async () => {
    const logs: string[] = []
    const logger: LoggerPort = {
      info: (message) => logs.push(`info:${message}`), success: (message) => logs.push(`success:${message}`),
      warn: (message) => logs.push(`warn:${message}`), error: (message) => logs.push(`error:${message}`),
      debug: (message) => logs.push(`debug:${message}`),
    }
    const { tracker } = createTracker(true, true, true, logger)
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onPageLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
    tracker.onPageShow('home#1', null)
    await tracker.whenReady()

    expect(tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'submit' })).toBe(true)
    expect(tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'change', eventName: 'search', elementType: 'input' })).toBe(true)
    expect(logs).toEqual(expect.arrayContaining([
      'debug:[GrowingIO Debug]: action=click',
      'debug:[GrowingIO Debug]: action=change',
    ]))
  })

  it('buffers App onShow then business track through hydration and replays them in that lifecycle order', async () => {
    const { tracker } = createTracker()
    expect(tracker.onAppLaunch({ path: '/launch', query: '' })).toBe(true)
    expect(tracker.onAppShow({ path: '/home', query: 'entry=1' })).toBe(true)
    expect(tracker.track('after_app_show')).toBe(true)

    await expect(tracker.whenReady()).resolves.toBe(true)
    expect(tracker.queuedEvents()).toMatchObject([
      { eventType: 'VISIT', eventSequenceId: 1, path: '/home', query: 'entry=1' },
      { eventType: 'CUSTOM', eventName: 'after_app_show', eventSequenceId: 2 },
    ])
  })

  it('keeps disabled collection state, then creates a replacement session with VISIT and current PAGE after consent', async () => {
    const { tracker } = createTracker(false)
    tracker.onAppShow({ path: '/privacy', query: '' })
    tracker.onPageLoad({ instanceId: 'privacy#1', route: 'pages/privacy/index', query: '', referralPage: null })
    tracker.onPageShow('privacy#1', null)
    await tracker.whenReady()
    expect(tracker.queuedEvents()).toHaveLength(0)

    expect(tracker.setDataCollect(true)).toBe(true)
    expect(tracker.queuedEvents()).toMatchObject([
      { eventType: 'VISIT', eventSequenceId: 1, path: '/privacy' },
      { eventType: 'PAGE', eventSequenceId: 2, path: 'pages/privacy/index', orientation: 'PORTRAIT' },
    ])
  })

  it('creates only one extra VISIT for a logged-in user A to B transition', async () => {
    const { tracker } = createTracker()
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    expect(tracker.setUserId('user-a')).toBe(true)
    expect(tracker.setUserId('user-b')).toBe(true)

    expect(tracker.queuedEvents().filter((event) => event.eventType === 'VISIT')).toMatchObject([
      { sessionId: 'session-1' },
      { sessionId: 'session-2', userId: 'user-b' },
    ])
  })

  it('renews the visit after logout and login as another user, while same-user login preserves it', async () => {
    const { tracker } = createTracker()
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    tracker.setUserId('A')
    tracker.track('as_a')
    tracker.clearUserId()
    tracker.setUserId('A')
    tracker.clearUserId()
    tracker.setUserId('B')
    tracker.track('as_b')
    expect(tracker.queuedEvents().map(event => [event.eventType, event.userId, event.sessionId])).toEqual([
      ['VISIT', undefined, 'session-1'], ['CUSTOM', 'A', 'session-1'],
      ['VISIT', 'B', 'session-2'], ['CUSTOM', 'B', 'session-2'],
    ])
  })

  it('rejects malformed Unicode login input without throwing or changing active identity', async () => {
    const { tracker } = createTracker()
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    tracker.setUserId('A')
    expect(() => tracker.setUserId('\ud800')).not.toThrow()
    expect(tracker.setUserId('\ud800')).toBe(false)
    expect(tracker.setUserId('B', '\udc00')).toBe(false)
    tracker.track('after_bad_identity')
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ userId: 'A', sessionId: 'session-1' })
  })

  it('preserves the latest user across logout and cold start without exposing it on anonymous events', async () => {
    const storage = new MemoryStorage()
    let sessionNumber = 0
    const create = () => new TrackerRuntime({
      storage, systemContext: { load: async () => system }, clock: { now: () => 100 }, timezone: { getOffsetMinutes: () => 0 },
      deviceIdFactory: () => 'device', sessionIdFactory: () => `session-${++sessionNumber}`, orientation: () => 'PORTRAIT',
    })
    const first = create()
    first.init({ accountId: 'account', dataSourceId: 'source' })
    first.onAppLaunch({ path: '/home', query: '' })
    first.onAppShow({ path: '/home', query: '' })
    await first.whenReady()
    first.setUserId('private-user-a')
    first.clearUserId()
    const stored = await storage.read('state', storageKeys('source').identity)
    expect(stored.kind === 'value' && stored.value.includes('private-user-a')).toBe(false)

    const second = create()
    second.init({ accountId: 'account', dataSourceId: 'source' })
    second.onAppLaunch({ path: '/home', query: '' })
    second.onAppShow({ path: '/home', query: '' })
    await second.whenReady()
    second.track('anonymous_after_restart')
    second.setUserId('B')
    second.track('as_b')
    const events = second.queuedEvents()
    expect(events.find(event => event.eventName === 'anonymous_after_restart')).toMatchObject({ sessionId: 'session-2' })
    expect(events.find(event => event.eventName === 'anonymous_after_restart')).not.toHaveProperty('userId')
    expect(events.find(event => event.eventName === 'as_b')).toMatchObject({ sessionId: 'session-3', userId: 'B' })
    expect(events.filter(event => event.sessionId === 'session-3')).toMatchObject([{ eventType: 'VISIT', userId: 'B' }, { eventType: 'CUSTOM', userId: 'B' }])
    expect(events.every(event => !Object.prototype.hasOwnProperty.call(event, 'lastUserId'))).toBe(true)
  })

  it('uses the new session and current page context with each event time after consent resumes', async () => {
    const { tracker, setNow } = createTracker(true, true)
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onPageLoad({ instanceId: 'home', route: 'pages/home', query: '', referralPage: null })
    tracker.onPageShow('home', 'Home')
    await tracker.whenReady()
    tracker.setDataCollect(false)
    setNow(200)
    tracker.setDataCollect(true)
    setNow(210)
    tracker.track('after_consent')
    setNow(220)
    tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'click' })
    setNow(230)
    tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'change', eventName: 'change', elementType: 'input' })
    expect(tracker.queuedEvents().slice(-5)).toMatchObject([
      { eventType: 'VISIT', sessionId: 'session-2' }, { eventType: 'PAGE', timestamp: 200, sessionId: 'session-2' },
      { eventType: 'CUSTOM', timestamp: 210, path: 'pages/home', sessionId: 'session-2' },
      { eventType: 'VIEW_CLICK', timestamp: 220, path: 'pages/home', sessionId: 'session-2' },
      { eventType: 'VIEW_CHANGE', timestamp: 230, path: 'pages/home', sessionId: 'session-2' },
    ])
    for (const event of tracker.queuedEvents()) expect(event).not.toHaveProperty('pageShowTimestamp')
  })

  it('sends App events immediately and flushes APP_CLOSED on background', async () => {
    const requests: string[] = []
    const transport: TransportPort = {
      dispatch: (request, done) => {
        requests.push(request.url)
        done({ kind: 'success', status: 204 })
      },
    }
    const uploaderRuntime: UploaderRuntime = {
      now: () => 123, random: () => 0.5,
      setTimeout: () => 1, clearTimeout: () => undefined,
    }
    const tracker = new TrackerRuntime({
      autoTrackProfile: testAutoTrackProfile,
      storage: new MemoryStorage(), systemContext: { load: async () => system }, clock: { now: () => 100 },
      timezone: { getOffsetMinutes: () => -480 }, deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1',
      orientation: () => 'PORTRAIT', upload: { transport, runtime: uploaderRuntime },
    })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    tracker.onAppHide()

    expect(requests).toStrictEqual(Array(2).fill('https://napi.growingio.com/v3/projects/account/collect?stm=123&compress=0'))
    expect(tracker.queuedEvents()).toStrictEqual([])
  })

  it('uses new network state for future events and wakes the uploader only when connectivity recovers', async () => {
    const networkState = { listener: null as ((state: NetworkState) => void) | null }
    const network: NetworkPort = {
      isConnected: () => null,
      current: async () => 'UNKNOWN',
      subscribe: (next) => { networkState.listener = next; return () => { networkState.listener = null } },
    }
    const tracker = new TrackerRuntime({
      autoTrackProfile: testAutoTrackProfile,
      storage: new MemoryStorage(), systemContext: { load: async () => system }, clock: { now: () => 100 },
      timezone: { getOffsetMinutes: () => -480 }, deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1',
      orientation: () => 'PORTRAIT', network,
    })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    networkState.listener?.('WIFI')
    tracker.track('after_reconnect')

    expect(tracker.queuedEvents().at(-1)).toMatchObject({ eventType: 'CUSTOM', eventName: 'after_reconnect', networkState: 'WIFI' })
  })

  it('requires the built-in auto-tracking plugin before accepting a constrained VIEW intent', async () => {
    const { tracker: unconfigured } = createTracker()
    expect(unconfigured.autoTrack({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'submit' })).toBe(false)
    const { tracker } = createTracker(true, true)
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onPageLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
    tracker.onPageShow('home#1', null)
    await tracker.whenReady()
    expect(tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'submit' })).toBe(true)
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ eventType: 'VIEW_CLICK', xpath: '#submit' })
  })

  it('accepts only dataCollect through setOptions and preserves the consent transition semantics', async () => {
    const { tracker } = createTracker(false)
    tracker.onAppShow({ path: '/privacy', query: '' })
    await tracker.whenReady()
    expect(tracker.setOptions({ idMapping: true })).toBe(false)
    expect(tracker.setOptions({ dataCollect: 'true' })).toBe(false)
    expect(tracker.setOptions({ dataCollect: true })).toBe(true)
    expect(tracker.queuedEvents()).toMatchObject([{ eventType: 'VISIT', path: '/privacy' }])
  })

  it('persists a generated anonymous identity before the next cold start', async () => {
    const storage = new MemoryStorage()
    const create = (deviceId: string) => new TrackerRuntime({
      storage, systemContext: { load: async () => system }, clock: { now: () => 100 }, timezone: { getOffsetMinutes: () => -480 },
      deviceIdFactory: () => deviceId, sessionIdFactory: () => 'session-1', orientation: () => 'PORTRAIT',
    })
    const first = create('first-device')
    first.init({ accountId: 'account', dataSourceId: 'source' })
    first.onAppShow({ path: '/home', query: '' })
    await first.whenReady()

    const second = create('second-device')
    second.init({ accountId: 'account', dataSourceId: 'source' })
    second.onAppShow({ path: '/home', query: '' })
    await second.whenReady()
    expect(second.queuedEvents()[0]).toMatchObject({ eventType: 'VISIT', deviceId: 'first-device' })
  })

  it('warns once when a userKey is ignored because idMapping is disabled', async () => {
    const warnings: string[] = []
    const { tracker } = createTracker(true, false, false, {
      info: () => undefined, success: () => undefined, error: () => undefined, debug: () => undefined,
      warn: (message) => { warnings.push(message) },
    })
    await tracker.whenReady()
    expect(tracker.setUserId('user-a', 'key-a')).toBe(true)
    expect(tracker.setUserId('user-b', 'key-b')).toBe(true)
    expect(warnings).toStrictEqual(['[GrowingIO]: userKey ignored because idMapping is disabled'])
  })
  it('在首次 AppShow 建立会话后按原顺序处理早期事件和身份修改', async () => {
    const { tracker } = createTracker()
    expect(tracker.setUserId('A')).toBe(true)
    expect(tracker.setLocation(30, 120)).toBe(true)
    expect(tracker.track('early')).toBe(true)
    expect(tracker.setUserId('B')).toBe(true)
    expect(tracker.setUserAttributes({ role: 'member' })).toBe(true)
    tracker.onAppLaunch({ path: '/home', query: '' })
    await tracker.whenReady()
    expect(tracker.queuedEvents()).toEqual([])
    tracker.onAppShow({ path: '/home', query: '' })
    expect(tracker.queuedEvents()).toMatchObject([
      { eventType: 'VISIT', userId: 'A' },
      { eventType: 'CUSTOM', eventName: 'early', userId: 'A', latitude: 30, longitude: 120 },
      { eventType: 'VISIT', userId: 'B' },
      { eventType: 'LOGIN_USER_ATTRIBUTES', userId: 'B', attributes: { role: 'member' } },
    ])
  })

  it('初始化期间同意采集只产生一组 VISIT 和 PAGE', async () => {
    const { tracker } = createTracker(false)
    tracker.onAppLaunch({ path: '/privacy', query: '' })
    tracker.onAppShow({ path: '/privacy', query: '' })
    tracker.onPageLoad({ instanceId: 'privacy', route: 'privacy', query: '', referralPage: null })
    tracker.onPageShow('privacy', '隐私')
    tracker.setDataCollect(true)
    await tracker.whenReady()
    expect(tracker.queuedEvents().map((event) => event.eventType)).toEqual(['VISIT', 'PAGE'])
    expect(new Set(tracker.queuedEvents().map((event) => event.sessionId)).size).toBe(1)
    expect(tracker.setDataCollect(true)).toBe(true)
    expect(tracker.queuedEvents()).toHaveLength(2)
  })

  it('a rejected consent resume leaves collection disabled and can be retried after hydration', async () => {
    const { tracker } = createTracker(false)
    for (let index = 0; index < 50; index++) {
      expect(tracker.onPageLoad({ instanceId: `page-${index}`, route: 'pages/privacy', query: '', referralPage: null })).toBe(true)
    }
    expect(tracker.setOptions({ dataCollect: true })).toBe(false)
    let reads = 0
    expect(tracker.track('still_disabled', { get privateValue() { reads++; return 'private' } })).toBe(false)
    expect(reads).toBe(0)
    await tracker.whenReady()
    tracker.onAppShow({ path: '/privacy', query: '' })
    tracker.onPageShow('page-0', 'Privacy')
    expect(tracker.queuedEvents()).toEqual([])
    expect(tracker.setOptions({ dataCollect: true })).toBe(true)
    expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
  })

  it('后台业务事件读取实时 App 状态', async () => {
    const { tracker } = createTracker()
    tracker.onAppShow({ path: '/home', query: '' })
    await tracker.whenReady()
    tracker.onAppHide()
    tracker.track('background')
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ appState: 'BACKGROUND' })
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.track('foreground')
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ appState: 'FOREGROUND' })
  })

  it('关闭 idMapping 后清理恢复的 userKey，保留 deviceId 和 userId', async () => {
    const storage = new MemoryStorage()
    const deps = { storage, systemContext: { load: async () => system }, clock: { now: () => 100 }, timezone: { getOffsetMinutes: () => 0 },
      deviceIdFactory: () => 'device', sessionIdFactory: () => 'session', orientation: () => 'PORTRAIT' as const }
    const first = new TrackerRuntime(deps)
    first.init({ accountId: 'account', dataSourceId: 'source', idMapping: true })
    first.onAppShow({ path: '/home', query: '' })
    await first.whenReady()
    first.setUserId('user', 'old-key')
    const second = new TrackerRuntime(deps)
    second.init({ accountId: 'account', dataSourceId: 'source', idMapping: false })
    second.onAppLaunch({ path: '/home', query: '' })
    second.onAppShow({ path: '/home', query: '' })
    await second.whenReady()
    second.track('after_restore')
    expect(second.queuedEvents().at(-1)).toMatchObject({ deviceId: 'device', userId: 'user' })
    expect(second.queuedEvents().at(-1)).not.toHaveProperty('userKey')
    const stored = await storage.read('state', storageKeys('source').identity)
    expect(stored.kind === 'value' && readIdentityRecord(stored.value, 'source')).toMatchObject({ identity: { userKey: null } })
  })

})
