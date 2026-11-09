# gio-uniapp-autotracker

GrowingIO 传统 uni-app Vue 3 数据采集 SDK。一行初始化即可自动采集页面浏览、App 生命周期与用户交互，同时支持手动埋点上报自定义事件、用户身份与属性。

> 当前版本面向 **HarmonyOS（鸿蒙）端** 的 `.vue` App 发布，提供开箱即用的无埋点与手动埋点能力。
>
> 自动交互采集（点击、输入完成、选择器、TabBar）当前仅在鸿蒙端默认开启；Android 与 iOS 需通过验证构建另行开启，尚未纳入本次发布范围。

## 功能特性

- **自动采集**包括 App 会话开始（`VISIT`）、页面浏览（`PAGE`），以及鸿蒙端的按钮点击、输入完成等交互。
- **手动埋点**：通过 `gdp()` 上报自定义事件、用户身份（`setUserId`）、用户属性（`setUserAttributes`）与位置信息。
- **无埋点插桩**：Vite 构建期自动为模板插桩，业务代码无需改动，原有事件 handler 完整保留。
- **隐私保护**：内置敏感字段拦截，密码、安全密码等输入内容永不读取、永不上报。
- **类型安全**：完整 TypeScript 类型定义，未知命令、参数错误在编译期即可发现。
- **离线缓存**：App 端事件落盘缓存，断网不丢数据，恢复联网后自动补发。

## 安装

选择以下任一方式，同一应用内不要同时加载两份 SDK。

### npm

```sh
npm install gio-uniapp-autotracker
```

### uni_modules

从 GitHub Release 下载 `*-uni_modules.tgz`，解压后将 `uni_modules/gio-uniapp-autotracker` 放入项目根目录。运行时导入路径为 `@/uni_modules/gio-uniapp-autotracker/index.js`，Vite 配置导入路径为 `./uni_modules/gio-uniapp-autotracker/vite.js`。

两种渠道均提供 ESM JavaScript 与 `.d.ts` 类型声明。

## 快速开始

在应用入口创建 App 后，注册插件并初始化 SDK：

```ts
import gdp from 'gio-uniapp-autotracker'

export function createApp() {
  const app = createSSRApp(App)

  // 注册自动采集插件
  gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])

  // 初始化：传入账户 ID、数据源 ID 与配置
  gdp('init', 'account-id', 'data-source-id', {
    uniVue: app,
    serverUrl: 'https://collector.example.com',
    dataCollect: true,
  })

  return { app }
}
```

初始化完成后，SDK 会自动读取 `uni` 宿主，通过全局 Vue mixin 接管 App / Page 生命周期。业务侧的 `App.vue` 与页面**无需**再引入任何 lifecycle bridge，也无需手动埋页面事件。

### 初始化配置

| 配置项 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `uniVue` | `App` | 是 | 应用实例，SDK 据此接管生命周期 |
| `accountId` | `string` | 是 | 账户 ID（`init` 第一个参数） |
| `dataSourceId` | `string` | 是 | 数据源 ID（`init` 第二个参数） |
| `serverUrl` | `string` | 否 | 数据上报地址 |
| `dataCollect` | `boolean` | 否 | 是否开启采集，默认开启 |
| `sessionExpires` | `number` | 否 | 会话过期时长（分钟），默认 0.5，最大 360 |
| `appVersion` | `string` | 否 | 上报的应用版本，缺省时自动读取宿主版本 |
| `idMapping` | `boolean` | 否 | 是否启用身份映射 |
| `debug` | `boolean` | 否 | 是否在控制台输出调试信息 |

非必填配置缺省、类型错误或超出范围时，SDK 会回退到默认值，不会阻断初始化。

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

- 内置组件的 `@click`、`@tap`、`@change` 事件
- input / textarea 的输入完成（优先 `@blur`，其次 `@confirm`）
- 列表项的 `data-index` 维度信息
- picker 的选中项文案

### 配置 Vite 插件

无埋点插桩是构建期能力，需在 `vite.config.ts` 中注册插件，且**必须放在 `uni()` 之前**：

```ts
import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

const uniPlugin = (uni as unknown as { default?: typeof uni }).default ?? uni

export default defineConfig(async () => {
  const { gioUniappAutoTrack } = await import('gio-uniapp-autotracker/vite')
  return {
    plugins: [gioUniappAutoTrack(), uniPlugin()],
  }
})
```

> uni_modules 渠道将导入路径替换为 `./uni_modules/gio-uniapp-autotracker/vite.js`。

### 自定义采集粒度

- 不想采集的交互：给监听声明静态 `data-growing-ignore`。
- 需要标记敏感内容的字段：声明 `data-growing-sensitive`。
- 需要手动补充采集：在业务原有 handler 中调用 `gdp('track', ...)`。

插桩始终以「业务行为不变」为前提。无法安全分析的复杂表达式、动态事件、自定义组件等会保持源码原样，不会擅自改写业务逻辑。

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
} from 'gio-uniapp-autotracker'

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

[GPL-3.0](./LICENSE)
