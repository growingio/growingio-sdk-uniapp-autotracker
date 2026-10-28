# 八端小程序接入

传统 uni-app Vue 3 `.vue` 项目可以使用同一份 SDK 编译到下列八个目标。运行适配、自动化及交付编译验证已完成；按开发约定，开发者工具交互及真机收数后补。飞书、钉钉、360、淘宝、快应用和鸿蒙元服务不在本轮支持范围内。

| 平台 | uni-app 目标 | wire platform | 设备字段前缀 | PAGE 场景来源前缀 |
| --- | --- | --- | --- | --- |
| 微信 | `mp-weixin` | `MinP` | `Weixin-` | `scn:` |
| 支付宝 | `mp-alipay` | `alip` | `Alipay-` | `scn:alip_` |
| 百度 | `mp-baidu` | `baidup` | `Baidu-` | `scn:baidup_` |
| 抖音 | `mp-toutiao` | `bytedance` | `Bytedance-` | `scn:bytedance_` |
| QQ | `mp-qq` | `qq` | `QQ-` | `scn:qq_` |
| 快手 | `mp-kuaishou` | `kuaishoup` | `KuaiShou-` | `scn:ks_` |
| 京东 | `mp-jd` | `jdp` | `JingDong-` | `scn:jd_` |
| 小红书 | `mp-xhs` | `xhsp` | `XiaoHongShu-` | `scn:xhs_` |

`appChannel` 在八端均为 `scn:原始scene`；上述平台来源前缀只用于 PAGE 缺少上一页及外部来源时的回退。原始字符串场景保留前导零。

## 初始化

安装方式、`gdp()` 命令及客户插件契约与 App 相同。npm 使用包名导入；uni_modules 使用 `@/uni_modules/gio-uniapp-autotracker/index.js`。

```ts
import App from './App.vue'
import { createSSRApp } from 'vue'
import gdp from 'gio-uniapp-autotracker'

export function createApp() {
  const app = createSSRApp(App)
  gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])
  gdp('init', 'account-id', 'data-source-id', {
    uniVue: app,
    appId: '平台分配的真实小程序 appId',
    appVersion: '1.0.0',
    serverUrl: 'https://collector.example.com',
    dataCollect: false,
    keepAlive: 5,
    uploadInterval: 1000,
  })
  return { app }
}
```

业务完成采集同意流程后调用 `gdp('setOptions', { dataCollect: true })`。手动事件、用户身份、用户属性和位置设置沿用现有命令。`init` 的 `true` 表示本地接纳初始化，不代表异步恢复已完成或服务端已经收数。

`appId` 必须是目标平台分配的小程序标识，不能是 DCloud 的 `__UNI__...`。宿主能返回账号信息时，配置必须与 `uni.getAccountInfoSync().miniProgram.appId` 一致；校验失败不会写入身份或安装生命周期，修正配置后可重试。开发者工具使用模拟账号时同样需要一致的配置。百度的部分 uni 版本会将原生 appKey 映射到这个字段，接入时应保持相同标识口径。

