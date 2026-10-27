import App from './App.vue'
import { createSSRApp } from 'vue'
import gdp from '@/uni_modules/gio-uniapp-autotracker/index.js'
import { dataCollectionState } from './sdk-state'

/** 创建 Vue 应用，先注册插件再初始化 SDK，并将应用交给生命周期安装器。 */
export function createApp() {
  const app = createSSRApp(App)
  // 沿用小程序 SDK 的接入顺序：先注册插件，再执行一次初始化。
  gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])
  // 小程序从真实账号信息提供 appId；App 沿用原有初始化参数。
  let miniAppId: string | undefined
  try {
    if (typeof uni.getAccountInfoSync === 'function') miniAppId = uni.getAccountInfoSync().miniProgram?.appId
  } catch { /* 账号信息不可用时，小程序需在这里显式配置真实 appId。 */ }
  gdp('init', 'demo-account', 'demo-source', {
    uniVue: app,
    idMapping: true,
    debug: true,
    dataCollect: dataCollectionState.enabled,
    ...(miniAppId ? { appId: miniAppId, appVersion: '0.1.0' } : {}),
  })
  return { app }
}
