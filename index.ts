import { createAppTracker, type AppRuntimeHost, type AppRuntimeOptions } from './src/platform/index.js'
import { SDK_VERSION, normalizeInitOptions, type GioInitOptions } from './src/constants/config.js'
import { createMiniProgramTracker, matchesMiniProgramAppId, type MiniProgramHost } from './src/platform/miniprogram.js'
import { resolveRuntimeTarget, type RuntimeTarget } from './src/platform/resolve.js'
import { isBuiltinPlugin, snapshotBuiltinPlugin, type GioBuiltinPlugin } from './src/core/lifecycle.js'
import { normalizeUniMPConfig, type UniMPInitOptions } from './src/plugins/gioHybridAdapter/contract.js'
import { createUniMPTracker } from './src/platform/unimp.js'
import type { NativePluginHost } from './src/platform/native-identifiers.js'
import { TrackerRuntime } from './src/core/growingIO.js'
import { installUniAppLifecycle, type UniAppVueApp } from './src/adapters/uniapp.js'
import { guid } from './src/utils/tools.js'

declare const uni: unknown
declare const __GIO_UNI_PLATFORM__: string

let singleton: TrackerRuntime | null = null
let gdpTracker: TrackerRuntime | null = null
let pendingGdpPlugins: readonly GdpPlugin[] = []

type GdpPlugin = GioBuiltinPlugin | GioPlugin

/** App SDK 只创建单例；重复请求返回首次运行时，避免重复安装生命周期、队列、存储命名空间和上传器。 */
function createGioTracker(host: AppRuntimeHost | MiniProgramHost, options: AppRuntimeOptions, target: RuntimeTarget): TrackerRuntime {
  if (singleton === null) singleton = target === 'app' ? createAppTracker(host as AppRuntimeHost, options) : createMiniProgramTracker(host, target, options)
  return singleton
}

/** 生命周期安装器所需的最小 Vue 应用接口，createSSRApp(App) 的结果满足此约束。 */
export type GioUniVueApp = UniAppVueApp

export type GioGdpInitOptions = (Omit<GioInitOptions, 'accountId' | 'dataSourceId'> & { runtime?: 'app' } | Omit<UniMPInitOptions, 'accountId' | 'dataSourceId'>) & Readonly<{
  /** 由 createSSRApp(App) 返回的 Vue 应用，SDK 通过它接管 App 和 Page 生命周期。 */
  uniVue: GioUniVueApp
}>

/** 可归一化为 GrowingIO 事件属性或用户属性字符串的基础值。 */
export type GioAttributeScalar = string | number | boolean | Date | null | undefined
export type GioAttributeValue = GioAttributeScalar | readonly GioAttributeScalar[]
export type GioAttributes = Readonly<Record<string, GioAttributeValue>>

/** 初始化完成后，仅允许在运行时修改 dataCollect。 */
export type GioMutableOptions = Readonly<{ dataCollect: boolean }>

/** 内部实例仅通过显式注册的客户插件安装参数提供。 */
export type GioPluginRuntime = TrackerRuntime

export type GioPlugin = Readonly<{
  name: string
  /** 首次有效初始化后安装客户插件；单个插件失败不阻止其他插件安装。 */
  install: (growingio: GioPluginRuntime) => void
}>

export type GioPluginRegistration = GioBuiltinPlugin | GioPlugin

/** 客户可调用的完整命令接口，不提供接受任意命令的兜底重载；未知命令或错误参数会先被 TypeScript 拒绝。 */
export interface GdpCommand {
  /** 首次 init 前声明内置或客户插件，重复名称使整批注册失败。 */
  (command: 'registerPlugins', plugins: readonly GioPluginRegistration[]): boolean
  /** 校验配置并启动异步初始化；同一运行期只允许首次成功初始化。 */
  (command: 'init', accountId: string, dataSourceId: string, options: GioGdpInitOptions): boolean
  /** 提交手动事件；true 表示本地接纳或暂存，不代表服务端接收成功。 */
  (command: 'track', eventName: string, attributes?: GioAttributes): boolean
  /** 更新登录身份；userKey 仅在初始化启用 idMapping 时生效。 */
  (command: 'setUserId', userId: string, userKey?: string | null): boolean
  /** 清除当前登录字段，保留设备身份与内部最近登录身份。 */
  (command: 'clearUserId'): boolean
  /** forceLogin 模式下，为本次等待上传的事件分配设备身份；每个运行期仅一次。 */
  (command: 'identify', deviceId: string | number): boolean
  /** 当前身份查询串，需拼入受信任的 H5 URL；未就绪或托管模式不提供身份快照。 */
  (command: 'getGioInfo'): string | null
  /** 提交用户属性事件，使用与手动事件一致的属性归一化规则。 */
  (command: 'setUserAttributes', attributes: GioAttributes): boolean
  /** 仅允许修改 dataCollect；恢复时按生命周期建立新会话，有当前页时补发 PAGE。 */
  (command: 'setOptions', options: GioMutableOptions): boolean
  /** 设置后续事件使用的内存位置，不主动定位、不请求权限。 */
  (command: 'setLocation', latitude: number, longitude: number): boolean
  /** 清除后续事件的位置字段，不修改宿主定位或持久记录。 */
  (command: 'clearLocation'): boolean
}

