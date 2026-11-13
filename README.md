# gio-uniapp-sdk

GrowingIO 传统 uni-app Vue 3 数据采集 SDK。一行初始化即可自动采集页面浏览、App 生命周期与用户交互，同时支持手动埋点上报自定义事件、用户身份与属性。

支持传统 uni-app **Vue 3 `.vue`** 项目的八端小程序与 HarmonyOS（鸿蒙）App。小程序自动点击、组件完成事件和内置 TabBar 在普通生产构建中默认开放，安装自动采集插件即可使用，无需内部验证开关。

| 小程序平台 | 编译目标 | 上报 platform |
| --- | --- | --- |
| 微信 | `mp-weixin` | `MinP` |
| 支付宝 | `mp-alipay` | `alip` |
| 百度 | `mp-baidu` | `baidup` |
| 抖音 | `mp-toutiao` | `bytedance` |
| QQ | `mp-qq` | `qq` |
| 快手 | `mp-kuaishou` | `kuaishoup` |
| 京东 | `mp-jd` | `jdp` |
| 小红书 | `mp-xhs` | `xhsp` |

八端代码交付覆盖自动化、正式包运行回归与开发/生产编译；开发者工具原生交互、真机及真实采集服务验收留待后续，尚无对应验收结论。各平台原生组件及模式的可用范围仍以宿主为准。Android/iOS App 与 Web 不在本次交付支持声明内；Vue 2、uni-app x 和 `.nvue` 不适用本接入方式。

本次为 **1.0.0 本地交付候选**，尚未发布到 npm 或 GitHub Release。请使用本地验证过的归档包接入，不将仓库内的候选代码视为已经发布的版本。

## 功能特性

- **自动采集**包括会话开始（`VISIT`）、页面浏览（`PAGE`），以及八端小程序、鸿蒙 App 的按钮点击、输入完成、选择器和内置 TabBar 等交互。
- **手动埋点**：通过 `gdp()` 上报自定义事件、用户身份（`setUserId`）、用户属性（`setUserAttributes`）与位置信息。
- **无埋点插桩**：Vite 构建期自动为模板插桩，业务代码无需改动，原有事件 handler 完整保留。
- **隐私保护**：内置敏感字段拦截，密码、安全密码等输入内容永不读取、永不上报。
- **类型安全**：完整 TypeScript 类型定义，未知命令、参数错误在编译期即可发现。
- **离线缓存**：小程序在当前运行期保留有界内存队列，恢复联网后补发；App 端在存储容量允许时将事件落盘，最多保留 7 天。

## 安装

选择以下任一方式，同一应用内不要同时加载两份 SDK。

### npm

本地构建归档位于 `dist/release/gio-uniapp-sdk-1.0.0.tgz`。在客户项目目录中安装实际交付的文件：

```sh
npm install /absolute/path/to/gio-uniapp-sdk-1.0.0.tgz
```

正式发布后可使用包名安装：`npm install gio-uniapp-sdk`。

### uni_modules

本地归档位于 `dist/release/gio-uniapp-autotracker-1.0.0-uni_modules.tgz`。解压后将 `uni_modules/gio-uniapp-autotracker` 放入客户项目根目录；正式发布后可从 GitHub Release 下载同类归档。运行时导入路径为 `@/uni_modules/gio-uniapp-autotracker/index.js`，Vite 配置导入路径为 `./uni_modules/gio-uniapp-autotracker/vite.js`。

两种渠道均提供 ESM JavaScript 与 `.d.ts` 类型声明。

## 快速开始

在应用入口创建 App 后，注册插件并初始化 SDK：

```ts
import App from './App.vue'
import { createSSRApp } from 'vue'
import gdp from 'gio-uniapp-sdk'

export function createApp() {
  const app = createSSRApp(App)

  // 注册自动采集插件
  gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])

  // 初始化：传入账户 ID、数据源 ID 与配置
  gdp('init', 'account-id', 'data-source-id', {
    uniVue: app,
    // 小程序必填目标平台分配的真实 appId；App 接入时省略。
    appId: '平台分配的真实小程序 appId',
    appVersion: '1.0.0',
    serverUrl: 'https://collector.example.com',
    dataCollect: false,
  })

  return { app }
}
```

初始化完成后，SDK 会自动读取 `uni` 宿主，通过全局 Vue mixin 接管 App / Page 生命周期。业务侧的 `App.vue` 与页面**无需**再引入任何 lifecycle bridge，也无需手动埋页面事件。

