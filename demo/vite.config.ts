import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

// 插件须位于 uni() 之前，在 uni-app 编译前完成 .vue 模板插桩。
const uniPlugin = (uni as unknown as { default?: typeof uni }).default ?? uni

export default defineConfig(async () => {
  const { gioUniappAutoTrack } = await import('./uni_modules/gio-uniapp-autotracker/vite.js')
  const appVerification = ['app', 'app-plus', 'app-harmony'].includes(process.env.UNI_PLATFORM ?? '')
  return {
    // 小程序使用默认生产能力；App demo 保留既有验证配置。
    define: appVerification ? { __GIO_AUTOTRACK_VERIFICATION__: true } : {},
    plugins: [gioUniappAutoTrack(), uniPlugin()],
  }
})
