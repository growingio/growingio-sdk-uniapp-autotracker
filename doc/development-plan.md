# gio-uniapp-autotracker 开发计划

> **平台小程序扩展：**微信、支付宝、百度、抖音、QQ、快手、京东和小红书的基础运行适配与自动化已完成，交付、开发／生产编译及当前结果见[小程序接入](./miniprogram.md)和[八端验证记录](./miniprogram-platforms-validation-2026-10-27.md)。开发者工具交互及真机收数按约定后补。该方向与下述 uniMP 原生宿主打通分别推进。

> **后续需求：**[uni 小程序与原生宿主打通设计](./unimp-native-hybrid-design.md) 给出了独立的实施阶段与验收矩阵，当前为待评审提案。已确认先假设 Android / iOS 提供约定的原生 module，JS 侧可按契约设计和开发，原生完成后再实测对接；微信等平台小程序适配和原生提前实测均不是 JS 开发前置条件。本文下方阶段继续描述原有独立 App 工作。

> **当前状态：阶段 0 至 3 和阶段 4 的代码均已完成静态实现与自动化覆盖，尚未获得 App 编译/真机/服务端证据。** 已建立 package、契约 fixtures、Vue3 demo、脱敏 mock collector、config / protocol / identity / session / queue / uploader、`uni` App storage/request/system/network adapter、App/Page 生命周期 bridge，以及 Vue3/Vite 无埋点编译探针和 runtime dispatcher。当前阻塞是可用 HBuilderX CLI、各目标设备与可访问 collector；本文中的“完成”均指满足对应的自动化和真机证据，不能以目录已创建、类型检查通过或单端构建成功替代。

## 1. 目标与执行规则

首期交付传统 uni-app Vue3 App SDK：Android、iOS、HarmonyOS 的手动埋点、访问/页面事件、身份、持久化队列、基础上传和受控无埋点。以 uniappx 当前公开 API 为上限；事件计时器、原生增强和其他 uniappx 尚未公开的能力全部放入二期。

本计划的文档优先级与职责固定如下：

| 文档 | 决定什么 | 本计划如何使用 |
|---|---|---|
| [Measurement Protocol](./measurement-protocol.md) | 字段白名单、必填性、事件含义、端间口径和请求报文 | 作为 contract fixture 的唯一字段依据；计划不得另造字段或修改含义 |
| [SDK 架构设计](./uniapp-sdk-development.md) | 目录、依赖方向、对外 API、生命周期、存储/上传和无埋点实现边界 | 决定实现归属、运行时约束和平台验收方式 |
| [传统 uni-app 无埋点方案](./uniapp-autotrack-design.md) | `xpath` 标识、事件名推导、插桩、隐私、去重、迁移和无埋点验收 | 决定阶段 4 的具体实现与测试向量 |
| 本文 | 交付顺序、每阶段输入/输出、准入和发布门槛 | 只把前三份文档拆成可执行里程碑，不覆盖前三者 |

若这些文档出现冲突，先停止对应实现：字段与报文以 Protocol 为准，无埋点具体行为以无埋点方案为准，工程边界与公共 API 以架构设计为准，随后修订本文的顺序和验收项。二期能力不得作为一期基础链路的前置条件。

当前开发节奏经用户明确授权采用“**开发先行、端侧验证后置**”：阶段 1 与后续纯 TypeScript core 可以在前序阶段的静态契约测试通过后并行推进；App 编译、真机、collector / 服务端接收证据仍必须在对应功能标记完成或进入发布阶段前补齐。任何实现提交都必须标明其仅有静态证明，不能借此跳过阶段 3 至 5 的端侧门槛。

## 2. 阶段总览

| 阶段 | 目标 | 可交付产物 | 准入 / 退出条件 |
|---|---|---|---|
| 0 | 固化边界 | 可执行 contract fixtures、包 / demo / mock collector 骨架、端口接口 | 无；退出后允许开始 core，但不宣称已有采集能力 |
| 1 | 构建可测 core | config、protocol、identity、session、事件构建、内置插件注册 | 阶段 0 的 fixtures 通过；退出后 core 不依赖 `uni` / Vue / UTS |
| 2 | 完成可靠传输 | uni ports、持久化队列、uploader、collector 集成测试 | 阶段 1 的 core contract 通过；退出后能在端口 fake 与 App adapter 下证明失败语义 |
| 3 | 接通 App / Page | 生命周期 bridge、页面快照、VISIT、PAGE、APP_CLOSED、三端 capability profile | 阶段 2 的可靠传输通过；退出后每端主链有真机证据 |
| 4 | 交付 Vue3 无埋点 | Vite AST 插桩、`gioEventAutoTracking`、click/change 隐私与去重 | 阶段 3 的页面上下文通过；退出后逐端、逐组件完成证据或明确禁用 |
| 5 | 发布验收 | 可复装 release 包、接入文档、能力矩阵和完整证据包 | 阶段 4 的所有已宣传能力通过；三端缺任一项均不得发布 |

