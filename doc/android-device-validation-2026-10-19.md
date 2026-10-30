# 安卓真机验证记录（2026-10-19）

> 2026-10-30 规则更新：密码框现保留不含 `textValue` 的 `VIEW_CHANGE`，track 不能放行密码值；显式 sensitive 仍整条忽略。下文密码相关实机结果记录的是旧规则，不作为新规则已完成真机复测的证据。

## 结论与适用范围

本次验证传统 uni-app Vue 3 SDK 当前已实现、可由 demo 执行的安卓场景，包括公共命令、生命周期、身份与会话、位置、采集开关、无埋点原生交互、上传错误恢复、真实断网和进程重启。已取得设备实际请求与本地 collector 接收证据；输入完成事件漏采的后续复核与修正见下方记录。

初次验证未触发 input/textarea 原生 `change`，独立 `blur` / `confirm` 已通过。当时三事件控件只选择 `change` 插桩，造成输入完成漏采；后续已定位并调整，见下方修正记录。生产能力表保持原值；本记录不代表多设备、多安卓版本、iOS 或生产服务端验收，也没有发布或打 tag。

### 后续输入完成事件修正

复核本机 HBuilderX 5.26 的 Android / 鸿蒙输入组件源码：共享输入逻辑对底层 DOM change 调用 `stopPropagation()`，input 不转发 change，textarea 的 change 处理函数为空。这与官方输入组件只提供 blur / confirm 完成事件的契约一致，并非某台设备偶发漏回调。

SDK 已把输入完成选择顺序调整为 `blur → confirm → change`，只插桩一个已声明的监听器。三事件控件现在使用 blur 生成一条 `VIEW_CHANGE`，其余业务回调保留；仅绑定 change 时保留兼容路径，但 App 业务应改用 blur / confirm。实际 demo 回归覆盖了“input 仅收到 confirm / blur”和“textarea 仅收到 blur”的事件序列。下文真机计数和原始记录属于修正前的验证，不能作为新规则已完成真机复测的证明。

修正后类型检查、覆盖率门禁与 702 项测试通过，SDK / demo 检查通过；Android 编译成功，鸿蒙运行包生成成功。两端编译产物均确认在三事件控件的 blur 监听器中插桩。本次修正未重新执行真机交互。

## 环境与基线

| 项目 | 本次实际环境 |
| --- | --- |
| 仓库 | `develop` / `7b75f4d`；开始时已有鸿蒙验证相关未提交改动，本轮保留 |
| 设备 | 小米 MI 6；USB 序列号仅保留末四位 `c3a6` |
| 系统 | Android 9 / API 28，MIUI V11；WebView 80.0.3987.99 |
| HBuilderX / uni 运行时 | 5.26 / 5.26，Vue 3；官方自动化插件 5.5.0 |
| SDK / demo 资源版本 | 0.1.0 / 0.1.0 |
| 调试基座 | `io.dcloud.HBuilder`，原生版本 15.26；协议中的 domain / appVersion 与该基座一致 |
| 屏幕 | 逻辑 360 × 640、DPR 3；协议与设备截图均为 1080 × 1920，竖屏 |
| collector | 电脑 `127.0.0.1:3103`，通过 `adb reverse` 连接；独立于此前鸿蒙 collector |
| 网络基线 | Wi-Fi 开启，移动数据关闭；断网测试实际关闭两者并在结束后恢复 |
| 无埋点 | demo 使用 `__GIO_AUTOTRACK_VERIFICATION__: true`，未修改 `src/constants/platform.ts` |

测试只使用合成账号、合成输入及固定合成坐标。运行时临时将 `demo/main.ts` 收数地址设为 `http://127.0.0.1:3103`；结束时撤回该配置。手机保留的是连接本地测试 collector 的验证产物，重新从源码运行需配置自己的测试地址。

## 验收矩阵

以下原生交互均通过安卓设备的真实点击、拖动、键盘、Home、网络设置或进程操作执行。自动化桥接用于导航、读取页面状态、滚动与定位；没有手动调用业务 handler、构造原生 `detail` 或伪造生命周期来代替这些验收。

