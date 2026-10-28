import type { AppPlatform, AppSystemContext, SystemContextPort } from '../types/index.js'

export interface AppSystemApi {
  /** 读取设备平台、型号和屏幕等信息，结果由端口安全裁剪。 */
  getDeviceInfo(): unknown
  /** 读取同步系统信息，作为设备字段及窗口信息的兼容回退。 */
  getSystemInfoSync(): unknown
  /** 读取应用版本、包标识和语言等应用上下文。 */
  getAppBaseInfo(): unknown
}

/** 将宿主系统结果限制为对象，不可用时返回空记录。 */
function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {}
}

/** 隔离宿主读取异常，使单项缺失不破坏其余系统字段。 */
function safeRecord(read: () => unknown): Readonly<Record<string, unknown>> {
  try {
    return record(read())
  } catch {
    return {}
  }
}

/** 读取非空去空白字符串，否则使用协议允许的回退值。 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** 传统 App 的部分基座不返回包名，此时通过 Native.js 读取实际安装包标识。 */
function nativeDomain(target: AppPlatform): string {
  try {
    const plus = record((globalThis as Record<string, unknown>).plus)
    const native = record(plus[target === 'iOS' ? 'ios' : 'android'])
    const invoke = native.invoke
    if (typeof invoke !== 'function') return ''
    if (target === 'Android' && typeof native.runtimeMainActivity === 'function') {
      return text(invoke.call(native, native.runtimeMainActivity.call(native), 'getPackageName'))
    }
    if (target === 'iOS') {
      const bundle = invoke.call(native, 'NSBundle', 'mainBundle')
      try { return text(invoke.call(native, bundle, 'bundleIdentifier')) }
      finally { if (typeof native.deleteObject === 'function') native.deleteObject.call(native, bundle) }
    }
  } catch { /* 宿主能力不可用时省略包名，不用 DCloud appid 冒充。 */ }
  return ''
}

/** 将宿主平台名称转换为 Android、iOS 或 HarmonyOS，其他平台不予初始化。 */
function platform(value: unknown): AppPlatform | null {
  const normalized = text(value).toLowerCase()
  if (normalized === 'android') return 'Android'
  if (normalized === 'ios') return 'iOS'
  if (normalized === 'harmony' || normalized === 'harmonyos') return 'HarmonyOS'
  return null
}

/** 只接受有限正数尺寸，避免非法值参与物理像素换算。 */
function dimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 校验设备像素比，缺失或非法时交由上层选择回退。 */
function pixelRatio(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 归一化语言与地区标记；无法识别的基础语言使用 und。 */
function language(value: unknown): string {
  const source = text(value)
  if (source === '') return 'und'
  const parts = source.replace(/_/g, '-').split('-')
  const base = parts[0]?.toLowerCase()
  if (base === undefined || !/^[a-z]{2,3}$/.test(base)) return 'und'
  return [base, ...parts.slice(1).map((part) => part.length === 4 ? `${part[0]?.toUpperCase() ?? ''}${part.slice(1).toLowerCase()}` : part.toUpperCase())].join('-')
}

/** 将可识别的设备形态转换为协议枚举，其他值为 UNKNOWN。 */
function deviceType(value: unknown): AppSystemContext['deviceType'] {
  const normalized = text(value).toUpperCase()
  return normalized === 'PHONE' || normalized === 'PAD' || normalized === 'FOLD' ? normalized : 'UNKNOWN'
}

/** Android 使用逻辑短边是否达到 600dp 区分平板布局。 */
function androidDeviceType(screenWidth: number): AppSystemContext['deviceType'] {
  return screenWidth > 0 ? (screenWidth >= 600 ? 'PAD' : 'PHONE') : 'UNKNOWN'
}

/** 将标准 uni 系统信息转换为协议上下文，不向核心暴露原始宿主对象。 */
export class AppSystemContextPort implements SystemContextPort {
  /** 绑定系统 API、SDK 版本及优先使用的业务应用版本。 */
  public constructor(private readonly api: AppSystemApi, private readonly sdkVersion: string, private readonly configuredAppVersion: string | null) {}

  /** 安全合并设备、系统和应用信息，转换物理屏幕尺寸并输出纯协议上下文。 */
  public async load(): Promise<AppSystemContext> {
    const device = safeRecord(() => this.api.getDeviceInfo())
    const system = safeRecord(() => this.api.getSystemInfoSync())
    const app = safeRecord(() => this.api.getAppBaseInfo())
    const targetPlatform = platform(device.platform ?? system.platform)
    if (targetPlatform === null) throw new Error('unsupported_platform')
    const width = dimension(device.screenWidth) ?? dimension(system.screenWidth) ?? 0
    const height = dimension(device.screenHeight) ?? dimension(system.screenHeight) ?? 0
    const ratio = pixelRatio(device.devicePixelRatio) ?? pixelRatio(system.devicePixelRatio) ?? pixelRatio(system.pixelRatio) ?? 1
    const physicalWidth = Math.round(width * ratio)
    const physicalHeight = Math.round(height * ratio)
    const domain = (targetPlatform === 'iOS' ? text(app.bundleId) : targetPlatform === 'Android' ? text(app.packageName) : text(app.bundleName ?? app.packageName)) || text(app.hostPackageName ?? system.hostPackageName) || nativeDomain(targetPlatform)
    const osVersion = text(device.osVersion, text(system.osVersion, text(device.platformVersion, text(system.system).replace(/^(?:iOS|Android|HarmonyOS)\s*/i, '') || 'UNKNOWN')))
    return {
      platform: targetPlatform,
      // 鸿蒙原生 SDK 使用 deviceInfo.displayVersion，对应 uni 的 osHarmonyDisplayVersion。
      platformVersion: targetPlatform === 'HarmonyOS'
        ? text(device.osHarmonyDisplayVersion, text(system.osHarmonyDisplayVersion, osVersion)) : osVersion,
      domain,
      appState: 'FOREGROUND',
      appName: text(app.appName),
      networkState: 'UNKNOWN',
      screenWidth: width === 0 || height === 0 ? 0 : Math.min(physicalWidth, physicalHeight),
      screenHeight: width === 0 || height === 0 ? 0 : Math.max(physicalWidth, physicalHeight),
      deviceBrand: text(device.deviceBrand ?? device.brand ?? system.deviceBrand ?? system.brand, 'UNKNOWN'),
      deviceModel: text(device.deviceModel ?? device.model ?? system.deviceModel ?? system.model, 'UNKNOWN'),
      deviceType: targetPlatform === 'Android' ? androidDeviceType(Math.min(width, height)) : deviceType(device.deviceType),
      appVersion: text(this.configuredAppVersion, text(app.appVersion, text(system.appVersion))),
      language: language(app.appLanguage ?? app.language),
      sdkVersion: this.sdkVersion,
    }
  }
}