每个阶段提交前都执行：协议 / 单元 / 集成测试、相关编译 fixture、`git diff --check`，并在变更说明中区分“静态测试已通过”与“真机、collector、服务端接收已通过”。只有阶段 3 至 5 要求真机和服务端证据；在此之前不得把 mock collector 成功描述为端侧完成。

## 3. 阶段 0：固定协议与工程边界

### 工作项

1. 建立根目录 `package.json`、TypeScript、测试和构建脚本；仓库根目录就是 SDK 包根目录。
2. 建立 `demo/` 三端验证工程和本地 mock collector，collector 记录脱敏的请求摘要及接收/拒绝结果。
3. 从 Protocol 写出每个 `eventType` 的字段白名单、必填字段和端间字段矩阵，作为 contract fixture 的输入。
4. 将共同口径 `APP_CLOSED.appState: BACKGROUND` 写入一份 App contract fixture，Android、iOS、HarmonyOS 复用该断言；仅在差异影响事件含义或数据正确性时新增端侧例外。
5. 固定普通 uni-app Page 的 page-context contract：`onLoad` query 与 pageKey 绑定；当前页面的 `PAGE`、`VIEW_*`、`CUSTOM`、`APP_CLOSED` 复用该快照，`VISIT` 只使用 `App.onShow` 的入口 query。阶段 3 才实现运行时 page store。
6. 固定全局 `eventSequenceId` 的 state record、迁移与 fixture：`VISIT`、`PAGE`、`CUSTOM`、`VIEW_CLICK`、`VIEW_CHANGE` 创建时递增，冷启动后续号，其他事件省略该字段。阶段 1 才实现生成和阶段 2 才实现持久化。
7. 定义 `SystemContextPort`、`ClockPort`、首屏 gate 的接口、fake 与测试向量，不实现生产 runtime：`VISIT`、首个 `PAGE` 和 initializing 期间事件必须等 identity/session/meta 及 Protocol App context 就绪；`platform` 固定映射为 `iOS` / `Android` / `HarmonyOS`，非一期宿主初始化失败；`platformVersion` 正常读取真实值，缺失或异常写 `UNKNOWN` 不阻塞；`domain` 必须从 iOS bundleId / Android packageName / Harmony bundleName 读取、不可用则写空字符串并记录诊断；屏幕尺寸先读设备 `screenWidth/screenHeight`、失败再回退标准 system info，必须为正整数并按短边/长边固定，不得使用窗口尺寸，均不可用则宽高写 `0` 并记录诊断；`deviceType` 统一为 `PHONE` / `PAD` / `FOLD` / `UNKNOWN`，未知只记录诊断不阻塞；品牌/型号正常时保留系统原值，缺失或异常统一写 `UNKNOWN` 并分别记录诊断；`appName` 读取失败写空字符串；`language` 优先 `appLanguage`、其次 `language`，统一规范化为 BCP 47，缺失或异常写 `und`；`timezoneOffset` 每条新事件按 `Date.getTimezoneOffset()` 读取并转为字符串，时区变化只影响未来事件，异常写 `0`；网络初始短时读取并订阅变化，`wifi/2g/3g/4g/5g` 规范为协议枚举，`none/unknown/cellular` 与错误写 `UNKNOWN`，离线照常入队、恢复 flush；`appVersion` 优先从安装包读取、失败才使用 init 的非空 fallback、两者皆无则写空字符串并记录诊断，继续采集；`ClockPort` 在事件创建时直接返回当前设备 Unix 毫秒时间，时钟回拨不修正，顺序只依赖 `eventSequenceId`；其他必填系统字段必须有明确降级值和诊断；`appState` 由生命周期更新未来事件快照。阶段 1 / 2 再分别实现 core gate 与 App 适配器。
   所有内部空字符串兜底只表示“读取不到”，不代表需要发送空值；`sanitizeOutboundEvent` 在字段白名单和系统兜底完成后、进入队列前移除 `null`、`undefined`、空字符串、空对象和空数组，并保留数值 `0`。
8. 确认首期 HBuilderX / CLI、Vue3、目标系统和最低版本；不以本机某次构建通过替代版本承诺。

### 验收