/** 将非数组对象视为参数记录，拒绝标量和空值。 */
function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null
}

/** 检查全局 uni 是否具备 App SDK 所需的宿主方法；缺失时拒绝初始化。 */
function runtimeHost(): Readonly<{ host: AppRuntimeHost | MiniProgramHost; target: RuntimeTarget }> | null {
  const candidate = record(typeof uni === 'undefined' ? (globalThis as Readonly<Record<string, unknown>>).uni : uni)
  const required = ['getStorageSync', 'setStorageSync', 'removeStorageSync', 'getNetworkType', 'request']
  if (candidate === null || !required.every(name => typeof candidate[name] === 'function')) return null
  const target = resolveRuntimeTarget(candidate, typeof __GIO_UNI_PLATFORM__ === 'undefined' ? undefined : __GIO_UNI_PLATFORM__)
  if (target === null || (target === 'app' && !['getDeviceInfo', 'getSystemInfoSync', 'getAppBaseInfo'].every(name => typeof candidate[name] === 'function'))) return null
  return { host: candidate as unknown as AppRuntimeHost | MiniProgramHost, target }
}

/** 确认传入的是可安装全局 mixin 的 Vue 应用。 */
function isUniVueApp(value: unknown): value is UniAppVueApp {
  const candidate = record(value)
  return candidate !== null && typeof candidate.mixin === 'function'
}

/** 校验客户插件的名称和安装方法，不在此执行插件代码。 */
function isCustomerPlugin(value: unknown): value is GioPlugin {
  const candidate = record(value)
  return candidate !== null && typeof candidate.name === 'string' && candidate.name.trim() !== '' && typeof candidate.install === 'function'
}

/** 取得插件声明的名称，供注册去重使用。 */
function pluginName(plugin: GdpPlugin): string {
  return plugin.name
}

/** 在首次初始化前原子校验并暂存插件；重复名称或非法声明使整批失败。 */
function registerGdpPlugins(value: unknown): boolean {
  if (!Array.isArray(value) || gdpTracker !== null) return false
  const plugins = value.filter((plugin): plugin is GdpPlugin => isBuiltinPlugin(plugin) || isCustomerPlugin(plugin))
  if (plugins.length !== value.length) return false
  const names = new Set(pendingGdpPlugins.map(pluginName))
  for (const plugin of plugins) {
    const name = pluginName(plugin)
    if (names.has(name)) return false
    names.add(name)
  }
  pendingGdpPlugins = [...pendingGdpPlugins, ...plugins.map(plugin => isBuiltinPlugin(plugin) ? snapshotBuiltinPlugin(plugin) : plugin)]
  return true
}

/**
 * 与独立小程序 SDK 对齐的命令入口。业务在 main.ts 注册插件，再将 Vue 应用作为 uniVue 传给 init。
 * SDK 读取全局 uni 并自行转发生命周期，业务页面统一调用 gdp()。
 *
 * @returns 命令是否被本地接纳；事件命令成功不代表采集服务已接收。
 */
