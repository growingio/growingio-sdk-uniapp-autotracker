import { normalizeInitOptions } from '../../constants/config.js'

export const HYBRID_EVENTS = ['PAGE', 'CUSTOM', 'VIEW_CLICK', 'VIEW_CHANGE', 'LOGIN_USER_ATTRIBUTES'] as const
export type HybridEventType = typeof HYBRID_EVENTS[number]
export const NATIVE_ERRORS = ['unsupported_version', 'configuration_mismatch', 'app_not_allowed', 'host_not_ready', 'source_closed',
  'stale_connection', 'duplicate_request', 'collection_disabled', 'identity_not_allowed', 'unsupported_event', 'invalid_payload',
  'payload_too_large', 'page_unavailable', 'queue_full', 'native_internal_error'] as const
export type NativeErrorCode = typeof NATIVE_ERRORS[number]
export type HybridErrorCode = NativeErrorCode | 'native_result_unknown' | 'invalid_config' | 'module_missing' | 'invalid_module'
  | 'handshake_timeout' | 'invoke_error' | 'invalid_reply' | 'response_timeout' | 'queue_expired' | 'connection_reset' | 'identity_blocked'
  | 'local_collection_disabled' | 'local_background' | 'local_queue_full' | 'location_owned_by_host' | 'unsupported_runtime'
  | 'metadata_too_large' | 'counter_exhausted'
export type HybridMethod = 'hello' | 'dispatchEvent' | 'setUserId' | 'clearUserId'
export type HybridError = Readonly<{
  code: HybridErrorCode
  phase: 'init' | 'handshake' | 'queue' | 'dispatch'
  method?: HybridMethod
  requestId?: number
  eventType?: HybridEventType
  outcome: 'not_sent' | 'rejected' | 'unknown'
  droppedCount?: number
}>
export type HybridReady = Readonly<{ collecting: boolean; identityBlocked: boolean; canWriteIdentity: boolean }>
export type HybridOptions = Readonly<{
  transport?: 'native-module'
  penetrateHybrid?: boolean
  onReady?: (state: HybridReady) => void
  onError?: (error: HybridError) => void
}>
export type UniMPInitOptions = Readonly<{
  runtime: 'unimp'
  appId: string
  accountId: string
  dataSourceId: string
  dataCollect?: boolean
  idMapping?: boolean
  debug?: boolean
}>
export type UniMPConfig = Readonly<{ appId: string; accountId: string; dataSourceId: string; dataCollect: boolean; idMapping: boolean; debug: boolean }>
export type Header = Readonly<{ version: 1; requestId: number; instanceId: string; generation: number }>
export type HostGate = Readonly<{ dataCollect: boolean; containerVisible: boolean }>
export type EventDraft = Readonly<{ eventType: HybridEventType; timestamp: number } & Record<string, unknown>>
export type Operation = Readonly<
  { method: 'dispatchEvent'; payload: { event: EventDraft; pageViewId?: string } }
  | { method: 'setUserId'; payload: { userId: string; userKey?: string } }
  | { method: 'clearUserId'; payload: Record<string, never> }
>
export type UniMPRequest = Header & (Readonly<{ method: 'hello'; payload: Pick<UniMPConfig, 'appId' | 'accountId' | 'dataSourceId' | 'idMapping'> & { sdkVersion: string } }> | (Operation & { connectionId: string }))
export type HelloPayload = Readonly<Pick<UniMPConfig, 'appId' | 'accountId' | 'dataSourceId' | 'idMapping'> & {
  hostType: 'native'; platform: 'Android' | 'iOS'; nativeSdkVersion: string; dcloudSdkVersion?: string
  host: HostGate; events: readonly HybridEventType[]; identityWrite: boolean
}>
export type UniMPReply = Header & Readonly<
  { status: 'ok'; connectionId: string; payload: HelloPayload }
  | { status: 'accepted' | 'ok'; connectionId: string; host: HostGate }
  | { status: 'rejected'; code: NativeErrorCode; connectionId?: string; host?: HostGate }
  | { status: 'unknown'; connectionId: string; code: 'native_result_unknown'; host?: HostGate }
