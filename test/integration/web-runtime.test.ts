import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWebLifecycle, webEntrySnapshot } from '../../src/adapters/web.js'
import { installUniAppLifecycle } from '../../src/adapters/uniapp.js'
import { createWebTracker } from '../../src/platform/web.js'
import { createWebStorage } from '../../src/platform/webStorage.js'

const config = { accountId: 'account', dataSourceId: 'source', storageType: 'localstorage', idMapping: true } as const
const identityKeys = ['gdp_user_id', 'account_gdp_cs1', 'account_gdp_user_key', 'account_gdp_gio_id']
const sessionKeys = ['account_gdp_session_id', 'account_gdp_session_id_sent']
const factories = { sdkVersion: 'test', deviceIdFactory: () => 'own-device', sessionIdFactory: () => 'own-session' }
const hostFields = {
  gioappid: 'host-app', gioprojectid: 'account', giodatasourceid: 'host-source',
  giou: 'host-device', giocs1: 'host-user', giouserkey: 'host-key', gios: 'host-session',
  giodatacollect: 'true', gioplatform: 'MinP',
}

function webHost(values = new Map<string, string>(), query = '') {
  const location = new URL(`https://web.example.com/offers${query}`)
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const document = Object.assign(new EventTarget(), { title: 'Offers', referrer: '', hidden: false })
  const browser = Object.assign(new EventTarget(), {
    location, document, localStorage,
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, path: string) { location.href = new URL(path, location).href },
    },
    navigator: { userAgent: 'Browser', language: 'en', onLine: true },
    screen: { width: 1000, height: 800 }, innerWidth: 1000, innerHeight: 800,
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(handle),
    fetch: () => new Promise<Response>(() => undefined),
  }) as unknown as Window
  return { browser, values }
}

function initialize(host: ReturnType<typeof webHost>, extra: Readonly<Record<string, unknown>> = {}) {
  const tracker = createWebTracker(host.browser, factories)
  expect(tracker.init({ ...config, ...extra })).toBe(true)
  installWebLifecycle(host.browser, tracker)
  return tracker
}