小程序还需在 `manifest.json` 对应目标中配置平台 appId，并在平台后台配置 HTTPS 采集域名。初始化的 `appId` 必须是同一真实标识，不能填写 DCloud 的 `__UNI__...`；账号接口可用时会核对二者。示例先关闭采集，完成业务同意流程后调用 `gdp('setOptions', { dataCollect: true })`。`init` 返回 `true` 表示本地接纳初始化，最终收数需核对请求和服务端数据。

### 初始化配置

| 配置项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `uniVue` | `App` | 是 | 应用实例，SDK 据此接管生命周期 |
| `appId` | `string` | 小程序是 | 真实平台小程序标识；与宿主账号信息保持一致 |
| `accountId` | `string` | 是 | 账户 ID（`init` 第一个参数） |
| `dataSourceId` | `string` | 是 | 数据源 ID（`init` 第二个参数） |
| `serverUrl` | `string` | 否 | 数据上报地址 |
| `dataCollect` | `boolean` | 否 | 是否开启采集，默认开启 |
| `keepAlive` | `number` | 否 | 小程序后台保活分钟数，0–1440，默认 5，允许小数 |
| `sessionExpires` | `number` | 否 | 小程序额外活动超时，默认 -1 关闭；App 后台超时默认 0.5 分钟；有效正数不超过 360 |
| `uploadInterval` | `number` | 否 | 小程序聚合间隔毫秒数，四舍五入后 0–3000，默认 1000；0 即时发送 |
| `appVersion` | `string` | 否 | 应用/小程序版本；显式配置优先，小程序缺省读取账号中的版本，无法取得则省略 |
| `idMapping` | `boolean` | 否 | 是否启用身份映射 |
| `debug` | `boolean` | 否 | 是否在控制台输出调试信息 |
| `forceLogin` | `boolean` | 否 | 等待一次 `identify(deviceId)` 后再发送当前运行期事件，默认 false |
| `miniprogramStorage` | `object` | 否 | 小程序身份存储选项：`plugin` 使用插件键，`storagePrefix` 设置用户字段前缀 |

`dataCollect`、`idMapping`、`debug`、`forceLogin` 及保活、超时、上传间隔的非法值会回退默认。`miniprogramStorage` 仅接受 `plugin`（布尔）和 `storagePrefix`（最多 128 位 ASCII 字母、数字、下划线或连字符，可为空）两个键，格式错误会拒绝初始化；真实 appId、账户、数据源和 `uniVue` 也必须有效。

需要等待用户同意时，初始化传入 `dataCollect: false`。关闭期间不新增采集事件；此前已接纳的待发事件保留，在恢复采集后继续上传。只有 `dataCollect` 可通过 `setOptions` 在运行期修改。

小程序默认上传间隔 1 秒，每批最多 50 条、最多三个并发请求，失败最多重试两次。前台离线且有待发事件时每 2 秒刷新网络，后台或空队列停止刷新；切后台尽力立即发送，不能保证宿主回收进程前完成。小程序 session 与队列仅在内存中，队列最多 200 条、2 MiB；进程退出后待发事件不会恢复。

设备及登录身份使用独立小程序 SDK 的 `_growing_*` 字符串键共享，事件序号按平台、appId、账户和数据源隔离。多键身份更新失败会保留本 SDK 的恢复记录，重启先恢复一致性；不能确认的损坏或外部冲突会阻止采集。运行中清缓存后，显式登录、退出或 `identify` 可以修复缺失的设备键，已清除的登录字段不会从内存复活。同一应用内切换 SDK 应停止旧运行时，不同时加载两套自动采集实现。

## 手动埋点

业务代码统一通过 `gdp()` 调用 SDK，无需持有任何内部实例：

```ts
// 上报自定义事件
gdp('track', 'purchase', { sku: 'sku-1', price: 99 })

// 设置用户 ID
gdp('setUserId', 'user-123')

// 清除用户 ID
gdp('clearUserId')

// 设置用户属性
gdp('setUserAttributes', { vip: true, level: 3 })

// 设置位置信息
gdp('setLocation', 31.23, 121.47)

// 清除位置信息
gdp('clearLocation')

// 动态开关采集
gdp('setOptions', { dataCollect: false })
```

### 支持的命令

| 命令 | 说明 |
| --- | --- |
| `track` | 上报自定义事件及属性 |
| `setUserId` | 设置当前用户 ID |
| `clearUserId` | 清除用户 ID |
| `setUserAttributes` | 设置用户属性 |
| `identify` | 高级身份识别 |
| `getGioInfo` | 获取 SDK 信息，返回 `string \| null` |
| `setOptions({ dataCollect })` | 动态开关采集 |
| `setLocation` / `clearLocation` | 设置 / 清除位置信息 |
| `registerPlugins` / `init` | 入口命令（初始化时调用） |

