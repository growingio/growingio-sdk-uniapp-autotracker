import type { MiniProgramPlatform, MiniProgramTarget } from '../types/index.js'

/** 平台事实与无埋点验收状态分开，运行入口和协议共用同一份映射。 */
export const MINI_PROGRAM_PROFILES = {
  'mp-weixin': { platform: 'MinP', name: 'Weixin', scenePrefix: '', global: 'wx' },
  'mp-alipay': { platform: 'alip', name: 'Alipay', scenePrefix: 'alip_', global: 'my' },
  'mp-baidu': { platform: 'baidup', name: 'Baidu', scenePrefix: 'baidup_', global: 'swan' },
  'mp-toutiao': { platform: 'bytedance', name: 'Bytedance', scenePrefix: 'bytedance_', global: 'tt' },
  'mp-qq': { platform: 'qq', name: 'QQ', scenePrefix: 'qq_', global: 'qq' },
  'mp-kuaishou': { platform: 'kuaishoup', name: 'KuaiShou', scenePrefix: 'ks_', global: 'ks' },
  'mp-jd': { platform: 'jdp', name: 'JingDong', scenePrefix: 'jd_', global: 'jd' },
  'mp-xhs': { platform: 'xhsp', name: 'XiaoHongShu', scenePrefix: 'xhs_', global: 'xhs' },
} as const satisfies Readonly<Record<MiniProgramTarget, { platform: MiniProgramPlatform; name: string; scenePrefix: string; global: string }>>

export const MINI_PROGRAM_TARGETS = Object.keys(MINI_PROGRAM_PROFILES) as MiniProgramTarget[]

/** 只接受已实现的目标，避免继承属性或相近生态被误认为已支持。 */
export function isMiniProgramTarget(value: string): value is MiniProgramTarget {
  return Object.prototype.hasOwnProperty.call(MINI_PROGRAM_PROFILES, value)
}

export function miniProgramProfileForPlatform(platform: unknown) {
  return Object.values(MINI_PROGRAM_PROFILES).find(profile => profile.platform === platform)
}
