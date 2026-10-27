import { GIO_IDENTITY_CIPHER, decryptIdentityValue, encryptIdentityValue } from './storage/encrypt.js'
import type { SessionPolicy } from '../constants/config.js'

export const IDENTITY_VALUE_MAX_LENGTH = 1000

export type Identity = Readonly<{
  deviceId: string
  userId: string | null
  userKey: string | null
  /** 退出登录后仍保留的内部比较身份，不能作为事件 userId 上报。 */
  lastUserId?: string | null
  /** 显式分配或迁入的设备身份不适用早期 App 预览 ID 的替换规则。 */
  deviceIdAssigned?: true
}>

export type IdentityRecordRead =
  | Readonly<{ kind: 'current' | 'legacy'; identity: Identity }>
  | Readonly<{ kind: 'corrupt' }>

export type IdentityUpdate = Readonly<{
  ok: boolean
  identity: Identity
  userKeyIgnored: boolean
  changed: boolean
}>

/** 检查身份信封是否为非数组对象。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 按码点验证身份长度并拒绝未配对 UTF-16 代理项。 */
export function isWithinLimit(value: string): boolean {
  // 一个合法码点最多占两个 UTF-16 单元，明显超长时无需遍历和分配完整字符数组。
  if (value.length > IDENTITY_VALUE_MAX_LENGTH * 2) return false
  let length = 0
  for (const character of value) {
    if (++length > IDENTITY_VALUE_MAX_LENGTH) return false
    // 身份编码器不接受未配对的 UTF-16 代理项，必须在改变身份前拒绝。
    if (character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff) return false
  }
  return true
}

/** identify 接受非空有效字符串或正有限数字，不截断或猜测设备身份。 */
export function assignedDeviceId(value: unknown): string | null {
  const id = typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : value
  return typeof id === 'string' && id.trim() !== '' && !['-', 'null', 'undefined'].includes(id) && isWithinLimit(id) ? id : null
}

/** 校验设备标识、登录字段和最近身份，防止损坏缓存进入运行时。 */
function validIdentity(value: unknown): value is Identity {
  return isRecord(value)
    && typeof value.deviceId === 'string'
    && value.deviceId.length > 0
    && isWithinLimit(value.deviceId)
    && (typeof value.userId === 'string' || value.userId === null)
    && (typeof value.userKey === 'string' || value.userKey === null)
    && (value.userId === null || isWithinLimit(value.userId))
    && (value.userKey === null || isWithinLimit(value.userKey))
    && (value.lastUserId === undefined || value.lastUserId === null || typeof value.lastUserId === 'string' && isWithinLimit(value.lastUserId))
    && (value.deviceIdAssigned === undefined || value.deviceIdAssigned === true)
}

/** 比较出站身份与内部最近登录身份，避免无变化的状态写入。 */
function sameIdentity(left: Identity, right: Identity): boolean {
  return left.deviceId === right.deviceId && left.userId === right.userId && left.userKey === right.userKey && left.lastUserId === right.lastUserId && left.deviceIdAssigned === right.deviceIdAssigned
}

/** 写入带版本的 JSON 信封，分别保护每个已填充的身份字段。 */
export function serializeIdentityRecord(identity: Identity, dataSourceId: string): string {
  if (!validIdentity(identity)) throw new Error('identity_invalid')
  /** 保留匿名 null，按数据源分别保护已填充的身份字段。 */
  const protect = (value: string | null): string | null => value === null ? null : encryptIdentityValue(value, dataSourceId)
  return JSON.stringify({
    version: 1,
    expiresAt: null,
    cipher: GIO_IDENTITY_CIPHER,
    value: {
      deviceId: protect(identity.deviceId),
      userId: protect(identity.userId),
      userKey: protect(identity.userKey),
      ...(identity.lastUserId === undefined ? {} : { lastUserId: protect(identity.lastUserId) }),
      ...(identity.deviceIdAssigned === undefined ? {} : { deviceIdAssigned: identity.deviceIdAssigned }),
    },
  })
}

