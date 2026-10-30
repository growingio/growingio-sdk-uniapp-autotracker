# 鸿蒙实机验证记录（2026-10-19）

> 2026-10-30 规则更新：密码框现保留不含 `textValue` 的 `VIEW_CHANGE`，track 不能放行密码值；显式 sensitive 仍整条忽略。下文密码相关实机结果记录的是旧规则，不作为新规则已完成真机复测的证据。

## 结论与适用范围

本次已完成当前 demo 可执行场景的鸿蒙实机验证，修复启动白屏及两个 demo 交互问题。SDK 公共逻辑、无埋点原生交互、真实断网恢复、上传错误恢复和真实进程重启补发均取得设备请求与本地 collector 接收证据。最终代码门禁为 **63 个文件、699 项测试通过**，最终鸿蒙原生构建和 **2 项实机自动化冒烟通过**。

这份结论适用于下述单台设备、传统 uni-app Vue 3 App 和工具版本。它不代表 Android/iOS 验收，也不代表生产收数服务验收。初次验证发现 input/textarea 的原生 `change` 未触发，后续已定位并修正 SDK 的完成事件选择规则，见下方记录；四选项 picker 还有回调缺失下标的限制，详见“能力边界”。生产平台能力表仍保持原值，未据此自动开放或发布。

### 后续输入完成事件修正

复核本机 HBuilderX 5.26 的 Android / 鸿蒙输入组件源码：共享输入逻辑阻止底层 DOM change 冒泡，input 不转发 change，textarea 的 change 处理函数为空。初次验证时 SDK 的 `change → blur → confirm` 优先级只为未触发的 change 插桩，因此漏采实际发生的完成事件。

SDK 现按 `blur → confirm → change` 选择一个已声明的完成监听器，三事件控件使用 blur 生成一条 `VIEW_CHANGE`，原业务回调保留；仅绑定 change 时保留兼容路径，App 业务应改用 blur / confirm。实际 demo 回归重放了两端已有的原生完成事件序列。下文真机计数和原始记录均属于修正前的验证，不代表新规则已经完成真机复测。

修正后类型检查、覆盖率门禁与 702 项测试通过，SDK / demo 检查通过；Android 编译成功，鸿蒙运行包生成成功。两端编译产物均确认在三事件控件的 blur 监听器中插桩。本次修正未重新执行真机交互。

## 环境与基线

| 项目 | 本次实际环境 |
| --- | --- |
| 仓库基线 | `develop` / `7b75f4d`；开始时工作区干净 |
| 设备 | BRA-AL00，USB 序列号仅保留末四位 `7009` |
| 系统 | `OpenHarmony-6.1.1.120`；系统展示 `BRA-AL00 6.1.0.135(SP8C00E120R8P11)`，API 24 |
| HBuilderX | 5.26.2026091802；设备 uni 运行时自报 5.25 |
| DevEco Studio | 26.0.0.851，`/Applications/DevEco-Studio.app`；继续执行时已存在，已核对工具链和配置并成功原生构建 |
| 设备连接工具 | `/Users/anoiv/OpenHarmony/20/toolchains/hdc`，工具链 6.0.0.47 |
| 自动化插件 | 本次安装 HBuilderX 官方 `hbuilderx-for-uniapp-test` 5.5.0，并安装其 npm 依赖；不需要下载 Playwright 浏览器 |
| 应用 | `com.growingio.analytics` / `EntryAbility`；经用户授权卸载原有同包名示例并清除数据，安装本仓库本次构建 |
| 网络 | 无 SIM；Wi-Fi 实际关闭和恢复，最终恢复开启 |
| collector | 电脑 `127.0.0.1:3100`，通过 USB 反向端口连接；只使用合成账号、合成输入和固定合成坐标 |
| 无埋点 | demo 使用 `__GIO_AUTOTRACK_VERIFICATION__: true`；`src/constants/platform.ts` 生产能力表未改动 |

本次设备验证构建临时设置 `serverUrl: 'http://127.0.0.1:3100'`。验证结束前已停止 HBuilderX 运行监听，并从 `demo/main.ts` 撤回临时地址；手机上保留的是已验证、连接本地 collector 的安装产物。重新从源码运行时，应按自己的测试环境配置收数地址。

