import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWebLifecycle } from '../../src/adapters/web.js'
import { createWebTracker } from '../../src/platform/web.js'
import { miniHost } from '../support/miniprogram-host.js'
import { webStoragePrefix } from '../../src/platform/webStorage.js'

const accountId = 'account'
const webConfig = { accountId, dataSourceId: 'web-source', storageType: 'localstorage', serverUrl: 'https://collector.example.com' } as const
const factories = { sdkVersion: '0.1.0', deviceIdFactory: () => 'web-device', sessionIdFactory: () => 'web-session' }
const sharedKeys = ['gdp_user_id', 'account_gdp_cs1', 'account_gdp_user_key', 'account_gdp_gio_id', 'account_gdp_session_id', 'account_gdp_session_id_sent']

function webPage(path: string, values = new Map<string, string>(), userAgent = 'Mozilla/5.0') {
  const location = new URL(path, 'https://web.example.com')
  const sent: Array<Record<string, unknown>> = []
  const history = {
    state: null,
    pushState(_state: unknown, _title: string, path?: string | URL | null) {
      if (path != null) location.href = new URL(path, location.href).href
    },
    replaceState(_state: unknown, _title: string, path?: string | URL | null) {
      if (path != null) location.href = new URL(path, location.href).href
    },
  }
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
  const document = Object.assign(new EventTarget(), { title: 'Offers', referrer: '', visibilityState: 'visible', hidden: false, readyState: 'complete' })
  const browser = Object.assign(new EventTarget(), {
    location, history, localStorage, document,
    navigator: { userAgent, onLine: true, language: 'en-US' },
    screen: { width: 1000, height: 800 }, innerWidth: 1024, innerHeight: 600,
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(timer),
    fetch: async (_url: string, request: RequestInit) => {
      sent.push(...JSON.parse(request.body as string))
      return { status: 204 }
    },
  }) as unknown as Window
  return { browser, location, values, sent }
}

function sharedSnapshot(values: Map<string, string>) {
  return sharedKeys.map(key => [key, values.get(key)])
}

async function boot(page: ReturnType<typeof webPage>, options: Record<string, unknown> = {}) {
  const tracker = createWebTracker(page.browser, factories)
  expect(tracker.init({ ...webConfig, ...options })).toBe(true)
  installWebLifecycle(page.browser, tracker, options.hashtag === true)
  expect(await tracker.whenReady()).toBe(true)
  return tracker
}