/** 兼容旧明文信封，后续成功写入时迁移到当前格式。 */
export function readIdentityRecord(serialized: string, dataSourceId: string): IdentityRecordRead {
  let record: unknown
  try {
    record = JSON.parse(serialized)
  } catch {
    return { kind: 'corrupt' }
  }
  if (!isRecord(record) || record.version !== 1 || record.expiresAt !== null || !isRecord(record.value)) return { kind: 'corrupt' }

  if (record.cipher === undefined) {
    return validIdentity(record.value) ? { kind: 'legacy', identity: record.value } : { kind: 'corrupt' }
  }
  if (record.cipher !== GIO_IDENTITY_CIPHER) return { kind: 'corrupt' }

  // 存储的 null 表示匿名；已填充字段解码失败则表示记录损坏。
  /** 区分合法匿名 null 与解码失败的 undefined，避免损坏身份被误当匿名恢复。 */
  const decrypt = (value: unknown): string | null | undefined => value === null ? null : decryptIdentityValue(value, dataSourceId) ?? undefined
  const hasLastUserId = Object.prototype.hasOwnProperty.call(record.value, 'lastUserId')
  const lastUserId = hasLastUserId ? decrypt(record.value.lastUserId) : undefined
  if (hasLastUserId && lastUserId === undefined) return { kind: 'corrupt' }
  const identity = {
    deviceId: decrypt(record.value.deviceId),
    userId: decrypt(record.value.userId),
    userKey: decrypt(record.value.userKey),
    ...(hasLastUserId ? { lastUserId } : {}),
    ...(record.value.deviceIdAssigned === undefined ? {} : { deviceIdAssigned: record.value.deviceIdAssigned }),
  }
  return validIdentity(identity) ? { kind: 'current', identity } : { kind: 'corrupt' }
}

/** 应用公开 setUserId 语义，持久化时机由运行时决定。 */
export function updateIdentity(
  current: Identity,
  userId: unknown,
  userKey: unknown,
  idMapping: boolean,
): IdentityUpdate {
  if (!validIdentity(current) || typeof userId !== 'string' || !isWithinLimit(userId)) {
    return { ok: false, identity: current, userKeyIgnored: false, changed: false }
  }
  if (userKey !== undefined && userKey !== null && (typeof userKey !== 'string' || !isWithinLimit(userKey))) {
    return { ok: false, identity: current, userKeyIgnored: false, changed: false }
  }
  const next: Identity = userId.length === 0
    ? { ...current, userId: null, userKey: null, lastUserId: current.userId ?? current.lastUserId ?? null }
    : { ...current, userId, userKey: idMapping ? (userKey ?? null) : null, lastUserId: userId }
  return {
    ok: true,
    identity: next,
    userKeyIgnored: userId.length > 0 && !idMapping && userKey !== undefined && userKey !== null,
    changed: !sameIdentity(current, next),
  }
}

export type SessionSnapshot = Readonly<{
  sessionId: string
  lastCloseTime: number | null
}>

export type SessionStartReason = 'initial' | 'cold_start' | 'timeout' | 'user_changed' | 'collection_resumed' | 'scene_changed' | 'activity_timeout'

export type SessionTransition = Readonly<{
  snapshot: SessionSnapshot | null
  startedNew: boolean
  reason: SessionStartReason | null
}>

export type SessionIdFactory = () => string

/** 确认会话观察时间为有限非负数。 */
function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/** 以非空字符串判断登录状态，保持与身份更新的空字符串退出语义一致。 */
function isLoggedIn(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0
}

/** 校验新会话标识并构造带变更原因的初始快照。 */
function createSession(idFactory: SessionIdFactory, reason: SessionStartReason): SessionTransition {
  const sessionId = idFactory()
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('session_id_factory_returned_empty')
  }
  return {
    snapshot: { sessionId, lastCloseTime: null },
    startedNew: true,
    reason,
  }
}

/** 会话状态机不依赖宿主存储，快照持久化由运行时经存储模块负责。 */
export class SessionManager {
  private lastActivityAt: number | null = null
  private snapshot: SessionSnapshot | null
  private lastUserId: string | null

  /** 注入会话策略与标识工厂，并恢复已有会话及最近登录身份。 */
  public constructor(
    private readonly policy: SessionPolicy,
    private readonly idFactory: SessionIdFactory,
    initialSnapshot: SessionSnapshot | null = null,
    initialLastUserId: string | null = null,
  ) {
    this.snapshot = initialSnapshot
    this.lastUserId = isLoggedIn(initialLastUserId) ? initialLastUserId : null
  }

  /** 读取当前会话快照，不触发续期或新建。 */
  public current(): SessionSnapshot | null {
    return this.snapshot
  }

  /** 新的 App JS 运行期视为冷启动，即使历史会话刚刚持久化也要重建。 */
  public onProcessLaunch(): SessionTransition {
    const reason: SessionStartReason = this.snapshot === null || this.snapshot.sessionId.trim() === ''
      ? 'initial'
      : 'cold_start'
    return this.replace(createSession(this.idFactory, reason))
  }