## 已修复问题

### 1. 导入 SDK 即白屏

在真机上对照验证：移除 SDK 导入可显示首页；恢复导入，即使尚未初始化 SDK，也出现 JSVM 编译/执行错误（状态 9/10）和白屏。原因是 `src/utils/tools.ts` 中的 Unicode 属性正则字面量，当前鸿蒙 JSVM 无法解析，导致整个业务脚本在加载阶段失败。

修复后 ASCII 域名和 IP 不依赖 Unicode 扩展；非 ASCII 域名按需、在异常保护中创建属性正则。宿主缺失能力时安全拒绝该类地址，避免阻断 SDK 加载。新增完整 SDK bundle 的语法回归检查，以及无 URL、无 Unicode 规范化、无属性转义环境的配置用例。修复后重新构建安装，首页和无埋点页均可实际操作。

### 2. 动态边界按钮不执行业务

本轮传统鸿蒙 App 宿主未执行动态 `tap` 监听。demo 改用动态 `click` 后，真实点击执行业务一次，并保持动态事件边界不采集的约定；受控测试同步验证真实页面的 `onClick`。

### 3. 四选项 picker 返回缺失下标

原生确认回调出现没有 `detail.value` 的情况，直接 `Number(undefined)` 会把选择状态污染成 `NaN`。demo 现在校验类型、整数和范围，非法值保留原状态，并提供忽略采集的“切换到下一种禁用标记”原生按钮。已用真实点击依次验证 `false`、`0`、`"0"`、`"false"` 四种状态；新增两项回归测试。

另新增 demo 独立 CommonJS 配置作用域，解决 HBuilderX 自动化插件生成的 CommonJS 配置与仓库根 `type: module` 冲突；本机 `env.js` 已排除提交。

## 实机验收矩阵

以下“通过”均同时核对实际业务行为与 collector 原始事件。原生点击、滑动、键盘和系统操作通过设备测试工具执行；自动化桥接用于导航、读取页面状态和元素位置，不以手动调用 handler 或构造 `detail` 代替原生事件。

