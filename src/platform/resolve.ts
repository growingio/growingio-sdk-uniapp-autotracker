import type { MiniProgramTarget } from '../types/index.js'

export type RuntimeTarget = 'app' | MiniProgramTarget
type Host = Readonly<Record<string, unknown>>

export function hostRecord(value: unknown): Host {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Host : {}
}

/** 可选宿主方法保留 this，读取失败仅丢弃该项系统信息。 */
export function readHostRecord(host: Host, name: string): Host {
  try { return typeof host[name] === 'function' ? hostRecord(host[name].call(host)) : {} }
  catch { return {} }
}

function targetOf(value: string): RuntimeTarget | null {
  if (value === 'app' || value === 'app-plus' || value === 'app-harmony') return 'app'
  return value === 'mp-weixin' || value === 'mp-alipay' ? value : null
}

/** 显式目标优先且必须一致；无目标的旧 App 保留原有完整宿主检查。 */
export function resolveRuntimeTarget(host: Host, buildTarget?: unknown, globals: Host = globalThis as Host): RuntimeTarget | null {
  const app = readHostRecord(host, 'getAppBaseInfo')
  const system = readHostRecord(host, 'getSystemInfoSync')
  const hints = [buildTarget, app.uniPlatform, system.uniPlatform].filter((value): value is string => typeof value === 'string' && value.trim() !== '').map(value => value.trim())
  if (hints.length > 0) {
    const target = targetOf(hints[0]!)
    return target !== null && hints.every(value => targetOf(value) === target) ? target : null
  }
  const candidates = (['wx', 'my'] as const).filter(name => typeof hostRecord(globals[name]).request === 'function')
  if (candidates.length > 1) return null
  if (candidates.length === 1) return candidates[0] === 'wx' ? 'mp-weixin' : 'mp-alipay'
  const required = ['getDeviceInfo', 'getAppBaseInfo', 'getSystemInfoSync']
  if (!required.every(name => typeof host[name] === 'function')) return null
  const os = readHostRecord(host, 'getDeviceInfo').platform ?? system.platform
  return typeof os === 'string' && ['android', 'ios', 'harmony', 'harmonyos'].includes(os.trim().toLowerCase()) ? 'app' : null
}
