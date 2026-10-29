# gio-uniapp-autotracker

传统 uni-app Vue 3 数据采集 SDK，包含 Android、iOS、HarmonyOS `.vue` App，以及微信、支付宝、百度、抖音、QQ、快手、京东和小红书小程序的运行适配。小程序已完成代码与自动化验证，开发者工具交互和真机收数后补。

高级身份、旧小程序身份迁移、H5 身份快照、App 可选标识及 uniMP 托管桥接已实现 JS 路径。原生宿主 module 与真机收数按约定后续联调。

## 文档

- [全端 Measurement Protocol](./doc/measurement-protocol.md)：唯一的事件字段与端间口径来源。
- [SDK 架构设计](./doc/uniapp-sdk-development.md)：目录、模块边界、依赖方向和运行时数据链。
- [八端小程序接入](./doc/miniprogram.md)：平台映射、appId、会话、内存队列、上传策略、无埋点门控及验证命令。
- [高级身份、H5 与原生扩展](./doc/advanced-identity-hybrid.md)：identify / forceLogin、旧身份迁移、H5 身份快照、App 标识增强及 uniMP JS 接入；原生 module 后续联调。
- [八端扩展验证记录](./doc/miniprogram-platforms-validation-2026-10-27.md)：六端新增适配、现有平台回归、开发／生产构建及交付检查。
- [本轮适配审查记录](./doc/miniprogram-review-2026-10-27.md)：App 兼容对照、边界修复及自动化结果。
- [小程序平台支持调研与开发方案](./doc/miniprogram-support-development-plan.md)：八个平台的调研、分批实施与验收门槛；八端基础代码已实现，端侧验收后补。
- [uni 小程序与原生宿主打通设计](./doc/unimp-native-hybrid-design.md)：含 [module 详细契约](./doc/unimp-native-bridge-contract.md) 和 [设计自审](./doc/unimp-native-hybrid-review.md)；JS SDK 已实现，Android / iOS module 与真机验收后补。
- [传统 uni-app 无埋点方案](./doc/uniapp-autotrack-design.md)：模板事件标识、插桩、隐私、去重和验收口径。
- [安装与发布](./doc/release.md)：npm、uni_modules 接入、版本渠道和自动发布配置。
- [开发计划](./doc/development-plan.md)：按依赖顺序拆分的实施、验证与发布门槛。
- [核心代码测试](./doc/testing.md)：全部核心功能的测试矩阵、覆盖率门槛与打包发布前验收。

仓库根目录就是 SDK 包根目录。`uni_modules/gio-uniapp-autotracker` 仅是使用方工程或发布压缩包中的安装位置，不在本仓库内再嵌套一层。

