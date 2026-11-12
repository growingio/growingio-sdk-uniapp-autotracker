import { describe, expect, it } from 'vitest'
import { canRoundTripWebIdentity, createWebLocalStorage, createWebStorage, webStoragePrefix } from '../../src/platform/webStorage.js'

const DEVICE_KEY = 'gdp_user_id'
const USER_KEY = 'project_gdp_cs1'
const DAY = 86_400_000
const NOW = new Date(2026, 10, 12, 14, 20, 30, 123).getTime()
const END = 1_794_571_200_123
const DEVICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DEVICE_CIPHER = 'gioenc-aaaaaaaa,cccc,5bbb,9eee,dddddddddddd'
// Captured with the CookieStorage and LocalStorage writers at Web SDK tag 4.4.2.
const COOKIE_DEVICE = 'gioenc-aaaaaaaa%2Ccccc%2C5bbb%2C9eee%2Cdddddddddddd'
const USER = "A@a`Z[z{ 手机🤖 0123 %;?=()!&:#$+/'"
const COOKIE_USER = "gioenc-A@a`Z[z{!%E6%89%8A%E6%9C%BB%F0%9F%B4%97!1032!$:><)(%20'%3B%22%25*.&"
const LOCAL_USER = "gioenc-A@a`Z[z{!扊朻🴗!1032!$:><)( ';\"%*.&"

type Cookie = { name: string; value: string; domain: string; path: string; expiresAt: number }

