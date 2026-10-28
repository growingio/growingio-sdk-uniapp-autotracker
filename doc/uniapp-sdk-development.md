# 传统 uni-app App 数据采集 SDK 开发文档

> **2026-10-27 平台扩展：**微信、支付宝、百度、抖音、QQ、快手、京东和小红书已增加独立平台配置，复用 core 与 uni 端口；配置、会话、报文及存储差异以[小程序接入](./miniprogram.md)为准。本文的一期章节继续定义现有 App 基线，不表示小程序沿用 App 会话、队列或协议。最新状态见[八端验证记录](./miniprogram-platforms-validation-2026-10-27.md)，真机收数按约定后补。

> **文档状态：开发设计基线**
>
> **一期范围：传统 uni-app、Vue 3、Android / iOS / HarmonyOS App、`.vue` 页面**
>
> **非一期范围：H5、小程序、Vue 2、`.nvue` 的完整无埋点、任意第三方/业务自定义组件的自动识别**
> **UTS 定位：一期不依赖；原生增强留待二期，且不是 SDK 的主运行时。**

> **扩展实现：**高级身份、内嵌 H5 与原生增强见[接入说明](./advanced-identity-hybrid.md)；原生宿主内 `.wgt` 使用独立 uniMP 托管模式。JS SDK 已实现，Android / iOS module 与真机收数后补，不把默认独立 App 模式当作 Native 打通。

本文是独立的传统 uni-app SDK 实施说明，不是现有 `gio-uniappx-autotracker` 的接入文档，也不建议把其中的 UTS 实现直接复制过来。目标是以 Vue 和 `uni.*` API 为主，在 Android、iOS、HarmonyOS 三端提供一致的手动埋点、页面埋点和受控无埋点能力。

一期以 `gio-uniappx-autotracker` 的**实际公开能力**为功能上限：保留 init、生命周期事件、track、身份/用户属性、`dataCollect`、定位、基础无埋点和已验证的内置插件入口；不因 Android/iOS/Web 独立 SDK 另有能力而提前加入。uniappx 当前没有的手动 PAGE、公开 flush/destroy/re-init、运行时 `autotrack`/`trackPage`/`debug` 开关、通用插件 capability/storage/request 体系、通用属性、事件计时器、原生设备标识增强和诊断查询 API，均放入二期。队列、批量和超时是一期内部固定策略；session 默认值由 profile 提供，但允许在 `init()` 中以 `sessionExpires` 覆盖。

> **协议来源：**事件字段、必填性、端间差异和报文示例以本仓库的 [Measurement Protocol](./measurement-protocol.md) 为唯一来源。本文件定义 SDK 的运行时与工程设计，不重复定义另一套字段协议。

---

## 1. 一句话设计

把 SDK 做成一台运行在传统 uni-app Vue 应用内的“事件记录器”：

1. 由 SDK 在 `main.ts` 初始化时安装的全局 Vue mixin 接管 App / Page 生命周期，建立访问、会话和页面上下文；
2. 由 Vue 3/Vite 的**模板编译插桩**记录点击和变更，不依赖 DOM；
3. 由纯 TS/JS core 构建事件、管理身份、缓存和上传；
4. 一期由基于 `uni.request` 的 App 请求适配器和 `uni.storage` 完成基础能力；core 只依赖标准请求端口；
5. 一期只使用标准 `uni.*` API；原生增强在二期再以 UTS 提供。

```text
业务 App.vue / 页面 .vue / Vite 编译链
              │
              ├─ 生命周期桥接（App / Page）
              ├─ 编译期 click/change 插桩
              ▼
       uniapp-vue-runtime（纯 TS）
              ▼
 sdk-core（事件、身份、session、队列、上传、插件）
              ▼
 platform-app（uni.request / uni.storage / system info）
              ├─ Android
              ├─ iOS
              └─ HarmonyOS
```

二期若经批准，再在 `platform-app` 下方接入可选 UTS 原生增强；一期没有这条依赖。

