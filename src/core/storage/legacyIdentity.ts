import type { LegacyMiniProgramIdentity } from '../../constants/config.js'
import { assignedDeviceId, isWithinLimit, type Identity } from '../userStore.js'

export interface LegacyIdentityPort {
  /** 只读旧独立 SDK 的键，绝不删除或覆盖。 */
  read(key: string): unknown
}

/** 兼容独立 SDK 的可选过期信封，只接纳有效的基础字符串。 */
function value(port: LegacyIdentityPort, key: string, now: number): string | null {
  let raw = port.read(key)
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const entry = raw as Record<string, unknown>
    const expiration = typeof entry.expiredAt === 'string' && /^\d+$/.test(entry.expiredAt) ? Number(entry.expiredAt) : entry.expiredAt
    if (typeof expiration !== 'number' || !Number.isFinite(expiration) || expiration <= now) return null
    raw = entry.value
  }
  return typeof raw === 'string' && isWithinLimit(raw) ? raw : null
}

/** 只迁移身份；不导入旧会话、序号、队列或跨数据源数据。 */
export function readLegacyMiniProgramIdentity(port: LegacyIdentityPort, source: LegacyMiniProgramIdentity, idMapping: boolean, now: number): Identity | null {
  try {
    const prefix = source.plugin ? '_growing_plugin_' : '_growing_'
    const deviceId = assignedDeviceId(value(port, `${prefix}uid_`, now))
    if (deviceId === null) return null
    const userId = value(port, `${source.storagePrefix ?? ''}${prefix}userId_`, now) || null
    const userKey = idMapping && userId !== null ? value(port, `${source.storagePrefix ?? ''}${prefix}userKey_`, now) || null : null
    return { deviceId, userId, userKey, deviceIdAssigned: true, ...(userId === null ? {} : { lastUserId: userId }) }
  } catch { return null }
}
