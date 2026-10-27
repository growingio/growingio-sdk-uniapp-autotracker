# 核心代码测试与发布前门禁

## 常用命令

在仓库根目录安装锁定依赖后运行：

```sh
pnpm install --frozen-lockfile
pnpm run test:release
```

`test:release` 先进行源码、测试、发布脚本及源码消费者示例的 TypeScript 检查，再运行全部单元、协议和集成测试，并检查核心源码覆盖率。不需要启动 HBuilderX 或连接设备。依赖生成包的两个消费者示例由构建后的 `release:check` 检查，首次运行代码测试无需预先生成 SDK 包。

打包前的完整验收入口：

```sh
pnpm run release:prepare
```

执行顺序为：类型检查 → 全部测试与覆盖率 → 构建 SDK → 生成 npm/uni_modules 压缩包 → 验证产物完整性、隔离安装、消费者类型与 demo。任一步失败立即停止；该命令不会发布 npm 包或创建 GitHub Release。

发布包消费者另外运行高级身份、原生标识与 uniMP JS 桥接；八端编译矩阵分别执行默认及迁移 / identify 消费者。具备 App 编译组件时，设置 `GIO_UNI_COMPILER_ROOT` 后运行 `pnpm run test:app:compile`，检查两渠道的独立 App 与 uniMP 客体资源编译。它不包含设备安装、wgt 宿主加载或真实 module 收数。

`release:publish` 在发布既有交付包之前再次检查代码测试及交付包，且实际发布仍仅允许在 GitHub tag 工作流中进行。源码、测试、测试配置或发布流程发生变化后，旧交付包会因构建摘要不匹配而被拒绝。

日常可用 `pnpm test` 快速运行所有测试，或 `pnpm exec vitest run test/unit/uploader.test.ts` 运行指定模块。单模块测试不作为发布前验收结果。

性能和高流量验证使用：

```sh
pnpm run test:stress
pnpm run bench:sdk
```

`test:stress` 运行真实 SDK 的一万次在线事件、两万次离线提交、三个固定种子各 5000 次故障交错，以及 75 轮模拟存储写入/冷启动恢复/重连；断言接纳/拒绝、序号、最多三个并发、重连排空、迟到回调与资源释放。冷启动场景逐项核对载荷、身份、会话与模拟宿主存储内容，封存的旧进程不得继续写入共享存储。队列单测另覆盖 5000 次固定种子的字节预算、批次和恢复交错。状态存储测试通过故意延迟旧写入，验证冷启动身份不回退，并检查每键最多一份在写和一份待写内容。

`bench:sdk` 输出 `test-results/stress-current.json`，记录队列入队、批次选择、离线调度、长属性、超长身份、无埋点长文本/多选值、2000 个监听器的 SFC 编译、慢存储堆保留量和写入量，以及完整运行时和冷启动压力场景。它预热后取 5 或 7 个样本，输出中位数和样本 P95；堆保留量在显式 GC 后读取。耗时只用于同机同环境对比，不设置跨硬件时间门槛，也不代表真实设备或网络吞吐。性能对照与全量测试应分开运行，减少 CPU 和 GC 争用。

使用 `node --expose-gc --import tsx scripts/stress-sdk.ts --micro-only --output <文件>` 可仅运行微基准；使用 `node --expose-gc --import tsx scripts/stress-sdk.ts --extended --output <文件>` 可扩展到十万次在线事件、二十万次离线提交，以及 250 轮冷启动恢复（每轮 190 次业务提交）。实测对照与修复记录见[2026-10-19 深度审查](./sdk-deep-review-2026-10-19.md)与[2026-10-16 深度审查](./sdk-deep-review-2026-10-16.md)。

## 核心功能与对应测试