| 类别 | 实际验证及结果 |
| --- | --- |
| 初始化 / 首次显示 | 通过：加载 SDK 后正常渲染，VISIT/PAGE、平台、版本、设备与系统上下文符合协议，重复注册插件拒绝 |
| 页面 / 路由 | 通过：真实切页、返回、query、referralPage、PAGE 关联；动态列表、swiper 文案在触发时取当前值 |
| 前后台 / 会话 | 通过：真实 Home 切后台产生 APP_CLOSED；短时恢复会话连续；实际后台 86,373 ms 后恢复产生新会话 |
| 身份 / 用户属性 | 通过：set/clear userId、userKey、用户属性；A→退出→A 保持会话，A→退出→B 新会话且无多余 PAGE；非法 UTF-16 身份拒绝 |
| 身份持久化 | 通过：真实终止进程、确认旧 PID 消失后启动新 PID；deviceId、userId、userKey 恢复，事件序号继续递增 |
| 位置 | 通过：固定合成坐标设置/清除、越界拒绝；非法身份和位置不覆盖此前合法值 |
| 自定义事件 | 通过：正常事件及属性过滤；非法事件名、未知命令拒绝；0/false、数组、嵌套和非法数值按协议处理 |
| 采集开关 | 通过：暂停期间 CUSTOM/VIEW 均不收集而业务继续；恢复产生新 VISIT/PAGE，后续点击和输入使用新的 PAGE 时间 |
| 屏幕上下文 | 逻辑尺寸 × DPR 计算通过，竖屏观察通过；宿主取整导致的物理像素差异见能力边界 |
| 基础点击 | 通过：click/tap、有/无 id、严格 currentTarget；父层无 id 不借用子 id，index=0 按协议省略 |
| 冒泡 / 去重 | 通过：同次父子点击各有一条、业务各一次；独立连续点击保留，切页返回后不被旧状态吞掉 |
| 表达式 / Vue 形式 | 通过：条件 handler 两分支、括号/对象/多层箭头、Options、script setup、setup 返回别名 |
| 条件显示 | 通过：v-if 删除/恢复、v-show 隐藏/恢复；可见可达元素正常采集 |
| 动态列表 | 通过：重排、保留 key 修改 id/title/src、插入/删除/重置；id、文案、索引和链接均使用当前状态 |
| 隐私优先级 | 通过：currentTarget/target ignore、sensitive 优先 track、动态切换后即时生效；布尔/数值/字符串 1 和四种禁用值分别验证 |
| 密码 / 敏感输入 | 通过：静态 password、动态 type/password、sensitive 均阻断自动事件，业务保持；合成敏感输入未进入接收事件 |
| input / textarea | 原生独立 blur、键盘 confirm 通过；无 track 时无 textValue；原生 change 未触发，单列能力边界 |
| 文本边界 | 通过：120 字符截至 100、控制字符归一化、清空仍保留事件且省略 textValue |
| switch / slider | 通过：true/false 与归零；`"false"` / `"0"` 保留 |
| radio / checkbox | 通过：A/B、单选/多选/取消全部；多值 `A\|\|B` 和空值字段规则 |
| picker / picker-view | 通过：动态 range 下标回退、字面量/对象 range 文案“上海”“方案乙”、多列 `1\|\|1` 和“华南\|\|下午”；四选项限制另列 |
| swiper | 通过：手动滑动文案回退；未放行 autoplay 业务继续而不采集；放行后的下标 0 和 1 均收到 |
| uni-link | 通过：真实 navigator 与父组件 emit 两个探针只收一条 `#openURL`，来源页与 hyperlink 正确，目标 PAGE 正确 |
| tabBar | 通过：真实点击四个底栏项，`#onTabItemTap`、一基 index 1–4、目标路径与 PAGE 对应 |
| 不采集边界 | 通过：函数引用、计算成员、`.stop`、动态事件、自定义 emit、input 打字仅执行业务；`.stop` 仍阻止父层冒泡 |
| 上传协议 | 通过：实际 uni.request 的 POST、JSON、项目路径、compress/stm、请求头均通过 collector 检查；VIEW 字段、身份、会话、页面关联符合协议 |
| HTTP 恢复 | 通过：200/204 接受；500 重试后恰好接收一次；400 丢弃且不重试 |
| 超时 / 并发 / 排空 | 通过：collector 延迟 15 秒，SDK 5 秒超时；六次真实点击产生 12 事件，最多三条并发请求，超时后队列排空且事件无重复 |
| 真实断网恢复 | 通过：系统关闭 Wi-Fi、无 SIM，离线点击保留；恢复网络和前台后离线/恢复标记各收到一次，分别为 UNKNOWN/WIFI |
| 离线冷启动 | 通过：Wi-Fi 关闭状态下真实终止并重启应用，点击先入队；恢复 Wi-Fi 后只补发一次，随后新事件为 WIFI |
| 真实进程重启补发 | 通过：捕获在途请求后 1,420 ms 内真实终止进程（早于首次超时），恢复后整条事件深比较一致且只收到一次；随后新事件身份恢复、序号递增 |

真实进程重启验证以 `native-cold-inflight.mjs` 的最终成功结果为准。早期“返回 500 后稍后停止进程”的试跑，由于等待期间应用仍运行并已耗尽重试，不能用作存储丢失证据，也没有据此修改 SDK。

## 能力边界和未覆盖环境

