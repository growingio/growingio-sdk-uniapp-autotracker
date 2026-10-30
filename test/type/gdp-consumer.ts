import gdp, {
  type GdpCommand,
  type GioAttributes,
  type GioGdpInitOptions,
  type GioPlugin,
  type GioPluginRuntime,
} from '../../index.js'

const app = {
  mixin(_options: Readonly<Record<string, unknown>>): void {},
}

const attributes = {
  sku: 'sku-1',
  price: 99,
  member: true,
  receivedAt: new Date(),
  tags: ['new', null, 1, false],
} satisfies GioAttributes

const initOptions = {
  uniVue: app,
  serverUrl: 'https://collector.example.com',
  dataCollect: false,
  idMapping: true,
  sessionExpires: 5,
} satisfies GioGdpInitOptions

const customerPlugin: GioPlugin = {
  name: 'customer-plugin',
  install(growingio) {
    const runtime: GioPluginRuntime = growingio
    void runtime.whenReady()
  },
}

const command: GdpCommand = gdp

command('registerPlugins', [{ name: 'gioEventAutoTracking' }, customerPlugin])
command('init', 'account-id', 'data-source-id', initOptions)
command('init', 'account-id', 'data-source-id', { uniVue: app, appId: 'wx123', keepAlive: 5, uploadInterval: 1000, sessionExpires: -1 })
// @ts-expect-error 小程序聚合间隔必须为数值。
command('init', 'account-id', 'data-source-id', { uniVue: app, uploadInterval: '1000' })
command('track', 'purchase_completed', attributes)
command('setUserId', 'user-1', 'email')
command('setUserId', 'user-1', null)
command('clearUserId')
command('setUserAttributes', attributes)
command('setOptions', { dataCollect: true })
command('setLocation', 30.2741, 120.1551)
command('clearLocation')
command('identify', 'assigned-device')
command('identify', 123)
const gioInfo: string | null = command('getGioInfo')
void gioInfo
command('registerPlugins', [{ name: 'gioHybridAdapter', options: { transport: 'native-module', onReady: state => { void state.identityBlocked }, onError: error => { void error.outcome } } }])
command('registerPlugins', [{ name: 'gioNativeIdentifiers', options: { fields: ['oaid', 'androidId'] } }])
command('init', 'account-id', 'data-source-id', { uniVue: app, runtime: 'unimp', appId: '__UNI__guest', idMapping: true })
command('init', 'account-id', 'data-source-id', { uniVue: app, appId: 'wx123', forceLogin: true,
  legacyMiniProgramIdentity: { appId: 'wx123', accountId: 'account-id', dataSourceId: 'data-source-id' } })
// @ts-expect-error identify 不接受对象。
command('identify', { id: 'device' })
// @ts-expect-error getGioInfo 返回可空查询串，不能当作布尔命令。
const infoAccepted: boolean = command('getGioInfo')
// @ts-expect-error 不提供未知的原生传输实现。
command('registerPlugins', [{ name: 'gioHybridAdapter', options: { transport: 'host-event' } }])
// @ts-expect-error 标识增强需要明确选择已支持字段。
command('registerPlugins', [{ name: 'gioNativeIdentifiers', options: { fields: ['unknown'] } }])

// @ts-expect-error 未知命令不属于客户 API。
command('getTracker')
// @ts-expect-error 嵌套对象不能作为事件属性。
command('track', 'purchase_completed', { order: { id: 'order-1' } })
// @ts-expect-error dataCollect 必须为布尔值，且是唯一可变选项。
command('setOptions', { idMapping: true })
// @ts-expect-error 公开位置接口只接受数值参数。
command('setLocation', '30.2741', 120.1551)
// @ts-expect-error init 必须接收 SDK 使用的 Vue 应用引用。
command('init', 'account-id', 'data-source-id', { dataCollect: true })