>
export interface UniMPHostPort {
  request(request: UniMPRequest, done: (reply: unknown) => void): void
  dispose(): void
}
export class HybridPortFailure extends Error {
  public constructor(public readonly code: 'module_missing' | 'invalid_module' | 'invoke_error') { super(code) }
}
export interface HybridScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}
export const HYBRID_MAX_BYTES = 256 * 1024

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : null
}
export function asciiId(value: unknown): value is string { return typeof value === 'string' && /^[\x00-\x7f]{1,128}$/.test(value) }
export function positiveCounter(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
export function validHybridOptions(value: unknown): value is HybridOptions {
  if (value === undefined) return true
  const input = record(value)
  return input !== null && Object.keys(input).every(key => ['transport', 'penetrateHybrid', 'onReady', 'onError'].includes(key))
    && (input.transport === undefined || input.transport === 'native-module')
    && (input.penetrateHybrid === undefined || typeof input.penetrateHybrid === 'boolean')
    && (input.onReady === undefined || typeof input.onReady === 'function') && (input.onError === undefined || typeof input.onError === 'function')
}
export function normalizeUniMPConfig(value: unknown): UniMPConfig | null {
  const input = record(value)
  if (input === null || input.runtime !== 'unimp'
    || ['serverUrl', 'sessionExpires', 'appChannel', 'appVersion', 'keepAlive', 'uploadInterval', 'forceLogin', 'legacyMiniProgramIdentity'].some(key => input[key] !== undefined)) return null
  const normalized = normalizeInitOptions({ accountId: input.accountId, dataSourceId: input.dataSourceId, dataCollect: input.dataCollect, idMapping: input.idMapping, debug: input.debug })
  const appId = typeof input.appId === 'string' ? input.appId.trim() : ''
  if (!normalized.ok || appId === '' || [...appId].length > 256) return null
  for (const character of appId) if (character.length === 1 && /[\ud800-\udfff]/.test(character)) return null
  const { accountId, dataSourceId, dataCollect, idMapping, debug } = normalized.config
  const config = { appId, accountId, dataSourceId, dataCollect, idMapping, debug }
  return wireBytes(JSON.stringify(config)) < HYBRID_MAX_BYTES - 1024 ? config : null
}

/** UTF-8 字节预算不依赖 TextEncoder / Buffer，支持传统 App JS 引擎。 */
export function wireBytes(value: string): number {
  let size = 0
  for (const part of value) { const point = part.codePointAt(0)!; size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4 }
  return size
}
function keys(input: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(input).every(key => allowed.includes(key)) }
function hostGate(value: unknown): value is HostGate {
  const input = record(value)
  return input !== null && keys(input, ['dataCollect', 'containerVisible']) && typeof input.dataCollect === 'boolean' && typeof input.containerVisible === 'boolean'
}
/** 只检查数据属性；有 accessor、循环、深层或非 JSON 形态时不执行 stringify。 */
function jsonData(value: unknown, depth = 0, budget = { remaining: 50000 }): boolean {
  if (--budget.remaining < 0 || depth > 16) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!Array.isArray(value) && record(value) === null) return false
  return Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, field]) => key === 'length' && Array.isArray(value)
    || 'value' in field && jsonData(field.value, depth + 1, budget))
}

/** 先区分无关回调；完全关联后才把非法内容视为当前请求的失败。 */
export function validateReply(value: unknown, request: UniMPRequest, config: UniMPConfig): Readonly<{ kind: 'unrelated' }> | Readonly<{ kind: 'invalid' }> | Readonly<{ kind: 'reply'; reply: UniMPReply }> {
  const input = record(value)
  const own = (key: string) => input === null ? undefined : Object.getOwnPropertyDescriptor(input, key)?.value
  if (input === null || own('requestId') !== request.requestId || own('instanceId') !== request.instanceId || own('generation') !== request.generation
    || (request.method !== 'hello' && own('connectionId') !== request.connectionId)) return { kind: 'unrelated' }
  if (!jsonData(input)) return { kind: 'invalid' }
  const serialized = JSON.stringify(input)
  if (wireBytes(serialized) > HYBRID_MAX_BYTES || input.version !== 1
    || !positiveCounter(input.requestId) || !positiveCounter(input.generation) || !asciiId(input.instanceId)) return { kind: 'invalid' }
  const base = ['version', 'requestId', 'instanceId', 'generation', 'status']
  if (input.status === 'rejected') {
    if (!keys(input, [...base, 'code', 'host', ...(request.method === 'hello' ? [] : ['connectionId'])])
      || !NATIVE_ERRORS.includes(input.code as NativeErrorCode) || (input.host !== undefined && !hostGate(input.host))
      || (input.code === 'collection_disabled' && (!hostGate(input.host) || input.host.dataCollect !== false))) return { kind: 'invalid' }
  } else if (request.method === 'hello') {
    const payload = record(input.payload)
    const version = (v: unknown) => typeof v === 'string' && v.trim() !== '' && [...v].length <= 64
    if (input.status !== 'ok' || !asciiId(input.connectionId) || !keys(input, [...base, 'connectionId', 'payload']) || payload === null
      || !keys(payload, ['hostType', 'appId', 'accountId', 'dataSourceId', 'idMapping', 'platform', 'nativeSdkVersion', 'dcloudSdkVersion', 'host', 'events', 'identityWrite'])
      || payload.hostType !== 'native' || payload.appId !== config.appId || payload.accountId !== config.accountId || payload.dataSourceId !== config.dataSourceId || payload.idMapping !== config.idMapping
      || !['Android', 'iOS'].includes(payload.platform as string) || !version(payload.nativeSdkVersion) || (payload.dcloudSdkVersion !== undefined && !version(payload.dcloudSdkVersion))
      || !hostGate(payload.host) || typeof payload.identityWrite !== 'boolean' || !Array.isArray(payload.events)
      || payload.events.length !== HYBRID_EVENTS.length || HYBRID_EVENTS.some(event => !(payload.events as unknown[]).includes(event))) return { kind: 'invalid' }
  } else if (input.status === 'unknown') {
    if (!keys(input, [...base, 'connectionId', 'code', 'host']) || input.code !== 'native_result_unknown' || (input.host !== undefined && !hostGate(input.host))) return { kind: 'invalid' }
  } else if (!keys(input, [...base, 'connectionId', 'host']) || input.status !== (request.method === 'dispatchEvent' ? 'accepted' : 'ok') || !hostGate(input.host)) return { kind: 'invalid' }
  return { kind: 'reply', reply: JSON.parse(serialized) as UniMPReply }
}
