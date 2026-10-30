/** 填入对应平台分配的真实 appId；百度、抖音等缺少账号接口时必须显式填写。 */
export const miniProgramAppIds: Readonly<Record<string, string>> = {
  'mp-weixin': '',
  'mp-alipay': '',
  'mp-baidu': '',
  'mp-toutiao': '',
  'mp-qq': '',
  'mp-kuaishou': '',
  'mp-jd': '',
  'mp-xhs': '',
}
