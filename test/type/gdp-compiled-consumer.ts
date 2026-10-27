import sdkGdp, {
  type GdpCommand,
  type GioAttributes,
  type GioGdpInitOptions,
  type GioPlugin,
} from '../../demo/uni_modules/gio-uniapp-autotracker/index.js'

const app = {
  mixin(_options: Readonly<Record<string, unknown>>): void {},
}

const options = { uniVue: app, idMapping: true } satisfies GioGdpInitOptions
const attributes = { productId: 'sku-1', amount: 99, labels: ['sale', true] } satisfies GioAttributes
const plugin: GioPlugin = { name: 'compiled-consumer-plugin', install: (growingio) => { void growingio.whenReady() } }
const command: GdpCommand = sdkGdp

command('registerPlugins', [{ name: 'gioEventAutoTracking' }, plugin])
command('init', 'account-id', 'data-source-id', options)
command('init', 'account-id', 'data-source-id', { uniVue: app, appId: 'wx123', keepAlive: 5, uploadInterval: 1000, sessionExpires: -1 })
command('track', 'purchase_completed', attributes)
command('setOptions', { dataCollect: true })

gdp('clearUserId')
gdp('setLocation', 30.2741, 120.1551)

// @ts-expect-error 只允许使用交付的 gdp 命令名称。
command('getTracker')
// @ts-expect-error 客户属性只接受基础值或基础值数组。
command('setUserAttributes', { nested: { unsafe: true } })