传统 uni-app 的重点是 Vue：`App.vue` 是应用入口，应用生命周期只能在其中监听；页面则是 `.vue` 或 `.nvue`。因此生命周期和模板编译才是架构第一层，UTS 不应反过来主导它们。[App.vue](https://uniapp.dcloud.net.cn/collocation/App.html) [页面说明](https://uniapp.dcloud.net.cn/tutorial/page.html)

---

## 2. 目标、非目标与发布承诺

### 2.1 一期目标

| 能力 | Android | iOS | HarmonyOS | 一期承诺 |
|---|:---:|:---:|:---:|---|
| 初始化、隐私开关、手动埋点 | ✓ | ✓ | ✓ | 必须一致 |
| visitor / user / session | ✓ | ✓ | ✓ | 必须一致 |
| `VISIT`、`PAGE`、`APP_CLOSED` | ✓ | ✓ | ✓ | `APP_CLOSED` 为尽力发送 |
| `VIEW_CLICK` | ✓ | ✓ | ✓ | 内置组件 + 显式标记 |
| `VIEW_CHANGE` 基础语义 | ✓ | ✓ | 条件支持 | Harmony 必须通过真机门槛后才可宣称支持 |
| 离线队列、批量、超时、有限重试 | ✓ | ✓ | ✓ | 必须一致 |
| Vue3 Options API / Composition API | ✓ | ✓ | ✓ | 必须一致 |
| `.vue` 页面 | ✓ | ✓ | ✓ | 必须一致 |

### 2.2 明确不承诺

- 任何 UI 库或业务自定义组件无需接入就能被自动识别；
- `.nvue`、weex 模式、原生页面、web-view 内 H5 的自动埋点；
- `APP_CLOSED` 一定发送成功。进入后台、系统杀进程、崩溃、网络中断都可能使最后一次请求失败；
- 任何输入框内容自动上报；
- iOS/Android 广告或设备标识（如 `idfa`、`oaid`、`imei`）的原生读取与上报；
- HarmonyOS 的所有 `change` 类型。先完成真实工程和真机验证，再按组件白名单开放；
- Vue2 / Webpack 的实现。接口和目录预留，但一期不交付该编译适配器。
- 事件计时器。`trackTimerStart/pause/resume/end/remove/clear` 及 CUSTOM.attributes 中的 `event_duration` 留到二期，不在一期暴露空 API 或伪实现。

### 2.3 版本与环境基线

- 项目类型：传统 uni-app，Vue 3；不是 uni-app x / `.uvue`；
- 产物：`uni_modules/gio-uniapp-autotracker`；
- 运行端：App Android、App iOS、App HarmonyOS；
- 构建端：Vue3/Vite。官方说明 Vue2 的编译器基于 Webpack、Vue3 基于 Vite，二者必须分别适配。[编译器说明](https://uniapp.dcloud.net.cn/tutorial/compiler.html)
- UTS：二期如以 `uni_modules` UTS 插件形式提供原生增强，传统 uni-app 是 JS 调用 UTS 插件，且 JS 与 UTS 的复杂数据交互必须使用 JSON/基础类型边界。[UTS 插件](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html)

---

## 3. 为什么以小程序 SDK 为蓝本

本 SDK 的 core 更接近 `gio-miniprogram-autotracker`，而不是将当前 uni-app x SDK 当作可直接迁移的成品。

### 3.1 可复用的语义与算法

- 事件协议、事件编码与字段上限；
- `VISIT` / `PAGE` / `CUSTOM` / `APP_CLOSED` / `VIEW_CLICK` / `VIEW_CHANGE` 的触发语义；
- visitor、登录用户、session 的存储和迁移策略；
- 有界内存队列、持久化队列、批量、超时、有限重试、单请求 finalizer；
- 页面 query 快照、页面实例级生命周期去重、tab 事件的建模；
- 点击/变更事件的去重、`data-growing-ignore`、`data-growing-track`、picker 显示值恢复；
- Web / mini SDK 中已验证的请求失败释放并发槽位、销毁取消延迟任务等可靠性原则。

### 3.2 必须重写的部分

| 现有实现 | 不能直接复用的原因 | 新 SDK 的处理 |
|---|---|---|
| 小程序 `App/Page/Component` hook | 传统 uni-app 是 Vue 运行时与编译产物，不应盲目重写所有宿主构造器 | SDK 在 `main.ts` 安装全局 Vue mixin 接管生命周期，并使用 Vite 插桩 |
| Web DOM 事件委托 | App Vue / nvue 不能把 DOM 当作通用事件源 | 以模板插桩为主；H5 后续另做 DOM 增强 |
| uni-app x UTS core | X 的主链是 UTS/uvue，传统 uni-app 主链是 JS/Vue | 复用事件语义和算法，重写 TS 运行时与 bridge |
| X 的 Vite 插桩器 | 可作为 Vue3 思路和测试样例，但其输出面向 uvue/UTS | 产出传统 Vue 事件调用协议 |

现有小程序的 uni-app adapter 采用重写 App/Page/Component 和业务方法的方式，能提供兼容经验，但不应成为一期主路径。它对 Vue 版本、编译器内部事件名、业务方法调用顺序和自定义组件都较敏感。主路径必须是**编译期插桩 + 最少运行时桥接**。

---

## 4. 工程结构与依赖方向

当前仓库本身就是独立 SDK 包，不再在源码根目录嵌套 `uni_modules/gio-uniapp-autotracker`，也不要把传统实现混进 `gio-uniappx-autotracker/utssdk`。使用方工程和 release 包才将本仓库根内容放入 `uni_modules/gio-uniapp-autotracker`。

```text
gio-uniapp-autotracker/
├── index.ts                         # gdp 公开 API 与类型
├── autotrack.ts                     # 编译探针的运行时公开入口
├── vite.ts                          # Vite 插件公开入口
├── src/
│   ├── constants/
│   │   ├── config.ts                # 初始化配置、SDK 版本
│   │   └── platform.ts              # 平台验收能力表与验证构建配置
│   ├── core/
│   │   ├── growingIO.ts             # TrackerRuntime：稳定插件门面，按模式委派
│   │   ├── localRuntime.ts          # App / 小程序本地装配与事件调度
│   │   ├── lifecycle.ts             # 插件注册、初始化状态、暂存和按序回放
│   │   ├── userStore.ts             # 设备/登录身份、会话、内存位置
│   │   ├── dataStore/
│   │   │   ├── index.ts            # 事件序号、EventComposer、EventDispatcher
│   │   │   ├── protocol.ts         # 唯一协议裁剪、属性归一化和字段验证
│   │   │   ├── app.ts              # App 生命周期、VISIT、APP_CLOSED
│   │   │   └── page.ts             # 页面快照、来源、方向和 PAGE
│   │   ├── storage/
│   │   │   ├── index.ts            # 命名空间、身份/会话/序号/队列持久化
│   │   │   └── encrypt.ts          # 身份字段编码与解码
│   │   ├── queue.ts                 # 有界队列、批次和请求占用
│   │   └── uploader.ts              # 请求构建、超时结算、并发和重试
│   ├── adapters/
│   │   └── uniapp.ts                # Vue mixin、App/Page bridge、query 快照
│   ├── platform/
│   │   ├── index.ts                 # 从 uni 宿主装配运行时
│   │   ├── uni.ts                   # uni storage / request 适配
│   │   ├── system.ts                # 系统、设备、应用上下文
│   │   └── network.ts               # 网络查询、通知和连接状态
│   ├── plugins/
│   │   └── gioEventAutoTracking/
│   │       ├── index.ts             # 隐私、值归一化、去重和 dispatcher
│   │       └── contract.ts          # 编译器与运行时共享的 schema v2
│   ├── compiler/
│   │   ├── vite.ts                  # Vue SFC/template 插桩
│   │   └── handler.ts               # listener AST 分析与改写
│   ├── types/
│   │   └── index.ts                 # 系统、存储、网络、传输等端口类型
│   └── utils/
│       └── tools.ts                 # UUID、collector hostname 规范化
├── demo/                            # 使用编译交付包的验收工程
├── test/                            # 单元、协议、集成及消费者类型测试
├── scripts/                         # 构建、打包、交付验证和发布
└── doc/
```

以上目录与当前实现一致，参考 Web / 小程序 SDK 的 `core/dataStore`、`core/storage`、`plugins` 和 `adapters` 分区；关联小模块在领域文件内维护，共享独立协议保留单独文件。二期原生增强获批后再新增相应目录。依赖以领域逻辑和宿主接口分离：`src/core` 不直接调用 Vue、Vite、`uni` 页面实例或 UTS 对象；`src/platform` 实现 `src/types/index.ts` 并装配运行时，`src/adapters` 负责 Vue 生命周期，`src/compiler` 只处理编译插桩，`src/plugins/gioEventAutoTracking` 只处理运行时探针。编译器和运行时仅共享 contract；未来 Vue2/Webpack 适配器放在 `src/compiler`，复用现有事件协议、上传和身份。

---

## 5. 对外 API 设计

### 5.1 API 原则

- API 采用 TS/JS，不要求业务侧会写 UTS；
- 所有配置在 `init()` 一次性归一化，不在深层逻辑猜测类型；
- 一期不支持多实例：同一 JS 运行期内首次 `gdp('init', ...)` 创建内部单例，后续初始化直接返回 `false`，绝不重复创建队列、storage namespace 或生命周期监听；
- `dataCollect` 默认 `true`，与 Android、iOS 和小程序 SDK 一致；需要等待隐私同意的业务必须在 `init()` 中显式传 `false`，再在同意后开启；
- 所有对象跨 UTS 边界时先裁成无函数、无循环引用的 JSON 快照；
- 首次成功 `init()` 后，重复 `init()` 必须直接失败，不能静默创建多个上报器；一期不提供 `destroy()` 或成功实例的重新初始化；
- `init()` 前除插件声明 `registerPlugins()` 外，业务 API 直接返回 `false`；只有首次 `init()` 已成功、内部仍在 hydration 的期间，事件才进入有界暂存。首屏 `VISIT/PAGE` 与这段期间的事件必须等待 state 和 SystemContext 就绪，不能先发缺字段报文。

### 5.2 推荐接口

```ts
import type { App as VueApp } from 'vue'

// 业务侧输入：accountId、dataSourceId 必传；serverUrl 省略时使用默认采集地址。
// appId 为跨端预留输入，当前 App profile 不消费它；其余由 config.ts 归一化。
export type GioInitOptions = {
  accountId: string
  dataSourceId: string
  serverUrl?: string | null
  // 仅 Web / 小程序 profile 消费；App 不校验、不存储、不上报。
  appId?: string | null
  // App 三端统一使用；未传或空白时省略，不读取平台专属系统渠道。
  appChannel?: string | null
  appVersion?: string | null
  // 分钟；未传时使用当前 profile 的默认值。App 默认 0.5，即 30 秒。
  sessionExpires?: number
  dataCollect?: boolean
  idMapping?: boolean
  debug?: boolean
}

type SessionPolicy = Readonly<{ timeoutMs: number }>

// 仅 App core 内部使用：所有 App 配置均已校验、补齐；appId 与原始 sessionExpires 不进入这里；appVersionFallback 不是最终上报值。
type ResolvedGioConfig = Omit<Required<GioInitOptions>, 'appId' | 'appVersion' | 'serverUrl' | 'appChannel' | 'sessionExpires'> & {
  serverUrl: string
  appChannel: string | null
  appVersionFallback: string | null
  sessionPolicy: SessionPolicy
}

export type GioAttributeScalar = string | number | boolean | Date | null | undefined
export type GioAttributeValue = GioAttributeScalar | readonly GioAttributeScalar[]
export type GioAttributes = Readonly<Record<string, GioAttributeValue>>
export type GioMutableOptions = Readonly<{ dataCollect: boolean }>

// SDK internal tracker: it is never exported to application code.
interface InternalGioUniAppTracker {
  init(options: GioInitOptions): boolean
  track(eventName: string, properties?: GioAttributes): boolean
  setUserId(userId: string, userKey?: string | null): boolean
  clearUserId(): boolean
  setUserAttributes(attributes: GioAttributes): boolean
  setOptions(options: GioMutableOptions): boolean
  setLocation(latitude: number, longitude: number): boolean
  clearLocation(): boolean
  registerPlugins(...plugins: GioBuiltinPlugin[]): boolean

  // 由 SDK 全局 lifecycle mixin 调用；不作为普通业务埋点 API 宣传
  onAppLaunch(options: unknown): boolean
  onAppShow(options: unknown): boolean
  onAppHide(): boolean
}

export type GioGdpInitOptions = Omit<GioInitOptions, 'accountId' | 'dataSourceId'> & {
  // createSSRApp(App) 返回的应用实例；SDK 据此安装生命周期 mixin。
  uniVue: VueApp
  sdkVersion?: string
}

export type GioPluginRuntime = InternalGioUniAppTracker

export type GioPlugin = {
  name: string
  // The only intentional internal-instance handoff: explicit customer plugins receive it here.
  install(growingio: GioPluginRuntime): void
}

export type GioPluginRegistration = GioBuiltinPlugin | GioPlugin

export interface GdpCommand {
  (command: 'registerPlugins', plugins: readonly GioPluginRegistration[]): boolean
  (command: 'init', accountId: string, dataSourceId: string, options: GioGdpInitOptions): boolean
  (command: 'track', eventName: string, attributes?: GioAttributes): boolean
  (command: 'setUserId', userId: string, userKey?: string | null): boolean
  (command: 'clearUserId'): boolean
  (command: 'setUserAttributes', attributes: GioAttributes): boolean
  (command: 'setOptions', options: GioMutableOptions): boolean
  (command: 'setLocation', latitude: number, longitude: number): boolean
  (command: 'clearLocation'): boolean
}

export const gdp: GdpCommand
```

`gdp()` 与小程序 SDK 使用同一命令式接入形态：先注册插件，再初始化。业务侧只传账户、数据源、采集配置和 `createSSRApp(App)` 得到的 `uniVue`。SDK 自己读取全局 `uni`、创建内部 tracker 与全局 Vue mixin；业务 `App.vue` 和页面不必引入 bridge。`deviceId` 由 SDK 首次启动生成并以 SDK storage namespace 持久化；`sessionId` 也由 SDK 自己按首次访问、超时、用户切换和恢复采集等会话边界创建。宿主对象、device/session ID 工厂都是内部依赖，绝不要求客户传入。

`src/constants/config.ts` 是唯一允许读取 `GioInitOptions` 的位置：`accountId`、`dataSourceId` 必须是非空且 UTF-16 合法的字符串，拒绝未配对代理字符，保留合法中文与 emoji；`serverUrl` 未传时固定补为 `https://napi.growingio.com`，传入时 trim、仅域名自动补 `https://`、去掉末尾 `/`，且必须是有效 HTTP(S) **基础地址**，不得传入既有接口路径或 query。必填项非法时，`init()` 返回 `false` 并记录受控诊断：不创建实例、不读写 SDK storage、不采集；接入方修正配置后可再次主动调用 `init()`。可选配置缺省、类型错误或超出有效范围时回退对应默认值，不阻断初始化；非法 `serverUrl` 使用默认采集地址，非法 `runtime` 使用默认本地采集模式，显式 `unimp` 模式仍须满足托管接入约定。首次成功后，后续 `init()` 返回 `false` 并记录 `already_initialized`，原实例不变。`appId` 是保留的跨端输入：当前 App profile 接受但在此边界直接剥离，不校验其内容、不写入 `ResolvedGioConfig`、storage、日志或采集报文，也绝不用于覆盖 App `domain`；未来 Web / 小程序 profile 才各自定义并消费它。`appChannel` 是 App 三端完全一致的可选 init 字段：非空字符串 trim 后写为 `ResolvedGioConfig.appChannel`，未传、空白或非法值时为 `null`；不读取 `uni.getAppBaseInfo().channel` 等平台专属渠道，也不做端侧猜测。它是 init 期固定值，`setOptions()` 不得修改，也不写 storage。`urlScheme` 不属于基础 init：一期没有 Deep Link 或圈选插件，基础 SDK 不读取、存储或上报它；以后只能由相应插件的专属配置提供。`dataCollect` 默认 `true`，`idMapping`、`debug` 默认 `false`，三者都是 init 输入；只有 `dataCollect` 可由 `setOptions()` 在运行时改变。`sessionExpires` 与 Web SDK 同名、同单位，单位为分钟：必须是大于 `0` 且不超过 `360`（6 小时）的有限数，允许小数，换算后的毫秒值也必须有限且大于 `0`；传入 `0`、负数、超过 `360`、NaN、Infinity 或非数字时回退 profile 默认值。上限及非法值回退默认的处理参照 Web SDK，保留 uni-app 的小数分钟精度。未传或非法时，App 为 `0.5`（30 秒），未来 Web profile 为 `30`；小程序默认关闭额外活动超时（`-1`），后台超时由 `keepAlive` 单独控制，未传或非法时为 `5` 分钟。它不支持 `setOptions()` 热修改。请求超时 5000ms、队列上限 200，都是内部固定策略。App 和 Web 事件入队后立即尝试发送；20 条/5000ms 的聚合节流仅适用于小程序，不应用到 App/Web。并发槽位占满、明确断网或失败重试时按各自策略等待，后台与重连可立即发送。`appVersion` 是用户可选的 fallback：非空时归一化为 `appVersionFallback`，不是最终上报值。其余 core 模块、平台适配器和插件不得再对可选字段各自补默认值。

调用顺序也固定：先 `gdp('registerPlugins', ...)`，再 `gdp('init', ...)`。业务侧所有事件、身份、属性和位置操作都只能通过 `gdp('xxx')`；SDK 不向页面暴露 tracker 或 `$gio`。只有客户显式注册的插件在 `install(growingio)` 中得到内部实例。首次 `init()` 返回 `true` 后，tracker 可短暂处于 `initializing`，该期间发生的事件才进入 bootstrap buffer，待 identity、session 和 SystemContext 完成后按发生顺序构建。这样既保留独立 SDK 的“插件先声明、初始化时统一安装”语义，也不会丢失合法初始化后的首屏事件。

一期每次真实 `Page:onShow` 都自动发送 `PAGE`，并始终维护页面快照供 CUSTOM / `VIEW_*` 使用；不提供 `trackPage` 开关或 `sendPage()` 手动 PAGE，避免与 uniappx 一期能力分叉。

基础事件 / 状态命令返回 `boolean`，表示本地接纳。高级身份扩展现已提供 `identify` 与返回 `string | null` 的 `getGioInfo`；uniMP 由插件 onReady / onError 报告异步状态。`getABTest()` 仍不在本次范围。完整公开类型与模式差异以[扩展接入说明](./advanced-identity-hybrid.md)为准。

### 5.3 一期内置插件入口

一期内置插件使用与 uniappx 同名的 `gioEventAutoTracking`。`registerPlugins()` 必须在首次 `init()` 前调用：它仅在内存中声明插件，不读写 SDK storage、不安装 Vue hook；`init()` 参数校验成功后再按声明顺序统一安装。内置插件名无效或任意插件重名时返回 `false`，不安装部分功能。配置非法导致 `init()` 失败时，已声明插件保留，接入方修正配置后重试无需重复注册；首次 `init()` 成功后注册窗口关闭。客户插件可以定义 `{ name, install(growingio) }`；这是唯一可取得内部 tracker 的路径，且安装异常会隔离，不影响基础初始化。业务页面、`App.vue` 和全局变量均不获得该实例。

```ts
type GioBuiltinPlugin = {
  name: 'gioEventAutoTracking'
  options?: Record<string, never>
}

type GioPlugin = {
  name: string
  install(growingio: InternalGioUniAppTracker): void
}
```

无埋点的 Vite 伴随插件仍只负责模板探针，运行时内置插件负责把稳定的 `AutoTrackCall` 交给 core；二者缺任一部分均安全不采集。ABTest、分享、圈选、性能和第三方插件不在传统 uni-app 一期伪实现。

### 5.4 二期通用插件契约（不进入一期）

插件不是 `platform` 适配器。所有产品能力使用同一份 `GioPlugin` 契约；需要 Vue 能力时，在**同一个插件对象**上实现可选的 `installVue`。无埋点的运行时部分是正式插件，Vite 插件则是它的编译期探针安装器：

| 类型 | 责任 | 是否进入 `src/core/lifecycle.ts` |
|---|---|---|
| 产品插件 | 无埋点、ABTest、圈选、分享、性能等可选产品能力；可选接入 Vue runtime | 是 |
| 平台适配器 | request、storage、network、system 的端侧实现 | 否，属于 `platform/` 并实现 ports |
| 无埋点 Vite 伴随插件 | 编译期把 `.vue` 模板改写为 `dispatchAutoTrack()` 调用；它只安装探针，属于无埋点插件的构建侧 | 否，不参与 runtime hook registry |
| Vue runtime carrier | SDK 在 `gdp('init')` 内部安装生命周期 mixin | 否；它不另建插件体系 |
| UTS 原生增强 | 可选的原生信息或能力 | 否，属于 `utssdk/`，只能通过 capability port 暴露 |

小程序 SDK 当前通过全局 emitter 同步广播 `onInstall`、`onError`、`onComposeBefore/After`、`onSendBefore/After`；Web 也允许运行时安装/卸载插件。新 SDK 不把可变 emitter、uploader 或宿主对象交给插件；仅显式注册的客户插件会在同步 `install(growingio)` 中拿到内部 tracker，页面和全局变量仍不可取得它。任何一个插件都不应绕过 `dataCollect`、篡改 Measurement Protocol，或因异步/异常卡住基础采集。

二期通用插件的注册规则如下：

1. `registerPlugins(...plugins)` 只允许在 `init()` 前调用；同一 `id` 只能注册一次，重复项返回 `false` 并记录 `plugin_duplicate`，不覆盖已注册插件。
2. `init()` 会按注册顺序同步执行 `setup()`；某插件安装失败只记录 `plugin_setup_failed`，不影响 core 和其他插件。
3. 初始化完成后不支持热插拔。此后 `registerPlugins()` 返回 `false` 并记录 `plugin_registration_closed`；`destroy()` 时按注册的逆序调用 `dispose()`，随后才能重新注册并 `init()`。
4. 二期可将 `gioEventAutoTracking` 迁移到这一通用契约；它必须和 `gioUniappAutoTrack()` Vite 伴随插件一起接入才启用 click/change。
5. 需要 Vue 运行时能力的插件必须在 `gdp('init')` 内部安装生命周期 mixin 时一并安装；它与 core `setup()` 共享同一 plugin ID、顺序、错误隔离和 destroy 生命周期，不能另建一份 Vue 插件注册表。

```ts
type PluginEvent = Readonly<ProtocolEvent>
type PluginResult = { ok: true } | { ok: false; reason: PluginErrorReason }
type PluginCapability = 'vue-runtime' | 'scoped-storage' | 'service-request'
type PluginTrackIntent =
  | { kind: 'custom'; eventName: string; attributes?: TrackProperties }
  | { kind: 'autotrack'; call: AutoTrackCall }

interface GioPlugin {
  readonly id: string              // 全 SDK 唯一，例：gio-abtest
  readonly version: string
  readonly requires?: readonly PluginCapability[]
  installVue?(context: GioVuePluginContext): void | (() => void)
  setup(context: PluginContext): PluginHooks | void
}

interface GioVuePluginContext {
  readonly app: App
  readonly tracker: Pick<GioUniAppTracker, 'track' | 'setOptions'>
  readonly platform: PlatformCapabilities
  onDispose(cleanup: () => void): void
}

interface PluginContext {
  readonly sdkVersion: string
  readonly platform: PlatformCapabilities // 只读能力声明，不暴露 uni / UTS 原对象
  readonly services: PluginServices
  getState(): Readonly<PluginState>       // identity/session/page 的脱敏只读快照
  emit(intent: PluginTrackIntent): TrackResult // core 唯一入口；intent 不是原始事件报文
  subscribe(listener: PluginListener): () => void
  reportDiagnostic(diagnostic: PluginDiagnostic): void
}

interface PluginServices {
  readonly storage?: PluginStoragePort   // 自动限制到该 plugin ID 的命名空间
  readonly request?: PluginRequestPort   // 产品服务请求；不是事件上报 TransportPort
}

interface PluginStoragePort {
  read(key: string): Promise<{ kind: 'value'; value: string } | { kind: 'missing' | 'failed' }>
  write(key: string, value: string): Promise<{ ok: true } | { ok: false; reason: 'quota' | 'failed' }>
  remove(key: string): Promise<{ ok: true } | { ok: false; reason: 'failed' }>
}

interface PluginRequestPort {
  request(input: PluginRequest): Promise<PluginResponse>
}

type PluginRequest = {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
}

type PluginResponse =
  | { kind: 'success'; status: number; body: string | null }
  | { kind: 'http' | 'network' | 'timeout' | 'unsupported'; status?: number }

interface PluginHooks {
  onReady?(): void
  onEventBuilt?(event: PluginEvent): void
  onEventQueued?(event: PluginEvent): void
  onSendStart?(batch: ReadonlyArray<PluginEvent>): void
  onSendResult?(result: Readonly<SendResult>): void
  onIdentityChanged?(change: Readonly<IdentityChange>): void
  onPrivacyChanged?(enabled: boolean): void
  dispose?(): void
}
```

`installVue`、`setup` 和所有 hook 都是同步的，并按注册顺序串行执行。`installVue` 可以安装 mixin、directive 或页面级桥接，但它只能取得 Vue app、受限 tracker facade、capability 和可登记的 cleanup，不取得 core、storage、queue、request、加密 key 或原始 userId。它的返回 cleanup 与 `onDispose()` 登记项在 destroy 时按逆序执行，随后才执行插件的 `dispose()`。Vue 安装失败记录 `plugin_vue_setup_failed` 并隔离该插件的 Vue 扩展，不影响基础采集。

事件 hook 保持观察型：事件对象、批次和结果均为只读快照，hook 的返回值被忽略。所有插件都只能调用同一个 `context.emit(intent)`：无埋点传 `{ kind: 'autotrack', call }`，未来产品插件传已有的受限 intent；core 负责按 kind 建事件、校验字段、执行隐私开关、入队和调用 TransportPort。插件不能传原始协议报文，更不能自行新增未定义的 kind。`onEventBuilt` 对应小程序的 compose 阶段，`onSendStart/onSendResult` 对应 send 前/后阶段；这样保留产品扩展时机，同时避免旧 SDK 中“插件可以改任意共享对象”的耦合。

因此无埋点不是一个特殊框架：它只是第一个同时实现 `installVue`（tabBar / 页面级 hook）、`setup`（attach dispatcher gateway）和 `context.emit({ kind: 'autotrack' })` 的 `GioPlugin`。以后 ABTest 若只需要身份/网络生命周期，可以只实现 `setup`；圈选若需要 Vue directive，可以再实现 `installVue`；它们的注册、排序、异常隔离、受限上报和销毁路径完全相同。每个产品插件包可额外导出自己的构建侧工具，但构建工具不得成为第二套 runtime plugin API。

### 5.5 后续产品插件如何扩展

每个插件包只导出一个或多个 `GioPlugin` 实例，由业务在 `init()` 前用同一个 `registerPlugins()` 注册；不允许 ABTest、圈选或其他产品各自创建全局 SDK、全局 emitter 或另一套 Vue plugin registry。插件的 `requires` 是声明，不是任意权限：registry 只提供已定义的服务，未声明或当前端不支持的能力返回 `plugin_capability_unavailable`，该插件降级/停用但不影响 core。

| 插件例子 | 实现同一套接口的方式 | 允许使用的附加能力 | 不允许做的事 |
|---|---|---|---|
| `gioEventAutoTracking` | `installVue` 挂 tab/page hook，`setup` 挂 dispatcher，`emit(autotrack)` | `vue-runtime` | 直接构造协议、存队列、发采集请求 |
| ABTest | `setup` 订阅 ready/identity；产品 API 从插件实例读结果 | `service-request`、`scoped-storage` | 调用事件 TransportPort、保存原始身份字段、改写其他事件 |
| 圈选 / 可视化 | `installVue` 安装 directive/mixin；需要时 `emit(custom)` | `vue-runtime`，按产品协议可加 request/storage | 挂全局 DOM 监听作为 App 通用方案、绕过 ignore/privacy |
| 分享 / 性能 | 只实现需要的 `setup` 或 `installVue` 与 hooks | 依实际协议声明 | 为方便复制一份 tracker、queue 或 event builder |

`PluginStoragePort` 的 key 由 core 自动限定为 `gio:v1:{dataSourceId}:plugin:{pluginId}:...`，插件只能读写自己的 namespace，不能读取 identity、session、queue 或其他插件的数据。`PluginRequestPort` 是产品服务请求端口，和采集上报的 `TransportPort` 完全分开；它统一处理宿主 request 差异、超时和取消，但不自动附带原始 userId、cookie、采集 body 或采集认证信息。若某产品协议需要身份参与请求，必须新增经过审查的**身份 intent** 由 core 构造，不能把原始身份值开放给任意插件。

这也是跨端统一点：App、Web、小程序未来只替换 `PluginStoragePort` / `PluginRequestPort` 的平台实现，插件本身仍是同一份 `GioPlugin`、同一份 Vue 可选挂载和同一份 intent。产品插件需要新事件类型时，先扩展 Measurement Protocol 和 `PluginTrackIntent` 的受限 union，再实现插件；不能靠任意 JSON 直通 collector。

插件 hook 抛错时，core 捕获异常，记录带 `pluginId` 与 hook 名的 `plugin_hook_failed` 诊断，并继续当前采集流程；错误诊断不会再次触发插件，避免递归。单个 hook 不允许返回 Promise；需要网络或耗时任务的插件自行调度，不能阻塞事件创建或上传。`dispose()` 无论其他插件是否失败都要继续执行，且同一实例最多执行一次。

插件契约的最小测试矩阵：重复 ID、Vue 安装/setup 失败隔离、hook 顺序、hook 异常隔离、隐私关闭时任意 `context.emit()` 被拒绝、插件不能改写事件快照、Vue cleanup 与 destroy 逆序 dispose、destroy 后可重新注册。ABTest、圈选、分享、性能等具体插件另有产品/服务端协议后，再以此契约实现。

### 5.6 接入示例

```ts
// main.ts
import { createSSRApp } from 'vue'
import App from './App.vue'
import gdp from 'gio-uniapp-autotracker'

export function createApp() {
  const app = createSSRApp(App)
  gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])
  gdp('init', 'account-id', 'data-source-id', {
    uniVue: app,
    serverUrl: 'https://collector.example.com',
    appVersion: '1.0.0',
    dataCollect: true,
    idMapping: false,
    debug: false,
  })
  return { app }
}
```

接入不再要求修改 `App.vue` 或任何页面：SDK 通过初始化时安装的全局 mixin 捕捉真实生命周期。业务 API 统一调用 `gdp('xxx')`，不会以 `$gio` 或 tracker 形式挂到页面上；该机制同时适用于 Options API 与 Composition API，不要求业务迁移写法。[App.vue](https://uniapp.dcloud.net.cn/collocation/App.html)

---

## 6. 生命周期、页面和会话

### 6.1 生命周期映射

| uni-app 时机 | SDK 操作 | 必须避免 |
|---|---|---|
| `App.vue:onLaunch` | 标记新的 App JS 运行期并记录启动参数快照；不直接发事件 | 读取尚未稳定的页面实例 |
| `App.vue:onShow` | 新运行期强制创建 session 并发 `VISIT`；无新 `onLaunch` 时才按后台超时续接 | 页面事件替代 App 事件 |
| `Page:onLoad` | 复制 query 并绑定到页面实例/唯一 page key | 以后从可变页面对象回读 query |
| `Page:onShow` | 解析 route/title/referral，记录内部显示时间 `shownAt`；自动发 `PAGE` | 全局 50ms 去重误吞不同页面 |
| `Page:onHide` | 标记页面非当前；不发 `APP_CLOSED` | 认为页面隐藏就是应用进入后台 |
| `Page:onUnload` | 删除该页面快照和页面专属去重桶 | 删除仍在栈中页面的上下文 |
| `App.vue:onHide` | 更新 lastCloseTime，持久化身份/队列，按 capability profile 构建 `APP_CLOSED` 并强制 flush | 宣称这是可靠退出确认 |

### 6.2 Session 规则

一期 App 的“新访问”只在以下情况发生：

1. 每次 `App:onLaunch` 标识出的新 App JS 运行期（包括用户杀进程后重启）；
2. 同一运行期从后台返回，距上次 `onHide` 超过当前 profile 的固定时长；
3. 已登录用户从 A 切换为不同的已登录用户 B；
4. `dataCollect` 从 `false` 恢复为 `true`。

`App:onLaunch` 是 App 冷启动边界：它出现时即使持久化的 `lastCloseTime` 距今不足 30 秒，也必须替换 session 并在紧随的 `onShow` 发 `VISIT`。只有没有新的 `onLaunch` 的后台恢复才比较 `lastCloseTime` 与当前时间。profile 提供默认值，`init({ sessionExpires })` 可统一覆盖。该字段与 Web SDK 同名、同为分钟单位：App（Android/iOS/HarmonyOS）默认 **0.5 分钟（30 秒）**，Web profile 默认 **30 分钟**，小程序由 `keepAlive` 控制默认 **5 分钟**的后台超时，`sessionExpires` 默认 `-1` 关闭额外活动超时。当前交付 App 与小程序 profile，Web 是未来规划；非法可选值统一回退对应默认值。Android/iOS/HarmonyOS 独立 SDK 虽使用秒单位的 `sessionInterval`，但传统 uni-app 在对外 API 边界统一采用 Web 的 `sessionExpires`，随后一次换算为 core 毫秒策略。小程序的 `keepAlive` 与 `sessionExpires` 分别在 profile 边界归一为 `timeoutMs` 与 `activityTimeoutMs`，不得把原始分钟配置带进 core。为让 `0.5` 能在全端表达，Web profile 接入时必须保留正的小数分钟值，不能沿用现有 Web 实现“取整且最小 1 分钟”的旧 normalizer。App 不沿用小程序“场景值变化即新访问”的规则。使用默认 App 值时，30 秒内从不同 Deep Link、分享或入口 query 回到 App 不新建 session、不补 `VISIT`；后续页面只按自身 `onLoad` 的 query 建快照。

```ts
// 可选值非法时继续初始化，使用当前 profile 的默认策略。
const app = normalizeInitOptions({ accountId: 'account', dataSourceId: 'source', sessionExpires: -1 })
if (app.ok) app.config.sessionPolicy // { timeoutMs: 30_000 }

const mini = normalizeInitOptions({
  accountId: 'account', dataSourceId: 'source', appId: 'wx-real-app-id', sessionExpires: 361,
}, 'mp-weixin')
if (mini.ok) mini.config.sessionPolicy // { timeoutMs: 300_000 }，不启用额外活动超时
```

`sessionId` 在新 session 产生时更新；同一 session 内的 `PAGE`、`CUSTOM`、`VIEW_*` 必须使用相同值。`onHide` 只记录关闭时间，不立即销毁 session，以便热启动续接。

### 6.3 页面快照

页面对象不得进入 `sdk-core` 或 UTS。运行时仅输出：

```ts
type PageSnapshot = {
  pageKey: string
  route: string
  query: Record<string, string>
  title: string | null
  shownAt: number
  referralPage: string | null
}
```

`title` 在每次 `Page:onShow` 由运行时适配器从框架可安全读取的当前页面导航栏标题生成纯字符串快照；非空才写入，取不到则为 `null` 并由出站清理省略。不得从 route 推导标题、读取 DOM，或把 Vue / 原生页面对象带入 core。这样可保留页面运行期已修改标题的机会，又不依赖 uniappx 的 UTS 页面对象实现。

`pageKey` 应与**页面实例**绑定，而不只是 route：同一路由连续打开两次时，两个页面仍是不同实例。生命周期去重也必须按 `pageKey + lifecycle` 完成，避免前一页面 50ms 内的 `onShow` 吞掉后一页面。

`referralPage` 只写入 `PAGE`；显式来源与 onLoad query 保持快照，自动来源在页面真实切换时刷新。普通页面跳转、返回和 tab 切换时，取刚刚可见的上一页面 route；同 route 的不同实例仍按不同 `pageKey` 处理；通过页面实例判断切换，返回先前打开的同路由实例也更新自动来源。从后台回到同一页面不是一次页面跳转，不能把当前 route 写成自己的 referral。没有上一页时，可使用平台入口来源：小程序 profile 与既有 SDK 一致，依次取外部小程序 `referrerInfo.appId`、规范化场景值 `scn:...`；App profile 只有在生命周期适配器给出已验证的外部入口来源时才可使用，否则省略，绝不伪造小程序 scene。入口来源只作为首个没有前序页面的 PAGE fallback，前序 PAGE route 始终优先。

`orientation` 是 PAGE 的 App 必填专有字段，不进入 `PageSnapshot`、storage 或全局静态 `SystemContext`。`OrientationPort` 在构建每条 PAGE 时读取当前方向：先读标准 `uni.getDeviceInfo()` / `uni.getSystemInfoSync()` 的 `deviceOrientation`，其次仅在当前窗口宽高能够明确判断时推断，最后复用**本次运行内**最后一个真实读取结果，统一输出 `PORTRAIT` 或 `LANDSCAPE`。三者都不可用时固定以 `PORTRAIT` 兜底，照常构建并分配该 PAGE 的 `eventSequenceId`；不得因方向接口的偶发异常漏掉 PAGE。正常真机路径仍必须证明能读取到真实方向，兜底只能是异常路径，不得替代平台适配。

### 6.4 App 原生弹窗与非业务页面

全局 mixin 可能收到 picker、actionSheet、dialog 等非业务页面回调。只允许当前 `getCurrentPages()` 栈顶与实际 Vue page instance 对应时生成页面生命周期；无法确认时宁可跳过并输出 debug 日志，不能把弹窗参数写进业务页面 query。

---

## 7. 无埋点设计

> **实施口径：**本节保留无埋点的架构边界。普通模板 `xpath`、事件名推导、schema v2、tabBar、`uni-link`、隐私、去重、迁移和验收细节以[传统 uni-app 无埋点方案](./uniapp-autotrack-design.md)为准；该方案优先于本节中任何较早的结构路径或旧 `AutoTrackCall` 示例。

### 7.1 为什么必须编译期插桩

传统 uni-app App 的 `.vue` 页面在 App 端使用 webview，`.nvue` 使用原生渲染；同一路由若两种文件并存，App 优先使用 `.nvue`，非 App 使用 `.vue`。[页面渲染规则](https://uniapp.dcloud.net.cn/tutorial/page.html)

因此不能使用“全局 `document.addEventListener`”作为 App 的统一方案：它不能覆盖 nvue，也不能代表所有宿主事件。无埋点一期由正式的 `gioEventAutoTracking` 插件负责；Vite 伴随插件仅在模板编译前/过程中添加调用。H5 DOM 监听是未来 H5 的另一种探针安装器，不进入一期 App 的基础链路。

### 7.2 无埋点插件与完整链路

无埋点必须同时具备运行时和构建时两部分，缺任一部分都**安全地不采集**，绝不降级为猜测式全局监听：

```text
业务 .vue template
  → gioUniappAutoTrack() 读取 template AST、保留原 handler/modifier
  → 仅注入 dispatchAutoTrack(AutoTrackCall) 调用
  → 原业务 handler（始终仍执行一次）
gdp('init') runtime construction
  → SDK 创建内部 App runtime 并安装唯一 dispatcher target
  → SDK 安装生命周期 mixin；业务侧仍只经 gdp 命令调用
  → src/plugins/gioEventAutoTracking/index.ts 查找已就绪的 gioEventAutoTracking
  → 插件：页面快照 + currentTarget 元数据 + ignore/敏感规则 + normalizer + 去重
  → core 内部无埋点入口
  → core：protocol 校验/补全 identity-session-page/eventSequenceId
  → privacy gate → queue → TransportPort → collector
```

`gioUniappAutoTrack()` 不直接构建 `VIEW_CLICK` / `VIEW_CHANGE`、不保存事件、也不发请求；`gioEventAutoTracking` 不解析 `.vue` 源码。两者只能通过同一份 `src/plugins/gioEventAutoTracking/contract.ts` 交互，`schemaVersion` 不匹配时 dispatcher 返回 `false`、记录兼容性诊断且不采集。

无埋点接入顺序固定为“创建 app → 注册 `gioEventAutoTracking` → `gdp('init', ..., { uniVue: app })` → Vue 挂载”。插件先声明、由初始化统一安装，和独立 SDK 的配置/初始化语义一致；Vite 配置和应用入口分属构建与运行时，不能靠全局变量相互猜测：

```ts
// main.ts
import gdp from 'gio-uniapp-autotracker'

gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])
gdp('init', 'account-id', 'data-source-id', { ...options, uniVue: app })
```

Vite 插件不得直接构建网络事件，它只调用 runtime 的稳定 schema v2 协议。内部类型不在本架构文档复制第二份，以[无埋点方案的版本化 call 合约](./uniapp-autotrack-design.md#32-版本化-call-合约)为唯一来源。其边界固定为：

- template probe 传 `eventName`、白名单 change 的 `elementType`/picker range，以及允许的模板 metadata；不传结构 xpath；change 的受限值由 dispatcher 从第二参数 native event 即时裁出；
- tabBar probe 传固定 `#onTabItemTap`、一基 index、text 和 pagePath；
- 原始 native event 仅作为 `dispatchAutoTrack(probe, nativeEvent)` 的瞬时参数，不写入 probe、日志、队列或协议；
- normalizer 完成隐私判断、`id#eventName`、组件值归一和去重后，才把纯 JSON 的 `NormalizedAutoTrackCall` 交给 `EventDispatcher`。

`dispatchAutoTrack()` 是 dispatcher 对 `gioEventAutoTracking` 的唯一入口：插件未注册、尚未 ready、`dataCollect=false`、页面快照不存在、schema 不匹配、元素被忽略/敏感或被去重时都返回 `false`，不抛异常、不影响业务 handler。只有插件 normalizer 确认得到可上报动作后，才调用 core 的受限内部入口；core 仍是唯一能把它变成协议 `VIEW_*` 事件的一层。

`src/plugins/gioEventAutoTracking/index.ts` 只保存当前 tracker 的模块内 gateway，不挂到 `globalThis`、Vue app 或 `uni` 对象。`gioEventAutoTracking` 成功安装后以实例 token attach gateway；一期没有 destroy/re-init，重复 init 直接失败。未来若支持多实例或完整销毁，必须在 `AutoTrackCall` 中新增显式 tracker key，不能按全局“最后初始化者”猜测。

二期 Vue2/Webpack、未来 H5 DOM 和小程序探针必须生成完全相同的调用；不得让任何端另造事件协议。

### 7.3 click 支持规则

一期支持白名单内置组件上没有修饰符的静态 `@click`、`@tap`，以及 `uni-link` 和 TabBar。普通元素没有业务 handler 时不凭空添加 listener；只有 `uni-link` 可以按明确宿主语义补充 `openURL` 采集 handler。动态事件名、自定义组件、计算成员/复杂表达式和带 `.stop`、`.prevent`、`.once`、`.capture`、`.self` 等修饰符的 listener 均保持原代码、不插桩并输出构建告警。

对可安全插桩的 handler，必须按纯方法引用、内联调用、箭头/函数表达式和顶层条件表达式分别生成代码，保证原 handler 只执行一次，`$event`、参数、返回值、抛错与求值次数不变。Options API、普通 `setup()` 与 `<script setup>` 的事件名口径相同，但 import 注入、模板绑定和 Ref 自动解包必须分别验证；完整改写矩阵以[无埋点方案](./uniapp-autotrack-design.md#41-推导规则)为准。

编译器注入的调用必须在原 handler 之前执行且永不 await：这样业务 handler 即使立即跳转/销毁页面，自动采集仍使用触发瞬间的 pageKey 和元素元数据。采集侧异常由 dispatcher 吞掉并记诊断；业务 handler 的返回值、抛错、参数个数以及调用次数不受影响。带修饰符的 listener 根本不进入这条改写链。

### 7.4 change 支持规则

`change` 不是单一事件。Vite 必须把白名单组件类型和 picker range 显式传给 runtime；dispatcher 再从 native event 即时裁出受限快照，不能假设每个 App 端都能从同一条 `event.detail.value` 读取。以下组件及值形态必须独立归一：

| 组件 | 候选事件 | 归一化值 | 默认是否上传值 |
|---|---|---|---|
| `input` / `textarea` | `blur`、`confirm`、`change` | string | 否 |
| `switch` | `change` | boolean | 否 |
| `slider` | `change` | number | 否 |
| `radio-group` | `change` | string | 否 |
| `checkbox-group` | `change` | string[] | 否 |
| `picker` | `change` | 选中下标或 range 显示值 | 否 |
| `picker-view` | `change` | 每列下标或显示值 | 否 |
| `swiper` | `change` | `current` / `source` | 否；可仅报 `data-title` |

默认值策略是“只记录组件发生变化”，即 `VIEW_CHANGE` 可带 xpath，但 `elementType` 仅参与内部归一化、不进入协议，`textValue` 默认为 `null`。仅当业务显式标记 `data-growing-track` 且组件不属于敏感类别时，才允许采集规范化后的值。

同一 input / textarea 的完成事件由 Vite 按 `blur → confirm → change` 只选择一个已声明的监听器插针，其他业务 handler 保持原样。传统 App 不转发输入框的原生 change，应使用 blur / confirm 生成 `VIEW_CHANGE`；仅声明 change 时保留兼容路径，不补发事件或添加监听器。宿主重复包装同一事件时，再由 runtime 使用“同对象 + 每页元素窄时间窗”两层去重；不同值的连续修改不能被合并。`0`、`false`、空字符串和空数组不能因真值判断导致整条变化事件丢失。

官方 `input` 的 `input`、`blur`、`confirm` 事件和平台支持面不同，不能把一个事件字段读取公式复制到所有组件或端上。[input 组件](https://uniapp.dcloud.net.cn/component/input.html)

### 7.5 隐私与显式标记

支持以下属性，命名与现有 SDK 保持一致：

| 属性 | 行为 |
|---|---|
| `data-growing-ignore` | 当前元素及其事件绝不采集；优先级最高 |
| `data-growing-track` | 允许该元素按配置采集可采集值；不覆盖敏感禁止规则 |
| `data-title` | 点击/允许的变更事件的展示文本 |
| `data-index` | 列表序号，仅 `VIEW_CLICK`；只接受大于 0 且小于 2147483647 的规范十进制整数 |
| `data-src` | 链接地址，仅 `VIEW_CLICK` |

强制忽略：`data-growing-sensitive`，静态 password / safe-password / file input，以及一期无法可靠确认安全类型的动态 `:type`。这些情况拒绝整个 probe，不产生 `VIEW_CHANGE`；即使存在 `data-growing-track` 也不能覆盖。验证码、身份证、银行卡、支付等业务敏感字段应由业务显式添加 `data-growing-sensitive`。敏感值必须在读取、字符串化和记录去重键之前短路；其他允许采集的值仍执行 trim、最大长度（建议 100）、控制字符处理和日志脱敏。

### 7.6 HarmonyOS 特殊门槛

当前 uni-app x SDK 已存在 Harmony 自动采集的 `change/blur/confirm` 框架限制先例。传统 uni-app 的 Vue3 App 实现不得据此推断“必然不支持”或“必然支持”，而应把 Harmony `VIEW_CHANGE` 做成能力开关：

1. 首先在真机 fixture App 上验证事件是否抵达插桩 handler；
2. 验证 payload 是否可标准化；
3. 验证业务 handler 语义无变化；
4. 验证最终 HTTP 请求和服务端入库；
5. 未通过的组件保持禁用，文档列为 unsupported，而不是伪造空值事件。

---

## 8. 事件协议与数据质量

一期遵循本仓库 [全端 Measurement Protocol](./measurement-protocol.md)。本节只定义 SDK 内部触发点；字段白名单、端间差异和报文样例不在此重复定义。关键事件为：

| 事件 | 触发点 | 关键约束 |
|---|---|---|
| `VISIT` | 新 session 的 App `onShow` | 仅一条；带 session/入口上下文 |
| `PAGE` | 真实页面 `onShow` | pageKey 去重；query 来自 `onLoad` 快照；方向归一化或兜底后构建 |
| `CUSTOM` | `track()` | 事件名与属性需校验、截断 |
| `LOGIN_USER_ATTRIBUTES` | `setUserAttributes()` | 与是否已登录无关；attributes 合法即立即发送，绝不缓冲到未来身份 |
| `APP_CLOSED` | App `onHide` | 尽力发送，不能承诺送达 |
| `VIEW_CLICK` | 模板 click/tap / tab | `xpath` 必填；`index` / `hyperlink` 仅本事件 |
| `VIEW_CHANGE` | 受支持 change 组件 | `xpath` 必填；禁止 `index` / `hyperlink` |

`track(eventName, properties)` 仅接受满足 `^[A-Za-z_][A-Za-z0-9_]{0,99}$` 的事件名：首字符为英文字母或下划线，剩余字符只能是英文字母、数字或下划线，总长不超过 100。非法名称不做 trim、替换或截断，整条 CUSTOM 返回 `false`、记录脱敏诊断，也不分配 `eventSequenceId` 或进入 queue。

普通页面的 query 在 `Page:onLoad` 只读取一次并绑定到该 pageKey。随后构建 `PAGE`、`VIEW_CLICK`、`VIEW_CHANGE`、`CUSTOM` 和 `APP_CLOSED` 时，若仍有当前页面上下文，均复用该快照；`VISIT` 则只使用 `App:onShow` 收到的入口 path/query，不能拿当前页面 query 冒充入口。`PAGE.referralPage` 读取当前显示快照的来源值，不在后续事件中扩散。该规则与小程序 SDK 的“页面上下文 + 启动入口”两条链路一致。

`setLocation(latitude, longitude)` 不触发定位、不申请定位权限，只接受业务已合法获得的位置。两个参数必须是有限数字，纬度范围为 `[-90, 90]`、经度范围为 `[-180, 180]`，因此 `0` 是合法坐标而不是“未设置”。设置成功后，坐标进入后续事件的 Protocol context；`clearLocation()` 或进程重启后不再携带。位置仅保存于当前运行期内存，绝不写入 SDK storage，也不影响已入队事件。

`setUserAttributes()` 与 `setUserId()` 没有前后依赖：只要 attributes 合法且 `dataCollect=true`，就立即构建 `LOGIN_USER_ATTRIBUTES`；尚未登录时不携带 userId，已登录时携带当时快照中的 userId/userKey。禁止把匿名期属性缓存在内存或存储中，待未来登录后再发送，避免错绑到另一个账号。

`CUSTOM.attributes`、`LOGIN_USER_ATTRIBUTES.attributes` 与插件的 custom intent 都经过同一个 attribute normalizer：key 转字符串并截至 100 字符；string/number/boolean 转为字符串；Date 用固定格式；一层数组逐项按同规则转换、最多 100 项并以 `||` 拼接；`null` / `undefined` 转为空字符串；最终值截至 1000 字符。截断后若多个原始 key 得到同一 key，按 `Object.keys()` 的输入顺序保留第一个，丢弃后续项并记录 `attribute_key_collision`，绝不静默覆盖。嵌套数组、普通对象、函数、symbol、循环引用和无法格式化的 Date 整项拒绝并计诊断，不能直接进入报文。这样 Protocol 中的 attributes 始终是 `Map<string,string>`，且 `0`、`false`、空字符串不会被误删。

### 8.1 xpath / 元素标识

一期不追求浏览器 DOM XPath。传统 uni-app Vue 3 模板采用与小程序一致的逻辑标识：

```text
{currentTarget || target 的 id}#{实际 handlerName-or-eventName}
```

主目标存在但没有 id 时 id 为空，结果为 `#eventName`；不得回退为模板位置或子节点 target 的 id。`v-for` 内的 `data-index` 仅是 `VIEW_CLICK.index` 附加维度，不能充当节点 ID，且只接受大于 0 且小于 2147483647 的规范十进制整数。无业务 handler 的 `uni-link` 固定为 `#openURL`，tabBar 固定为 `#onTabItemTap`。完整的版本化契约、推导与迁移规则见[传统 uni-app 无埋点方案](./uniapp-autotrack-design.md)。

### 8.2 去重

运行时先用 native event 对象身份抑制同一对象上的重复 probe，再用以下键覆盖宿主产生不同 JS 包装对象的情况：

```text
pageKey + nativeEvent.type + action + xpath + textValue + index + hyperlink
```

- 只有键完全相同、两个时间戳均为有限正数且绝对差小于 10ms 时才判重；
- 时间戳为 0、缺失或不可信时跳过时间窗层，不得把后续事件永久合并；
- 页面切换清空最近事件，不得用单一全局时间窗跨页面去重；
- 不同父子 currentTarget、不同值或不同事件类型不合并；`0`、`false`、空字符串不能因真值判断导致整条事件丢失；
- 去重只影响本地判定，不能改写协议 `timestamp`。

---

## 9. 身份、存储与隐私同意

### 9.1 身份状态

| 字段 | 规则 |
|---|---|
| `deviceId` / visitor ID | SDK 自己生成并持久化；不直接把系统 `deviceId` 当永久 visitor ID |
| `userId` | `setUserId()` 同步更新内存并排程持久化；下一事件立即生效；长度超过 1000 或包含未配对 UTF-16 代理字符时整次调用失败并保留旧身份；不擅自 trim，只有空字符串表示退出 |
| `userKey` | 仅 `init({ idMapping: true })` 时与 `userId` 同步存储/上报；默认 `false` 时保留 userId、丢弃 userKey 并 warning；长度超过 1000 时整次调用失败 |
| `sessionId` | 新访问更新；首次匿名 → userId 不重置；最近非空身份 A → 不同身份 B 时新建 session 并发送 `VISIT`，包括 A 退出后登录 B；登出与再次登录 A 不重置 session |

不能使用 `uni-`、`uni_`、`dcloud-`、`dcloud_` 作为 SDK storage key 前缀，它们是框架保留前缀。非 App 端清 storage 还会改变框架 deviceId；虽然一期是 App，也应保持自己的 visitor ID 策略，以便未来扩端。[Storage 文档](https://uniapp.dcloud.net.cn/api/storage/storage.html)

存储 key 使用跨端固定的 `GIO_STORAGE_PREFIX = 'gio:v1:'`，不加入 `uniapp`、`web` 或小程序平台名。相同 `dataSourceId` 在每个宿主各自的存储空间中使用同一命名规则：

```text
gio:v1:{dataSourceId}:identity
gio:v1:{dataSourceId}:session
gio:v1:{dataSourceId}:queue:v1
gio:v1:{dataSourceId}:meta
```

`eventSequenceId` 放在 `meta` 中，作为一份持久化全局计数器：`VISIT`、`PAGE`、`CUSTOM`、`VIEW_CLICK`、`VIEW_CHANGE` 创建时递增，冷启动后继续；其他事件不携带该字段。它不随 session 重置，也不需要任何平台分支。恢复时取 `meta` 与有效待发队列中最大事件序号的较大值，避免分别落盘或异常退出使新事件复用队列中已分配的编号。若计数器和历史队列都已丢失，不能据此恢复已上传历史的最大编号。

`PAGE.timestamp` 与该页快照的内部显示时间 `shownAt` 共用同一次构建时取时，恢复采集补 PAGE 时刷新该值。CUSTOM / VIEW 仅携带当前页的 `path` / `query`，其 `timestamp` 由 `ClockPort.now()` 在**每条事件实际创建**时读取，其他非 PAGE 事件也遵循这一取时规则，取设备当前系统 Unix 毫秒时间；不得使用入队、重试或发送时间覆盖它，也不因时钟回拨、重复或未来值进行单调化修正。该口径严格对齐 Android 的 `System.currentTimeMillis()`、iOS 的当前 Unix 毫秒时间和 HarmonyOS 的 `Date.now()`；跨事件先后关系只使用 `eventSequenceId`，不能借 `timestamp` 猜测。

### 9.2 存储边界与记录格式

`core` 不直接调用 `uni.getStorageSync`、`localStorage` 或任一小程序全局对象。`src/types/index.ts` 定义异步存储端口；一期 App 适配器可以在内部调用同步 `uni` API 后立即 resolve，但 core 从第一天起不依赖同步特性：

```ts
type StorageArea = 'state' | 'queue'
type StorageRead =
  | { kind: 'value'; value: string }
  | { kind: 'missing' | 'unavailable' | 'corrupt'; message?: string }
type StorageWrite =
  | { kind: 'ok' }
  | { kind: 'unavailable' | 'quota' | 'failed'; message?: string }

interface StoragePort {
  readonly persistentQueue: boolean
  read(area: StorageArea, key: string): Promise<StorageRead>
  write(area: StorageArea, key: string, value: string): Promise<StorageWrite>
  remove(area: StorageArea, key: string): Promise<StorageWrite>
}
```

存储端口只读写字符串，不知道 visitor、session、事件或版本。`core` 负责 JSON 编码、字段校验、过期和版本 envelope：

```json
{ "version": 1, "expiresAt": null, "value": { "...": "..." } }
```

对外 `init()` 仍同步完成参数校验和实例创建，但 tracker 在 state 和 SystemContext hydration 完成前处于 `initializing`：不能先生成新的 visitor 再读取旧 visitor，也不能先发缺少设备/网络 context 的首屏报文。这段时间的业务事件与身份/位置指令共用一个 bootstrap buffer，生命周期使用独立 buffer；两者各自最多 50 条或 256KB 序列化 JSON，合计上限为 100 条或 512KB。各缓冲满时保留已有项、拒绝新项，业务突发不能挤掉首次 App/Page 生命周期；释放时按共同的接收顺序合并回放。App show/hide 同时保存接收时刻，仅用于计算真实后台会话间隔；事件报文仍在回放构建时取当前时间。属性先按统一规则规范化，再保存 JSON 快照，避免 undefined、非有限数字或 Date 在初始化前后改变语义。identity/session/meta 与 SystemContext 都完成后，按原发生顺序构建并入队；存储不可用时才生成仅当前进程有效的 visitor，并记录诊断。

`SystemContextPort` 一次性解析 Protocol 要求的 App context：`platform`、`platformVersion`、`domain`、`appState`、`appName`、`networkState`、屏幕、品牌/型号/类型、语言、`sdkVersion` 与安装包 `appVersion`；`timezoneOffset` 是每条事件的动态 context，不固化在该快照。`platform` 由 App profile 固定映射为 `iOS`、`Android`、`HarmonyOS`，绝不透传 uni 的原始字符串；无法识别目标 App 平台或落在 H5/小程序等非一期宿主时，初始化失败并记录 `unsupported_platform`。`platformVersion` 正常时只取系统真实版本号、去掉首尾空白但不改写格式；读取失败、空白或异常时写 `UNKNOWN` 并记录 `platform_version_unavailable`，继续采集且不提供业务覆盖入口。`domain` 优先读取 `uni.getAppBaseInfo()` 的 iOS `bundleId`、Android `packageName` 或 HarmonyOS `bundleName` / `packageName`，其次读取真实宿主包字段 `hostPackageName`；Android / iOS 字段缺失时通过 Native.js 读取实际安装包标识。不提供业务覆盖入口，也不使用 DCloud appid 代替包标识；均不可用时省略该字段。屏幕尺寸优先由 `uni.getDeviceInfo()` 读取，失败再使用 `uni.getSystemInfoSync()` 的设备 `screenWidth/screenHeight`，绝不用随页面变化的 window 尺寸；两个逻辑尺寸均须为有限正数（允许小数），乘以有效的 `device.devicePixelRatio`、`system.devicePixelRatio` 或兼容的 `system.pixelRatio`（均不可用时为 1）并四舍五入为物理像素，再统一写为短边 `screenWidth`、长边 `screenHeight`；Android 的 600dp 平板分类仍使用缩放前的逻辑尺寸，因此横竖屏不会把同一设备拆成两种尺寸。两级读取后仍无有效值时宽高均写 `0` 并记录 `screen_size_unavailable`，不阻塞初始化。`deviceType` 只允许 `PHONE`、`PAD`、`FOLD`、`UNKNOWN`：iOS `iPhone` / `iPad` 映射为前两者，Android 保留同名类型，HarmonyOS 使用其设备类型映射；取不到或不能可靠映射时写 `UNKNOWN` 并记录 `device_type_unknown`，不阻塞采集。`deviceBrand`、`deviceModel` 不作跨端改名，正常时保留系统原值；空、异常或不可用时均写 `UNKNOWN`，分别记录 `device_brand_unavailable`、`device_model_unavailable`，不阻塞采集。`appName` 只取同一 API 的 `appName`，不可覆盖；读取失败统一写空字符串并记录 `app_name_unavailable`，与独立 Android/iOS SDK 的 best-effort 行为对齐。`language` 优先读取标准 App 信息中的 `appLanguage`，其次 `language`；App 统一转换为 BCP 47（`_` 转 `-`，语言小写、script 首字母大写、region 大写），只读到 `zh` 则保留 `zh`，不擅自补成 `zh-Hans` 或 `zh-CN`；取不到或无法解析时写 `und` 并记录 `language_unavailable`。每条新事件通过 `TimezonePort` 读取标准 `Date.getTimezoneOffset()` 并转为字符串，采用“本地时间转 UTC 所需增加分钟数”的统一口径（中国 `-480`）；系统时区或夏令时变化只影响后续事件。读取抛错、非有限数或无法转为整数时写 `0` 并记录 `timezone_offset_unavailable`，不阻塞采集。`appVersion` 优先读取 `uni.getAppBaseInfo().appVersion` 等标准 App 信息；读取失败才使用 `ResolvedGioConfig.appVersionFallback` 的非空值；两者都不可用时写空字符串并记录 `app_version_unavailable`，继续采集，不能伪造 `1.0.0`。网络查询使用固定短 deadline；将宿主返回的 `wifi`、`2g`、`3g`、`4g`、`5g` 规范为 `WIFI`、`2G`、`3G`、`4G`、`5G`，`none`、`unknown`、泛化 `cellular`、超时、错误或宿主不可用都写 `UNKNOWN` 并记录诊断，绝不猜测代际。初始化发起首读但不等待异步网络查询完成：使用已获取的读数或 Native.js 同步读数，暂不可用时以 UNKNOWN 构建事件，避免把最多 1 秒的查询 deadline 变成首屏事件延时。初始化就绪后订阅网络状态变化，并在返回前台时主动重查；启动与首次显示共用未完成的查询；后续回到前台若查询仍在进行，则合并记录一次重查，当前查询结束后重新读取，仅更新后续事件。监听缺失或注册失败的宿主也可在恢复前台后解除离线状态。查询本身与其 Promise 回调均受新通知的优先级保护，二者只更新后续事件的 snapshot；连接状态与协议 networkState 分开保存：明确断网为 false，明确联网为 true，无法判断为 null；UNKNOWN 不等于断网。明确断网时事件照常入队和持久化，普通发送、到期重试及后台强制发送均暂停；恢复网络后继续发送，包括宿主报告已连接但无法区分代际的情况。飞行中的请求因明确断网而失败时保留原事件及重试额度；查询失败或迟到的旧读数不能解除新的断网状态。事件 builder 完成字段白名单和系统兜底后，统一调用 `sanitizeOutboundEvent`：它在入队、持久化和发送前移除 `null`、`undefined`、空字符串、空对象和空数组，保留数值 `0`；因此 `domain`、`appName`、无 fallback 的 `appVersion` 等读取失败时不会伪造值，也不会把空字段发给 collector。`attributes` 已经被属性 normalizer 转为字符串 map，其中 `"false"` 不是空值。首个 `VISIT`、首个 `PAGE` 和 buffer 中任何手动/无埋点事件都使用同一份就绪后的稳定 context snapshot 与各自构建时的 timezone；后续网络或时区变化只更新未来事件，不回写已入队事件。`appState` 是生命周期驱动的未来事件快照，不能永久沿用启动时的值。

`appChannel` 由 App event builder 从 `ResolvedGioConfig.appChannel` 直接读取，三端规则完全相同：非空即进入后续事件，`null` 则交给 `sanitizeOutboundEvent` 省略。显式值仅保存于当前成功 init 的内存配置，不写 storage、不支持运行时修改；不得读取 `uni.getAppBaseInfo().channel` 或加入任何端侧自动回退。

读取时 core 校验 envelope；过期、损坏或错误类型只删除本 SDK 自己的 key，并分别记录 `storage_expired`、`storage_corrupt`。绝不能调用 `uni.clearStorage()`、清空 `localStorage` 或删除宿主其他业务 key。

### 9.3 身份字段 XOR 保护

所有端对 `identity` record 中的 visitor/deviceId、userId、userKey，以及内部保留的最近非空身份 `lastUserId` 使用同一套 XOR 保护；旧记录缺少 `lastUserId` 时兼容恢复，由当前 userId 推导最近身份。填充字段解码失败必须视为记录损坏，不能与合法匿名 null 混同。`lastUserId` 不进入事件报文；key 名、session、queue、meta 和事件报文不使用该算法。它的目标是避免身份值以明文直接出现在宿主存储中，**不是密码学安全的加密**：攻击者若取得 SDK 和本地数据仍可还原。若有对抗攻击或合规加密需求，必须另行使用平台安全存储/服务端方案，不能把 XOR 当作替代品。

不复用 Web SDK 现有的字符级 `^ 1` 实现。新算法固定为 `xor-utf8-v1`，密文前缀固定为全端统一的 `GIO_IDENTITY_CIPHER_PREFIX = 'gioenc-v3-'`：

```text
明文字符串
  → 标准 UTF-8 字节
  → cipher[i] = plain[i] XOR key[i mod key.length]
  → Base64URL（无 padding）
  → gioenc-v3-<密文>
```

`gioenc-v2-` 是现有 Web SDK 的前缀，但它对应另一套有问题的旧算法；新实现绝不能用 `v2` 前缀写出 `xor-utf8-v1` 的结果，否则只看前缀无法确定该如何解码。`gioenc-v3-` 从此作为 Android、iOS、HarmonyOS、Web 和小程序的共同写入格式，算法由 record 内的 `cipher` 字段校验。`key` 是由 SDK 内部稳定 seed 与 `dataSourceId` 按 UTF-8 拼接得到的非空字节串；它不作为公开配置项，也不按 Android/iOS/Web/小程序分叉。实现必须自带一致的 UTF-8 与 Base64URL 编解码，不能依赖 `btoa`、`TextEncoder`、Node Buffer 或某个宿主特有 API；中文、emoji、空字符串、代理对、非法 Base64URL、错误 UTF-8 都要有跨端 fixture。

身份 record 的 envelope 增加 `cipher: "xor-utf8-v1"`，并逐字段保护身份值，例如：

```json
{
  "version": 1,
  "expiresAt": null,
  "cipher": "xor-utf8-v1",
  "value": {
    "deviceId": "gioenc-v3-...",
    "userId": "gioenc-v3-...",
    "userKey": "gioenc-v3-..."
  }
}
```

读取时只有该标记才解码；未标记的合法旧明文按 `legacy-plain-v0` 读取，并在下一次成功写入时迁移为新格式。任何解码、UTF-8 校验或字段校验失败都视为 `identity_corrupt`：清理该 identity record、记录诊断并重新生成 visitor，绝不把无法验证的密文当 userId 使用。后续算法升级只新增版本读取器；旧版本成功写入新 record 后再删除旧格式。

| 存储内容 | area | 生命周期与失败处理 |
|---|---|---|
| `identity` | `state` | visitor/user/userKey；无过期。首次读取缺失才生成 visitor；写失败时仅在当前进程保留，并记录诊断 |
| `session` | `state` | sessionId、最后后台时间；由 core 注入的 `SessionPolicy` 判断，不依赖宿主 TTL |
| `meta` | `state` | eventSequenceId、schema/version；无过期 |
| `queue:v1` | `queue` | 仅 App 三端持久化待发纯 JSON 事件与 retry 元数据；容量或写入失败不宣称可恢复，记录 drop reason；损坏或迁移失败只丢该队列 |

App 适配器的 `persistentQueue=true`，同一队列的读改写由 core 串行化并带 revision，成功落盘后才把它视为“已持久化”；发送中的项目不能被后续快照覆盖。Web/小程序适配器的 `persistentQueue=false`，core 只保留有界内存队列：失败可在当前运行期间重试，但刷新、退出、被回收或冷启动后不恢复。`dataCollect=false` 只阻止后续事件构建、入队和落盘；切换本身不删除既有 queue/state，也不取消已排程或进行中的上传。已存在的待发事件仍按 uploader 的既有生命周期处理；关闭采集不是清除历史数据的 API。身份、session 与序号也不因该开关变化而清理。

`identity`、`session`、`meta` 和 `queue` 各自按键顺序写入，不能依赖宿主写入总是同步完成。每个键最多保留一份在写和一份待写快照：慢写入期间的新更新覆盖唯一待写项，并共用该次最新快照的写入结果；中间快照不会逐个落盘。当前写入失败后仍尝试最新待写项，键之间独立。队列 revision 仅在成功写入时递增，到达安全整数上限后从 1 继续，负值按损坏记录处理；revision 不作为跨运行期全局序号。

### 9.4 各端存储适配器

| 适配器 | `state` | `queue` | 适配器负责的差异 |
|---|---|---|---|
| `app-storage.ts`（一期） | `uni` storage | 同一 `uni` storage | 同步 API 抛错、容量不足、App 重启后的恢复 |
| `web-storage.ts`（二期） | localStorage | 不持久化 | localStorage 被禁用/抛错、配额；不使用 cookie、localStorage 或 IndexedDB 保存失败上报 |
| `miniprogram-storage.ts`（二期） | 宿主 storage | 不持久化 | `getStorageSync` 返回形态、`data` 参数名、批量 API 是否存在、各宿主配额/清理语义；失败上报只留内存 |

适配器不得使用“静默换一个永久存储”的方式掩盖失败。若 state 宿主持久化不可用，SDK 仍可在当前进程处理已有内存事件并尝试发送，但不会承诺冷启动恢复；仅 App 的 queue 写入失败记录 `queue_persist_failed`，避免把临时内存误当可靠队列。

### 9.5 迁移与清理

- key 和 envelope 都带版本；新版本先完整读校验、写入新记录，确认成功后才删除旧记录；
- identity/session/meta 单独迁移，任一记录失败不影响其他记录；仅 App 的 queue 参与迁移，迁移失败只清理旧 queue 并记录 `queue_migration_failed`，不阻塞启动；
- `dataCollect` 切换不参与任何 SDK storage 清理；`clearUserId()` 只清 userId/userKey，不清 visitor、eventSequenceId 或其他业务存储；
- `setUserId()` 采用 Android/iOS 独立 SDK 的换人语义：首次匿名 → A 仅更新身份；A → B（均为非空且不同）新建 session 并发送一条 `VISIT`；A → 空仅清 userId/userKey，不产生 `VISIT`，但保留加密的最近非空身份；之后登录 B 仍按 A → B 换人，重新登录 A 则续接原 session；同一 userId 重复设置不产生额外 session 或 `VISIT`。换人时不补 `PAGE`，后续真实页面生命周期仍按正常规则产生页面事件；
- `idMapping` 是 init 期固定配置，默认 `false`，不允许通过 `setOptions()` 热修改。关闭时调用 `setUserId(userId, userKey)` 仍成功更新 userId，但丢弃 userKey 并输出一次明确 warning；开启时才持久化并写入 Protocol 的 `userKey`。userId 或 userKey 任一超过 1000 字符或包含未配对 UTF-16 代理字符时整次调用失败，内存与存储均不改变；
- Web/小程序二期没有可靠离线队列承诺；同一运行期的内存队列按实例串行发送，页面刷新或宿主回收后的失败数据允许丢失。

### 9.6 隐私同意状态机

```text
未初始化 → 采集中 → 已关闭采集 → 再次采集
       init(省略 dataCollect / true)  setOptions(false)   setOptions(true)
```

- 未传 `dataCollect` 时立即采集；这是与既有 SDK 对齐的默认行为；
- 需要等待隐私同意的业务必须 `init({ dataCollect: false })`；禁止采集时可初始化身份和必要配置，但不得产生、持久化或上传行为事件；
- 后台因换人或恢复采集而新建 session 时，保留 App 离开时间，下一次前台恢复仍按该时间判断会话超时。
- 从关闭重新开启时新建 session，并立即补当前入口 `VISIT` 与当前页 `PAGE`；关闭期间的事件不补发。该顺序与 Android、iOS 和小程序 SDK 的恢复采集行为对齐；
- 从 `true` 切到 `false` 时，立即阻止后续自动/手动事件构建；不删除既有待发队列，不清 identity/session/eventSequenceId，也不取消已排程或进行中的上传。关闭期间新发生的事件不会补发；再次同意后从新 session 开始。事件计时器不属于一期，因此一期没有 timer registry 可清理；二期加入计时器时再按独立 SDK 的“关闭即清计时器”语义实现。
- `debug` 默认关闭且只能在 `init()` 配置；开启后按小程序 SDK 的调试口径打印已完成字段清理、移除 SDK 内部 `requestId` 等元数据后的待发事件数组。它是本地开发排障输出，不持久化、不上报，也不得在生产环境开启；敏感 input 的事件仍须在事件构建阶段被拒绝，不能因 debug 绕过隐私规则。

---

## 10. 上传、队列与网络

### 10.1 请求边界

一期实际使用 `src/platform/uni.ts` 对 `uni.request` 的封装；但 `src/core/uploader.ts` 不得直接调用 `uni.request`、`fetch`、`XMLHttpRequest` 或任一小程序全局对象。它只调用 `src/types/index.ts` 中的同一个端口：

```ts
type TransportRequest = {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  timeoutMs: number
}

type TransportResult =
  | { kind: 'success'; status: number }
  | { kind: 'http'; status: number; responseText?: string }
  | { kind: 'network' | 'timeout' | 'aborted' | 'unsupported'; message?: string }

type TransportHandle = { abort?: () => void }

interface TransportPort {
  dispatch(request: TransportRequest, done: (result: TransportResult) => void): TransportHandle | void
}
```

请求适配器只做宿主 API 参数转换、返回值归一化和可选取消；不得决定批次、重试、删除队列或构造事件。uploader 为每次 dispatch 建立唯一 finalizer：它自己的 deadline 先到时完成为 `timeout` 并调用可用的 `abort()`；之后才到的 success/fail/complete 回调必须被忽略。同步抛错也要转换为 `network` 并走同一 finalizer。

| 适配器 | 实际请求方式 | 仅在该适配器处理的差异 |
|---|---|---|
| `app-request.ts`（一期） | `uni.request` | callback 与 requestTask.abort、App HTTP/证书/网络失败 |
| `web-request.ts`（二期） | 优先 `fetch`，无 fetch 时 XHR | CORS、AbortController/XHR abort、响应文本；不把 DOM 依赖带入 core |
| `miniprogram-request.ts`（二期） | `wx.request`、`my.request`、`tt.request` 等宿主包装 | header/headers 命名、请求 task 是否支持 abort、域名白名单和宿主 fail 形态 |

Web 和小程序适配器是后续能力，不进入 1.0 发布物；其接口和 App 完全相同。二期如采用 UTS 网络实现，也只能替换 App 适配器的内部实现，不能绕过 `TransportPort` 或改变请求结果语义。

### 10.2 报文、状态码与重试

- 所有大小上限的 `KB` / `MB` 均按 `1024` 换算，且统一以 `utf8JsonByteLength(value) = UTF-8(JSON.stringify(value)).byteLength` 计算；单条事件按自身 JSON，batch 按实际 HTTP JSON 数组 body（包含 `[`、`,`、`]`），持久化 queue 按完整 queue envelope（含 retry 元数据），bootstrap buffer 按完整 buffer 数组。
- 一次请求最多 50 条事件且实际 HTTP JSON body 不超过 512KB；单条事件自身超过 512KB 时直接丢弃并记录 `event_too_large`，不拆分、不重试；
- 最多同时发送 3 个请求。每批先尝试一次；仅 `network`、`timeout` 和 5xx 可再重试 2 次，延迟依次为 800ms、1600ms，并各自加入 ±20% 抖动；
- core 将基础 `serverUrl` 拼为 `POST {serverUrl}/v3/projects/{accountId}/collect?stm={sendAt}&compress=0`，其中 `sendAt` 是批次实际开始发送时的 Unix 毫秒；请求头固定为 `Content-Type: application/json`、`Accept: application/json`，Body 为已清理的 JSON 事件数组。适配器不得改写 URL、事件、压缩标记或认证字段；
- 成功状态码以 Protocol/collector 契约为准；一期 collector 明确接受 `200` 和 `204`，其他状态码转换为 `http`；
- 仅 `network`、`timeout` 和 5xx `http` 进入有限退避重试；4xx、编码错误和 `unsupported` 不重试并记录 drop reason；
- App 三端将重试中的队列及已使用的 retryCount 持久化，冷启动按剩余额度继续发送，不归零；剩余额度不同的事件分批发送，超过额度的历史项直接丢弃；Web 和小程序只在当前运行期的内存队列中重试，刷新、退出或宿主回收后不恢复；
- App `onHide` 只触发最长 1 秒的 force flush；到期未完成的事件保持在 App 持久化队列中，留待下次启动发送，不采用另一种“后台专用”报文。Web 二期没有 `APP_CLOSED`，不得为了发送而伪造关闭事件或把 sendBeacon 混入核心链路；
- HTTP `200`/`204` 只表示 collector 已接收；服务端入库拒绝必须由可关联的响应/诊断协议另行证明。

### 10.3 队列状态

```text
产生事件 → validate/privacy → 内存队列 → 持久化快照
         → App/Web 立即尝试发送；小程序按专属节流策略 → sending
         → 成功：删除；可重试失败：退回等待；不可重试：丢弃并计数
```

持久化的每条事件必须是纯 JSON。App 队列最多 200 条且完整持久化 queue envelope 总量不超过 2MB；达到任一上限时保留最早的已有事件、丢弃新事件并记录 `queue_full`。写入失败、容量达到上限、JSON 序列化失败都应有可计数的 drop reason，不能无限重试或影响业务 UI。

App 事件缓存自事件 `timestamp` 起保留 7 天（7 × 24 小时），到达有效期即丢弃；冷启动恢复、事件入队和上传调度时清理，释放过期事件的容量。重启、重试及后续队列写入不会延长有效期；延迟重试中的批次也必须在实际发送前排除过期事件。未运行期间不执行后台清理，下次启动时清除。旧缓存直接按原事件时间计算，无需变更存储格式；缺少时间戳、无法判定年龄的历史事件在清理时丢弃。有限重试、成功及不可重试失败的删除规则继续生效；小程序仍为当前运行期内的内存队列，不应用 App 的 7 天策略。

容量判断包含 revision 字段的最长合法表示、条目包装、逗号及数组边界。事件 JSON 和字节数在接纳时冻结，批次按单事件字节累计；上传调度只读取请求标识和队列长度，不复制整份事件载荷。队列快照、领取批次及发送前观察回调接收独立数据，外部修改不得污染内部记录或后续重试报文。

官方 storage 各端实现不同：App 是持久化存储，H5 和各小程序有自己的容量/清理语义。因此即便一期只做 App，队列接口也要从一开始具备条数和字节上限，为后续扩端留下正确边界。[Storage 文档](https://uniapp.dcloud.net.cn/api/storage/storage.html)

### 10.4 网络状态

网络状态只用于调度，不是事件成功证明：

- 初始化时在固定短 deadline 内读取当前网络；`wifi` / `2g` / `3g` / `4g` / `5g` 统一规范为 `WIFI` / `2G` / `3G` / `4G` / `5G`；
- 订阅网络变化；从任何状态恢复到已知在线状态后立即尝试 flush；
- `none`、`unknown`、泛化 `cellular`、网络 API 不可用、超时或报错均以上报值 `UNKNOWN` 处理，仍可正常入队；
- 发送失败的最终判断来自 `TransportResult`，而不是网络回调。

---

## 11. 二期：UTS 原生增强层

### 11.1 何时使用

本节保留后续原生实现边界。当前已交付可选 module 的 JS 端口；本轮不新增 UTS 或 Android / iOS module。原生插件只解决标准 API 无法可靠获得、且产品确实需要的能力，例如：

- 原生渠道或设备字段；
- 更早/更可靠的 Android Activity 前后台通知；
- 原生网络、广告标识或系统能力；
- 后续接原生 GrowingIO SDK 的桥梁。

不使用 UTS 的能力：基本埋点、页面生命周期、模板 click/change、身份、队列、基础 HTTP。这些应保持在 Vue/TS/`uni.*` 主链，避免业务接入方被强迫进入 UTS 编译与桥接问题。

### 11.2 原生可选字段边界

已实现可选 `gioNativeIdentifiers` 插件的 JS 接入，只补充 Protocol 定义的端侧可选字段：iOS 的 `idfa` / `idfv`，Android 的 `oaid` / `googleAdvertisingId` / `androidId` / `imei`。默认关闭，不新增自动权限请求，也不等待这些字段才构建首个 `VISIT` 或 `PAGE`。宿主 module 只返回已有授权可安全取得的值；字段为空、无权限、module 缺失、超时或调用失败时直接省略，不伪造 `UNKNOWN` 或其他端的值。具体 module、停采失效和字段白名单见[接入说明](./advanced-identity-hybrid.md#app-原生标识增强)。

设备标识仅允许写入 `VISIT`。它们都是增强而非采集前提：基础事件、隐私开关、session、队列和上传必须在没有任何可选字段时保持完全可用。

### 11.3 桥接硬约束

- JS → UTS 仅传 primitive、`UTSJSONObject` / JSON 数组和无循环快照；
- 不传 `VueApp`、页面实例、原生句柄、函数或 proxy；
- 导出接口避免依赖未解绑的长期 callback；订阅必须有明确 unsubscribe；
- UTS 不可用、版本不满足或单端编译失败时，后续原生增强必须降级为无增强，而不是让核心 SDK 初始化失败；
- 原生字段需要单端 capability 检查；不把 Android/iOS 值伪装为 Harmony 值。

官方确认传统 uni-app 由 JS 调用 UTS，且 JS 引擎的复杂对象交互仅支持 JSON 类边界；这正是主 core 不进入 UTS 的原因。[UTS 插件交互](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html)

---

## 12. Vue3/Vite 插桩器实现规范

### 12.1 无埋点插件的构建侧安装接口

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
import { gioUniappAutoTrack } from 'gio-uniapp-autotracker/vite'

export default defineConfig({
  plugins: [
    gioUniappAutoTrack({ enabled: true }),
    uni(),
  ],
})
```

插件顺序必须用 fixture 工程在目标 HBuilderX / CLI 编译器版本验证。公开文档不能只因某个 X 工程可用就宣称传统 uni-app 也必然相同。

### 12.2 AST 改写范围

处理 `.vue` SFC 的 template AST，不用正则扫描字符串。至少覆盖：

- 静态事件名，以及已验证不会改变原语义的动态 handler 参数；
- `@click` / `v-on:click` / `@tap`；
- `@change`、`@blur`、`@confirm`；
- 纯方法引用、带参数调用、内联表达式，以及经独立业务语义回归的直接箭头 listener、条件选择方法引用；其他复杂嵌套表达式保持原样并输出 build warning；
- `v-for`、`v-if`、slot、动态 attribute；
- `data-*` 元数据与静态 input type；
- 对 `uni-link` 等无业务 handler 的组件添加只采集调用。

SFC block 必须由 `@vue/compiler-sfc` 提取，template 内容再交给 `@vue/compiler-dom`；禁止用正则截取 SFC。普通元素缺失 handler、动态事件名、计算成员、复杂嵌套表达式、自定义组件事件和任何事件修饰符都不在一期范围内，必须报清晰的 build warning 并保留原业务代码。绝不能生成会改变业务 handler 参数/返回值的“半正确”代码。

### 12.3 改写时序

固定契约：dispatcher 先同步执行，再执行业务 handler；若采集内部错误，捕获并吞掉 SDK 错误后继续业务 handler。理由是业务 handler 可能马上导航或销毁页面，而采集应保留当前页面快照。这个时序必须固化到测试，且不能吞掉业务错误。

```ts
// 概念示意，不代表最终生成文本
($event) => {
  dispatchAutoTrack(snapshot($event))
  return originalHandler($event)
}
```

原始纯方法引用必须显式补回 Vue 原本透传的 `$event` 调用；直接箭头、函数表达式和顶层条件表达式使用各自 wrapper，保证 listener 和条件只求值一次。Options API、普通 `setup()` 与 `<script setup>` 分别验证模板上下文和 Ref 自动解包，不能只验证生成文本看起来相似。

### 12.4 二期 Vue2 预留

二期增加：

```text
src/autotrack/vue2-webpack/
  index.ts
  loader-or-plugin.ts
  transform.ts
  fixtures/
```

唯一允许不同的是“如何把模板 AST 改成运行时代码”；输出必须继续调用 `dispatchAutoTrack(AutoTrackCall)`，再由同一个 `gioEventAutoTracking` runtime 插件处理。禁止复制一份 normalizer、queue、event builder 或 privacy 实现。

---

## 13. `.nvue`、native page 与二期扩展

`.nvue` 是 App 原生渲染页面，与 `.vue` 的 webview 渲染不同；若同名 `.vue/.nvue` 同时存在，App 会选择 `.nvue`。这会让一期的 Vue3 `.vue` 插桩器根本不执行在实际 App 页面上。[页面说明](https://uniapp.dcloud.net.cn/tutorial/page.html)

因此上线前必须执行以下扫描：

```bash
rg --files -g '*.nvue' -g '*.vue' src pages
```

并在接入报告中列出：

- 哪些 route 在 App 实际落到 `.nvue`；
- 这些 route 是否只获得手动埋点/页面埋点；
- 是否需要第二期 `nvue` 插桩器；
- 是否启用 weex 编译模式。weex 模式中 `onShow` 行为与标准 Vue 页面有差异，不能沿用一期生命周期假设。[nvue 说明](https://uniapp.dcloud.net.cn/tutorial/nvue-outline.html)

二期目标可以拆成：

1. nvue 页面生命周期和手动埋点先支持；
2. 建立 nvue 事件 fixture；
3. 仅对验证通过的内置组件开放 click/change；
4. 最后才承诺完整模板无埋点。

---

## 14. Android / iOS / HarmonyOS 能力矩阵

### 14.1 代码层 capability profile

```ts
type Capability = {
  platform: 'Android' | 'iOS' | 'HarmonyOS'
  appLifecycle: boolean
  pageLifecycle: boolean
  autoClick: boolean
  changeInput: boolean
  changePicker: boolean
  tabBar: boolean
  appClosedBestEffort: boolean
}
```

不要使用一个 `isApp` 分支掩盖三端差异。每个能力以 `platform + compiler version + fixture result` 为依据。

`APP_CLOSED.appState` 不属于 capability：当前三个 App 端共同写为 `BACKGROUND`，由 `App.vue:onHide` 的后台语义决定。小的实现时机差异优先统一口径；只有影响事件含义、字段可用性或数据正确性的差异才成为 capability。完整口径见 [Measurement Protocol](./measurement-protocol.md)。

### 14.2 验收矩阵

| 用例 | Android | iOS | HarmonyOS | 证据 |
|---|:---:|:---:|:---:|---|
| 冷启动 `VISIT` + 首屏 `PAGE` | 必测 | 必测 | 必测 | 设备日志 + collect 请求 + 服务端接收 |
| 热启动 session 续接 / 超时新 session | 必测 | 必测 | 必测 | event sequence |
| 页面 query/referral | 必测 | 必测 | 必测 | 报文快照 |
| 普通 click / 列表 click / tab click | 必测 | 必测 | 必测 | `VIEW_CLICK` |
| input blur/confirm | 必测 | 必测 | 探测后定 | `VIEW_CHANGE` / 禁用证明 |
| switch/slider/radio/checkbox/picker | 必测 | 必测 | 逐项探测 | 组件矩阵 |
| 断网、恢复、超时、4xx、5xx | 必测 | 必测 | 必测 | 队列与 finalizer 日志 |
| 后台 `APP_CLOSED` | 必测 | 必测 | 必测 | best-effort 说明 |

**只有“SDK 已入队”或 HTTP 200 不是验收完成。** 每个主链至少要证明：初始化 → 事件构建 → 入队 → 请求发出 → HTTP 响应 → 服务端接收/拒绝日志。

---

## 15. 测试策略与质量门禁

### 15.1 单元测试

- config 归一化、空值和非法参数；
- identity/session 的新建、持久化和用户切换；
- page snapshot 和 pageKey 去重；
- 所有 `change` normalizer；尤其 `0` / `false` / 空数组；
- privacy rules：password、动态 type、ignore/track 冲突；
- event builder 的字段白名单、长度、`VIEW_CHANGE` 不带 index/hyperlink；
- uploader 的同步抛错、超时、一次 finalizer、重试上限、force flush；

### 15.2 插桩 fixture 测试

每个 fixture 都做“源码 → 生成代码 → 执行语义”三段断言：

- 普通元素无 handler 时不插桩并告警；`uni-link` 无 handler 时只补 `openURL` 探针；
- 普通方法 / 带 event 的方法 / 带业务参数的方法；
- 内联表达式、箭头函数、三元表达式；
- 修饰符保持源码、不插桩并产生可定位 warning；
- `v-for` 动态 dataset；
- input password、safe-password、file 与动态 type 即使带 `data-growing-track` 也不生成事件；
- input / textarea / switch / slider / radio / checkbox / picker / picker-view / swiper；
- 父子嵌套点击、业务 handler throw、异步导航。

### 15.3 编译和真机

每次影响 runtime 或 autotrack 的改动：

1. 运行 TS lint、typecheck、unit 与 fixture 测试；
2. 用目标 HBuilderX 打开 demo 根工程；
3. 分别编译 Android / iOS / HarmonyOS；
4. 用真机执行第 14.2 节矩阵；
5. 保存 SDK debug 日志、请求摘要和服务端接收证据；
6. 只在对应证据齐全后更新平台支持表。

构建通过只证明源码/编译器组合可接受；它不证明原生事件、网络和服务端收数正确。

---

## 16. 日志、诊断与可观测性

### 16.1 Debug 日志字段

日志分两类，口径对齐小程序 SDK：

1. 无论 `debug` 是否开启，参数错误、未初始化调用、配置/插件警告、初始化开始/完成和请求失败均通过统一 `consoleText(message, level)` 输出；level 只允许 `info`、`success`、`warn`、`error`，前缀固定为 `[GrowingIO]：`。初始化开始/完成的文本明确标识当前产品，依次为 `Gio uni-app SDK 初始化中...`、`Gio uni-app SDK 初始化完成！`；配置失败、运行期初始化失败和重复初始化分别输出对应的中文受控诊断，不输出 SDK 内部对象或状态码。
2. `debug: true` 时额外输出热路径：App 生命周期格式为 `App: <lifecycle> <timestamp>`，Page 生命周期格式为 `Page: <route> # <lifecycle> <timestamp>`，与小程序 SDK 一致；无埋点 action 也会输出。事件只在 uploader 准备实际发送请求时打印完整待发数组，绝不在入队时打印。App 无聚合等待，联网且存在空闲上传槽位时，事件入队后立即打印并发送；离线、并发槽位占满或失败重试仍可能推迟这条发送日志，不代表事件未生成。事件数组必须是已执行 Protocol 字段裁剪和 `sanitizeOutboundEvent`、且移除 SDK 内部 `requestId` / `trackingId` 后的 JSON；格式固定为单参数 ``console.log(`[GrowingIO Debug]: ${JSON.stringify(events)}`)``，避免 App 调试基座丢弃第二个参数。

`debug` 只改变本地控制台输出，不改变事件、队列、重试、请求或隐私规则；它不支持 `setOptions()` 热修改。由于调试事件数组会包含协议中本来就允许上报的字段（例如 userId、query 或业务显式允许采集的值），接入方不得在生产环境开启，也不得把控制台内容转存或上传为诊断数据。password、验证码、证件、支付、文件等被事件构建拒绝的敏感值，不得因为 debug 出现在日志中。

### 16.2 诊断计数

二期再提供只读的 `getDiagnostics()`，至少包含：

- init 状态、平台、SDK 版本；
- 当前 queue 条数/字节数；
- 最近上传成功/失败时间和失败分类；
- dropped 计数（隐私拒绝、队列满、schema 非法、不可重试）；
- autotrack 采集、过滤、去重计数；
- 后续 native enhancement 可用性和失败原因。

诊断 API 只用于开发/排障；不可把原始事件内容暴露给业务 UI。

---

## 17. 发布、兼容和升级

### 17.1 发布产物

- SDK 同时作为无作用域 npm 包 `gio-uniapp-autotracker` 与 `uni_modules/gio-uniapp-autotracker` 发布；
- 运行时 SDK 与 Vite 插件可以分 entry，但必须版本同步；
- release 包只包含编译后的 ESM JS、类型、Vite 入口、文档与许可证；二期原生增强发布时再增加必要 UTS 目录；
- demo、测试记录、内部 collector 配置和秘钥不可进入发布包；
- package metadata 声明支持传统 uni-app + Vue3 + App 三端，不借用 uni-app x 的版本承诺。

当前仓库以 `pnpm run release:prepare` 生成 `dist/uni_modules/gio-uniapp-autotracker`，并由 `pnpm run release:check` 验证递归白名单、版本/哈希、双渠道公共代码、Vite 依赖隔离，并在仓库外安装最终压缩包执行入口/类型/探针验证；仍不能替代三端设备请求和收数验收。双渠道发布流程见 [安装与发布](./release.md)。

### 17.2 向后兼容

- `AutoTrackCall`、事件字段、storage key 都应带版本；
- 只新增可选字段，不改写已发布字段含义；
- Vite 插桩器必须对不支持语法 fail-open：保留业务模板并产出 build warning；
- SDK core 升级需要 queue migration；迁移失败时丢弃旧队列并记录 `queue_migration_failed`，不要阻塞应用启动；
- 新增 Vue2/Webpack 只能新增 adapter，不得更改 Vue3 的输出协议。

---

## 18. 实施计划与完成定义

本节保留首期的阶段概览和完成定义；具体工作拆分、依赖、每阶段验收与发布门槛见独立的 [开发计划](./development-plan.md)。

### 阶段 A：骨架与协议（2–3 人日）

- 建立独立模块结构、对外 API、config、event builder；
- 从 mini SDK 移植 identity/session/queue/uploader 的语义，去掉平台宿主 hook；
- 建立 mock collector 和协议快照测试；
- 明确 `dataCollect` 默认开启、显式关闭路径与存储 key。

### 阶段 B：Vue runtime 与页面（2–3 人日）

- SDK 全局 Vue mixin / page lifecycle bridge；
- page snapshot、pageKey、session、`VISIT/PAGE/APP_CLOSED`；
- Android/iOS/Harmony profile 与基础 uni API；
- demo 冷启动、热启动、导航和后台用例。

### 阶段 C：Vue3 无埋点（3–5 人日）

- Vite AST 插桩和 fixture；
- click、tab、基础 change；
- normalizer、privacy、dedupe；
- HBuilderX / CLI 编译链探测。

### 阶段 D：稳定性与三端验收（4–7 人日）

- 请求超时/重试/finalizer、断网、队列满；
- Android/iOS/Harmony 真机矩阵；
- Harmony change capability gate；
- 接入文档、兼容表、release 检查。

**一期可发布的完成定义**：

1. Android、iOS、HarmonyOS 均完成冷/热启动、页面、手动埋点、click、上传链路真机证明；
2. `VIEW_CHANGE` 按端和组件列出通过/未通过矩阵，不以“代码存在”代替支持；
3. 隐私拒绝、敏感输入、队列满、断网恢复都具备自动测试；
4. Vue3 插桩 fixture 全部通过，业务 handler 语义回归通过；
5. 一期不依赖 UTS；二期 UTS enhancement 关闭或不可用时，核心 SDK 仍可工作；
6. 发布包与 demo 可在指定 HBuilderX 版本重建。

---

## 19. 二期清单

按风险而不是按目录排序：

1. Vue2 / Webpack 插桩器，复用 `src/plugins/gioEventAutoTracking/contract.ts`；
2. `.nvue` 页面生命周期与无埋点能力；
3. H5：独立 profile、CORS/Storage 和 DOM 增强；
4. 小程序：从 mini SDK platform profile 逐家接入，不把 App 兼容假设带过去；
5. 圈选、可视化配置、share、ABTest 等产品插件；
6. UTS 原生增强扩展，但任何增强不得成为采集基础能力的单点故障。
7. 事件计时器：提供 `trackTimerStart/pause/resume/end/remove/clear`，以单调时钟累计前台有效耗时；结束时发送 CUSTOM，并写入秒单位的 `event_duration`。计时器只存在内存，`destroy()` 或进程重启即清除。
8. 手动 PAGE、公开 `flush()`、`destroy()`/重新初始化，以及 `trackPage` / `autotrack` / 运行时 `debug` 开关；先在 uniappx 形成对应能力，再同步进入传统 uni-app。
9. 通用第三方插件契约：hooks、capability、插件 storage/request、销毁生命周期和产品插件的公开注册；不在传统 uni-app 单独提前开放。

---

## 20. 官方资料与仓库参考

- [uni-app 教程](https://uniapp.dcloud.net.cn/tutorial/)
- [App.vue 与应用生命周期](https://uniapp.dcloud.net.cn/collocation/App.html)
- [页面与 `.vue` / `.nvue` 选择规则](https://uniapp.dcloud.net.cn/tutorial/page.html)
- [uni-app 编译器：Vue2/Webpack 与 Vue3/Vite](https://uniapp.dcloud.net.cn/tutorial/compiler.html)
- [nvue 介绍](https://uniapp.dcloud.net.cn/tutorial/nvue-outline.html)
- [UTS 插件](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html)
- [uni.request](https://uniapp.dcloud.net.cn/api/request/request.html)
- [Storage](https://uniapp.dcloud.net.cn/api/storage/storage.html)
- 本仓库：[全端 Measurement Protocol](./measurement-protocol.md)
- 参考实现：`../gio-miniprogram-autotracker`、`../gio-web-autotracker`、当前仓库的 `uni_modules/gio-uniappx-autotracker`