function browserHost(options: { hostname?: string; protocol?: string; userAgent?: string; domains?: string[]; pathname?: string } = {}) {
  const hostname = options.hostname ?? 'shop.example.test'
  const pathname = options.pathname ?? '/'
  const controls = { now: NOW, cookieBlocked: false, cookieDenied: false, localDenied: false, localWrite: 'accept', localRemove: true }
  const cookies: Cookie[] = []
  const cookieWrites: string[] = []
  const local = new Map<string, string>()
  const domainMatches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`)
  const document = {
    get cookie() {
      if (controls.cookieDenied) throw new DOMException('denied', 'SecurityError')
      return cookies
        .filter(cookie => domainMatches(cookie.domain) && cookie.expiresAt > controls.now
          && (cookie.path === '/' || pathname === cookie.path || pathname.startsWith(`${cookie.path}/`)))
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ')
    },
    set cookie(value: string) {
      if (controls.cookieDenied) throw new DOMException('denied', 'SecurityError')
      cookieWrites.push(value)
      if (controls.cookieBlocked) return
      const [pair = '', ...attributes] = value.split('; ')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator)
      const attrs = new Map(attributes.map(attribute => {
        const index = attribute.indexOf('=')
        return [attribute.slice(0, index).toLowerCase(), attribute.slice(index + 1)]
      }))
      const domain = (attrs.get('domain') ?? hostname).replace(/^\./, '').toLowerCase()
      if (!domainMatches(domain) || (options.domains !== undefined && !options.domains.includes(domain))) return
      const path = attrs.get('path') ?? '/'
      const expiresAt = attrs.has('expires') ? Date.parse(attrs.get('expires')!) : Infinity
      const index = cookies.findIndex(cookie => cookie.name === name && cookie.domain === domain && cookie.path === path)
      if (index >= 0) cookies.splice(index, 1)
      if (expiresAt > controls.now) cookies.push({ name, value: pair.slice(separator + 1), domain, path, expiresAt })
    },
  }
  const localStorage = {
    getItem: (key: string) => local.get(key) ?? null,
    setItem(key: string, value: string) {
      if (controls.localWrite === 'quota') throw new DOMException('full', 'QuotaExceededError')
      if (controls.localWrite === 'accept') local.set(key, value)
    },
    removeItem(key: string) {
      if (controls.localRemove) local.delete(key)
    },
  }
  const browser = {
    document,
    location: { hostname, pathname, protocol: options.protocol ?? 'https:' },
    navigator: { userAgent: options.userAgent ?? 'Browser' },
    get localStorage() {
      if (controls.localDenied) throw new DOMException('denied', 'SecurityError')
      return localStorage
    },
  } as unknown as Window
  return { browser, controls, cookies, cookieWrites, local, now: () => controls.now }
}

describe('Web 4.4.2 storage', () => {
  it('uses the project ID for main keys and the positive 32-bit hash for child keys', () => {
    expect(webStoragePrefix('project', 'data-source')).toBe('project')
    expect(webStoragePrefix('project', 'data-source', true)).toBe('532859621')
  })

  it('round-trips the current Cookie writer output with its punctuation, Unicode and scope', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.kind).toBe('cookie')
    expect(store.domain).toBe('example.test')
    expect(host.cookies).toEqual([])
    host.cookies.push({ name: DEVICE_KEY, value: COOKIE_DEVICE, domain: 'example.test', path: '/', expiresAt: END })
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'value', value: DEVICE })
    const writes = host.cookieWrites.length
    expect(store.write(USER_KEY, USER, { identity: true, expiresAt: END })).toEqual({ kind: 'ok' })
    expect(host.cookieWrites[writes]).toBe(`${USER_KEY}=${COOKIE_USER}; path=/; expires=Fri, 13 Nov 2026 12:00:00 GMT; domain=.example.test`)
    expect(store.read(USER_KEY, true)).toEqual({ kind: 'value', value: USER })
  })

  it('preserves the empty identity value used on logout and defaults to midnight plus 400 days', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.write(USER_KEY, '', { identity: true })).toEqual({ kind: 'ok' })
    expect(host.cookies).toEqual([{
      name: USER_KEY, value: '', domain: 'example.test', path: '/',
      expiresAt: new Date(2026, 10, 12).getTime() + 400 * DAY,
    }])
    expect(store.read(USER_KEY, true)).toEqual({ kind: 'value', value: '' })
  })

  it('reads the current LocalStorage writer output without renewing it', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, { storageType: 'localstorage' }, host.now)
    host.local.set(DEVICE_KEY, `{"value":"${DEVICE_CIPHER}","expiredAt":${END}}`)
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'value', value: DEVICE })
    expect(host.local.get(DEVICE_KEY)).toBe(`{"value":"${DEVICE_CIPHER}","expiredAt":${END}}`)
    expect(store.write(USER_KEY, USER, { identity: true, expiresAt: END })).toEqual({ kind: 'ok' })
    expect(JSON.parse(host.local.get(USER_KEY)!)).toEqual({ value: LOCAL_USER, expiredAt: END })
    expect(store.read(USER_KEY, true)).toEqual({ kind: 'value', value: USER })
    expect(host.cookieWrites).toEqual([])
  })

  it('stores empty login state and uses the Web calendar default for LocalStorage expiry', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, { storageType: 'localstorage' }, host.now)
    expect(store.write(USER_KEY, '', { identity: true })).toEqual({ kind: 'ok' })
    const expiredAt = new Date(2029, 10, 4).getTime()
    expect(host.local.get(USER_KEY)).toBe(`{"value":"","expiredAt":${expiredAt}}`)
    expect(store.read(USER_KEY, true)).toEqual({ kind: 'value', value: '' })
    host.controls.now = expiredAt
    expect(store.read(USER_KEY, true)).toEqual({ kind: 'missing' })
    expect(host.local.has(USER_KEY)).toBe(true)
  })

  it.each(['cookie', 'localstorage'] as const)('preserves numeric and falsy JSON strings in %s', storageType => {
    const host = browserHost()
    const store = createWebStorage(host.browser, { storageType }, host.now)
    for (const value of ['0123', 'false', 'null', '""']) {
      expect(store.write(USER_KEY, value, { identity: true })).toEqual({ kind: 'ok' })
      expect(store.read(USER_KEY, true)).toEqual({ kind: 'value', value })
    }
  })

  it.each(['cookie', 'localstorage'] as const)('round-trips current w2-prefixed identities in %s', storageType => {
    const host = browserHost()
    const store = createWebStorage(host.browser, { storageType }, host.now)
    for (const value of ['w2,', 'w2,test']) {
      expect(store.write(USER_KEY, value, { identity: true })).toEqual({ kind: 'ok' })
      expect(store.read(USER_KEY, true)).toEqual({ kind: 'value', value })
      const cipher = value === 'w2,' ? 'gioenc-v3-' : 'gioenc-v3-udru'
      if (storageType === 'localstorage') expect(JSON.parse(host.local.get(USER_KEY)!).value).toBe(cipher)
      else expect(host.cookies.find(cookie => cookie.name === USER_KEY)?.value).toBe(cipher)
    }
  })

  it.each(['cookie', 'localstorage'] as const)('keeps valid identities when the Web reader would change a %s value', storageType => {
    const host = browserHost()
    const store = createWebStorage(host.browser, { storageType }, host.now)
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'ok' })
    for (const value of ['true', '{"id":1}', '"name"', 'w3,test', '`aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']) {
      expect(store.write(DEVICE_KEY, value, { identity: true })).toMatchObject({ kind: 'failed' })
      expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'value', value: DEVICE })
    }
  })

  it('does not replace an existing cookie when the new identity cannot be URI-encoded', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'ok' })
    expect(store.write(DEVICE_KEY, '\uD800', { identity: true })).toMatchObject({ kind: 'failed' })
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'value', value: DEVICE })
  })

  it('checks input compatibility for the physical key and storage medium before writes', () => {
    const backtickUuid = '`aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    expect(canRoundTripWebIdentity(DEVICE_KEY, backtickUuid, 'cookie')).toBe(false)
    expect(canRoundTripWebIdentity(USER_KEY, backtickUuid, 'cookie')).toBe(true)
    expect(canRoundTripWebIdentity(USER_KEY, '\uD800', 'cookie')).toBe(false)
    expect(canRoundTripWebIdentity(USER_KEY, '\uD800', 'localstorage')).toBe(true)
    expect(canRoundTripWebIdentity(USER_KEY, USER, 'cookie')).toBe(true)
  })

  it.each(['gioenc-v2-udru', 'unencoded', 'gioenc-', 'gioenc-ustd'])(
    'reports an incompatible identity without replacing %s',
    value => {
      const host = browserHost()
      const store = createWebStorage(host.browser, { storageType: 'localstorage' }, host.now)
      const record = JSON.stringify({ value, expiredAt: END })
      host.local.set(DEVICE_KEY, record)
      expect(store.read(DEVICE_KEY, true)).toMatchObject({ kind: 'corrupt' })
      expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toMatchObject({ kind: 'failed' })
      expect(host.local.get(DEVICE_KEY)).toBe(record)
    },
  )

  it('reports malformed Cookie encoding as corruption', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    host.cookies.push({ name: DEVICE_KEY, value: 'gioenc-%E0%A4', domain: 'example.test', path: '/', expiresAt: END })
    expect(store.read(DEVICE_KEY, true)).toMatchObject({ kind: 'corrupt' })
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toMatchObject({ kind: 'failed' })
    expect(host.cookies[0]?.value).toBe('gioenc-%E0%A4')
  })

  it('detects all visible copies and does not delete or change either Cookie scope', () => {
    const host = browserHost({ pathname: '/checkout' })
    const shared = { name: DEVICE_KEY, value: COOKIE_DEVICE, domain: 'example.test', path: '/', expiresAt: END }
    const scoped = { ...shared, name: 'gdp_user%5Fid', domain: 'shop.example.test', path: '/checkout' }
    host.cookies.push(shared, scoped)
    const store = createWebStorage(host.browser, { cookieDomain: '.shop.example.test' }, host.now)
    expect(store.domain).toBe('shop.example.test')
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'corrupt', message: 'web_cookie_conflict' })
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'failed', message: 'web_cookie_conflict' })
    expect(store.remove(DEVICE_KEY)).toEqual({ kind: 'failed', message: 'web_cookie_conflict' })
    expect(host.cookies).toEqual([shared, scoped])
  })

  it('tries the Web domain candidates and keeps the probed default for an unrelated configured domain', () => {
    const host = browserHost({ hostname: 'a.shop.example.co.uk', domains: ['example.co.uk', 'shop.example.co.uk', 'a.shop.example.co.uk'] })
    expect(createWebStorage(host.browser, { cookieDomain: '.Shop.Example.CO.UK' }, host.now).domain).toBe('shop.example.co.uk')
    expect(createWebStorage(host.browser, { cookieDomain: 'b.shop.example.co.uk' }, host.now).domain).toBe('example.co.uk')
    expect(createWebStorage(host.browser, { cookieDomain: 'unrelated.test' }, host.now).domain).toBe('example.co.uk')
    expect(host.cookies).toEqual([])
    expect(host.cookieWrites.some(write => /domain=\.co\.uk$/i.test(write))).toBe(false)
  })

  it('uses the full hostname when the parent Cookie domain is denied', () => {
    const host = browserHost({ domains: ['shop.example.test'] })
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.domain).toBe('shop.example.test')
  })

  it.each([
    { hostname: 'localhost' },
    { hostname: '127.0.0.1' },
    { protocol: 'file:' },
    { userAgent: 'Chromium Electron/40' },
  ])('skips Cookie probing in Web local and Electron environments (%j)', options => {
    const host = browserHost(options)
    expect(createWebStorage(host.browser, {}, host.now).kind).toBe('localstorage')
    expect(host.cookieWrites).toEqual([])
  })

  it('falls back to local storage when Cookies are blocked without reading another medium', () => {
    const host = browserHost()
    host.controls.cookieBlocked = true
    host.cookies.push({ name: DEVICE_KEY, value: COOKIE_DEVICE, domain: 'example.test', path: '/', expiresAt: END })
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.kind).toBe('localstorage')
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'missing' })
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'ok' })
    expect(host.local.has(DEVICE_KEY)).toBe(true)
  })

  it('shares memory fallback only within the same page when both persistent stores fail', () => {
    const host = browserHost()
    host.controls.cookieDenied = true
    host.controls.localDenied = true
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.kind).toBe('memory')
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'ok' })
    expect(createWebStorage(host.browser, {}, host.now).read(DEVICE_KEY, true)).toEqual({ kind: 'value', value: DEVICE })
    const other = browserHost()
    other.controls.localDenied = true
    expect(createWebStorage(other.browser, { storageType: 'localstorage' }, other.now).read(DEVICE_KEY, true)).toEqual({ kind: 'missing' })
  })

  it('detects a Cookie write or removal ignored by the browser', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'ok' })
    host.controls.cookieBlocked = true
    expect(store.write(DEVICE_KEY, 'new-device', { identity: true })).toMatchObject({ kind: 'failed' })
    expect(store.remove(DEVICE_KEY)).toMatchObject({ kind: 'failed' })
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'value', value: DEVICE })
  })

  it('can remove a valid identity within its selected Cookie scope', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'ok' })
    expect(store.remove(DEVICE_KEY)).toEqual({ kind: 'ok' })
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'missing' })
  })

  it('keeps the selected medium when access to it later fails', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    host.local.set(DEVICE_KEY, `{"value":"${DEVICE_CIPHER}","expiredAt":${END}}`)
    host.controls.cookieDenied = true
    expect(store.read(DEVICE_KEY, true)).toMatchObject({ kind: 'unavailable' })
    expect(store.write(DEVICE_KEY, 'new-device', { identity: true })).toMatchObject({ kind: 'unavailable' })
    expect(host.local.get(DEVICE_KEY)).toBe(`{"value":"${DEVICE_CIPHER}","expiredAt":${END}}`)
  })

  it('checks expiration before writing a Cookie session and removes only the named key', () => {
    const host = browserHost()
    const store = createWebStorage(host.browser, {}, host.now)
    const session = 'project_gdp_session_id'
    expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toEqual({ kind: 'ok' })
    expect(store.write(session, 'session-1', { expiresAt: END })).toEqual({ kind: 'ok' })
    expect(store.write(session, 'session-2', { expiresAt: NOW + 100 })).toMatchObject({ kind: 'failed' })
    expect(store.read(session)).toEqual({ kind: 'value', value: 'session-1' })
    expect(store.remove(session)).toEqual({ kind: 'ok' })
    expect(store.read(session)).toEqual({ kind: 'missing' })
    expect(store.read(DEVICE_KEY, true)).toEqual({ kind: 'value', value: DEVICE })
  })

  it('uses a LocalStorage object envelope for WebView records without a memory fallback', () => {
    const host = browserHost()
    host.controls.localDenied = true
    const store = createWebLocalStorage(host.browser, host.now)
    const key = 'gdp_query_string'
    const value = { gioappid: 'host', giodatacollect: 'false' }
    expect(store.read(key)).toMatchObject({ kind: 'unavailable' })
    expect(store.write(key, value)).toMatchObject({ kind: 'unavailable' })
    expect(store.remove(key)).toMatchObject({ kind: 'unavailable' })
    host.controls.localDenied = false
    expect(store.remove(key)).toEqual({ kind: 'ok' })
    expect(store.write(key, value, { expiresAt: END })).toEqual({ kind: 'ok' })
    expect(host.local.get(key)).toBe(`{"value":{"gioappid":"host","giodatacollect":"false"},"expiredAt":${END}}`)
    expect(store.read(key)).toEqual({ kind: 'value', value })
  })

  it('detects ignored LocalStorage writes, removals, and quota failures', () => {
    const host = browserHost()
    const store = createWebLocalStorage(host.browser, host.now)
    expect(store.write('gdp_query_string', { gioappid: 'host' })).toEqual({ kind: 'ok' })
    host.controls.localWrite = 'drop'
    expect(store.write('gdp_query_string', { gioappid: 'other' })).toMatchObject({ kind: 'failed' })
    host.controls.localWrite = 'quota'
    expect(store.write('gdp_query_string', { gioappid: 'other' })).toMatchObject({ kind: 'quota' })
    host.controls.localRemove = false
    expect(store.remove('gdp_query_string')).toMatchObject({ kind: 'failed' })
    expect(store.read('gdp_query_string')).toEqual({ kind: 'value', value: { gioappid: 'host' } })
  })

  it.each(['{', 'null', '{"value":"gioenc-a"}', '{"value":"gioenc-a","expiredAt":"9999999999999"}'])(
    'does not replace a malformed identity envelope %s',
    envelope => {
      const host = browserHost()
      const store = createWebLocalStorage(host.browser, host.now)
      host.local.set(DEVICE_KEY, envelope)
      expect(store.read(DEVICE_KEY, true)).toMatchObject({ kind: 'corrupt' })
      expect(store.write(DEVICE_KEY, DEVICE, { identity: true })).toMatchObject({ kind: 'failed' })
      expect(host.local.get(DEVICE_KEY)).toBe(envelope)
    },
  )
})