- 所有事件类型都有协议快照和至少一个 App 报文 fixture；Clock fixture 覆盖相同、回拨与未来系统时间，均原样写入事件 `timestamp`，不影响 `eventSequenceId` 递增。
- 冷启动 fixture 证明 `init()` 不阻塞业务，但首个 `VISIT/PAGE` 与 bootstrap buffer 事件均在 SystemContext 就绪后按原顺序构建；platform 覆盖三端固定映射、非一期宿主拒绝、版本原值与缺失/异常降级 `UNKNOWN`；domain 的三端映射正确且不可覆盖，缺失时写空字符串；screen 读取覆盖 device info、system info 回退、横竖屏相同的短边/长边输出和两级缺失时宽高为 `0`；deviceType 覆盖 iPhone/iPad、Android `PHONE/PAD/FOLD`、Harmony 映射和未知降级 `UNKNOWN`；brand/model 覆盖原值透传、空值和异常降级 `UNKNOWN`；appName 缺失写空字符串；language 覆盖 `zh_CN`、`zh-hans`、仅 `zh` 与缺失/异常（`und`）的规范化向量；timezone 覆盖中国 `-480`、UTC `0`、时区/夏令时切换后的未来事件和异常 `0`；network 覆盖大小写规范化、`none/unknown/cellular`、超时/错误 `UNKNOWN`、离线入队和恢复 flush；安装包 appVersion 优先于 fallback，读不到安装包时使用非空 fallback，两者皆无写空字符串且继续采集。
- 出站清理 fixture 覆盖 `domain` / `appName` / 无 fallback 的 `appVersion` 在内部为空字符串时最终省略；`null`、`undefined`、空对象、空数组也均省略，而数值 `0` 与属性字符串 `"false"` 保留。
- demo 能启动且能显示 mock collector 的接收结果。
- 未解决的协议口径不进入 core 实现。
- **阶段退出判定：**此阶段只交付边界、骨架和可执行测试数据；不得提前实现事件构建、storage、网络发送或生命周期 hook。所有后续代码必须能追溯到此阶段的一条 Protocol fixture 或架构约束。

## 4. 阶段 1：core 与协议实现

### 工作项

1. 实现 `src/constants/config.ts`：对外 `GioInitOptions` 只要求非空 `accountId`、`dataSourceId`；`serverUrl` 未传时补为 `https://napi.growingio.com`，传入时规范为 HTTP(S) 基础地址（仅域名补 `https://`、移除末尾 `/`）。非法必填项或显式地址使 `init()` 返回 `false`，且不创建实例、不读写 SDK storage；修正后允许接入方再次主动初始化。首次成功后重复 `init()` 返回 `false` 并保持原实例。默认值只能在这里补齐。`appId` 保留为 Web / 小程序 profile 的跨端输入，当前 App profile 接受后即剥离，不校验、不持久化、不上报且不影响 `domain`。`appChannel` 是 App 三端统一的可选 init 配置：非空 trim 后写入 resolved config，空白/未传则为 `null` 并在出站省略；不读取系统渠道、不经 UTS、也不支持运行时修改。`dataCollect` 默认 `true`，仅显式传 `false` 时禁止事件生成、持久化与上传；必要 identity/session 状态仍可初始化。`idMapping` 默认 `false` 且仅 init 期可设。`sessionExpires` 是 init 期可选配置，与 Web SDK 同名、同为分钟单位，必须是大于 `0` 的有限数并允许小数；未传时 profile 默认值分别为 App `0.5`（30 秒）、Web `30`、小程序 `5`。core 只接收解析后的毫秒 `SessionPolicy`；未来小程序对 `keepAlive`（分钟）的兼容映射只留在其 profile 边界，未来 Web profile 必须保留 `0.5` 等正小数而不能沿用旧的整分 normalizer。上传超时、队列上限和发送阈值仍为内部策略，不作为 `GioInitOptions` 暴露。
2. 实现 `src/core/dataStore/protocol.ts` 与 `src/core/dataStore/index.ts`：公共 context、事件专有字段、字段裁剪、长度与类型验证，并在入队前运行统一 `sanitizeOutboundEvent`；它移除 `null`、`undefined`、空字符串、空对象和空数组，保留 `0`，使读取失败的系统字段不会作为空值发出。CUSTOM `eventName` 固定为 `^[A-Za-z_][A-Za-z0-9_]{0,99}$`，非法时整条拒绝且不分配序号；所有 attributes 经同一 normalizer 输出 `Map<string,string>`（key 100、value 1000、一层数组 `||` 拼接、null/undefined 为空字符串、嵌套对象拒绝）。
3. 实现 `src/core/userStore.ts` 与 `src/core/storage/encrypt.ts`：稳定 `deviceId`、`userId`、`userKey`、clear 语义和 storage migration；身份字段使用 `xor-utf8-v1`（UTF-8 字节级循环 XOR + Base64URL），统一输出 `gioenc-v3-` 前缀；存储 key 统一使用 `gio:v1:` 前缀。所有值经 version envelope 读写，不直接操作宿主存储。
4. 实现 `src/core/userStore.ts`：新访问、热启动续接、session 更新和 `eventSequenceId`；匿名 → 首个 userId 不切 session，已登录 A → B 时新 session + `VISIT`，登出不新建 session/`VISIT`。
5. 实现 `src/core/dataStore/page.ts`：`pageKey`、当前页、referral、内部显示时间 `shownAt`；只保存纯数据。
6. 实现仅内存的 `src/core/userStore.ts`：`setLocation()` 校验有限数和纬度/经度范围（含合法 `0`），`clearLocation()` / 进程重启清除；不得请求权限、不得写 storage。
7. 实现与 uniappx 当前能力同级的 `src/core/lifecycle.ts`：只允许在首次 `init()` 前声明已交付的内置插件名称，重复或未知名称返回 `false`；声明仅留内存，`init()` 参数校验成功后才按声明顺序安装。配置失败后保留声明，修正后重试无需重新注册；首次成功后注册窗口关闭。一期只交付同名 `gioEventAutoTracking`，不实现第三方插件 hook、capability registry、插件 storage/request 或 destroy/dispose 生命周期。基础 init 不含 `urlScheme`；以后 Deep Link／圈选插件如需它，必须使用插件专属配置并先扩展协议与 intent。
8. 定义 `src/types/index.ts` 并提供内存 fake，实现不依赖 `uni` 的单元测试。