1. **传统 App 输入组件不转发原生 change。** 独立 blur 和 confirm 已通过；初次验证的三事件控件只选择 change，后续已修正为 blur 优先，上报类型仍为 `VIEW_CHANGE`，不伪造原生 change 回调。原始记录中“completion capability”的通过表示修正前的观察断言成立，不表示 change 能力通过。
2. **四选项原生 picker 确认缺少下标。** 已修复 demo 非法状态并提供可实际验证四种隐私标记的备用按钮；这不代表宿主 picker 回调缺陷已修复。其他已列 picker/picker-view 路径成功。
3. **精确物理分辨率尚不能由宿主指标证明。** 宿主提供逻辑 375 × 828、DPR 3.25，SDK 按现有公式得到 1219 × 2691；设备截图为 1216 × 2688，相差约 3 像素。公式验证通过不等于精确物理尺寸验收；未调整系统旋转锁定，未执行真实横屏。
4. 无 SIM，未覆盖蜂窝网络/网络制式切换；未做多设备、多系统版本、自然长时间运行、设备端大规模容量压力、损坏私有存储或系统进程回收压力。损坏存储、队列上限、迟到回调、宿主 API 缺失等有受控测试，须与实机证据区分。
5. 本地 collector 验证了设备实际请求和接收结果，未验证生产端鉴权、服务端入库、看板展示或正式环境 TLS。未启用生产平台能力表，未提交、推送、打 tag 或发布。

## 最终自动化与代码门禁

| 检查 | 最终结果 |
| --- | --- |
| `pnpm run test:release` | 63 个文件、699 项全部通过，包含 TypeScript 与逐文件覆盖率门禁 |
| 覆盖率 | 语句/行 98.69%，函数 99.02%，分支 92.97% |
| `pnpm run demo:check` | 通过：SDK 构建、编译产物消费者类型、demo 结构；撤回临时收数地址后再次检查 |
| HarmonyOS 原生构建 | hvigor BUILD SUCCESSFUL，签名、安装、启动成功；使用本次源码产物 |
| 官方插件实机冒烟 | 2/2：完整首页含 6 个功能入口；进入无埋点页并执行真实页面业务 |
| 协议 / 隐私核对 | 所有已记录设备上传请求均通过 collector 请求契约；合成密码、敏感/忽略输入原文未泄漏到接收事件 |

本轮有过本地监听权限、自动化连接地址、键盘造成原生窗口偏移等测试环境问题；已修正工具连接与交互定位后继续验证，未当作 SDK 缺陷。最初受限环境端口监听失败的测试结果不代替最终成功门禁。

## 复查入口与证据

长期回归入口：`test/integration/app-runtime-syntax.test.ts`、`test/unit/config.test.ts`、`test/integration/demo-review-scenarios.test.ts`，以及 `demo/pages/index/harmony-smoke.test.js`。自动化配置和 USB 连接说明见 [demo README](../demo/README.md#鸿蒙实机与自动化)。

本次原始设备证据位于仓库本地、已被 git 忽略的 `test-results/harmony-device/`，供本机复查，不随本次源码提交自动归档：

- [本轮证据摘要](../test-results/harmony-device/validation-summary.json)：冻结时接收 273 条事件、记录 270 次上传尝试，非法请求 0；149 条原生断言/观察中包含 3 条 change 未触发的能力观察。
- [原生操作断言](../test-results/harmony-device/native-results.ndjson)、[接收事件](../test-results/harmony-device/events.ndjson)、[每次上传尝试](../test-results/harmony-device/attempts.ndjson)。记录包含重复试跑；请求数/事件数不能当作独立场景通过数。
- [最终官方自动化 JSON](../test-results/harmony-device/automation-smoke-final.json)：`success=true`、2 passed、0 failed。
- [白屏修复后首页](../test-results/harmony-device/home-fixed.jpeg)、[最终首页](../test-results/harmony-device/home-final.jpeg)。
- 断网基线 `network-baseline.json` / `network-offline.json`，离线冷启动基线 `offline-cold-baseline.json`，在途终止基线 `cold-inflight-baseline.json`，以及相应 `native-*.mjs` 实际设备驱动脚本。
- `coverage/coverage-summary.json`、`test-results/junit.xml`；完整门禁日志 `/tmp/gio-harmony-final-tests.log`、最终冒烟日志 `/tmp/gio-harmony-final-smoke.log`。

collector 最终恢复正常 200 响应、关闭故障注入；手机 Wi-Fi 恢复开启，保留可操作的示例页面。要在另一台电脑复现，需重新准备本机工具路径、签名、USB 端口映射和合成 collector，不能直接复制包含设备信息的 `demo/env.js`。
