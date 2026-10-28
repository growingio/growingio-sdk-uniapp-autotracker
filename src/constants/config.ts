import { normalizeCollectorHost } from '../utils/tools.js'
import metadata from '../../package.json' with { type: 'json' }
import type { MiniProgramTarget } from '../types/index.js'

/** 旧独立小程序 SDK 的主实例或子实例身份来源；调用方明确确认其归属。 */
export type LegacyMiniProgramIdentity = Readonly<{
  appId: string
  accountId: string
  dataSourceId: string
  /** 独立 SDK 子实例的 trackingId 前缀，主实例留空。 */
  storagePrefix?: string
  plugin?: boolean
}>

/** 必填标识严格校验；可选配置缺省或非法时使用对应平台的默认值。 */
export type GioInitOptions = Readonly<{
  accountId: string
  dataSourceId: string
  serverUrl?: string | null
  /** 小程序的真实平台 appId；App 不消费此字段。 */
  appId?: string | null
  /** 小程序后台保活分钟数，范围 0–1440，默认 5。App 不消费。 */
  keepAlive?: number
  /** 小程序聚合上报间隔毫秒数，先四舍五入，范围 0–3000，默认 1000。App 不消费。 */
  uploadInterval?: number
  appChannel?: string | null
  appVersion?: string | null
  /** 会话过期分钟数，支持正小数，最大 360；非法值回退默认，小程序默认 -1（关闭活动超时）。 */
  sessionExpires?: number
  dataCollect?: boolean
  idMapping?: boolean
  debug?: boolean
  /** 显式开启后，本次运行期的事件等待 identify 分配设备身份后再上传。 */
  forceLogin?: boolean
  /** 仅小程序支持；只在新身份命名空间缺失时单向读取旧身份。 */
  legacyMiniProgramIdentity?: LegacyMiniProgramIdentity
}>

export type SessionPolicy = Readonly<{ timeoutMs: number; activityTimeoutMs?: number }>

export type ResolvedGioConfig = Readonly<{
  accountId: string
  dataSourceId: string
  serverUrl: string
  appChannel: string | null
  appVersionFallback: string | null
  sessionPolicy: SessionPolicy
  dataCollect: boolean
  idMapping: boolean
  debug: boolean
  miniprogram?: Readonly<{ target: MiniProgramTarget; appId: string; uploadIntervalMs: number }>
  forceLogin?: true
  legacyMiniProgramIdentity?: LegacyMiniProgramIdentity
}>

export type ConfigErrorCode =
  | 'invalid_options'
  | 'invalid_account_id'
  | 'invalid_data_source_id'
  | 'invalid_app_id'

export type ConfigResult =
  | Readonly<{ ok: true; config: ResolvedGioConfig }>
  | Readonly<{ ok: false; code: ConfigErrorCode }>

const DEFAULT_SERVER_URL = 'https://napi.growingio.com'
const APP_DEFAULT_SESSION_TIMEOUT_MS = 30_000
const MINI_PROGRAM_DEFAULT_KEEP_ALIVE_MS = 5 * 60_000
const MINI_PROGRAM_MAX_KEEP_ALIVE_MINUTES = 60 * 24
const MINI_PROGRAM_DEFAULT_UPLOAD_INTERVAL_MS = 1000
const MINI_PROGRAM_MAX_UPLOAD_INTERVAL_MS = 3000
const MAX_SESSION_EXPIRES_MINUTES = 60 * 6

/** 确认初始化参数是普通对象形态，拒绝数组与空值。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 归一化非空字符串并拒绝未配对代理项，避免后续 URI 或 UTF-8 编码失败。 */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // 字符串迭代可保留合法代理对，未配对代理项必须提前拒绝。
  // 否则初始化开始后可能在 URI 或 UTF-8 编码阶段抛错。
  for (const character of trimmed) {
    const point = character.codePointAt(0)!
    if (point >= 0xD800 && point <= 0xDFFF) return null
  }
  return trimmed === '' ? null : trimmed
}

/** 规范采集服务基础地址；非法可选值回退默认地址，兼容缺少 URL 的 App 运行时。 */
function normalizeServerUrl(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_SERVER_URL
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_SERVER_URL

  // 部分 App 运行时没有浏览器的 URL 构造器，因此仅解析采集服务基础地址。
  // 不接受凭据、接口路径、查询参数、片段或转义主机。
  const candidate = value.trim().includes('://') ? value.trim() : `https://${value.trim()}`
  if (typeof globalThis.URL === 'function') {
    try {
      const url = new globalThis.URL(candidate)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.pathname !== '/'
        || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return DEFAULT_SERVER_URL
      return url.origin
    } catch { return DEFAULT_SERVER_URL }
  }
  const match = /^(https?):\/\/(\[[a-f\d:.]+\]|[^\s/:?#@\[\]\\%]+)(?::(\d+))?\/?$/i.exec(candidate)
  if (match === null) return DEFAULT_SERVER_URL
  const protocol = match[1]!.toLowerCase()
  const host = normalizeCollectorHost(match[2]!)
  if (host === null) return DEFAULT_SERVER_URL
  const port = match[3] === undefined ? null : Number(match[3])
  if (port !== null && (!Number.isInteger(port) || port > 65535)) return DEFAULT_SERVER_URL
  const suffix = port === null || (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80) ? '' : `:${port}`
  return `${protocol}://${host}${suffix}`
}

/** 布尔配置仅接受实际布尔值；缺省或非法值统一回退默认。 */
function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 校验分钟值并换算为毫秒；keepAlive 允许零，非法值由对应配置回退默认。 */
function normalizeSessionTimeout(value: unknown, maxMinutes: number, allowZero = false): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || value > maxMinutes) return null
  const timeoutMs = value * 60_000
  return Number.isFinite(timeoutMs) && (allowZero || timeoutMs > 0) ? timeoutMs : null
}