### 验收

- `VISIT`、`PAGE`、`CUSTOM`、`LOGIN_USER_ATTRIBUTES`、`APP_CLOSED`、`VIEW_CLICK`、`VIEW_CHANGE` 全部通过 protocol snapshot。
- 配置 fixture 覆盖最小必传输入、`serverUrl` 缺省默认值、仅域名补 `https://`、尾部斜杠移除、显式非法地址、非法必填项、失败后修正重试、首次成功后的重复初始化，以及禁止热修改项；失败的 `init()` 不创建实例也不读写 SDK storage。同一 JS 运行期内首次 `gdp('init', ...)` 只创建一个内部 runtime，重复初始化不会重复队列或生命周期监听。`sessionExpires` 覆盖 App 默认 `0.5` 分钟、合法正小数/整数覆盖、`0`/负数/NaN/Infinity/非数字拒绝，以及 `ResolvedGioConfig` 只向 session core 暴露毫秒 `sessionPolicy` 而非原始配置值。App 传入空、正常或异常 `appId` 均不影响 `ResolvedGioConfig`、storage、日志或采集报文；`appChannel` 覆盖三端非空值均上报、空白/未传均省略、不会读取平台系统渠道且禁止运行时修改；core、adapter、plugin 读取到的均为同一份完整 App `ResolvedGioConfig`。
- `setUserAttributes()` fixture 覆盖匿名与已登录两种状态：均立即发送，不缓冲；仅已登录快照携带 userId/userKey。
- 未传 `dataCollect` 的初始化立即进入可采集状态；显式 `false` 时仍可初始化必要 identity/session 状态，但不产生、不持久化、不上传事件。
- `init()` 前除 `registerPlugins()` 的插件声明外，所有业务 API 返回 `false` 且不缓存；首次成功后的重复 `init()` 返回 `false` 且不重复注册监听；一期没有 `destroy()` 或成功实例的重新初始化。未传 `sessionExpires` 时，App profile 在后台 30 秒后切换为新 session，不因 30 秒内入口变化切换；传值时按该分钟数判断。Session core 通过解析后的 `SessionPolicy` 比较时间；未来 Web / 小程序默认值分别为 30 分钟 / 5 分钟，同样允许 init 传入合法分钟数覆盖。
- userId fixture 覆盖匿名 → A、A → B、A → 空、同 ID 重设及仅 userKey 改变；仅 A → B 产生新 session 和 `VISIT`，且不额外补 PAGE。覆盖 `idMapping=false` 时丢弃 userKey 但保留 userId、`idMapping=true` 时携带 userKey，以及任一身份字段超过 1000 字符时整次调用保持旧值。
- identity cipher fixture 覆盖 ASCII、中文、emoji、空字符串、非法 Base64URL、错误 UTF-8、旧明文迁移和损坏记录恢复；任一端的明文与密文向量完全一致。
- 内置插件 fixture 覆盖 init 前声明、`gioEventAutoTracking` 成功/重复/未知名称、初始化失败后保留声明并可重试、首次成功后拒绝新注册、安装失败隔离和 `dataCollect=false` 时安全不采集；不实现通用 hook、capability 或跨插件 storage。
- `VIEW_CHANGE` 不含 `index`、`hyperlink`；App `title` / `referralPage` 不泄漏到不允许的事件。
- CUSTOM 名称 fixture 覆盖合法边界 100、101 字符、数字开头、中文、空格、连字符和空白；非法项不入队、不递增 `eventSequenceId`。
- 0、false、空字符串和空数组按协议区分，不被误判为缺失。
- location fixture 覆盖边界坐标、`0` 坐标、NaN/Infinity/越界拒绝、清除与进程重启；仅成功设置后的未来事件携带坐标，storage 与历史队列不含坐标状态。
- attribute fixture 覆盖 string、number、boolean、Date、一层数组、null/undefined、超长 key/value、截断后 key 冲突、嵌套对象/数组、函数和循环引用；截断冲突按输入 `Object.keys()` 顺序保留第一个、后续项记录 `attribute_key_collision`；任一端输出相同的 `Map<string,string>` 或相同拒绝诊断。
- core 单元测试不依赖 HBuilderX、设备或网络。
- **阶段退出判定：**core 的 public API、字段裁剪、身份 / session / 属性 / 位置和内置插件语义均由 unit 与 protocol fixture 覆盖；生产 core 不 import `uni`、Vue、Vite、页面实例或 UTS 对象。随后才允许接入真实 storage、request 和系统信息。

## 5. 阶段 2：平台端口、队列与上传

### 工作项