| 功能 | 验证行为 | 主要测试文件（相对仓库根目录） |
|---|---|---|
| 公共 API、配置与插件 | 所有 gdp 命令、非法输入、未初始化调用、重复 init、注册原子性、失败 init 后重试、安装顺序及插件异常隔离 | `test/integration/sdk-public-contract.test.ts`；`test/unit/{public-api,config,plugin-registry,tracker-lifecycle}.test.ts` |
| 启动与采集同意 | 异步恢复顺序、不可变快照、条数/UTF-8 字节上限、生命周期独立缓冲、关闭采集不读取业务值、恢复后 VISIT/PAGE | `test/unit/{bootstrap-buffer,hydration,tracker-event-gate,tracker}.test.ts` |
| 匿名/登录身份 | deviceId 生成、旧格式迁移、加密记录、userId/userKey、切换用户后的会话、清除身份 | `test/unit/{identity,identity-codec,identity-persistence}.test.ts`；`test/integration/sdk-public-contract.test.ts` |
| 高级身份与 H5 | forceLogin 暂存、identify 保序 / 原子失败、旧 SDK 显式迁移、重启恢复、停采与查询串 | `test/unit/advanced-identity.test.ts`；`public-hybrid.test.ts` |
| 可选原生标识 | 默认不读、平台过滤、VISIT 白名单、超时 / 异常 / 晚到回调、停采失效 | `test/unit/native-identifiers.test.ts` |
| uniMP JS 托管 | 单 FIFO、身份阻断、PAGE 依赖、前台代次、限额、时钟、协议验证、module 与公开入口 | `test/unit/{unimp-runtime,unimp-contract,unimp-native-module,public-hybrid}.test.ts`；`test/support/unimp-host.ts` |
| 会话和事件序列 | 冷启动、后台 30 秒边界、身份/同意变化、序列跨会话恢复、APP_CLOSED 无序列 | `test/unit/{session,event-sequence,session-persistence,meta-persistence}.test.ts`；`test/protocol-contract/event-sequence.fixture.test.ts` |
| App / Page 生命周期 | 入口和页面上下文、页面可见性、卸载、动态标题、方向、后台事件、宿主异常隔离 | `test/unit/{app-lifecycle,page-lifecycle,page-store,app-bridge,page-bridge,uniapp-installer,orientation}.test.ts` |
| 事件协议、属性与位置 | 所有事件类型的字段白名单、公共上下文、属性清洗、0/false、事件名校验、经纬度及清除位置 | `test/unit/{protocol,event-composer,event-dispatcher,location-state}.test.ts`；`test/protocol-contract/*.test.ts` |
| 队列与持久化 | FIFO、容量、字节边界、并发领取、重试状态、损坏记录隔离、写入失败后的后续恢复 | `test/unit/{queue,queue-persistence,persistence-boundaries}.test.ts` |
| 上传与网络 | POST/JSON 协议、200/204 接收、4xx 丢弃、5xx/网络重试、最多 3 个并发、断网保留、超时/取消只结算一次 | `test/unit/{collector,uploader,transport-finalizer,app-request,app-network}.test.ts`；`test/integration/mock-collector.test.ts` |
| 无埋点编译 | Vue AST、三种组件写法、条件分支、参数/this/返回值/异常、幂等性、复杂表达式警告与安全跳过 | `test/unit/{autotrack-vite,autotrack-semantics}.test.ts`；`test/integration/autotrack-hbuilderx.test.ts` |
| 无埋点运行时 | schema、id#eventName、各 change 组件、敏感与 ignore、去重、tabBar、正式能力开关、编译到 HTTP 收集的完整链路 | `test/unit/{autotrack-contract,autotrack-dispatch,capabilities}.test.ts`；`test/integration/autotrack-pipeline.test.ts` |
| 三端宿主装配 | Android/iOS/HarmonyOS 公共 API 到真实 SDK 运行时、协议与受控请求；系统信息、网络和存储降级 | `test/integration/sdk-public-contract.test.ts`；`test/unit/{app-runtime,app-system-context,app-storage}.test.ts` |
| 打包发布 | 失败停止后续步骤、发布前再检查、版本渠道、npm 重试、两种安装包内容与真实消费者导入 | `test/integration/release-gate.test.ts`；`test/unit/{release-policy,npm-publisher}.test.ts`；`scripts/check-{release,package-consumers}.ts` |