| 类别 | 实际验证及结果 |
| --- | --- |
| 启动 / 初始化 | 通过：加载 SDK 后首页完整，VISIT/PAGE 到达 collector；平台、设备、版本、包名与系统字段正确 |
| 插件 / 命令边界 | 通过：初始化后注册插件被明确拒绝；非法事件名与未知命令拒绝 |
| 自定义事件 / 属性 | 通过：字符串、数字、布尔、数组归一化；嵌套对象、NaN 被剔除 |
| 身份 / 用户属性 | 通过：set/clear userId、userKey 和用户属性；事件使用当前身份 |
| 身份 / 会话 | 通过：A→退出→A 保持会话；A→退出→B 新会话且没有额外 PAGE；非法 UTF-16 身份拒绝 |
| 位置 | 通过：设置、清除和越界拒绝；非法位置/身份不覆盖先前合法值 |
| 页面 / 路由 | 通过：切页、返回、query、referralPage 和 PAGE 关联 |
| 前后台 | 通过：真实 Home 产生 BACKGROUND 的 APP_CLOSED，且不带 eventSequenceId；短时恢复会话连续 |
| 超时会话 | 通过：实际后台约 35.4 秒，超过默认 30 秒后产生新的 VISIT/session |
| 屏幕 | 通过：逻辑尺寸 × DPR 与物理截图一致，PHONE 与 PORTRAIT 正确；未执行真实横屏 |
| 采集开关 | 通过：非法值/额外配置字段拒绝；暂停时 CUSTOM/VIEW 不入队，业务点击与输入计数继续增加 |
| 恢复采集 | 通过：重建 VISIT/PAGE；后续 CUSTOM/VIEW.pageShowTimestamp 与新 PAGE.timestamp 一致 |
| 基础点击 | 通过：click/tap、有/无 id、严格 currentTarget；主目标无 id 不借子 id，data-index=0 省略 |
| 冒泡 / 去重 | 通过：父子不同 xpath 各一条，业务各一次；连续独立点击及切页返回后的点击均保留 |
| 连续交互 | 通过：30 次真实点击对应 30 条业务事件和 30 条无埋点事件，序号无重复、无缺口 |
| 动态列表 | 通过：重排、保留 key 更新 id/title/src、增删和重置；采集当前文案、链接与一基 index |
| 条件 / 表达式 | 通过：v-if 删除/恢复、v-show 隐藏/恢复、条件 handler 两个分支、括号/对象/多层箭头 |
| Vue 写法 | 通过：Options、script setup、setup 返回别名；原生截图中两个组件业务计数各为 1，事件各一条 |
| ignore / sensitive | 通过：currentTarget/target 隐私优先级、字符串/数字 1、动态切换与恢复；业务执行但自动事件被拦截 |
| 四种禁用标记 | 通过：原生 picker 实际遍历 false、0、"0"、"false"；点击保留，输入事件不带原文 |
| 密码 / 动态类型 | 通过：静态 password、动态 type/password、sensitive 阻断自动事件，业务执行；合成敏感输入未进入请求 |
| input / textarea | 独立 blur、键盘 confirm 通过；未授权输入仍有 VIEW_CHANGE，但没有 textValue；原生 change 边界见下文 |
| 文本边界 | 通过：120 字符截至 100、控制字符归一化、清空后事件保留但省略 textValue |
| switch / slider | 通过：true/false、非零与归零；字符串 "false" / "0" 保留 |
| radio / checkbox | 通过：A/B、多选、取消单项与取消全部；多值 A\|\|B，空值字段省略 |
| picker | 通过：动态 range 下标回退；字面量字符串/对象 range 分别采集“上海”“方案乙”；原生确认返回合法下标 |
| picker-view | 通过：双列下标 1\|\|1、固定列文案“华南\|\|下午” |
| swiper | 通过：真实手动滑动、文案回退；未放行 autoplay 业务继续但不采集；放行后下标 0、1 均收到 |
| uni-link | 通过：真实 navigator 跳转及组件 emit 组合只生成一条 #openURL，hyperlink、来源与目标 PAGE 正确 |
| tabBar | 通过：真实点击四项，#onTabItemTap、一基 index 1–4、目标路径正确 |
| 不采集边界 | 通过：函数引用、计算成员、.stop、动态事件、自定义 emit、打字只执行业务；.stop 仍阻止父层冒泡 |
| 请求协议 | 通过：实际 uni.request 的 POST、JSON、项目路径、compress/stm、请求头及 VIEW 字段符合协议 |
| HTTP 恢复 | 通过：200/204 接收；500 重试后恰好接收一次；400 丢弃且不重试 |
| 超时 / 并发 | 通过：collector 延迟 15 秒，SDK 5 秒超时；六次真实点击的 12 条事件，在三个请求槽位内排空且无重复 |
| 真实断网恢复 | 通过：实际关闭 Wi-Fi/移动数据，离线事件入队；恢复网络与前台后两条标记各一次，网络为 UNKNOWN/WIFI |
| 在途进程终止 | 通过：捕获请求后，在事件生成约 95 ms 时发出终止命令并确认进程消失；旧 PID 消失，新 PID 启动后整条事件逐字段一致、只收到一次 |
| 冷启动身份 / 序号 | 通过：重启后 deviceId、userId、userKey 恢复，新事件序号继续递增 |
| 离线冷启动 | 通过：关闭网络后真实重启进程，确认原生页面就绪再点击；恢复网络后只补发一次，随后新事件为 WIFI 且序号递增 |

