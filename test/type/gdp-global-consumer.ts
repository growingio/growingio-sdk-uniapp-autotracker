import '../../index.js'

const app = {
  mixin(_options: Readonly<Record<string, unknown>>): void {},
}

gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])
gdp('init', 'account-id', 'data-source-id', { uniVue: app, dataCollect: false })
gdp('track', 'page_opened', { source: 'global-page' })

// @ts-expect-error 全局页面调用也必须拒绝错误命令名称。
gdp('trakc', 'page_opened')