1. 在 `src/types/index.ts` 定义 `StoragePort`、`TransportPort` 与各自标准结果；在 `src/platform/index.ts` 实现 system、network、scheduler、logger；一期实现 `src/platform/uni.ts` 与 `src/platform/uni.ts`，分别归一化 `uni` storage 异常/容量失败和 `uni.request` 的 success/fail/complete、requestTask.abort、同步异常。
2. 实现有界内存队列、条数 / 字节上限和 drop reason：业务/状态指令与生命周期使用独立 bootstrap buffer，各为 50 条或 256KB，合计最多 100 条或 512KB，释放时按接收顺序合并；App 持久化队列为 200 条或 2MB；任一上限满时保留旧事件、丢弃新事件。`KB` / `MB` 均按 1024 换算，统一使用 UTF-8 编码后 `JSON.stringify` 的真实字节数：buffer 为完整数组、queue 为含 retry 元数据的完整持久化 envelope。仅 App 三端实现持久化快照与冷启动恢复，Web/小程序未来仅复用内存队列和当前运行期重试；`dataCollect` 由开关前置阻止后续事件生成，不清空历史队列、identity、session 或序号，也不取消既有上传任务。
3. 实现 uploader：core 自己控制单请求 finalizer 与 deadline、每批最多 50 条和 512KB、最多 3 个并发、最多 2 次重试（800ms、1600ms，均 ±20% 抖动）、4xx 不重试、5xx/网络错误退避；单条超过 512KB 的事件记录 `event_too_large` 后直接丢弃。batch 上限按实际 HTTP JSON 数组 body 的 UTF-8 字节数计算，包含数组括号与分隔符。请求固定为 `POST {serverUrl}/v3/projects/{accountId}/collect?stm={sendAt}&compress=0`，使用 `Content-Type: application/json` 与 `Accept: application/json`，Body 为清理后的 JSON 事件数组；禁止在 core 直接调用任何宿主请求 API。
4. 实现冷启动恢复、网络恢复 flush 与前后台最长 1 秒 force flush；一期没有公开或内部 `destroy()` 生命周期。
5. 实现 init 期固定的 `debug` 日志：所有模式下用小程序同款 `[GrowingIO]：` 的 `info` / `success` / `warn` / `error` 输出初始化、参数/插件提示和请求失败；仅 `debug=true` 时额外输出 App/Page/action 热路径，以及发送前已清理、移除 SDK 内部元数据后的完整事件 JSON 数组，前缀固定为 `[GrowingIO Debug]:`。debug 不得改变采集/隐私语义，也不支持运行时修改；公开 diagnostics 查询 API 放入二期。

### 验收

- 同步抛错、fail、timeout、complete 不会泄漏发送槽位或重复删除事件。
- App transport fixture 覆盖 `uni.request` 的 200、204、4xx、5xx、fail、无 abort task、重复/延迟回调和同步抛错；同一组 fixture 将复用于未来 Web/小程序适配器。
- App storage fixture 覆盖首次生成、冷启动恢复、过期、损坏 JSON、写入失败、容量不足、串行 queue revision、`dataCollect` 切换不清理历史 queue/state 和 queue migration；未来 Web/小程序 fixture 断言失败事件只在当前运行期内存中重试、重启后不恢复。
- 断网、恢复、4xx、5xx、持久化失败、bootstrap buffer 满、队列满、超大单事件、2 次重试及 1 秒后台 flush deadline 都有自动化测试。
- `dataCollect` 从开到关时，新增事件不会入队；此前内存/持久化队列、identity、session 与序号保持不变，既有上传任务不由该开关取消。再次开启时按顺序新建 session、发送当前入口 `VISIT` 和当前页 `PAGE`；关闭期间新发生的事件不补发。一期没有事件计时器；二期加入后才测试关闭采集时清空 timer registry 的独立 SDK 语义。
- `APP_CLOSED` 为有限等待的 best effort；三端复用 `appState: BACKGROUND` 断言，且不会阻塞业务进入后台。
- mock collector 能断言批次、重试次数和最终事件顺序。
- **阶段退出判定：**所有 transport 完成路径（成功、HTTP、网络、超时、同步抛错、延迟回调）只会结束一次并释放槽位；App adapter 的集成测试通过后，才允许由生命周期触发真实事件。
- 日志 fixture 覆盖 debug 关闭时没有热路径/事件 JSON、参数错误与请求失败仍输出统一提示；debug 开启时 Page、action 和待发事件数组使用小程序同名 `[GrowingIO Debug]:` 格式，数组不含 `requestId` / `trackingId`，且敏感 input 仍不会出现。

## 6. 阶段 3：App 与 Page 生命周期桥

### 工作项