export const gdp = ((command: unknown, ...args: readonly unknown[]): boolean | string | null => {
  if (command === 'registerPlugins') return registerGdpPlugins(args[0])
  if (command === 'init') {
    if (gdpTracker !== null || typeof args[0] !== 'string' || typeof args[1] !== 'string') return false
    const input = record(args[2])
    if (input === null || !isUniVueApp(input.uniVue)) return false
    const { uniVue, sdkVersion: _ignoredVersion, ...init } = input
    if (input.runtime === 'unimp') {
      const value = { ...init, accountId: args[0], dataSourceId: args[1] }
      if (normalizeUniMPConfig(value) === null || !pendingGdpPlugins.some(plugin => isBuiltinPlugin(plugin) && plugin.name === 'gioHybridAdapter')
        || pendingGdpPlugins.some(plugin => isBuiltinPlugin(plugin) && plugin.name === 'gioNativeIdentifiers')) return false
      const host = record(typeof uni === 'undefined' ? (globalThis as Readonly<Record<string, unknown>>).uni : uni) ?? {}
      // 不要求本地 App 的存储 / 请求 / 系统 API；缺少 module 在首次前台握手时报告。
      const tracker = createUniMPTracker(host as NativePluginHost)
      if (!tracker.registerPlugins(...pendingGdpPlugins.filter(isBuiltinPlugin)) || !tracker.init(value)) return false
      singleton = tracker; gdpTracker = tracker
      installUniAppLifecycle(uniVue, tracker, { host, unimp: true })
      installCustomerPlugins(tracker)
      return true
    }
    if (input.runtime !== undefined && input.runtime !== 'app') return false
    const runtime = runtimeHost()
    if (runtime === null || pendingGdpPlugins.some(plugin => isBuiltinPlugin(plugin) && plugin.name === 'gioHybridAdapter')) return false
    const { host, target } = runtime
    if (target !== 'app' && pendingGdpPlugins.some(plugin => isBuiltinPlugin(plugin) && plugin.name === 'gioNativeIdentifiers')) return false
    const config = normalizeInitOptions({ ...init, accountId: args[0], dataSourceId: args[1] }, target === 'app' ? undefined : target)
    if (!config.ok || (config.config.miniprogram !== undefined && !matchesMiniProgramAppId(host, config.config.miniprogram.appId))) return false
    const tracker = createGioTracker(host, {
      sdkVersion: SDK_VERSION,
      deviceIdFactory: guid,
      sessionIdFactory: guid,
    }, target)
    const registered = new Set(tracker.registeredPluginNames())
    const builtinPlugins = pendingGdpPlugins.filter(isBuiltinPlugin).filter((plugin) => !registered.has(plugin.name))
    if (!tracker.registerPlugins(...builtinPlugins) || !tracker.init({ ...init, accountId: args[0], dataSourceId: args[1] })) return false
    installUniAppLifecycle(uniVue, tracker, { host, miniprogram: target === 'app' ? undefined : target })
    gdpTracker = tracker
    installCustomerPlugins(tracker)
    return true
  }
  if (gdpTracker === null) return command === 'getGioInfo' ? null : false
  switch (command) {
    case 'track': return gdpTracker.track(args[0], args[1])
    case 'setUserId': return gdpTracker.setUserId(args[0], args[1])
    case 'clearUserId': return gdpTracker.clearUserId()
    case 'identify': return gdpTracker.identify(args[0])
    case 'getGioInfo': return gdpTracker.getGioInfo()
    case 'setUserAttributes': return gdpTracker.setUserAttributes(args[0])
    case 'setOptions': return gdpTracker.setOptions(args[0])
    case 'setLocation': return gdpTracker.setLocation(args[0], args[1])
    case 'clearLocation': return gdpTracker.clearLocation()
    default: return false
  }
}) as GdpCommand

function installCustomerPlugins(tracker: TrackerRuntime): void {
  for (const plugin of pendingGdpPlugins.filter(isCustomerPlugin)) {
    try { plugin.install(tracker) }
    catch { globalThis.console?.warn(`[GrowingIO]: custom plugin install failed (${plugin.name})`) }
  }
}

declare global {
  /** main.ts 导入 SDK 根入口后，uni-app 页面可使用由 SDK 声明的全局命令。 */
  const gdp: GdpCommand
}

;(globalThis as Record<string, unknown>).gdp = gdp

export default gdp

export type { GioBuiltinPlugin } from './src/core/lifecycle.js'
export type { HybridOptions, HybridReady, HybridError, HybridErrorCode } from './src/plugins/gioHybridAdapter/contract.js'
export type { NativeIdentifierField } from './src/plugins/gioNativeIdentifiers/index.js'
