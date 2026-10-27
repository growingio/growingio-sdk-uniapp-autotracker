import type { ResolvedGioConfig } from '../constants/config.js'
import { MINI_PROGRAM_PROFILES } from '../constants/platform.js'
import type { MiniProgramSystemContext, MiniProgramTarget, SystemContextPort } from '../types/index.js'
import { createUniTracker, type AppRuntimeOptions, type UniRuntimeHost } from './index.js'
import { hostRecord, readHostRecord } from './resolve.js'

export type MiniProgramHost = UniRuntimeHost & {
  getWindowInfo?: () => unknown
  getAccountInfoSync?: () => unknown
  getEnterOptionsSync?: () => unknown
  getLaunchOptionsSync?: () => unknown
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function positive(values: readonly unknown[], fallback = 0): number {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? fallback
}

function dimension(values: readonly unknown[], ratio: number): number {
  const result = Math.round(positive(values) * ratio)
  return Number.isSafeInteger(result) ? result : 0
}

/** 只用真实账号信息校验 appId；接口缺失时允许显式配置，绝不使用 DCloud appid。 */
export function matchesMiniProgramAppId(host: MiniProgramHost, appId: string): boolean {
  const account = readHostRecord(host as unknown as Record<string, unknown>, 'getAccountInfoSync')
  const actual = text(hostRecord(account.miniProgram).appId)
  return actual === '' || actual === appId
}

export class MiniProgramSystemContextPort implements SystemContextPort {
  public constructor(private readonly host: MiniProgramHost, private readonly config: ResolvedGioConfig, private readonly sdkVersion: string) {}

  public async load(): Promise<MiniProgramSystemContext> {
    const config = this.config.miniprogram!
    const host = this.host as unknown as Record<string, unknown>
    const system = readHostRecord(host, 'getSystemInfoSync')
    const device = readHostRecord(host, 'getDeviceInfo')
    const window = readHostRecord(host, 'getWindowInfo')
    const app = readHostRecord(host, 'getAppBaseInfo')
    const account = hostRecord(readHostRecord(host, 'getAccountInfoSync').miniProgram)
    const profile = MINI_PROGRAM_PROFILES[config.target]
    const rawOs = text(device.osName, text(device.platform, text(system.osName, text(system.platform, 'UNKNOWN'))))
    const normalizedOs = rawOs.toLowerCase()
    const os = normalizedOs === 'android' ? 'Android' : normalizedOs === 'ios' ? 'iOS'
      : normalizedOs === 'harmonyos' || normalizedOs === 'ohos' ? 'HarmonyOS' : rawOs
    const ratio = positive([window.pixelRatio, device.devicePixelRatio, system.pixelRatio], 1)
    const version = text(app.hostVersion, text(system.hostVersion, text(system.version)))
    return {
      platform: profile.platform, platformVersion: profile.name + (version === '' ? '' : ` ${version}`),
      domain: config.appId, deviceType: `${profile.name}-${os}`, operatingSystem: `${profile.name}-${os}`,
      appVersion: this.config.appVersionFallback ?? text(account.version), sdkVersion: this.sdkVersion,
      networkState: 'UNKNOWN', language: text(system.language, text(app.hostLanguage, text(app.language, 'und'))),
      screenWidth: dimension([window.screenWidth, device.screenWidth, system.screenWidth], ratio),
      screenHeight: dimension([window.screenHeight, device.screenHeight, system.screenHeight], ratio),
      deviceBrand: text(device.deviceBrand, text(device.brand, text(system.brand, 'UNKNOWN'))),
      deviceModel: text(device.deviceModel, text(device.model, text(system.model, 'UNKNOWN'))),
    }
  }
}

export function createMiniProgramTracker(host: MiniProgramHost, target: MiniProgramTarget, options: AppRuntimeOptions) {
  return createUniTracker(host, options, config => new MiniProgramSystemContextPort(host, config, options.sdkVersion), target)
}