1. 实现 `src/core/dataStore/app.ts`，并提供 `App.vue` 的显式 `onLaunch/onShow/onHide` 接入方式。
2. 实现 `src/core/dataStore/page.ts` 与 `page-snapshot.ts`；Page 生命周期只传 `route`、query、title、pageKey、当前 `referralPage` 等纯快照。前序页面 route 优先；无前序页时才允许使用平台入口来源，小程序为 `referrerInfo.appId` / `scn:...`，App 没有已验证来源则省略。
3. 实现 PAGE 专用 `OrientationPort`：每条 PAGE 先读取标准 deviceOrientation，再在可证实时由当前窗口宽高推断，最后复用本进程最后一个真实值；三者均不可用时以 `PORTRAIT` 兜底，仍构建 PAGE 并分配序号，不能因方向接口异常漏采页面。
4. 验证 Vue3 Options API、Composition API、Tab 页、重复入栈同 route、返回上一页和前后台切换。
5. 实现 `VISIT`、`PAGE`、`APP_CLOSED` 的运行时调度，确保 `APP_CLOSED` 不从 Page hide 推断。每次真实 `Page:onShow` 自动发送 `PAGE`，并维护页面快照供其他事件使用；一期不实现 `trackPage` 开关或 `sendPage()`。
6. 建立 Android、iOS、HarmonyOS 的 capability profile；尚未验证的功能为 false，不用一个 `isApp` 掩盖差异。

### 验收

- 每端 demo 证明冷启动 `VISIT + 首屏 PAGE`、热启动续接和超时新 session。
- `onLoad` 冻结 query，`onShow` 发 PAGE；同 route 两实例不互相去重。title fixture 覆盖安全读取的非空导航栏标题、运行期修改后的重新快照及不可用时省略；不得由 route 或 DOM 推导。
- referral fixture 覆盖前进、返回、tab、同 route 不同实例、后台恢复与冷启动入口：`PAGE` 只携带冻结 referral，前序 route 优先于入口来源；小程序首屏可使用 `referrerInfo.appId` 或 `scn:...`，App 无验证来源时省略。
- orientation fixture 覆盖标准读取、窗口推断、进程内最后真实值和全不可用时的 `PORTRAIT` 兜底；兜底 PAGE 必须正常分配 `eventSequenceId`。三端真机 PAGE 都必须包含真实的 `PORTRAIT` / `LANDSCAPE`，兜底仅用于异常路径。
- PAGE fixture 覆盖真实 `Page:onShow` 自动发送及 CUSTOM / `VIEW_*` 复用当前页面快照；一期没有 `trackPage` 或 `sendPage()` 分支。
- 后台、页面 hide、页面 unload 的行为分别有事件序列断言。
- 页面实例、Vue 实例和函数均未进入 core、storage 或 UTS bridge。
- **阶段退出判定：**Android、iOS、HarmonyOS 均完成“初始化 → 入队 → 请求 → collector 接收”的主链真机记录；未通过的能力在 capability profile 中明确为 `false`，不进入无埋点宣传范围。

## 7. 阶段 4：Vue3 / Vite 无埋点

### 工作项

1. 实现一方内置插件 `src/plugins/gioEventAutoTracking/index.ts`（名称 `gioEventAutoTracking`）：通过一期的内置插件注册表安装 tabBar / 页面 hook 和模块内 dispatcher gateway；它只把合法 `AutoTrackCall` 交给 core 内部入口，由 core 生成受协议约束 `VIEW_CLICK` / `VIEW_CHANGE`。不实现通用 `GioPlugin`、hook、capability 或 dispose 契约。
2. 实现其 Vite 伴随插件 `vite.ts` 与 `src/compiler/vite.ts`，在 uni 编译器前使用 `@vue/compiler-sfc` 读取完整 Vue 3 `.vue` SFC，再处理 template AST；不得用正则截取可能嵌套的 `<template>`。它只安装探针，不建事件、不写队列、不发请求。Vue 2 / Webpack 不在 1.0 无埋点范围内。
3. 按[无埋点方案](./uniapp-autotrack-design.md)定义并固定版本化 `AutoTrackCall`；普通模板 probe 传 `eventName`，白名单 change 额外传组件类型和 picker range，runtime 从第二参数 native event 即时裁出受限 change 快照，并以 `currentTarget || target` 的 id 生成 `id#eventName`；tabBar 固定为 `#onTabItemTap`。编译产物只调用 `src/plugins/gioEventAutoTracking/index.ts`，由 dispatcher 路由至已 ready 的 `gioEventAutoTracking`，未注册/不匹配安全返回 false。
4. 覆盖 click/tap、tab、input/textarea、switch、slider、radio、checkbox、picker、picker-view 和 swiper 的受支持语义。
5. 实现 `data-growing-ignore`、`data-growing-track`、`data-title`、`data-index`、`data-src`、敏感 input 默认拒绝和最大长度限制；ignore 同时检查 currentTarget 与原始 target，敏感 probe 即使带 track 也整条拒绝，`data-index` 仅接受大于 0 且小于 2147483647 的规范十进制整数。
6. input / textarea 同时声明 confirm/change/blur 时只选择一个完成事件插针；对重复 callback 实现同 native event 对象去重，以及按 pageKey、元素和值约束的有效时间戳窄窗去重；不以真值判断丢弃 0、false、空字符串或空数组。
7. 对无法安全改写的动态事件名、复杂表达式、自定义组件和带事件修饰符的 listener，保持原代码、不插桩并输出 build warning。
8. 扫描 `.nvue` 页面；一期不插桩其 click/change，仅保留生命周期页面事件和手动埋点能力，并输出 build warning。

### 验收