## 无埋点自动采集

SDK 通过 Vite 插件在**构建期**为模板插桩，自动采集以下交互：

- 已声明业务 handler 的内置组件 `@click`、`@tap` 事件，及内置 TabBar 点击
- input / textarea 的输入完成（优先 `@blur`，其次 `@confirm`）
- 列表项的 `data-index` 维度信息
- picker 的选中项文案

change 组件包括 `input`、`textarea`、`switch`、`slider`、`radio-group`、`checkbox-group`、`picker`、`picker-view`、`swiper`。输入完成优先采用已声明的 `blur → confirm → change` 中一个事件，输入过程不采集。picker 支持 selector、multiSelector、date、time、region 的值归一化，前提是目标宿主具备对应模式；不为宿主补造原生组件或模式。

模板探针生成 `VIEW_CLICK` / `VIEW_CHANGE`，xpath 为 `元素 id#业务函数名`，缺少 id 时为 `#业务函数名`；内置 TabBar 使用 `#onTabItemTap`，index 从 1 开始。自定义 TabBar 作为普通模板组件处理。小程序支持 `@tap="save"`、`@tap="actions.save"`、直接调用和可安全分析的箭头 handler，业务参数、返回值和异常传播保持原有语义。

### 配置 Vite 插件

无埋点插桩是构建期能力，需在 `vite.config.ts` 中注册插件，且**必须放在 `uni()` 之前**：

```ts
import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

const uniPlugin = (uni as unknown as { default?: typeof uni }).default ?? uni

export default defineConfig(async () => {
  const { gioUniappAutoTrack } = await import('gio-uniapp-sdk/vite')
  return {
    plugins: [gioUniappAutoTrack(), uniPlugin()],
  }
})
```

> uni_modules 渠道将导入路径替换为 `./uni_modules/gio-uniapp-autotracker/vite.js`。

### 自定义采集粒度

- 不想采集的交互：给监听声明静态 `data-growing-ignore`。
- 需要标记敏感内容的字段：声明 `data-growing-sensitive`。
- change 默认保留事件但不读取组件值；明确允许采集非敏感值时声明 `data-growing-track`，例如 `<input data-growing-track @blur="save($event)" />`。
- 需要手动补充采集：在业务原有 handler 中调用 `gdp('track', ...)`。

插桩始终以「业务行为不变」为前提。无法安全分析的复杂表达式、动态事件、自定义组件等会保持源码原样，不会擅自改写业务逻辑。

分享、曝光、ABTest、多实例和事件计时器不包含在本次小程序交付能力内；原生 uniMP 打通采用独立宿主契约，不能按本小程序接入方式使用。

## 隐私与敏感数据

SDK 默认保护以下内容：

- **密码字段**（含动态 `:password`）：保留 `VIEW_CHANGE` 事件，但**始终不读取、不上报**输入内容。
- **敏感标记**：显式 `data-growing-sensitive` 的元素整条采集会被拒绝。
- **忽略标记**：`data-growing-ignore` 的元素不会被自动采集。

需要精确控制采集范围的场景，请结合 `data-growing-sensitive`、`data-growing-ignore` 与手动 `gdp('track', ...)` 使用。

## TypeScript 类型

SDK 在客户项目中自动声明全局 `gdp`，无需额外 `.d.ts` 文件。也可按需从根入口导入类型：

```ts
import gdp, {
  type GioAttributes,
  type GioGdpInitOptions,
  type GioPlugin,
  type GioPluginRuntime,
} from 'gio-uniapp-sdk'

const options = {
  uniVue: app,
  dataCollect: true,
  idMapping: true,
} satisfies GioGdpInitOptions

const attributes = { sku: 'sku-1', price: 99, tags: ['new', 'sale'] } satisfies GioAttributes

gdp('init', 'account-id', 'data-source-id', options)
gdp('track', 'purchase_completed', attributes)
```

未知命令、错误参数个数、嵌套属性或非布尔 `dataCollect` 等错误用法会在 TypeScript 编译期直接报错。

## 调试

初始化时设置 `debug: true`，SDK 会在控制台输出 `[GrowingIO Debug]:` 前缀的操作标签与即将派发的协议事件数组，便于排查采集问题。该开关不影响隐私、重试或采集行为。

## 示例

项目内提供了可运行的 showcase demo，展示生命周期、页面上下文、自定义事件、用户身份/属性、无埋点交互与 `dataCollect` 动态开关等完整用法。可用 HBuilderX 打开 `demo/` 目录运行体验。

## 许可证

[Apache-2.0](./LICENSE)
