export const APP_EVENT_TYPES = [
  'VISIT',
  'PAGE',
  'CUSTOM',
  'LOGIN_USER_ATTRIBUTES',
  'APP_CLOSED',
  'VIEW_CLICK',
  'VIEW_CHANGE',
] as const

export type AppEventType = (typeof APP_EVENT_TYPES)[number]
export type ProtocolEvent = Readonly<Record<string, unknown>> & Readonly<{ eventType: AppEventType }>

const COMMON_FIELDS = [
  'deviceId', 'userId', 'userKey', 'sessionId', 'dataSourceId', 'eventType', 'platform',
  'platformVersion', 'timestamp', 'domain', 'appState', 'appName', 'path', 'query',
  'networkState', 'appChannel', 'screenWidth', 'screenHeight', 'deviceBrand', 'deviceModel',
  'deviceType', 'appVersion', 'language', 'timezoneOffset', 'latitude', 'longitude', 'sdkVersion',
] as const

const EVENT_FIELDS: Readonly<Record<AppEventType, readonly string[]>> = {
  VISIT: ['eventSequenceId'],
  PAGE: ['eventSequenceId', 'orientation', 'protocolType', 'title', 'referralPage'],
  CUSTOM: ['eventSequenceId', 'eventName', 'pageShowTimestamp', 'attributes'],
  LOGIN_USER_ATTRIBUTES: ['attributes'],
  APP_CLOSED: [],
  VIEW_CLICK: ['eventSequenceId', 'pageShowTimestamp', 'textValue', 'xpath', 'index', 'hyperlink'],
  VIEW_CHANGE: ['eventSequenceId', 'pageShowTimestamp', 'textValue', 'xpath'],
}

const REQUIRED_EVENT_FIELDS: Readonly<Record<AppEventType, readonly string[]>> = {
  VISIT: ['eventSequenceId'],
  PAGE: ['eventSequenceId', 'orientation'],
  CUSTOM: ['eventSequenceId', 'eventName'],
  LOGIN_USER_ATTRIBUTES: ['attributes'],
  APP_CLOSED: [],
  VIEW_CLICK: ['eventSequenceId', 'pageShowTimestamp', 'xpath'],
  VIEW_CHANGE: ['eventSequenceId', 'pageShowTimestamp', 'xpath'],
}

const REQUIRED_COMMON_FIELDS = [
  'deviceId', 'sessionId', 'dataSourceId', 'eventType', 'platform', 'platformVersion', 'timestamp',
  'domain', 'appState', 'appName', 'networkState', 'screenWidth', 'screenHeight', 'deviceBrand',
  'deviceModel', 'deviceType', 'appVersion', 'language', 'timezoneOffset', 'sdkVersion',
] as const

const CUSTOM_EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/

/** 校验 CUSTOM 名称以字母或下划线开头，且总长度不超过 100 个 ASCII 字符。 */
export function isValidCustomEventName(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_EVENT_NAME.test(value)
}

export type AttributeDiagnostic = 'attribute_invalid_value' | 'attribute_key_collision'
export type NormalizedAttributes = Readonly<{ attributes: ReadonlyMap<string, string>; diagnostics: readonly AttributeDiagnostic[] }>
export type BuildEventResult =
  | Readonly<{ ok: true; event: ProtocolEvent }>
  | Readonly<{ ok: false; code: 'invalid_event_type' | 'missing_required_field' | 'invalid_custom_event_name' | 'invalid_field_value' }>

const FIELD_ENUMS: Readonly<Record<string, readonly string[]>> = {
  platform: ['Android', 'iOS', 'HarmonyOS'],
  appState: ['FOREGROUND', 'BACKGROUND'],
  networkState: ['2G', '3G', '4G', '5G', 'WIFI', 'UNKNOWN'],
  deviceType: ['PHONE', 'PAD', 'FOLD', 'UNKNOWN'],
  orientation: ['PORTRAIT', 'LANDSCAPE'],
}

/** 校验保留的出站字段，兼容缓存中已被清理的公共空字段。 */
function validWireField(key: string, value: unknown, mini = false): boolean {
  if (mini && key === 'platform') return value === 'MinP' || value === 'alip'
  if (mini && (key === 'deviceType' || key === 'operatingSystem')) return typeof value === 'string' && /^(Weixin|Alipay)-.+$/.test(value)
  switch (key) {
    case 'eventSequenceId': return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    case 'timestamp': case 'pageShowTimestamp': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    case 'screenWidth': case 'screenHeight': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    case 'index': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2147483647
    case 'latitude': case 'longitude': return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= (key === 'latitude' ? 90 : 180)
    case 'attributes': return typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.values(value).every((part) => typeof part === 'string')
    default: {
      const choices = FIELD_ENUMS[key]
      return typeof value === 'string' && (choices === undefined || choices.includes(value))
    }
  }
}

/** 识别出站应省略的空值，同时保留有意义的数字零和布尔 false。 */
function isEmptyOutboundValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

/** 在字段白名单裁剪后移除出站空值，保留零和 false。 */
export function sanitizeOutboundEvent(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => !isEmptyOutboundValue(value)))
}

/** 按 Unicode 码点截断字符串，避免拆开合法代理对。 */
function truncate(value: string, max: number): string {
  let result = ''
  let length = 0
  for (const character of value) {
    result += character
    if (++length === max) break
  }
  return result
}