- fixture 覆盖完整链路：“源 SFC -> 转换代码 -> dispatch -> 无埋点插件 normalizer -> core protocol/queue -> mock collector”，并验证普通模板 `xpath` 只会是 `id#eventName`、tabBar 固定为 `#onTabItemTap`，以及 Vite 或运行时插件任一缺失时安全不采集。
- 原 handler 的调用次数、参数、返回值和抛错行为不变；带修饰符的 listener 不插桩，原代码和修饰符行为保持不变并有构建告警。
- SDK 自身异常不影响 handler；handler 抛错不被 SDK 吞掉。
- 无埋点 runtime gateway 在重复 init 失败、插件未注册和插件安装失败时不泄漏；同一对象或宿主不同包装对象造成的重复 callback 只生成一次对应 `VIEW_*`，不同父子显式节点与不同值的连续 change 不被误吞，零或非法时间戳不会导致后续事件永久丢失。
- password / 动态 type / 证件 / 支付 / 文件等敏感值不出现在报文或日志。
- HarmonyOS 的每个 `VIEW_CHANGE` 组件单独通过真机与服务端门槛，否则禁用。
- `.nvue` fixture 断言页面事件与手动埋点可用，且不会被错误宣称为无埋点支持。
- **阶段退出判定：**每个已宣传的组件至少有源码转换、业务 handler 回归、真机请求和 collector / 服务端接收四类证据；没有通过 HarmonyOS 门槛的 `VIEW_CHANGE` 组件保持禁用。

## 8. 二期工作项：UTS 原生增强（不进入一期顺序）

### 工作项

1. 定义 `NativeEnhancementPort` 的 JSON 输入/输出和 capability 返回值。
2. 在 `utssdk/app-android`、`app-ios`、`app-harmony` 分别实现已批准的原生字段或能力。
3. 用 `native/bridge.ts` 包装调用、版本检查、失败降级和订阅释放。
4. 对 iOS、Android、HarmonyOS 专属标识分别验收；不将某端字段复制给另一端。可选字段只在既有授权下读取，SDK 不主动申请权限，也不阻塞首个 `VISIT/PAGE`；设备标识仅进入 `VISIT`。`appChannel` 是三端共用的 core init 配置，不属于原生增强。

### 验收

- 未安装、禁用、编译失败或运行失败 UTS 时，阶段 1 至 4 的核心能力正常。
- bridge 只传 JSON/原始值；没有页面 / Vue / 原生对象跨边界。
- 无权限、空值和原生调用失败时，请求中省略对应可选字段且首屏事件照常上报；不得填充伪值或触发权限弹窗。
- 每项已宣传能力都有目标系统真机和 mock collector / 服务端接收证据。

## 9. 阶段 5：发布与交付

### 工作项

1. 提供初始化、App.vue 生命周期接入、Vue 3 / Vite 插件、隐私开关、支持矩阵和降级说明；1.0 仅面向 Android、iOS、HarmonyOS App，明确 Vue 2 / Webpack、H5 和各家小程序为后续能力。
2. 同一次构建生成 `dist/npm` 与 `dist/uni_modules/gio-uniapp-autotracker/`，最终压缩包位于 `dist/release`，生成文件不提交 Git；不得将该嵌套用于日常源码目录。
3. 用干净的 demo 工程重新安装 / 复制 release 包，运行 typecheck、编译和三端验证；HarmonyOS 与 Android/iOS 同为 1.0 正式支持端，缺少任一端真机证据不得发布。
4. 输出 platform capability matrix、自动化测试结果、真机日志摘要、请求摘要和服务端接收证据；每项标明版本、目标端、HBuilderX / 编译器版本、SDK 包版本和验证日期。
5. 检查 release 包内容：只包含编译后的 ESM JS、类型、Vite 入口、文档与许可证；不得包含 demo、测试记录、mock collector、内部配置或任何凭据。运行时 SDK 与 Vite 插件若分 entry，必须使用同一版本。

### 发布门槛

| 能力 | Android | iOS | HarmonyOS |
|---|:--:|:--:|:--:|
| 初始化、身份、手动埋点、队列和上传 | 必须通过 | 必须通过 | 必须通过 |
| 冷/热启动 VISIT 与 PAGE | 必须通过 | 必须通过 | 必须通过 |
| 普通 click / tab click | 必须通过 | 必须通过 | 必须通过 |
| `VIEW_CHANGE` | 组件级通过 | 组件级通过 | 组件级通过后才宣称支持 |

仅当自动化契约、发布包重建、目标端编译、真机请求和服务端接收证据同时存在时，才能将对应能力标为完成。

## 10. 实施跟踪与证据归档

以下清单记录实现与证据的实际状态；静态完成不等于端侧或发布完成：

