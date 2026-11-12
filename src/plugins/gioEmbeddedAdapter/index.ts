import { createWebLocalStorage, type WebStorage } from '../../platform/webStorage.js'

export type WebEmbeddedOptions = Readonly<{
  strict?: boolean
  ignoreFields?: readonly string[]
  rewriteQuery?: boolean
}>

type WebEmbeddedConfig = Readonly<{
  projectId: string
  appId?: string
  hashtag?: boolean
  embeddedAdapter?: WebEmbeddedOptions
  sessionExpiresMs: number
}>

export type WebEmbeddedContext = Readonly<{
  strict: boolean
  dataSourceId: string
  deviceId?: string
  userId?: string | null
  userKey?: string | null
  sessionId?: string
  collecting?: boolean
  routingOnly: boolean
  newDevice?: boolean
  dimensions: Readonly<Record<string, string | number>>
  ownsSession(): boolean
  renew(): void
}>

const QUERY_KEY = 'gdp_query_string'
const FIRST_VISIT_KEY = 'gdp_embedded_new_device'
const DEFAULT_SESSION_EXPIRES_MS = 30 * 60_000
const MINI_PROGRAM_WEBVIEW = /miniprogram|webview|baiduboxapp|toutiaomicroapp|kwapp|jdapp|xhsminiapp/i

const HOST_DIMENSIONS = {
  gioappid: 'domain',
  gioappchannel: 'appChannel',
  giodevicebrand: 'deviceBrand',
  giodevicemodel: 'deviceModel',
  giodevicetype: 'deviceType',
  giolanguage: 'language',
  gionetworkstate: 'networkState',
  giooperatingsystem: 'operatingSystem',
  gioplatform: 'platform',
  gioplatformversion: 'platformVersion',
  gioscreenheight: 'screenHeight',
  gioscreenwidth: 'screenWidth',
} as const

const HOST_QUERY_FIELDS = new Set([
  ...Object.keys(HOST_DIMENSIONS),
  'gioprojectid', 'giodatasourceid', 'giodatacollect', 'giou', 'giocs1', 'giouserkey', 'gios', 'gionewdevice', 'giocircleroomid',
])

/** 仅识别打通协议声明的字段，业务自定义参数继续参与页面采集。 */
export function isWebEmbeddedParameter(key: string): boolean {
  return HOST_QUERY_FIELDS.has(key.toLowerCase())
}

type RoutedSnapshot = Readonly<Record<string, unknown> & {
  gioappid: string
  gioprojectid: string
  giodatasourceid: string
}>
type HostSession = Readonly<{ projectId: string; appId: string; deviceId: string; sessionId: string }>
type FirstVisit = HostSession & Readonly<{ newDevice: boolean; expiresAt: number }>

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null
}

function hasRouting(fields: Readonly<Record<string, unknown>>): fields is RoutedSnapshot {
  return typeof fields.gioappid === 'string' && fields.gioappid.trim() !== ''
    && typeof fields.gioprojectid === 'string' && fields.gioprojectid.trim() !== ''
    && typeof fields.giodatasourceid === 'string' && fields.giodatasourceid.trim() !== ''
}

function decodeHostField(key: string, raw: string): string | boolean {
  let value = raw
  try { value = decodeURIComponent(raw) } catch { /* Web 对非法 URI 转义保留原值。 */ }
  if (value === 'undefined' || value === 'null') return ''
  if (key === 'giodatacollect' || key === 'gionewdevice') {
    if (value === 'true' || value === 'TRUE') return true
    if (value === 'false' || value === 'FALSE') return false
  }
  return value
}

function parseUrlSnapshot(query: string): { fields: RoutedSnapshot; businessQuery: string } | null {
  const fields = Object.create(null) as Record<string, unknown>
  const order: string[] = []
  const business: string[] = []
  for (const entry of query.split('&')) {
    if (entry === '') continue
    const separator = entry.indexOf('=')
    const key = separator === -1 ? entry : entry.slice(0, separator)
    const value = separator === -1 ? '' : entry.slice(separator + 1)
    if (isWebEmbeddedParameter(key)) {
      const hostKey = key.toLowerCase()
      fields[hostKey] = decodeHostField(hostKey, value)
    } else {
      fields[key] = value
      business.push(entry)
    }
    order.push(key)
  }
  fields.__GIO_ORDER__ = order
  if (!hasRouting(fields)) return null
  return { fields, businessQuery: business.length ? `?${business.join('&')}` : '' }
}

function hostSession(fields: RoutedSnapshot): HostSession {
  return {
    projectId: fields.gioprojectid, appId: fields.gioappid,
    deviceId: typeof fields.giou === 'string' ? fields.giou : '',
    sessionId: typeof fields.gios === 'string' ? fields.gios : '',
  }
}

function sameHostSession(left: HostSession, right: HostSession): boolean {
  return left.projectId === right.projectId && left.appId === right.appId
    && left.deviceId === right.deviceId && left.sessionId === right.sessionId
}

