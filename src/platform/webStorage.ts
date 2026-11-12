import type { StorageWrite } from '../types/index.js'
import { guid } from '../utils/tools.js'

export type WebStorageRead =
  | Readonly<{ kind: 'value'; value: unknown }>
  | Readonly<{ kind: 'missing' | 'corrupt' | 'unavailable'; message?: string }>

export interface WebStorage {
  readonly kind: 'cookie' | 'localstorage' | 'memory'
  readonly domain?: string
  read(key: string, identity?: boolean): WebStorageRead
  write(key: string, value: string | Readonly<Record<string, unknown>>, options?: Readonly<{ identity?: boolean; expiresAt?: number }>): StorageWrite
  remove(key: string): StorageWrite
}

type WebStorageValue = string | Readonly<Record<string, unknown>>

interface BrowserStorage {
  readonly kind: WebStorage['kind']
  readonly domain?: string
  get(key: string): string | null
  set(key: string, value: string, expiresAt?: number): void
  remove(key: string): void
}

const DAY = 86_400_000
const CIPHER_PREFIX = 'gioenc-'
const WEB_DEVICE_KEY = 'gdp_user_id'
const WEB_DEVICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SPECIAL_TOP_DOMAIN = /^(\.ac\.|\.br\.|\.co\.|\.com\.|\.edu\.|\.gov\.|\.org\.|\.net\.)/
const COOKIE_CONFLICT = new Error('web_cookie_conflict')
const MEMORY = new WeakMap<Window, Map<string, string>>()

/** Web 4.4.2 的当前写入器对 UTF-16 码元执行可逆变换。 */
function transformIdentity(value: string): string {
  return value.split('').map(character =>
    'AaZz@{[`'.includes(character) ? character : String.fromCharCode(character.charCodeAt(0) ^ 1),
  ).join('')
}

function parseWebValue(value: unknown): unknown {
  if (typeof value !== 'string' || !Number.isNaN(Number(value))) return value
  try {
    return JSON.parse(value) || value
  } catch {
    return value
  }
}