/** 将受支持的基础值和有效 Date 转为属性字符串；不支持的值返回 null。 */
function normalizeAttributeScalar(value: unknown): string | null {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return null
}

/** 先校验全部数组项，再在 1000 码点预算内拼接，避免短输出分配巨大的临时字符串。 */
function normalizeAttributeArray(values: readonly unknown[]): string | null {
  const parts = values.map(normalizeAttributeScalar)
  if (parts.some(part => part === null)) return null
  let value = ''
  let remaining = 1000
  for (let index = 0; index < parts.length; index++) {
    if (index > 0) {
      const delimiter = '||'.slice(0, remaining)
      value += delimiter
      remaining -= delimiter.length
      if (remaining === 0) break
    }
    for (const character of parts[index] ?? '') {
      value += character
      if (--remaining === 0) break
    }
    if (remaining === 0) break
  }
  return value
}

/** 统一属性键和值的长度、数组拼接和冲突处理，丢弃非法属性并返回诊断。 */
export function normalizeAttributes(input: unknown): NormalizedAttributes {
  const attributes = new Map<string, string>()
  const diagnostics: AttributeDiagnostic[] = []
  if (input === null || input === undefined) return { attributes, diagnostics }
  if (typeof input !== 'object' || Array.isArray(input)) return { attributes, diagnostics: ['attribute_invalid_value'] }

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = truncate(rawKey, 100)
    let value: string | null
    if (Array.isArray(rawValue)) {
      if (rawValue.length > 100) {
        diagnostics.push('attribute_invalid_value')
        continue
      }
      value = normalizeAttributeArray(rawValue)
    } else {
      value = normalizeAttributeScalar(rawValue)
    }
    if (value === null) {
      diagnostics.push('attribute_invalid_value')
      continue
    }
    if (attributes.has(key)) {
      diagnostics.push('attribute_key_collision')
      continue
    }
    attributes.set(key, truncate(value, 1000))
  }
  return { attributes, diagnostics }
}

/** 按事件白名单裁剪并校验报文。缓存恢复允许省略已清理的公共空字段，事件专属必填项仍严格检查。 */
export function buildAppEvent(eventType: string, fields: Readonly<Record<string, unknown>>, restored = false): BuildEventResult {
  return buildEvent(eventType, fields, restored, false)
}

/** 小程序独立的字段与枚举契约，不能放宽 App 的报文校验。 */
export function buildMiniProgramEvent(eventType: string, fields: Readonly<Record<string, unknown>>, restored = false): BuildEventResult {
  return buildEvent(eventType, fields, restored, true)
}

function buildEvent(eventType: string, fields: Readonly<Record<string, unknown>>, restored: boolean, mini: boolean): BuildEventResult {
  if (!APP_EVENT_TYPES.includes(eventType as AppEventType)) return { ok: false, code: 'invalid_event_type' }
  const typedEventType = eventType as AppEventType
  if (typedEventType === 'CUSTOM' && !isValidCustomEventName(fields.eventName)) {
    return { ok: false, code: 'invalid_custom_event_name' }
  }
  const common = mini ? [...COMMON_FIELDS.filter(key => key !== 'appState' && key !== 'appName'), 'operatingSystem', 'title'] : COMMON_FIELDS
  const specific = mini ? EVENT_FIELDS[typedEventType].filter(key => key !== 'orientation' && key !== 'protocolType') : EVENT_FIELDS[typedEventType]
  const allowed = new Set([...common, ...specific, ...(mini && typedEventType === 'VISIT' ? ['referralPage'] : [])])
  const candidate = Object.fromEntries(
    Object.entries({ ...fields, eventType: typedEventType }).filter(([key]) => allowed.has(key)),
  )
  // 公共字段沿用既有契约，已提供的空值可以在出站报文中省略。
  // 事件专属必填字段在空值清理后仍须存在。
  // 缓存保存的是已清理空字段的上报事件，恢复时不再要求这些公共字段存在。
  const required = mini ? [...REQUIRED_COMMON_FIELDS.filter(key => key !== 'appState' && key !== 'appName'), 'operatingSystem', 'path'] : REQUIRED_COMMON_FIELDS
  if (!restored && required.some((key) => !(key in candidate))) return { ok: false, code: 'missing_required_field' }
  const event = sanitizeOutboundEvent(candidate)
  const requiredSpecific = mini ? REQUIRED_EVENT_FIELDS[typedEventType].filter(key => key !== 'orientation') : REQUIRED_EVENT_FIELDS[typedEventType]
  if ([...requiredSpecific, ...(mini ? ['platform', 'domain', 'timestamp', 'deviceId', 'sessionId', 'dataSourceId', 'platformVersion', 'sdkVersion'] : [])].some((key) => !(key in event))) return { ok: false, code: 'missing_required_field' }
  if (!Object.entries(event).every(([key, value]) => validWireField(key, value, mini))) return { ok: false, code: 'invalid_field_value' }
  if (mini) {
    const prefix = event.platform === 'MinP' ? 'Weixin-' : 'Alipay-'
    if (typeof event.deviceType !== 'string' || !event.deviceType.startsWith(prefix) || event.operatingSystem !== event.deviceType) return { ok: false, code: 'invalid_field_value' }
  }
  return { ok: true, event: event as ProtocolEvent }
}