function readFirstVisit(storage: WebStorage): FirstVisit | null {
  const result = storage.read(FIRST_VISIT_KEY)
  const value = result.kind === 'value' ? record(result.value) : null
  if (!value || typeof value.projectId !== 'string' || typeof value.appId !== 'string'
    || typeof value.deviceId !== 'string' || typeof value.sessionId !== 'string'
    || typeof value.newDevice !== 'boolean' || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null
  return value as FirstVisit
}

function collectionFlag(fields: RoutedSnapshot): boolean | undefined {
  return fields.giodatacollect === undefined ? undefined : fields.giodatacollect === true
}

function loginValue(value: unknown, strict: boolean): string | null | undefined {
  if (typeof value === 'string') return value || null
  return strict ? undefined : null
}

/** 先匹配目标实例，再缓存宿主快照。只有 URL 来源需要解码。 */
export function readWebEmbeddedContext(browser: Window, config: WebEmbeddedConfig, now = Date.now): WebEmbeddedContext | null {
  const options = config.embeddedAdapter
  if (!options || Array.isArray(options) || typeof options !== 'object' || !config.appId) return null
  const strict = options.strict === true
  if (strict && !MINI_PROGRAM_WEBVIEW.test(browser.navigator.userAgent)) return null

  const { pathname, search, hash } = browser.location
  const searchSnapshot = parseUrlSnapshot(search.slice(1))
  const hashQueryStart = config.hashtag ? hash.indexOf('?') : -1
  const fresh = searchSnapshot ?? (hashQueryStart >= 0 ? parseUrlSnapshot(hash.slice(hashQueryStart + 1)) : null)
  const storage = createWebLocalStorage(browser, now)
  const cached = fresh === null ? storage.read(QUERY_KEY) : null
  const fields = fresh?.fields ?? (cached?.kind === 'value' ? record(cached.value) : null)
  if (!fields || !hasRouting(fields) || fields.gioprojectid !== config.projectId || fields.gioappid !== config.appId) return null

  const owner = hostSession(fields)
  const collecting = collectionFlag(fields)
  const deviceId = owner.deviceId || undefined
  const sessionId = owner.sessionId || undefined
  const routingOnly = collecting === false && deviceId === undefined && sessionId === undefined
    && fields.giocs1 === undefined && fields.giouserkey === undefined
  const hasHostSession = deviceId !== undefined && sessionId !== undefined
  const sessionExpiresMs = Number.isFinite(config.sessionExpiresMs) && config.sessionExpiresMs > 0
    ? config.sessionExpiresMs : DEFAULT_SESSION_EXPIRES_MS

  const ownsSession = () => {
    const current = storage.read(QUERY_KEY)
    if (current.kind === 'value') {
      const latest = record(current.value)
      return latest !== null && hasRouting(latest) && latest.giodatasourceid === fields.giodatasourceid
        && collectionFlag(latest) === collecting && sameHostSession(hostSession(latest), owner)
    }
    if (current.kind === 'corrupt') return false
    // 查询缓存可能被单独清除，首访记录仍能标识后打开页面的宿主会话。
    const latestFirstVisit = readFirstVisit(storage)
    return latestFirstVisit === null || sameHostSession(latestFirstVisit, owner)
  }
  const matchingFirstVisit = () => {
    const latest = readFirstVisit(storage)
    return latest && hasHostSession && sameHostSession(latest, owner) ? latest : null
  }

  let firstVisit: FirstVisit | null
  let useStoredFirstVisit = true
  if (fresh) {
    firstVisit = hasHostSession && typeof fields.gionewdevice === 'boolean'
      ? { ...owner, newDevice: fields.gionewdevice, expiresAt: now() + sessionExpiresMs } : null
    const savedQuery = { ...fields }
    delete savedQuery.gionewdevice
    useStoredFirstVisit = storage.write(QUERY_KEY, savedQuery).kind === 'ok' && (firstVisit
      ? storage.write(FIRST_VISIT_KEY, firstVisit).kind === 'ok'
      : storage.remove(FIRST_VISIT_KEY).kind === 'ok')
    // 只有快照完整落盘才清理 URL，否则刷新仍需读取原始参数。
    if (useStoredFirstVisit && options.rewriteQuery !== false) {
      const path = searchSnapshot
        ? `${pathname}${fresh.businessQuery}${hash}`
        : `${pathname}${search}${hash.slice(0, hashQueryStart)}${fresh.businessQuery}`
      const url = path.startsWith('//') ? `${browser.location.origin}${path}` : path
      try { browser.history.replaceState(browser.history.state, '', url) } catch { /* URL 保留时仍可使用已匹配的宿主上下文。 */ }
    }
  } else {
    firstVisit = matchingFirstVisit()
  }

  const dimensions: Record<string, string | number> = {}
  const ignoreFields = Array.isArray(options.ignoreFields) ? options.ignoreFields : []
  for (const [key, dimension] of Object.entries(HOST_DIMENSIONS)) {
    const value = fields[key]
    if (!ignoreFields.includes(dimension) && (typeof value === 'string' || typeof value === 'number')) dimensions[dimension] = value
  }

  return {
    strict, dataSourceId: fields.giodatasourceid, deviceId, sessionId, collecting, routingOnly, dimensions, ownsSession,
    userId: loginValue(fields.giocs1, strict), userKey: loginValue(fields.giouserkey, strict),
    get newDevice() {
      if (firstVisit?.newDevice !== true) return firstVisit?.newDevice
      if (!ownsSession()) return false
      if (useStoredFirstVisit) firstVisit = matchingFirstVisit() ?? firstVisit
      return firstVisit.newDevice && firstVisit.expiresAt > now()
    },
    renew() {
      if (collecting === false || !useStoredFirstVisit || !ownsSession()) return
      const latest = matchingFirstVisit()
      if (!latest) return
      const timestamp = now()
      const renewed = { ...latest, newDevice: latest.newDevice && latest.expiresAt > timestamp, expiresAt: timestamp + sessionExpiresMs }
      if (storage.write(FIRST_VISIT_KEY, renewed).kind === 'ok') firstVisit = renewed
    },
  }
}
