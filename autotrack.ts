// 本入口仅供 Vite 插桩生成的代码调用，与面向客户的 SDK 根入口分开。
// 业务侧运行时统一通过 gdp() 使用 SDK。
export { dispatchAutoTrack } from './src/plugins/gioEventAutoTracking/index.js'
