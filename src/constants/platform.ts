import { CHANGE_ELEMENTS, type ChangeElement } from '../plugins/gioEventAutoTracking/contract.js'
import type { AppPlatform, MiniProgramTarget, MiniProgramPlatform } from '../types/index.js'

export type AppCapabilityProfile = Readonly<{
  platform: AppPlatform
  appLifecycle: boolean
  pageLifecycle: boolean
  autoClick: boolean
  autoChange: Readonly<Record<ChangeElement, boolean>>
  changeInput: boolean
  changePicker: boolean
  tabBar: boolean
  appClosedBestEffort: boolean
}>

export type AutoTrackCapabilityProfile = Omit<AppCapabilityProfile, 'platform'> & Readonly<{ platform: AppPlatform | MiniProgramPlatform }>

export const MINI_PROGRAM_PROFILES = {
  'mp-weixin': { platform: 'MinP', name: 'Weixin', scenePrefix: '' },
  'mp-alipay': { platform: 'alip', name: 'Alipay', scenePrefix: 'alip_' },
} as const

/** 小程序能力与 App 分开验收；验证构建不修改生产矩阵。 */
export function miniProgramCapabilityProfile(target: MiniProgramTarget, verificationBuild = false): AutoTrackCapabilityProfile {
  return {
    ...unverified('Android'), platform: MINI_PROGRAM_PROFILES[target].platform,
    autoClick: verificationBuild, tabBar: verificationBuild,
    changeInput: verificationBuild, changePicker: verificationBuild,
    autoChange: Object.fromEntries(CHANGE_ELEMENTS.map(element => [element, verificationBuild])) as Record<ChangeElement, boolean>,
  }
}

/** 静态测试只能证明代码结构；平台、编译器版本、真机请求和服务端收数证据齐全前，各项 App 能力保持未验收状态。 */
const unverified = (platform: AppPlatform): AppCapabilityProfile => ({
  platform,
  appLifecycle: false,
  pageLifecycle: false,
  autoClick: false,
  autoChange: Object.fromEntries(CHANGE_ELEMENTS.map((element) => [element, false])) as Record<ChangeElement, boolean>,
  changeInput: false,
  changePicker: false,
  tabBar: false,
  appClosedBestEffort: false,
})

const profiles: Readonly<Record<AppPlatform, AppCapabilityProfile>> = {
  Android: unverified('Android'),
  iOS: unverified('iOS'),
  HarmonyOS: unverified('HarmonyOS'),
}

/** 按系统选择已验收能力；专用验证构建只开放待测链路，不修改生产能力表。 */
export function appCapabilityProfile(platform: unknown, verificationBuild = false): AppCapabilityProfile | null {
  const profile = typeof platform === 'string' && Object.prototype.hasOwnProperty.call(profiles, platform) ? profiles[platform as AppPlatform] : null
  if (profile === null || !verificationBuild) return profile
  // demo 的显式验证构建只开放采集链路，不回写已验收能力表。
  return {
    ...profile, autoClick: true, tabBar: true, changeInput: true, changePicker: true,
    autoChange: Object.fromEntries(CHANGE_ELEMENTS.map((element) => [element, true])) as Record<ChangeElement, boolean>,
  }
}

/** 列出各 App 平台的生产能力配置，供验收检查使用。 */
export function allAppCapabilityProfiles(): readonly AppCapabilityProfile[] {
  return Object.values(profiles)
}