function decodeIdentity(key: string, value: unknown): string | null {
  if (value === '') return ''
  if (typeof value !== 'string' || !value.startsWith(CIPHER_PREFIX) || value === CIPHER_PREFIX
    || value.startsWith('gioenc-v2-')) return null

  const plain = transformIdentity(value.slice(CIPHER_PREFIX.length))
  if (parseWebValue(plain) !== plain) return null
  // 4.4.2 的设备 UUID 修复会改变这种标识，不能作为当前格式无损互换。
  if (key === WEB_DEVICE_KEY && plain.includes('`') && WEB_DEVICE_UUID.test(plain.replace(/`/g, 'a'))) return null
  return plain
}

function encodeIdentity(key: string, value: string): string | null {
  const encoded = value === '' ? '' : `${CIPHER_PREFIX}${transformIdentity(value)}`
  return decodeIdentity(key, encoded) === value ? encoded : null
}

function encodeCookieValue(value: string): string {
  // 4.4.2 使用 js-cookie 3.0.5，以下字符保持原样。
  return encodeURIComponent(value).replace(/%(2[346BF]|3[AC-F]|40|5[BDE]|60|7[BCD])/g, decodeURIComponent)
}

function decodeCookieValue(value: string): string {
  return decodeURIComponent(value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value)
}

/** 在多键更新前检查值能否按所选介质和 Web 4.4.2 的读取规则原样恢复。 */
export function canRoundTripWebIdentity(key: string, value: string, medium: WebStorage['kind']): boolean {
  const encoded = encodeIdentity(key, value)
  if (encoded === null) return false
  if (medium !== 'cookie') return true
  try {
    return decodeCookieValue(encodeCookieValue(encoded)) === encoded
  } catch {
    return false
  }
}

function getCookie(browser: Window, key: string): string | null {
  let value: string | null = null
  for (const entry of browser.document.cookie.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 0) continue
    let name: string
    try {
      name = decodeURIComponent(entry.slice(0, separator).trimStart())
    } catch {
      continue
    }
    if (name !== key) continue
    if (value !== null) throw COOKIE_CONFLICT
    value = entry.slice(separator + 1)
  }
  return value
}

function cookieStorage(browser: Window, domain: string, now: () => number): BrowserStorage {
  const attribute = domain.split(';', 1)[0]!.trim()
  const set = (key: string, value: string, expiresAt?: number) => {
    const name = encodeURIComponent(key).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent)
      .replace(/[()]/g, character => character === '(' ? '%28' : '%29')
    const expiry = expiresAt === undefined ? '' : `; expires=${new Date(expiresAt).toUTCString()}`
    browser.document.cookie = `${name}=${value}; path=/${expiry}; domain=${attribute}`
  }
  return {
    kind: 'cookie',
    domain: attribute.replace(/^\./, '').toLowerCase(),
    get: key => getCookie(browser, key),
    set,
    remove: key => set(key, '', now() - DAY),
  }
}

function localStorage(browser: Window): BrowserStorage {
  return {
    kind: 'localstorage',
    get: key => browser.localStorage.getItem(key),
    set: (key, value) => browser.localStorage.setItem(key, value),
    remove: key => browser.localStorage.removeItem(key),
  }
}

function memoryStorage(browser: Window): BrowserStorage {
  let values = MEMORY.get(browser)
  if (values === undefined) {
    values = new Map()
    MEMORY.set(browser, values)
  }
  const pageValues = values
  return {
    kind: 'memory',
    get: key => pageValues.get(key) ?? null,
    set: (key, value) => { pageValues.set(key, value) },
    remove: key => { pageValues.delete(key) },
  }
}

function domainCandidates(hostname: string): string[] {
  const parts = hostname.split('.')
  const last = Number(parts[parts.length - 1])
  if (parts.length < 2 || (last >= 0 && last <= 255)) return []
  const domains = [2, 3, 4].map(length => `.${parts.slice(-length).join('.')}`)
  return [...new Set(domains.filter(domain => !SPECIAL_TOP_DOMAIN.test(domain)))]
}

function canWrite(storage: BrowserStorage): boolean {
  const key = `__gdp_storage_test_${guid()}`
  try {
    storage.set(key, 'yes')
    let written: boolean
    try {
      written = storage.get(key) === 'yes'
    } finally {
      storage.remove(key)
    }
    return written && storage.get(key) === null
  } catch {
    return false
  }
}

function findCookieStorage(browser: Window, domains: readonly string[], now: () => number): BrowserStorage | undefined {
  for (const domain of domains) {
    const storage = cookieStorage(browser, domain, now)
    if (storage.domain && canWrite(storage)) return storage
  }
  return undefined
}

function selectCookieStorage(browser: Window, configuredDomain: string | undefined, now: () => number): BrowserStorage | undefined {
  const { hostname, protocol } = browser.location
  if (['', 'localhost', '127.0.0.1'].includes(hostname) || !['http:', 'https:'].includes(protocol)
    || browser.navigator.userAgent.includes('Electron')) return undefined

  const defaultStorage = findCookieStorage(browser, [...domainCandidates(hostname), hostname], now)
  if (defaultStorage === undefined || !configuredDomain) return defaultStorage
  const candidates = domainCandidates(configuredDomain)
  return candidates.length > 0
    ? findCookieStorage(browser, [configuredDomain, ...candidates], now) ?? defaultStorage
    : defaultStorage
}

function defaultExpiration(cookie: boolean, now: number): number {
  const date = new Date(now)
  return cookie
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() + 400 * DAY
    // 4.4.2 的 LocalStorage 写入器以 getDay() 作为目标月份的日期。
    : new Date(date.getFullYear() + 3, date.getMonth(), date.getDay()).getTime()
}

function hasReservedPrefix(value: string): boolean {
  return value.startsWith(CIPHER_PREFIX) || (value.startsWith('w3,') && value.length > 3)
}

function readValue(key: string, raw: string, identity: boolean, cookie: boolean, now: () => number): WebStorageRead {
  const corrupt: WebStorageRead = { kind: 'corrupt', message: 'web_storage_corrupt' }
  try {
    let value: unknown
    if (cookie) {
      value = decodeCookieValue(raw)
    } else {
      const envelope = JSON.parse(raw) as { value?: unknown; expiredAt?: unknown } | null
      if (typeof envelope !== 'object' || envelope === null || !Object.prototype.hasOwnProperty.call(envelope, 'value')
        || typeof envelope.expiredAt !== 'number' || !Number.isFinite(envelope.expiredAt)) return corrupt
      if (envelope.expiredAt <= now()) return { kind: 'missing' }
      value = envelope.value
    }
    if (identity) {
      const decoded = decodeIdentity(key, value)
      return decoded === null
        ? { kind: 'corrupt', message: 'web_identity_incompatible' }
        : { kind: 'value', value: decoded }
    }
    return typeof value === 'string' && hasReservedPrefix(value)
      ? corrupt
      : { kind: 'value', value: parseWebValue(value) }
  } catch {
    return corrupt
  }
}

function serializeValue(value: WebStorageValue, cookie: boolean, expiresAt: number): string | null {
  if (cookie && typeof value === 'string') return encodeCookieValue(value)
  const json = JSON.stringify(value)
  if (typeof json !== 'string' || (typeof value !== 'string' && !json.startsWith('{'))) return null
  return cookie ? encodeCookieValue(json) : `{"value":${json},"expiredAt":${expiresAt}}`
}

function writeFailure(error: unknown): StorageWrite {
  if (error === COOKIE_CONFLICT) return { kind: 'failed', message: COOKIE_CONFLICT.message }
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined
  if (name === 'QuotaExceededError') return { kind: 'quota', message: 'web_storage_quota' }
  if (name === 'SecurityError') return { kind: 'unavailable', message: 'web_storage_unavailable' }
  return { kind: 'failed', message: 'web_storage_write_failed' }
}

function adaptStorage(storage: BrowserStorage, now: () => number): WebStorage {
  const cookie = storage.kind === 'cookie'
  const read = (key: string, identity = false): WebStorageRead => {
    try {
      const raw = storage.get(key)
      return raw === null ? { kind: 'missing' } : readValue(key, raw, identity, cookie, now)
    } catch (error) {
      return error === COOKIE_CONFLICT
        ? { kind: 'corrupt', message: COOKIE_CONFLICT.message }
        : { kind: 'unavailable', message: 'web_storage_unavailable' }
    }
  }
  return {
    kind: storage.kind,
    domain: storage.domain,
    read,
    write(key, value, options) {
      const identity = options?.identity === true
      const previous = read(key, identity)
      if (previous.kind === 'unavailable') return { kind: 'unavailable', message: previous.message }
      if (previous.kind === 'corrupt') return { kind: 'failed', message: previous.message }
      let prepared = value
      if (identity) {
        const encoded = typeof value === 'string' ? encodeIdentity(key, value) : null
        if (encoded === null) return { kind: 'failed', message: 'web_identity_incompatible' }
        prepared = encoded
      } else if (typeof value === 'string' && (hasReservedPrefix(value) || parseWebValue(value) !== value)) {
        return { kind: 'failed', message: 'web_storage_value_incompatible' }
      }

      try {
        const currentTime = now()
        const expiresAt = options?.expiresAt ?? defaultExpiration(cookie, currentTime)
        // Cookie 到期时间只能保存到整秒，避免写入已过期值时清除现有记录。
        const effectiveExpiry = cookie ? Math.floor(new Date(expiresAt).getTime() / 1_000) * 1_000 : expiresAt
        if (!Number.isFinite(effectiveExpiry) || effectiveExpiry <= currentTime) {
          return { kind: 'failed', message: 'web_storage_expiry_invalid' }
        }
        const serialized = serializeValue(prepared, cookie, expiresAt)
        if (serialized === null) return { kind: 'failed', message: 'web_storage_value_incompatible' }
        storage.set(key, serialized, expiresAt)
        return storage.get(key) === serialized ? { kind: 'ok' } : { kind: 'failed', message: 'web_storage_write_unverified' }
      } catch (error) {
        return writeFailure(error)
      }
    },
    remove(key) {
      const identity = key === WEB_DEVICE_KEY || /_gdp_(?:cs1|user_key|gio_id)$/.test(key)
      const previous = read(key, identity)
      if (previous.kind === 'unavailable') return { kind: 'unavailable', message: previous.message }
      if (previous.kind === 'corrupt') return { kind: 'failed', message: previous.message }
      try {
        storage.remove(key)
        return storage.get(key) === null ? { kind: 'ok' } : { kind: 'failed', message: 'web_storage_remove_unverified' }
      } catch (error) {
        return writeFailure(error)
      }
    },
  }
}

/** WebView 缓存固定使用同源 LocalStorage，访问失败直接交给调用方处理。 */
export function createWebLocalStorage(browser: Window, now = Date.now): WebStorage {
  return adaptStorage(localStorage(browser), now)
}

/** 首次探测后固定介质及 Cookie 域，读取和写入均使用同一范围。 */
export function createWebStorage(
  browser: Window,
  options: Readonly<{ storageType?: 'cookie' | 'localstorage'; cookieDomain?: string }>,
  now = Date.now,
): WebStorage {
  if (options.storageType !== 'localstorage') {
    const cookie = selectCookieStorage(browser, options.cookieDomain, now)
    if (cookie !== undefined) return adaptStorage(cookie, now)
  }
  const local = localStorage(browser)
  return adaptStorage(canWrite(local) ? local : memoryStorage(browser), now)
}

/** 子实例采用 Web 多实例插件的正 32 位哈希前缀。 */
export function webStoragePrefix(projectId: string, dataSourceId: string, subInstance = false): string {
  if (!subInstance) return projectId
  const key = projectId + dataSourceId
  let hash = 0
  for (let index = 0; index < key.length; index++) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0
  }
  return String(Math.abs(hash))
}
