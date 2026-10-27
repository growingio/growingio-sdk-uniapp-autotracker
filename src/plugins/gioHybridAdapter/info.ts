import type { Identity } from '../../core/userStore.js'

/** 与 Web SDK gioEmbeddedAdapter 对齐的查询串；不创建会话或改变身份。 */
export function embeddedGioInfo(input: Readonly<{
  collecting: boolean
  appId: string
  accountId: string
  dataSourceId: string
  platform: string
  sessionId: string | null
  identity: Identity
  idMapping: boolean
  newDevice: boolean
}>): string | null {
  if (input.appId.trim() === '' || input.collecting && input.sessionId === null) return null
  const fields: Record<string, string | boolean> = {
    gioappid: input.appId, gioprojectid: input.accountId, giodatasourceid: input.dataSourceId,
    giodatacollect: input.collecting,
    ...(input.collecting ? {
      gioplatform: input.platform, gios: input.sessionId!, giou: input.identity.deviceId,
      giocs1: input.identity.userId ?? '', gionewdevice: input.newDevice,
      ...(input.idMapping ? { giouserkey: input.identity.userKey ?? '' } : {}),
    } : {}),
  }
  try { return Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&') }
  catch { return null }
}