async function miniSender() {
  const mini = miniHost('mp-weixin')
  expect(mini.init({ idMapping: true, uploadInterval: 0 })).toBe(true)
  expect(await mini.tracker.whenReady()).toBe(true)
  mini.show()
  expect(mini.tracker.setUserId('宿主%2F', 'host-key+')).toBe(true)
  return mini
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('H5 WebView runtime', () => {
  it.each([false, true])('uses the target child instance identity scope after embedding (strict=%s)', async strict => {
    const ordinary = webPage('/ordinary')
    const own = await boot(ordinary, { idMapping: true, webStorageSubInstance: true })
    expect(own.setUserId('web-user', 'web-key')).toBe(true)
    const originalPrefix = webStoragePrefix(accountId, 'web-source', true)
    const suffixes = ['_gdp_cs1', '_gdp_user_key', '_gdp_gio_id', '_gdp_session_id']
    ordinary.values.set(`${originalPrefix}_gdp_session_id`, JSON.stringify({ value: 'web-session', expiredAt: Date.now() + 1_800_000 }))
    const original = suffixes.map(suffix => ordinary.values.get(`${originalPrefix}${suffix}`))
    const mini = await miniSender()
    const hostQuery = mini.tracker.getGioInfo()!
    const hostPrefix = webStoragePrefix(accountId, 'source', true)
    const page = webPage(`/offers?${hostQuery}`, ordinary.values, 'miniProgram')
    await boot(page, { appId: mini.appId, idMapping: true, webStorageSubInstance: true, embeddedAdapter: { strict } })
    expect(suffixes.map(suffix => page.values.get(`${originalPrefix}${suffix}`))).toEqual(original)
    if (strict) expect(page.values.has(`${hostPrefix}_gdp_session_id`)).toBe(false)
    else {
      expect(JSON.parse(page.values.get(`${hostPrefix}_gdp_session_id`)!).value).toBe(new URLSearchParams(hostQuery).get('gios'))
      expect(page.values.has(`${hostPrefix}_gdp_cs1`)).toBe(true)
      expect(page.values.has(`${hostPrefix}_gdp_user_key`)).toBe(true)
    }
  })

  it.each([false, true])('renews the owned host session before expiry and stops on pagehide (strict=%s)', async strict => {
    const mini = await miniSender()
    const page = webPage(`/offers?${mini.tracker.getGioInfo()!}`, new Map(), 'miniProgram')
    vi.spyOn(page.browser, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined))
    await boot(page, { appId: mini.appId, sessionExpires: 1 / 60, embeddedAdapter: { strict } })
    const first = JSON.parse(page.values.get('gdp_embedded_new_device')!)
    expect(first.value.expiresAt).toBe(Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(801)
    const renewed = JSON.parse(page.values.get('gdp_embedded_new_device')!)
    expect(renewed.value.expiresAt).toBeGreaterThan(first.value.expiresAt)
    expect(renewed.value.sessionId).toBe(first.value.sessionId)
    if (strict) expect(page.values.has('account_gdp_session_id')).toBe(false)
    else expect(JSON.parse(page.values.get('account_gdp_session_id')!).expiredAt).toBe(renewed.value.expiresAt)
    page.browser.dispatchEvent(new Event('pagehide'))
    const stopped = page.values.get('gdp_embedded_new_device')
    await vi.advanceTimersByTimeAsync(801)
    expect(page.values.get('gdp_embedded_new_device')).toBe(stopped)
  })

  it.each([false, true])('sends the mini-program PAGE and CUSTOM identity without a duplicate VISIT (strict=%s)', async strict => {
    const ordinary = webPage('/ordinary')
    const own = await boot(ordinary, { idMapping: true })
    expect(own.setUserId('web-user', 'web-key')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(ordinary.sent[0]).toMatchObject({ eventType: 'VISIT', platform: 'web', domain: 'web.example.com', dataSourceId: 'web-source' })
    const ordinarySession = JSON.stringify({ value: 'web-session', expiredAt: Date.now() + 1_800_000 })
    ordinary.values.set('account_gdp_session_id', ordinarySession)
    const before = sharedSnapshot(ordinary.values)

    const mini = await miniSender()
    const hostQuery = mini.tracker.getGioInfo()!
    const hostSessionId = new URLSearchParams(hostQuery).get('gios')
    expect(hostSessionId).toBeTruthy()
    const query = `product=1&gioBusiness=keep&${hostQuery}&gioscreenHeight=850&giolanguage=zh-CN&gioappchannel=mini-channel&gionetworkstate=WIFI`
    const path = strict ? `/embedded#/offers?${query}` : `/offers?${query}`
    const page = webPage(path, ordinary.values, 'Mozilla/5.0 MicroMessenger miniProgram')
    const tracker = await boot(page, { appId: mini.appId, idMapping: false, hashtag: strict, embeddedAdapter: {
      strict, rewriteQuery: false, ignoreFields: ['language', 'deviceId', 'sessionId', 'dataSourceId', 'userId', 'userKey'],
    } })
    expect(tracker.setUserId('ignored')).toBe(false)
    expect(tracker.clearUserId()).toBe(false)
    expect(tracker.identify('ignored-device')).toBe(false)
    expect(tracker.track('embedded_offer')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)

    expect(page.sent.map(event => event.eventType)).toEqual(['PAGE', 'CUSTOM'])
    for (const event of page.sent) expect(event).toMatchObject({
      platform: 'MinP', domain: mini.appId, dataSourceId: 'source', deviceId: 'fixture-device',
      userId: '宿主%2F', userKey: 'host-key+', sessionId: hostSessionId,
      query: 'product=1&gioBusiness=keep', language: 'en-US', screenHeight: '850', appChannel: 'mini-channel', networkState: 'WIFI',
    })
    expect(page.location.href).toContain('giouserkey=')
    if (strict) expect(sharedSnapshot(page.values)).toEqual(before)
    else expect(JSON.parse(page.values.get('account_gdp_session_id')!).value).toBe(hostSessionId)

    const regular = webPage('/regular', page.values)
    const regularTracker = await boot(regular, { idMapping: true })
    expect(regularTracker.track('regular_identity')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(regular.sent.at(-1)).toMatchObject({
      eventName: 'regular_identity', platform: 'web', domain: 'web.example.com', dataSourceId: 'web-source',
      ...(strict ? { deviceId: 'web-device', userId: 'web-user', userKey: 'web-key' }
        : { deviceId: 'fixture-device', userId: '宿主%2F', userKey: 'host-key+' }),
    })
  })

  it('stops a matched routing-only snapshot over a cached collecting context and leaves an unrelated page collecting', async () => {
    const mini = await miniSender()
    const active = webPage(`/offers?${mini.tracker.getGioInfo()!}`)
    const embeddedOptions = { appId: mini.appId, embeddedAdapter: {} }
    const activeTracker = await boot(active, embeddedOptions)
    expect(activeTracker.track('active_offer')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(active.sent.map(event => event.eventType)).toEqual(['PAGE', 'CUSTOM'])
    const before = sharedSnapshot(active.values)

    expect(mini.tracker.setDataCollect(false)).toBe(true)
    const stop = mini.tracker.getGioInfo()!
    const stopped = webPage(`/offers?product=1&${stop}`, active.values)
    const stoppedTracker = await boot(stopped, embeddedOptions)
    stoppedTracker.track('stopped_offer')
    expect(stoppedTracker.setDataCollect(true)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(stopped.location.search).toBe('?product=1')
    expect(stopped.sent).toEqual([])
    expect(stoppedTracker.queuedEvents()).toEqual([])
    expect(sharedSnapshot(stopped.values)).toEqual(before)

    const unrelated = webPage(`/elsewhere?product=2&${stop}`, active.values)
    const unrelatedTracker = await boot(unrelated, { ...embeddedOptions, appId: 'different-app' })
    expect(unrelatedTracker.track('unrelated_offer')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(unrelated.sent.map(event => event.eventType)).toEqual(['VISIT', 'PAGE', 'CUSTOM'])
    for (const event of unrelated.sent) expect(event).toMatchObject({ platform: 'web', domain: 'web.example.com', dataSourceId: 'web-source', query: 'product=2' })
  })

  it('retains the newer host session when the first WebView upload settles late', async () => {
    const mini = await miniSender()
    const options = { appId: mini.appId, embeddedAdapter: {} }
    const first = webPage(`/offers?${mini.tracker.getGioInfo()!}`)
    let finishFirstUpload!: (response: Response) => void
    const firstUpload = new Promise<Response>(resolve => { finishFirstUpload = resolve })
    vi.spyOn(first.browser, 'fetch').mockReturnValue(firstUpload)
    const firstTracker = await boot(first, options)
    const oldSession = firstTracker.queuedEvents()[0]?.sessionId
    expect(oldSession).toBeTruthy()

    expect(mini.tracker.setUserId('next-user', 'next-key')).toBe(true)
    const latestQuery = mini.tracker.getGioInfo()!
    const latestSession = new URLSearchParams(latestQuery).get('gios')
    expect(latestSession).toBeTruthy()
    expect(latestSession).not.toBe(oldSession)
    const second = webPage(`/offers?${latestQuery}`, first.values)
    await boot(second, options)
    await vi.advanceTimersByTimeAsync(1)
    expect(second.sent[0]).toMatchObject({ sessionId: latestSession, userId: 'next-user' })
    const storedSession = second.values.get('account_gdp_session_id')!
    const storedFirstVisit = second.values.get('gdp_embedded_new_device')!
    expect(JSON.parse(storedSession).value).toBe(latestSession)
    expect(JSON.parse(storedFirstVisit).value).toMatchObject({ sessionId: latestSession, newDevice: false })

    vi.setSystemTime(Date.now() + 100)
    finishFirstUpload(new Response(null, { status: 204 }))
    await vi.advanceTimersByTimeAsync(1)
    expect(firstTracker.queuedEvents()).toEqual([])
    expect(second.values.get('account_gdp_session_id')).toBe(storedSession)
    expect(second.values.get('gdp_embedded_new_device')).toBe(storedFirstVisit)
  })

  it.each([
    { strict: false, logout: false, userId: undefined, userKey: undefined },
    { strict: true, logout: false, userId: 'web-user', userKey: 'web-key' },
    { strict: true, logout: true, userId: undefined, userKey: undefined },
  ])('distinguishes omitted login fields from host logout (strict=$strict, logout=$logout)', async ({ strict, logout, userId, userKey }) => {
    const ordinary = webPage('/ordinary')
    const own = await boot(ordinary, { idMapping: true })
    expect(own.setUserId('web-user', 'web-key')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    const before = sharedSnapshot(ordinary.values)
    const mini = await miniSender()
    const host = new URLSearchParams(mini.tracker.getGioInfo()!)
    for (const field of ['giocs1', 'giouserkey']) {
      if (logout) host.set(field, '')
      else host.delete(field)
    }
    const page = webPage(`/offers?${host}`, ordinary.values, 'miniProgram')
    const tracker = await boot(page, { appId: mini.appId, idMapping: true, embeddedAdapter: { strict } })
    expect(tracker.track('host_login_state')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(page.sent.map(event => event.eventType)).toEqual(['PAGE', 'CUSTOM'])
    for (const event of page.sent) {
      expect(event).toMatchObject({ deviceId: 'fixture-device', dataSourceId: 'source' })
      expect(event.userId).toBe(userId)
      expect(event.userKey).toBe(userKey)
    }
    if (strict) expect(sharedSnapshot(page.values)).toEqual(before)
  })
})