不能依赖所有平台都有账号或版本接口。百度、抖音建议显式配置 appId 和 appVersion；京东也应显式提供 appVersion。无账号接口时仍可初始化，版本无法取得时省略并诊断。该差异以[账号信息兼容表](https://uniapp.dcloud.net.cn/api/other/getAccountInfoSync.html)和所用编译器实现为准。

SDK 优先采用编译目标和 `uniPlatform`，明确冲突或不支持的目标会拒绝初始化。缺少这些字段时可以识别唯一的 `wx/my/swan/tt/qq/ks/jd/xhs` 宿主；多个候选不猜测。为保持旧 App 接入兼容，仅在没有小程序目标线索且完整旧 App 宿主成立时保留原 App 回退。SDK 不把小程序的 Android／iOS 系统值直接当作 App 平台。

## 配置差异

| 配置 | 八端小程序 | 现有 App |
| --- | --- | --- |
| `appId` | 必填真实平台 appId | 继续不消费 |
| `appVersion` | 显式配置优先，其次取账号信息中的小程序版本；均无则省略并记录固定诊断 | 显式配置优先，其次读取应用及同步系统信息；均无则省略 |
| `keepAlive` | 有限数，单位分钟，范围 0–1440，允许小数，默认 5；非法值回退默认 | 不消费 |
| `sessionExpires` | 默认 `-1`，关闭额外活动超时；大于 0 且不超过 360 的有限数启用按分钟计算的活动超时，支持小数 | 保持默认 0.5 分钟的后台超时；接受大于 0 且不超过 360 的有限数，支持小数 |
| `uploadInterval` | 单位毫秒，先四舍五入再校验 0–3000，默认 1000；非法值回退默认，0 表示即时发送 | 不消费，保持即时发送 |
| `appChannel` | 根据当前访问 scene 生成 `scn:...`，缺失为 `scn:NA` | 继续使用初始化配置 |
| 运行期配置 | 只允许修改 `dataCollect` | 保持不变 |

非必填初始化配置缺省、类型错误或超出有效范围时，统一回退对应默认值，不阻断初始化。`keepAlive` 回退 5 分钟，`uploadInterval` 回退 1000 毫秒，非法 `sessionExpires` 与 `-1` 一样关闭额外活动超时。`dataCollect` 回退 `true`，`idMapping`、`debug`、`forceLogin` 回退 `false`；合法的显式布尔值保留。必填的账户、数据源、`uniVue` 和真实平台 `appId` 仍须有效。

`keepAlive` 和 `uploadInterval` 直接沿用独立小程序 SDK 的边界及取整规则。`keepAlive: 0` 在后台间隔大于 0 时创建新访问；`uploadInterval: 0` 关闭聚合等待并立即尝试发送。例如 `uploadInterval: 3000.4` 取整为 3000，`3000.5` 取整后超限，回退为 1000。

SDK 不主动登录、定位或申请权限。`setLocation` 仍只设置后续事件使用的内存坐标。

## 生命周期和协议

SDK 通过 `uniVue` 自动接管明确属于 App 和 Page 的生命周期，普通组件不会被当成 App。页面不需要单独安装桥接。页面路由支持原生页面及 Vue 页面元数据；同路由实例独立保存 query、标题和显示时间。

八端按上表发送独立平台值，`domain` 均为初始化时校验的小程序标识；`platformVersion` 使用平台名和宿主版本，设备字段使用 `Weixin-Android`、`Baidu-iOS` 等口径，协议会拒绝另一平台的设备前缀。小程序报文不携带 App 专属的 `appState/appName/orientation/protocolType`。详细字段以 [Measurement Protocol](./measurement-protocol.md) 为准。

VISIT 使用访问入口 path/query 与外部来源，PAGE 和后续交互使用页面快照。生命周期参数有有效路径时优先采用它；缺失时尝试可用的最新入口接口，启动接口只用于冷启动。入口附加参数不能覆盖原 query，内部圈选／框架参数和复杂值不进入报文，原始宿主参数不被修改。标题支持 `gioPageTitle`、成功设置的导航栏标题及可用页面元数据；没有可靠来源时省略，不假定小程序具有 App 的全局路由表。

抖音原生参数 `refererInfo` 与标准 `referrerInfo` 均被接纳，优先采用非空标准字段；其他平台不读取该原生别名。[抖音原生接口说明](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/foundation/lifecycle/tt-get-enter-options-sync)。QQ、百度、京东等目标可能没有 `getEnterOptionsSync`，SDK 使用实际生命周期参数，不用旧启动入口覆盖热进入。[uni 最新入口兼容表](https://uniapp.dcloud.net.cn/api/getEnterOptionsSync.html)。

冷启动创建新 session；后台间隔超过 keepAlive 或已知有效场景变化时创建新访问。恰好等于 keepAlive 时延续原会话。普通前后台切换保持该次访问的首次入口。可选活动超时在前台行为及恢复前台时检查，先补 VISIT 和必要的 PAGE，再生成业务事件。页面早于 App 恢复时延后处理，避免使用旧 session；补发 PAGE 与随后同一页面的 onShow 协调去重。

登录用户切换和恢复采集沿用现有身份规则，并为小程序补齐当前 PAGE；关闭采集期间不回放行为。关闭采集不删除历史身份、序号或已存在的待发事件。

## 存储和请求

身份与全局事件序号按平台、appId、accountId、dataSourceId 隔离并持久化，沿用当前身份编码。session 和事件队列只在当前 JS 运行期存在，不读写存储。默认不读取独立小程序 SDK 数据；可显式开启旧身份迁移，旧键始终只读。`identify` / `forceLogin` 与内嵌 H5 身份快照也已提供，配置与限制见[高级身份说明](./advanced-identity-hybrid.md)。不要同时加载两套自动采集实现。

队列继续有条数和字节限制。默认每秒聚合上报，最多三个并发请求，每批最多 50 条；切后台取消聚合等待并尽力立即发送，重复后台通知不重复生成关闭事件。请求唯一结算、5 秒超时和最多两次重试继续复用当前核心逻辑。宿主被回收后内存事件可能丢失。

正式环境需要在平台后台配置 HTTPS 采集域名。开发者工具跳过域名校验不代表正式版请求可用。SDK 的本地接纳、HTTP 200／204 与产品中的正确归档是三个不同验证层级。

## 无埋点与验收状态

模板插桩仍需在 `uni()` 之前安装 `gioUniappAutoTrack()`，它同时注入确定的构建目标。仅使用手动事件和基础生命周期时不需要该插件。

```ts
import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

const uniPlugin = (uni as unknown as { default?: typeof uni }).default ?? uni
export default defineConfig(async () => {
  const { gioUniappAutoTrack } = await import('gio-uniapp-autotracker/vite')
  return { plugins: [gioUniappAutoTrack(), uniPlugin()] }
})
```

生产的自动点击、逐组件 change 和 tabBar 门控目前保持关闭，待各端真实交互与收数证据归档后逐项开放，不以一端结果开放另一端。专用验证工程可通过内部验证构建开放待测链路；不要复制该开关到正式应用。ignore、敏感输入、值授权、表达式支持范围和 schema v2 继续遵循[无埋点方案](./uniapp-autotrack-design.md)。分享、曝光、ABTest、多实例、事件计时器和原生增强仍不在本轮范围内。

## 验证命令

```sh
pnpm run test:release
pnpm run release:prepare
```

发布准备包含 npm／uni_modules × 八目标 × 开发／生产压缩 × 有／无插桩插件，共 64 组真实编译，以及 16 个独立模拟宿主消费者。编译工程使用实际 demo 初始化，包含普通页、分包和内置 tabBar。开发模式执行单次构建，不验证热更新或开发者工具操作。锁定 CLI 为 `3.0.0-5020420260812001`，编译报告写入 `test-results/miniprogram-build/`。

局部排查可执行 `pnpm run test:miniprogram:compile --targets mp-baidu,mp-toutiao`；报告另存为带 targets 后缀的文件，不能替代默认全矩阵发布检查。

可额外指定本机 HBuilderX 编译包执行同一矩阵：

```sh
GIO_UNI_COMPILER_ROOT=/Applications/HBuilderX.app/Contents/HBuilderX/plugins/uniapp-cli-vite pnpm run test:miniprogram:compile
```

这些检查不连接生产 collector，也不替代开发者工具操作或真机验收。最新结果见[八端扩展验证记录](./miniprogram-platforms-validation-2026-10-27.md)，首批历史记录见[微信和支付宝实现验证记录](./miniprogram-validation-2026-10-27.md)。