## 能力边界

1. **传统 App 输入组件不转发原生 change。** 独立 input change 的业务增量为 0；同时声明三个完成事件时，input 实际执行 blur/confirm，textarea 实际执行 blur，均没有 change。初次验证的 SDK 仅对 change 插桩，后续已按上方记录修正为 blur 优先。原始记录中的三条“completion capability”是修正前的能力观察，不是 change 能力通过。
2. 只覆盖单台 Android 9 设备和本次 HBuilderX/WebView 版本。未执行真实横屏、蜂窝网络/制式切换、多设备、多安卓版本、系统内存压力回收或自然长时间运行。
3. 大容量队列、损坏存储、宿主 API 缺失、迟到回调、写入竞争等由受控测试覆盖，不能据此声称已在真机上制造所有异常。真实进程终止、真实断网与恢复另有本轮设备证据。
4. 本地 collector 证明实际请求与本地接收结果；未验证生产鉴权、入库、看板或正式 TLS。生产无埋点能力表仍为原值，未据此自动开放。
5. 初次受限环境运行代码测试时，测试端口与进程通信权限导致失败；允许本机端口后完整门禁通过。设备驱动试跑中修正了组件定位、导航动画/离线启动就绪等待和调试基座导出启动入口，未据此修改 SDK。

## 最终检查与证据

代码门禁 `pnpm run test:release`：**63 个文件、699 项测试全部通过**，包含 TypeScript、压力/恢复场景和逐文件覆盖率门禁。覆盖率为语句/行 **98.69%**、函数 **99.02%**、分支 **92.97%**。SDK 构建、消费者类型与 demo 结构检查通过，Android 原生编译、安装、启动成功；撤回临时收数地址后再次通过 `demo:check`。

新增可复用冒烟入口：`demo/pages/index/android-smoke.test.js`。完整原生检查连接由官方插件运行，通过后再执行独立的真实进程终止测试；最终官方安卓冒烟 **2/2 通过**（success=true，0 failed），完整检查连接 **1/1 通过**。

冻结时共接收 **322 条事件**、记录 **312 次上传尝试**，非法请求 **0**；**140 条原生断言记录**及 **3 条 change 能力观察**已归档。该计数包含试跑与复查，不表示 140 个互相独立的场景。原始请求的协议、合成敏感值拦截与已接收序号唯一性最终复核通过。

本轮本机原始证据保存在已被 git 忽略的 `test-results/android-device/`，不会随源码提交自动归档：

- [机器可读摘要](../test-results/android-device/validation-summary.json)、[原生断言/观察](../test-results/android-device/native-results.ndjson)。记录包含试跑与复查，条数不能当作独立测试场景数。
- [接收事件](../test-results/android-device/events.ndjson)、[上传尝试](../test-results/android-device/attempts.ndjson)、[环境记录](../test-results/android-device/system-info.json)。
- [script setup 计数截图](../test-results/android-device/script-setup-count.png)、[setup 别名计数截图](../test-results/android-device/setup-alias-count.png)。
- [检查连接的官方测试报告](../test-results/android-device/automation-inspection.json)、最终安卓冒烟报告 `automation-smoke-final.json`。
- `network-baseline.json`、`session-background.json`、`cold-inflight-baseline.json`、`offline-cold-baseline.json` 和对应 `native-*.mjs` 驱动脚本。
- `coverage/coverage-summary.json`、`test-results/junit.xml`；完整代码门禁日志 `/tmp/gio-android-tests-final.log`，demo 检查日志 `/tmp/gio-android-demo-check.log`。

复现时需准备本机 HBuilderX、ADB、USB 设备、自动化插件、端口映射与测试 collector。`demo/env.js` 含本机配置，继续排除提交。手机最终停留在首页，Wi-Fi 开启、移动数据关闭，与原基线一致；本轮 collector 已停止，3103/9520 测试映射已移除，源码临时地址已撤回。没有卸载应用、清空基座数据、提交、推送或发布。