## 覆盖率与报告

覆盖范围包括 `index.ts`、`autotrack.ts`、`vite.ts` 和 `src/` 中的全部源码，即使文件没有被测试导入也计入。只有纯类型声明文件 `src/types/index.ts` 由 TypeScript 检查替代运行时覆盖率。

每个文件必须达到：行与语句覆盖率 90%、函数覆盖率 85%、分支覆盖率 80%。任一文件不达标就返回非零退出码。配置与阈值使用 [Vitest 3 覆盖率能力](https://v3.vitest.dev/config/#coverage)。覆盖率是防遗漏门槛，不能代替上表中的业务行为断言。

- `coverage/index.html`：逐文件可视报告及未覆盖代码。
- `coverage/coverage-summary.json`：机器可读的覆盖率汇总。
- `test-results/junit.xml`：每个用例的执行结果。

分支推送和 PR 的 `SDK Code Tests` 工作流运行完整 `release:prepare`；tag 的 `Publish SDK` 工作流执行相同门禁。CI 保留报告 14 天。报告属于生成文件，不提交 Git。

## 验证边界

这些测试运行真实 SDK 代码，替换 uni 宿主、时间、存储和网络等外部依赖；HTTP 链路使用本地 mock collector。它们证明代码行为，不代表 Android/iOS/HarmonyOS 真机、签名打包或生产服务端验收。生产平台能力表不会因代码测试通过而自动开启。独立的[安卓真机报告](./android-device-validation-2026-10-19.md)和[鸿蒙实机报告](./harmony-device-validation-2026-10-19.md)分别记录了单台设备的真实原生交互、设备上传、本地 collector 接收结果和宿主限制。

## 八端小程序专项检查

`test/unit/miniprogram-platform.test.ts` 覆盖目标识别、配置、系统接口回退、八端协议与存储隔离；`test/integration/miniprogram-runtime.test.ts` 覆盖真实 SDK 的会话、入口、页面、身份、采集开关、批量上传、重试及编译后监听器的隐私与业务行为。现有 App 用例继续作为回归基线。

提交前补充 `test/integration/miniprogram-boundaries.test.ts`（异常场景、先到页面、采集同意、队列满及跨页面去重）、`test/integration/app-miniprogram-compatibility.test.ts`（三端 App 的公开入口、协议、30 秒超时、原存储及即时上传）和 `test/unit/uploader-aggregation.test.ts`（聚合截止时间、并发、强制发送、离线及重试窗口）。审查结论见[适配审查记录](./miniprogram-review-2026-10-27.md)。

`test/integration/miniprogram-cross-platform.test.ts` 额外检查八端宿主冲突、设备前缀交叉拒绝、账号及最新入口接口缺失、抖音原生来源别名、存储隔离和返回栈生命周期序列；独立预期表与生产平台表分别维护。最新结果见[八端扩展验证记录](./miniprogram-platforms-validation-2026-10-27.md)。

`pnpm run test:miniprogram:compile` 在 SDK 构建后检查 npm／uni_modules × 八端 × 开发／生产压缩 × 有／无插桩插件，共 64 种实际编译，并在独立进程运行 16 个交付包消费者。使用实际 demo 初始化，验证分包和内置 tabBar 编译。该命令已接入 `release:check`，因此 CI 的 `release:prepare` 也会执行。可用 `GIO_UNI_COMPILER_ROOT` 指定 HBuilderX 编译包复检；结果保存在 `test-results/miniprogram-build/`。这些检查不等同于小程序开发者工具交互或真机收数，生产自动交互能力不会因此开放。