源码集中在 `src/`，沿用 Web / 小程序 SDK 的领域组织：`core/growingIO.ts` 保留稳定运行时门面，`core/localRuntime.ts` 协调 App / 小程序本地采集，`core/userStore.ts` 管理身份与会话，`core/dataStore/` 管理事件和页面，`core/storage/` 管理持久化；`plugins/`、`adapters/`、`platform/`、`compiler/` 分别放运行时插件、框架接入、宿主能力和编译插桩。根目录的 `index.ts`、`autotrack.ts`、`vite.ts` 是三个公开入口，完整目录及依赖边界见[架构文档](./doc/uniapp-sdk-development.md#4-工程结构与依赖方向)。

## Vue 3 / App 接入

选择一种安装方式，同一个应用不要同时加载两份 SDK：

- npm：`npm install gio-uniapp-autotracker`，按下方包名导入。
- uni_modules：下载 GitHub Release 的 `*-uni_modules.tgz`，解压后将 `uni_modules/gio-uniapp-autotracker` 放入项目根目录。运行时导入 `@/uni_modules/gio-uniapp-autotracker/index.js`；Vite 配置导入 `./uni_modules/gio-uniapp-autotracker/vite.js`。

两种渠道均为 ESM JavaScript + `.d.ts`。Vite 入口已预设各自探针路径，正常接入均调用 `gioUniappAutoTrack()`；非标准目录可通过 `runtimeImport` 覆盖。编译插件包含自己的解析器，不要求接入方额外安装 Vue/Babel 编译依赖。

在应用入口创建 App 后，按小程序 SDK 一样调用 `gdp('registerPlugins')` 和 `gdp('init')`。`init` 传入 `uniVue: app` 后，SDK 自己读取 `uni` 宿主，并以全局 Vue mixin 自动接管 App / Page 生命周期；业务的 `App.vue` 和页面不需要引入 lifecycle bridge。

```ts
import gdp from 'gio-uniapp-autotracker'

export function createApp() {
  const app = createSSRApp(App)
  gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])
  gdp('init', 'account-id', 'data-source-id', {
    uniVue: app,
    serverUrl: 'https://collector.example.com',
    dataCollect: true,
  })
  return { app }
}
```

初始化时，非必填配置缺省、类型错误或超出范围都回退各自默认值，不阻断 SDK 初始化。App 的 `sessionExpires` 默认 0.5 分钟，支持正小数且最大 360 分钟；`-1`、NaN、Infinity、超限等非法值使用默认值。必填的账户、数据源和 `uniVue` 仍需有效；小程序还需真实平台 `appId`。

App 的 `appVersion` 优先使用初始化时显式传入的非空字符串，去掉首尾空白；未传、空白或非法值时，依次读取 `uni.getAppBaseInfo().appVersion`、`uni.getSystemInfoSync().appVersion`。均不可用时省略该字段，不影响采集。例如配置 `appVersion: '1.0.0'` 后，即使安装包版本为 `0.1.0`，新事件也会上报 `1.0.0`。

App 离线积压超过 200 条或 2MiB 后仍可继续接纳并尝试持久化；成功落盘的事件可在冷启动后恢复，联网后每批最多发送 50 条、512KiB。缓存按原事件时间保留 7 天，实际可保存量受宿主存储容量约束。小程序使用当前运行期内的有界内存队列。

业务侧只通过 `gdp()` 调用 SDK，例如 `gdp('track', 'purchase', { sku: 'sku-1' })`。SDK 不向页面暴露 tracker 或 `$gio`；只有显式通过 `gdp('registerPlugins', [...])` 注册的客户插件会在 `install(growingio)` 中收到内部实例。自动页面/App 生命周期不再要求页面代码配合。

## TypeScript 类型

根入口会在客户项目中自动声明全局 `gdp`，无需额外的 `.d.ts` 文件；默认导入和全局调用具有同一组严格的命令重载。可从根入口按需导入 `GdpCommand`、`GioGdpInitOptions`、`GioUniVueApp`、`GioAttributes`、`GioPlugin` 和 `GioPluginRuntime` 等类型：

```ts
import gdp, { type GioAttributes, type GioGdpInitOptions } from 'gio-uniapp-autotracker'

const options = {
  uniVue: app,
  dataCollect: false,
  idMapping: true,
} satisfies GioGdpInitOptions

const attributes = { sku: 'sku-1', price: 99, tags: ['new', 'sale'] } satisfies GioAttributes
gdp('init', 'account-id', 'data-source-id', options)
gdp('track', 'purchase_completed', attributes)
```

支持的业务命令为 `track`、`setUserId`、`clearUserId`、`setUserAttributes`、`identify`、`getGioInfo`、`setOptions({ dataCollect })`、`setLocation` 和 `clearLocation`；`registerPlugins` 与 `init` 是入口命令。除 `getGioInfo` 返回 `string | null` 外，其余命令返回本地接纳结果。高级能力的启用方式及 uniMP 限制见[接入说明](./doc/advanced-identity-hybrid.md)。未知命令、错误参数个数、嵌套属性或非布尔 `dataCollect` 均会在 TypeScript 编译期报错。`GioPluginRuntime` 只会作为显式注册插件的 `install(growingio)` 参数出现，页面代码仍只能调用 `gdp()`。

无埋点的模板插桩是一个构建期能力，因此 Vue 3/Vite 项目仍需在 `vite.config.ts` 增加一次插件（且必须排在 `uni()` 前）。这项配置不能放在运行时 `main.ts`，因为模板在应用代码执行前就已编译：

```ts
import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

const uniPlugin = (uni as unknown as { default?: typeof uni }).default ?? uni
export default defineConfig(async () => {
  const { gioUniappAutoTrack } = await import('gio-uniapp-autotracker/vite')
  return { plugins: [gioUniappAutoTrack(), uniPlugin()] }
})
```

异步导入支持未声明 `"type": "module"` 的现有 Vite 配置，不要求更改整个业务工程的模块类型。uni_modules 将上面的导入路径替换为 `./uni_modules/gio-uniapp-autotracker/vite.js`。已使用 ESM 配置的工程也可静态导入，详见[安装说明](./doc/release.md)。

无埋点处理当前白名单内的内置组件静态 `@click`、`@tap` 与 `@change`；input/textarea 的输入完成采集优先使用 `@blur`，未声明 blur 时使用 `@confirm`。普通模板 `xpath` 在 runtime 按小程序口径生成 `id#eventName`；`uni-link` 使用 `#openURL`，tabBar 使用 `#onTabItemTap`。input/textarea 按 `blur → confirm → change` 只选择一个已声明的完成事件插针，原业务 handler 全部保留。传统 App 不转发输入框的原生 change；仅声明 `@change` 时保留兼容插桩，但不会补发事件，应改用 blur / confirm。`data-growing-ignore` 和敏感输入会拒绝整条采集，`data-growing-track` 不能覆盖敏感规则；非敏感 `change` 值仅在显式标记 track 时传递。`data-index` 仅接受大于 0 且小于 2147483647 的整数。动态事件、自定义组件、修饰符及歧义 listener 表达式保持业务代码不变、不插桩并产生构建告警。`.nvue` 不在一期模板插桩范围内，也会产生构建告警。完整规则见[无埋点方案](./doc/uniapp-autotrack-design.md)。

业务行为不变是插桩的前提。可安全分析的显式调用（如 `save($event)`）、带简单首参数的同步函数和两侧均为显式调用的简单条件表达式可以插桩。`@click="save"`、`actions.save`、条件返回函数、复杂组件选项等保持源码原样并告警，不会擅自改成调用。需要精确采集这些交互时可在业务原有 handler 中调用 `gdp('track', ...)`，不要为了消除告警随意改写业务模板。

对明确不需要自动采集的监听，可声明静态启用的 `data-growing-ignore`：编译器保留原监听，不再报告采集边界告警。false / 0、动态 ignore 或可能被 `v-bind` 覆盖的标记仍保留诊断；模板语法错误和缺失 handler 也仍会报告。此规则不扩大支持的事件或表达式范围。

动态绑定只由原模板求值，SDK 不在事件时重新求值 getter、range 或其他绑定。动态 `data-*` 依赖宿主原生 dataset；picker 的动态 range 无法安全取文案时使用下标，动态链接可由业务明确提供 `data-src`。静态字面量仅在不会被展开绑定、动态属性名或绑定修饰符覆盖时作为授权/文案补充；静态 ignore/sensitive 仍保守拒绝采集。picker-view 的条件渲染或动态文案也使用下标回退。

编译侧 Vue 解析器固定为 `3.4.21`，随 Vite 工具打包，与 App 运行时隔离。SDK 上报版本固定取包版本，不能由 `init` 参数覆盖。

自动测试与 HBuilderX 编译检查不等于三端真机验收。[2026-10-19 安卓真机报告](./doc/android-device-validation-2026-10-19.md)和[鸿蒙实机报告](./doc/harmony-device-validation-2026-10-19.md)已记录各自单台设备的原生交互、实际请求与本地 collector 接收结果及能力限制；iOS、多设备及生产服务端验收仍待补齐，发布边界见[无埋点发布说明](./doc/autotrack-v2-release.md)。

`src/constants/platform.ts` 的能力表同时参与无埋点运行时门控。当前三端 `autoClick`、`tabBar` 和逐组件 `autoChange` 全部为 `false`，因此默认不发送模板或 tabBar 的 `VIEW_*`。待对应端的编译版本、真机请求和 collector 接收记录归档后，再逐项开放；单元测试使用内部受控宿主配置；demo 通过专用构建常量 `__GIO_AUTOTRACK_VERIFICATION__` 显式开放待验收链路，便于实机验证。验证开关不会改变生产验收状态，正式应用不要复制。

`debug: true` 只在本地输出 `[GrowingIO Debug]:` 的操作标签与即将派发的协议事件数组；不会输出队列内部元数据，也不会改变隐私、重试或采集行为。

## Showcase demo

先运行 `pnpm build:sdk`，它将编译产物写入 `demo/uni_modules/gio-uniapp-autotracker`。然后可用 HBuilderX 打开 [demo](./demo) 目录；demo 只引用这份编译产物，不跨目录引用 SDK 源码。它默认采集，以便启动后验证 `VISIT`、生命周期、`track`、身份和用户属性、路由上下文、无埋点业务交互及 `dataCollect` 动态开关；如需隐私同意流程，可在 `demo/sdk-state.ts` 将 `enabled` 设为 `false` 后通过示例页恢复采集。ABTest 和微信分享会明确显示为当前未实现，而非模拟接口结果。详见 [demo/README.md](./demo/README.md)。

schema v2 与旧编译探针互不兼容，升级时必须整体重新构建 App。同名 handler 无 id 时使用相同标识；需区分的元素应补稳定 `id`，列表附加维度使用规范正整数 `data-index`。迁移说明见[无埋点发布说明](./doc/autotrack-v2-release.md)。

## 发布目录

执行 `pnpm run test:release` 可运行项目级类型检查、全部自动化测试和逐文件覆盖率检查。执行 `pnpm run release:prepare` 会先通过这些代码检查，再构建、打包并验证交付包；任一步失败立即停止。功能覆盖矩阵及报告位置见[核心代码测试](./doc/testing.md)。

同一次构建生成 `dist/npm` 和 `dist/uni_modules/gio-uniapp-autotracker`，最终压缩包及摘要在 `dist/release`。`demo/uni_modules` 同步使用生成产物；这些目录均不提交 Git。`release:check` 可单独复检已有交付包，`release:publish` 在发布前会再次执行代码测试及交付包检查。

推送与 `package.json.version` 一致的 `v版本号` 标签会触发 GitHub Actions：检查、构建、独立安装验证、npm 发布和 GitHub Release 附件上传。正式版走 `latest`，预发布走 `next` 并标记 GitHub prerelease。DCloud 插件市场暂不上架。首次发布前需完成 npm 所有权及 Trusted Publisher 配置，操作流程见[安装与发布](./doc/release.md)。