| 阶段 | 当前状态 | 允许标记完成的最小证据 |
|---|---|---|
| 0 | 静态完成；端侧验证阻塞 | contract fixtures、package / demo / mock collector 骨架与本地启动记录；仍缺可用 HBuilderX CLI 下的 demo 编译记录 |
| 1 | 静态完成；端侧验证阻塞 | config / protocol / identity / session / event sequence / plugin registry、page / location state、tracker init 生命周期已有 unit 与 contract 覆盖；identity / session / meta / queue 与 SystemContext 已通过统一 hydration gate 恢复，tracker gate 已完成 bootstrap 排空与 dataCollect 切换，EventComposer 已把可信系统/身份/session/location context 构成后入队，`TrackerRuntime` 已串联 hydration 后的 track、用户属性、A→B 换人 VISIT 与 dataCollect 恢复；公开 `gdp` 已固定单例初始化语义，接入文档已具备，仍缺端侧证明 |
| 2 | 静态完成；端侧验证阻塞 | ports、identity / session / queue 持久化、collector 请求、单请求 finalizer、有界并发 uploader、后台 force flush、App storage/request/SystemContext adapter 已有 fake 测试；`TrackerRuntime` 已在每次成功的事件路径触发 queue/meta 持久化与 uploader，`createAppTracker` 已把 App storage/request/SystemContext/时钟/时区/方向组合进 runtime；debug 事件数组只在 uploader 的真实派发前从协议事件生成，不含 queue 内部元数据。仍缺网络恢复、后台 deadline 的真实 App 行为与 collector 失败路径集成 |
| 3 | 静态完成；端侧验证阻塞 | `src/core/dataStore/app.ts` 已覆盖 launch 不重复发 VISIT、onShow session 续接/超时更新、onHide 的 APP_CLOSED→持久化→force flush 顺序及 dataCollect 恢复后的 VISIT；`src/core/dataStore/page.ts` 已覆盖 onLoad 冻结 page snapshot、onShow 自动 PAGE、page hide 不推断 APP_CLOSED，方向 resolver 已覆盖标准值/窗口推断/最近值/PORTRAIT 兜底；App/Page bridge 已将宿主参数裁成 JSON 快照，并接入默认开启采集的验收 demo；tabBar bridge 生成版本化 click intent。三端 profile 仍全为 false，缺三端完整请求串联与冷/热启动、导航、后台 collector 接收记录 |
| 4 | schema v2 代码与受控链路已实现；三端验收待完成 | 已实现完整 SFC/事件表达式 AST、分形态 listener 改写、运行时 `id#eventName`、tabBar 一基 index、双目标隐私短路、逐组件 change 归一与两层去重；测试实际执行转换后的 Vue listener 并通过 HTTP mock collector 断言最终事件。逐组件能力表已接入运行时；Android、iOS、HarmonyOS 的真机请求和服务端接收证据未齐前，所有无埋点能力保持禁用。详见[无埋点发布说明](./autotrack-v2-release.md)。 |
| 5 | schema v2 发布目录已同步；端侧验证阻塞 | release 包已同步 schema v2 源码和文档，并验证目录白名单、public package metadata、runtime/Vite 双入口、`@vue/compiler-sfc`、`@vue/compiler-dom` 与事件表达式 parser 运行依赖及 Vue 编译器版本一致。仍需干净工程复装、三端编译与真机证据包。 |

证据按“自动化测试结果、构建日志、脱敏请求摘要、collector / 服务端接收结果、真机日志与能力矩阵”归档。请求摘要和日志不得包含完整身份值、输入内容、token、cookie 或其他凭据。某项仅有静态测试、仅有构建成功、或仅有 HTTP 200 时，只能记录对应层级已通过，不能把整项能力标记为完成。

当前工作 shell 没有可执行的 `HBUILDERX_CLI_PATH`，虽然系统中存在 HBuilderX.app；此前直接启动 CLI 曾因缺少 `neon` 指令集失败。因此 demo 的 HBuilderX 编译、App 安装与真机记录均处于环境阻塞状态，不能以当前静态检查替代。

## 11. 后续扩展顺序

1. Vue2 / Webpack：仅新增编译适配器，复用 `AutoTrackCall`、core 和 platform ports。
2. `.nvue`：先完成页面和手动事件，再按组件逐项验证无埋点。
3. H5：新增浏览器 platform adapter 与 DOM 增强，不复用 App DOM 假设。
4. 小程序：按宿主逐家新增 platform adapter/profile，复用协议和 core；不搬入传统 App 的生命周期假设。
5. 手动 PAGE、公开 `flush()`、`destroy()`/重新初始化、`trackPage` / `autotrack` / 运行时 `debug` 开关：先以 uniappx 后续实现为准补齐，不能单独在传统 uni-app 提前交付。
6. 通用第三方插件契约：hook、capability、插件 storage/request、销毁生命周期；与 uniappx 形成同级实现后再开放。
7. ABTest、分享、圈选和性能等产品插件：在 core plugin 生命周期稳定后按独立包或目录加入。
8. 事件计时器：新增 core 的内存 timer registry 与单调时钟 port，提供 start/pause/resume/end/remove/clear；结束时以 CUSTOM.attributes 的 `event_duration`（秒）上报，前后台停表策略与 Android/iOS/HarmonyOS 独立 SDK 对齐，重启后清空。
9. UTS 原生增强：经过独立产品决策后，再实现端侧标识和 capability；不得成为基础采集前提。