/** 统一校验必填项并归一化可选项；可选值非法时回退默认，不阻断初始化。 */
export function normalizeInitOptions(input: unknown, target?: MiniProgramTarget): ConfigResult {
  if (!isRecord(input)) return { ok: false, code: 'invalid_options' }
  // 显式托管模式由独立入口处理；其他非法 runtime 值使用默认的本地采集模式。
  if (input.runtime === 'unimp') return { ok: false, code: 'invalid_options' }

  const accountId = nonEmptyString(input.accountId)
  if (accountId === null) return { ok: false, code: 'invalid_account_id' }
  const dataSourceId = nonEmptyString(input.dataSourceId)
  if (dataSourceId === null) return { ok: false, code: 'invalid_data_source_id' }

  const serverUrl = normalizeServerUrl(input.serverUrl)
  const appChannel = nonEmptyString(input.appChannel)
  const appVersionFallback = nonEmptyString(input.appVersion)

  let sessionPolicy: SessionPolicy = {
    timeoutMs: target === undefined
      ? normalizeSessionTimeout(input.sessionExpires, MAX_SESSION_EXPIRES_MINUTES) ?? APP_DEFAULT_SESSION_TIMEOUT_MS
      : normalizeSessionTimeout(input.keepAlive, MINI_PROGRAM_MAX_KEEP_ALIVE_MINUTES, true) ?? MINI_PROGRAM_DEFAULT_KEEP_ALIVE_MS,
  }
  let miniprogram: ResolvedGioConfig['miniprogram']
  if (target !== undefined) {
    const appId = nonEmptyString(input.appId)
    if (appId === null || appId.startsWith('__UNI__')) return { ok: false, code: 'invalid_app_id' }
    const activityTimeoutMs = normalizeSessionTimeout(input.sessionExpires, MAX_SESSION_EXPIRES_MINUTES)
    if (activityTimeoutMs !== null) {
      sessionPolicy = { ...sessionPolicy, activityTimeoutMs }
    }
    const rawInterval = input.uploadInterval
    const interval = typeof rawInterval === 'number' ? Math.round(rawInterval) : NaN
    const uploadIntervalMs = Number.isFinite(interval) && interval >= 0 && interval <= MINI_PROGRAM_MAX_UPLOAD_INTERVAL_MS
      ? interval : MINI_PROGRAM_DEFAULT_UPLOAD_INTERVAL_MS
    miniprogram = { target, appId, uploadIntervalMs }
  }
  const dataCollect = normalizeBoolean(input.dataCollect, true)
  const idMapping = normalizeBoolean(input.idMapping, false)
  const debug = normalizeBoolean(input.debug, false)
  let migration: LegacyMiniProgramIdentity | undefined
  const source = input.legacyMiniProgramIdentity
  if (miniprogram !== undefined && isRecord(source)
    && Object.keys(source).every(key => ['appId', 'accountId', 'dataSourceId', 'storagePrefix', 'plugin'].includes(key))
    && source.appId === miniprogram.appId && source.accountId === accountId && source.dataSourceId === dataSourceId
    && (source.storagePrefix === undefined || (typeof source.storagePrefix === 'string' && source.storagePrefix.length <= 128 && /^[A-Za-z0-9_-]*$/.test(source.storagePrefix)))
    && (source.plugin === undefined || typeof source.plugin === 'boolean')) {
    migration = { appId: source.appId, accountId: source.accountId, dataSourceId: source.dataSourceId,
      ...(source.storagePrefix === undefined ? {} : { storagePrefix: source.storagePrefix }), ...(source.plugin === undefined ? {} : { plugin: source.plugin }) }
  }

  return {
    ok: true,
    config: {
      accountId,
      dataSourceId,
      serverUrl,
      appChannel,
      appVersionFallback,
      sessionPolicy,
      dataCollect,
      idMapping,
      debug,
      ...(miniprogram === undefined ? {} : { miniprogram }),
      ...(input.forceLogin === true ? { forceLogin: true as const } : {}),
      ...(migration === undefined ? {} : { legacyMiniProgramIdentity: migration }),
    },
  }
}

export const SDK_VERSION: string = metadata.version