async function settlePersistence() {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

function initializeVue(host: ReturnType<typeof webHost>) {
  type Hook = (this: Record<string, unknown>, options?: unknown) => void
  let hooks!: Record<string, Hook>
  let readPageTitle: (() => string | null) | undefined
  const tracker = createWebTracker(host.browser, factories, () => readPageTitle?.() ?? null)
  tracker.init(config)
  readPageTitle = installUniAppLifecycle({ mixin: options => { hooks = options as Record<string, Hook> } }, tracker, {
    web: { entry: () => webEntrySnapshot(host.browser), title: () => host.browser.document.title },
  })
  const app = { $mpType: 'app' }
  hooks.onLaunch!.call(app)
  hooks.onShow!.call(app)
  return { tracker, hooks }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('ordinary H5 runtime', () => {
  it('keeps uni-app H5 entry and title callbacks working through the public command entry', async () => {
    vi.resetModules()
    const host = webHost()
    vi.stubGlobal('window', host.browser)
    vi.stubGlobal('uni', { getSystemInfoSync: () => ({ uniPlatform: 'h5' }) })
    try {
      const { default: gdp } = await import('../../index.js')
      let tracker!: import('../../index.js').GioPluginRuntime
      let hooks!: Record<string, (this: Record<string, unknown>, options?: unknown) => void>
      gdp('registerPlugins', [{ name: 'web-compatibility', install: value => { tracker = value } }])
      expect(gdp('init', 'account', 'source', { uniVue: { mixin: value => { hooks = value as typeof hooks } }, storageType: 'localstorage' })).toBe(true)
      const app = { $mpType: 'app' }, page = { $mpType: 'page', $page: { route: 'offers' } }
      hooks.onLaunch!.call(app)
      hooks.onShow!.call(app)
      hooks.onLoad!.call(page)
      hooks.onShow!.call(page)
      expect(await tracker.whenReady()).toBe(true)
      expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
      expect(tracker.queuedEvents()[1]).toMatchObject({ platform: 'web', path: '/offers', title: 'Offers' })
      host.browser.document.title = 'Updated offers'
      expect(gdp('track', 'public_web_event')).toBe(true)
      expect(tracker.queuedEvents().at(-1)).toMatchObject({ eventName: 'public_web_event', path: '/offers', title: 'Updated offers' })
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps malformed business query keys and an external referrer query in the page snapshot', () => {
    const host = webHost(new Map(), '?%broken=1&campaign=first')
    host.browser.location.hash = '#/details?sku=2'
    Object.defineProperty(host.browser.document, 'referrer', { value: 'https://external.example/inbound?utm_source=outside' })
    expect(webEntrySnapshot(host.browser, true)).toEqual({ path: '/details', query: '%broken=1&campaign=first&sku=2', referralPage: 'https://external.example/inbound?utm_source=outside' })
  })

  it('deduplicates unchanged navigation and restores a page from the browser back-forward cache', async () => {
    const host = webHost()
    const tracker = initialize(host)
    expect(await tracker.whenReady()).toBe(true)
    const sessionId = tracker.queuedEvents()[0]!.sessionId
    host.browser.dispatchEvent(new Event('hashchange'))
    host.browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }))
    expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
    host.browser.dispatchEvent(new Event('pagehide'))
    host.browser.document.title = 'Restored offers'
    host.browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'PAGE', 'PAGE'])
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ sessionId, path: '/offers', title: 'Restored offers' })
  })

  it('recovers queued H5 events on online notification and preserves ignored user-key and debug behavior', async () => {
    const host = webHost()
    Object.assign(host.browser.navigator, { onLine: false })
    const uploaded: Array<Record<string, unknown>> = []
    vi.spyOn(host.browser, 'fetch').mockImplementation(async (_url, options) => {
      uploaded.push(...JSON.parse(options!.body as string))
      return new Response(null, { status: 204 })
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tracker = initialize(host, { idMapping: false, debug: true })
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.track('while_offline')).toBe(true)
    expect(uploaded).toEqual([])
    Object.assign(host.browser.navigator, { onLine: true })
    host.browser.dispatchEvent(new Event('online'))
    await settlePersistence()
    expect(uploaded.map(event => event.eventType)).toEqual(['VISIT', 'PAGE', 'CUSTOM'])
    expect(tracker.queuedEvents()).toEqual([])
    expect(tracker.setUserId('debug-user', 'ignored-key')).toBe(true)
    expect(tracker.track('after_online')).toBe(true)
    expect(uploaded.at(-1)).toMatchObject({ eventType: 'CUSTOM', eventName: 'after_online', userId: 'debug-user' })
    expect(uploaded.at(-1)).not.toHaveProperty('userKey')
  })

  it('uses the previous H5 page as referral after an external landing in the browser lifecycle', async () => {
    const host = webHost()
    Object.defineProperty(host.browser.document, 'referrer', { value: 'https://external.example/inbound' })
    const tracker = initialize(host)
    await tracker.whenReady()
    host.browser.location.hash = '#/details'
    host.browser.dispatchEvent(new Event('hashchange'))
    const pages = tracker.queuedEvents().filter(event => event.eventType === 'PAGE')
    expect(pages[0]).toMatchObject({ path: '/offers', referralPage: 'https://external.example/inbound' })
    expect(pages[1]).toMatchObject({ path: '/details', referralPage: '/offers' })
  })

  it('uses the previous H5 page as referral after an external landing in the Vue lifecycle', async () => {
    const host = webHost()
    Object.defineProperty(host.browser.document, 'referrer', { value: 'https://external.example/inbound' })
    const { tracker, hooks } = initializeVue(host)
    const first = { $mpType: 'page', $page: { route: 'offers' } }
    hooks.onLoad!.call(first)
    hooks.onShow!.call(first)
    await tracker.whenReady()
    hooks.onHide!.call(first)
    host.browser.location.pathname = '/details'
    const second = { $mpType: 'page', $page: { route: 'details' } }
    hooks.onLoad!.call(second)
    hooks.onShow!.call(second)
    const pages = tracker.queuedEvents().filter(event => event.eventType === 'PAGE')
    expect(pages[0]).toMatchObject({ path: '/offers', referralPage: 'https://external.example/inbound' })
    expect(pages[1]).toMatchObject({ path: '/details', referralPage: '/offers' })
  })

  it('preserves the active page gioPageTitle when the document title changes', async () => {
    const host = webHost()
    const { tracker, hooks } = initializeVue(host)
    const page = { $mpType: 'page', $page: { route: 'offers' }, gioPageTitle: 'Analytics offers' }
    hooks.onLoad!.call(page)
    hooks.onShow!.call(page)
    await tracker.whenReady()
    host.browser.document.title = 'Updated UI title'
    expect(tracker.track('explicit_title')).toBe(true)
    expect(tracker.queuedEvents().at(-1)?.title).toBe('Analytics offers')
    page.gioPageTitle = 'Updated analytics title'
    expect(tracker.track('changed_explicit_title')).toBe(true)
    expect(tracker.queuedEvents().at(-1)?.title).toBe('Updated analytics title')
  })

  it.each(['-', 'null', 'undefined', ' '])('restores the target Web SDK device value %j', async deviceId => {
    const host = webHost()
    const storage = createWebStorage(host.browser, { storageType: 'localstorage' })
    expect(storage.write('gdp_user_id', deviceId, { identity: true })).toEqual({ kind: 'ok' })
    const tracker = initialize(host)
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.queuedEvents()[0]).toMatchObject({ deviceId })
  })

  it('continues its own event sequence after reloading with the same local storage', async () => {
    const first = webHost()
    const tracker = initialize(first)
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.track('before_reload')).toBe(true)
    const last = tracker.queuedEvents().at(-1)!.eventSequenceId as number
    await settlePersistence()

    const next = initialize(webHost(first.values))
    expect(await next.whenReady()).toBe(true)
    expect(next.queuedEvents()[0]?.eventSequenceId).toBe(last + 1)
    expect(next.track('after_reload')).toBe(true)
    expect(next.queuedEvents().at(-1)?.eventSequenceId).toBe(last + 3)
  })

  it('uses a changed document title for consecutive custom events on the current page', async () => {
    const host = webHost()
    const tracker = initialize(host)
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.queuedEvents().find(event => event.eventType === 'PAGE')?.title).toBe('Offers')
    host.browser.document.title = 'Updated offers'
    expect(tracker.track('first_title')).toBe(true)
    expect(tracker.track('second_title')).toBe(true)
    expect(tracker.queuedEvents().filter(event => event.eventType === 'CUSTOM').map(event => event.title))
      .toEqual(['Updated offers', 'Updated offers'])
  })

  it('restores an existing device and login without generating or rewriting shared identity', async () => {
    const host = webHost()
    const first = initialize(host)
    expect(await first.whenReady()).toBe(true)
    expect(first.setUserId('own-user', 'own-key')).toBe(true)
    const write = vi.spyOn(host.browser.localStorage, 'setItem')
    const factory = vi.fn(() => 'incorrect-new-device')
    const next = createWebTracker(host.browser, { ...factories, deviceIdFactory: factory })
    expect(next.init(config)).toBe(true)
    installWebLifecycle(host.browser, next)
    expect(await next.whenReady()).toBe(true)
    expect(factory).not.toHaveBeenCalled()
    expect(write.mock.calls.filter(([key]) => identityKeys.includes(key))).toEqual([])
    expect(next.queuedEvents()[0]).toMatchObject({ deviceId: 'own-device', userId: 'own-user', userKey: 'own-key' })
  })

  it('restores a partially failed login write and permits a complete retry before collecting again', async () => {
    const host = webHost()
    const tracker = initialize(host)
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.setUserId('old-user', 'old-key')).toBe(true)
    const before = identityKeys.map(key => [key, host.values.get(key)])
    const setter = host.browser.localStorage.setItem
    let rejectNextKey = true
    vi.spyOn(host.browser.localStorage, 'setItem').mockImplementation((key, value) => {
      if (rejectNextKey && key === 'account_gdp_user_key') {
        rejectNextKey = false
        throw new DOMException('full', 'QuotaExceededError')
      }
      setter(key, value)
    })

    expect(tracker.setUserId('new-user', 'new-key')).toBe(false)
    expect(identityKeys.map(key => [key, host.values.get(key)])).toEqual(before)
    expect(tracker.track('while_failed')).toBe(false)
    expect(tracker.setUserId('new-user', 'new-key')).toBe(true)
    expect(tracker.track('after_retry')).toBe(true)
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ userId: 'new-user', userKey: 'new-key' })
  })

  it('keeps the latest shared identity when an older VISIT request succeeds', async () => {
    const host = webHost()
    let finish!: (response: Response) => void
    vi.spyOn(host.browser, 'fetch').mockReturnValue(new Promise<Response>(resolve => { finish = resolve }))
    const tracker = initialize(host)
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.setUserId('new-user', 'new-key')).toBe(true)
    const latest = identityKeys.map(key => [key, host.values.get(key)])
    vi.setSystemTime(Date.now() + 86_400_000)
    finish(new Response(null, { status: 204 }))
    await settlePersistence()
    expect(identityKeys.map(key => [key, host.values.get(key)])).toEqual(latest)
  })

  it.each([
    { field: 'giou', value: 'd'.repeat(1001) },
    { field: 'giocs1', value: 'u'.repeat(1001) },
    { field: 'giouserkey', value: 'k'.repeat(1001) },
  ])('rejects the invalid host $field before changing shared identity keys', async ({ field, value }) => {
    const ordinary = webHost()
    const initial = initialize(ordinary)
    expect(await initial.whenReady()).toBe(true)
    expect(initial.setUserId('own-user', 'own-key')).toBe(true)
    const before = identityKeys.map(key => [key, ordinary.values.get(key)])

    const query = new URLSearchParams({ ...hostFields, [field]: value })
    const embedded = initialize(webHost(ordinary.values, `?${query}`), { appId: 'host-app', embeddedAdapter: {} })
    expect(await embedded.whenReady()).toBe(false)
    expect(identityKeys.map(key => [key, ordinary.values.get(key)])).toEqual(before)
    expect(embedded.queuedEvents()).toEqual([])

    const recovered = initialize(webHost(ordinary.values))
    expect(await recovered.whenReady()).toBe(true)
    expect(recovered.queuedEvents()[0]).toMatchObject({ deviceId: 'own-device', userId: 'own-user', userKey: 'own-key' })
  })

  it.each(['corrupt query cache', 'different cached host owner', 'corrupt shared session'])(
    'keeps shared identity and session together when non-strict startup encounters %s',
    async fault => {
      const ordinary = webHost()
      const initial = initialize(ordinary)
      expect(await initial.whenReady()).toBe(true)
      expect(initial.setUserId('own-user', 'own-key')).toBe(true)
      for (const key of sessionKeys) {
        ordinary.values.set(key, JSON.stringify({ value: 'own-session', expiredAt: Date.now() + 1_800_000 }))
      }
      if (fault === 'corrupt query cache') ordinary.values.set('gdp_query_string', '{malformed')
      if (fault === 'corrupt shared session') ordinary.values.set('account_gdp_session_id', '{malformed')
      if (fault === 'different cached host owner') {
        ordinary.values.set('gdp_query_string', JSON.stringify({
          value: { ...hostFields, giou: 'previous-device', gios: 'previous-session', giodatacollect: true },
          expiredAt: Date.now() + 1_800_000,
        }))
      }
      const sharedKeys = [...identityKeys, ...sessionKeys]
      const before = sharedKeys.map(key => [key, ordinary.values.get(key)])
      const page = webHost(ordinary.values, `?${new URLSearchParams(hostFields)}`)
      if (fault === 'different cached host owner') {
        const setter = page.browser.localStorage.setItem
        vi.spyOn(page.browser.localStorage, 'setItem').mockImplementation((key, value) => {
          if (key === 'gdp_query_string') throw new DOMException('full', 'QuotaExceededError')
          setter(key, value)
        })
      }
      const embedded = initialize(page, { appId: 'host-app', embeddedAdapter: {} })
      expect(await embedded.whenReady()).toBe(false)
      expect(sharedKeys.map(key => [key, ordinary.values.get(key)])).toEqual(before)
      expect(embedded.queuedEvents()).toEqual([])
    },
  )
})