  /** 处理 App.onShow；后台间隔恰好等于超时时间时仍沿用原会话。 */
  public resume(now: number): SessionTransition {
    if (!validTimestamp(now)) throw new Error('invalid_session_timestamp')

    if (this.snapshot === null || this.snapshot.sessionId.trim().length === 0) {
      return this.replace(createSession(this.idFactory, 'initial'))
    }

    const { lastCloseTime } = this.snapshot
    if (lastCloseTime !== null && validTimestamp(lastCloseTime) && now - lastCloseTime > this.policy.timeoutMs) {
      return this.replace(createSession(this.idFactory, 'timeout'))
    }

    this.snapshot = { ...this.snapshot, lastCloseTime: null }
    return { snapshot: this.snapshot, startedNew: false, reason: null }
  }

  /** 处理 App.onHide，记录离开时间并保留会话，以供热启动判断。 */
  public hide(now: number): SessionSnapshot | null {
    if (!validTimestamp(now)) throw new Error('invalid_session_timestamp')
    if (this.snapshot === null) return null
    this.snapshot = { ...this.snapshot, lastCloseTime: now }
    return this.snapshot
  }

  /** 首次登录与退出沿用会话；退出后换账号登录仍需新建会话。 */
  public onUserIdChange(previousUserId: string | null | undefined, nextUserId: string | null | undefined): SessionTransition {
    const previous = isLoggedIn(previousUserId) ? previousUserId : this.lastUserId
    if (isLoggedIn(nextUserId)) this.lastUserId = nextUserId ?? null
    else if (isLoggedIn(previousUserId)) this.lastUserId = previousUserId ?? null
    if (isLoggedIn(previous) && isLoggedIn(nextUserId) && previous !== nextUserId) {
      return this.replace(createSession(this.idFactory, 'user_changed'), true)
    }
    if (this.snapshot === null) return { snapshot: null, startedNew: false, reason: null }
    return { snapshot: this.snapshot, startedNew: false, reason: null }
  }

  /** 采集同意从 false 切换为 true 时，建立新的访问与会话。 */
  public onCollectionResumed(): SessionTransition {
    return this.replace(createSession(this.idFactory, 'collection_resumed'), true)
  }

  /** 小程序场景切换，或显式活动超时，使用同一会话替换路径。 */
  public renew(reason: 'scene_changed' | 'activity_timeout'): SessionTransition {
    return this.replace(createSession(this.idFactory, reason))
  }

  /** 仅配置了活动超时的小程序调用；读取快照本身不触发续期。 */
  public touch(now: number): SessionTransition {
    if (!validTimestamp(now)) throw new Error('invalid_session_timestamp')
    const expired = this.snapshot !== null && this.lastActivityAt !== null && this.policy.activityTimeoutMs !== undefined
      && now - this.lastActivityAt > this.policy.activityTimeoutMs
    const transition = expired ? this.renew('activity_timeout') : { snapshot: this.snapshot, startedNew: false, reason: null }
    this.lastActivityAt = now
    return transition
  }

  /** 提交新会话；后台身份或采集变化时可保留原离开时间。 */
  private replace(transition: SessionTransition, preserveCloseTime = false): SessionTransition {
    if (transition.snapshot === null) throw new Error('session_transition_missing_snapshot')
    // 后台更新身份或采集开关不会让 App 回到前台，必须保留离开时间。
    this.snapshot = preserveCloseTime
      ? { ...transition.snapshot, lastCloseTime: this.snapshot?.lastCloseTime ?? null }
      : transition.snapshot
    this.lastActivityAt = null
    return { ...transition, snapshot: this.snapshot }
  }
}

export type Location = Readonly<{ latitude: number; longitude: number }>

/** 显式业务位置仅保存在内存中，不请求权限，也不读写存储。 */
export class LocationState {
  private location: Location | null = null

  /** 仅接受有限且未越界的经纬度，合法零值保留；失败不覆盖旧位置。 */
  public set(latitude: unknown, longitude: unknown): boolean {
    if (typeof latitude !== 'number' || typeof longitude !== 'number'
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false
    this.location = { latitude, longitude }
    return true
  }

  /** 清除仅内存保存的位置，不调用宿主定位或存储。 */
  public clear(): void {
    this.location = null
  }

  /** 返回位置副本，避免调用方修改内部状态。 */
  public current(): Location | null {
    return this.location === null ? null : { ...this.location }
  }
}
