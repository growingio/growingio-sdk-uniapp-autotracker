# 微信和支付宝实现验证记录

> 首批历史记录。合并 App 修正及其余六端扩展后的最新测试与编译结果见[八端扩展验证记录](./miniprogram-platforms-validation-2026-10-27.md)。

日期：2026-10-27。分支：`minp`，基于 `1ec311b` 工作区开发，版本保持 `0.1.0`。本轮按确认范围完成代码、自动化及编译验证，开发者工具交互和真机收数后补。

## 已实现能力

- 保持 `gdp()` 和 Vue 应用接入方式，识别微信／支付宝目标，校验真实 appId，拒绝明确冲突及其他小程序目标。
- 使用独立小程序系统上下文和协议校验：微信 `MinP`、支付宝 `alip`，不混入 App 专属字段。
- 接入 App／Page 生命周期、原生路由、入口和额外参数清理、动态标题；普通组件不会触发 App 生命周期。
- 实现五分钟后台保活、场景变化、可选活动超时、登录及恢复采集的会话边界，协调页面补发顺序。
- 持久化隔离后的身份及全局序号，session 与事件队列仅存在于当前运行期。
- 复用 uni 请求和网络端口，默认每秒聚合；后台即时 flush、重复后台通知去重、有限并发、超时及重试。
- 复用 schema v2 模板探针、值授权、敏感输入保护和业务行为规则；生产自动交互能力保持逐项验收门控。
- 更新 npm／uni_modules 声明、公开配置类型、demo 和接入文档，将小程序消费者与编译矩阵加入发布检查。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 项目类型检查 | 通过 |
| 全部协议、单元、集成及发布门禁测试 | 69 个文件，852 项通过；较扩展前增加 150 项，其中审查阶段新增 35 项 |
| 总语句及行覆盖率 | 99.04% |
| 总分支覆盖率 | 93.25% |
| 总函数覆盖率 | 99.54% |
| 逐文件覆盖率门槛 | 全部通过，保持原阈值 |
| 本地真实 HTTP 接收 | 两个平台分别通过 200／204，共四种组合；检查请求契约及小程序报文 |
| App 与扩展前版本对照 | 对照 `1ec311b` 的 8 组公开入口执行结果，报文、存储内容和命令返回值一致 |

专项覆盖包括目标与 OS 分离、appId 拒绝后可重试、缺失／抛错的可选系统方法、尺寸回退、存储隔离、冷启动、keepAlive 阈值及相等边界、场景变化、活动超时、Page 早于 App、页面补发去重、身份及采集同意、队列重启丢弃、上传聚合／后台发送、迟到及重复回调、失败重试、SFC 业务监听及敏感输入拒绝。

测试入口：[平台与协议](../test/unit/miniprogram-platform.test.ts)、[完整运行链路](../test/integration/miniprogram-runtime.test.ts)、[真实 HTTP](../test/integration/miniprogram-collector.test.ts)、[审查边界回归](../test/integration/miniprogram-boundaries.test.ts)、[App 兼容](../test/integration/app-miniprogram-compatibility.test.ts)、[上传聚合](../test/unit/uploader-aggregation.test.ts)。原有 App 的协议、存储、会话、无埋点及发布测试继续运行，未修改覆盖率阈值或跳过失败用例。具体修复见[审查记录](./miniprogram-review-2026-10-27.md)。

## 交付包和编译结果

| 工具链 | 版本 | 编译组合 | 独立运行消费者 |
| --- | --- | --- | --- |
| 仓库锁定 CLI | `3.0.0-5020420260812001`，编译器显示 5.24 | npm／uni_modules × 微信／支付宝 × 有插件／无插件，共 8 组通过 | 两渠道 × 两平台，共 4 组通过 |
| 本机 HBuilderX | `uniapp-cli-vite 5.26.2026091411.1611`，DCloud `3.0.0-alpha-5020520260821001` | 相同 8 组通过 | 相同 4 组通过 |

编译使用交付的 JavaScript 和声明文件，不从消费者跨目录导入 SDK TypeScript。fixture 包含 `<script setup>`、Options API、按钮、输入完成、v-model、敏感输入、picker、列表和动态 dataset；有插件时检查探针和目标平台事件绑定，无插件时检查没有插入模板探针。

独立运行消费者使用模拟 uni 宿主，执行公共 gdp、生命周期、页面与后台发送，并校验 wire platform、appId、字段白名单以及 session／queue 不落盘。它证明交付包可以运行，不能代替微信或支付宝原生运行环境。

此外，本机 HBuilderX 5.26 的传统 `app` 目标最小工程编译通过，使用当前 SDK 源码及现有探针。该项验证的是 Android／iOS 共用的 App JavaScript 资源，不是签名安装包或三端设备验收。

`release:prepare` 检查类型、测试、覆盖率、SDK 构建、双渠道打包、独立 App 消费者、声明文件、demo 及小程序矩阵。最终包保存在 `dist/release/`，本轮不执行远端发布。

可重复执行：

```sh
pnpm run release:prepare
GIO_UNI_COMPILER_ROOT=/Applications/HBuilderX.app/Contents/HBuilderX/plugins/uniapp-cli-vite pnpm run test:miniprogram:compile
```

原始结果位于忽略提交的 `coverage/`、`test-results/junit.xml`、`test-results/miniprogram-build/`。编译报告关联构建的 sourceHash；源码或文档变化后必须重新构建，不能沿用旧交付包检查。

## App 兼容范围

App 继续使用原存储键、持久化 session／queue、30 秒默认后台超时、即时上传、原字段白名单与 gdp 返回值语义。新增 appId、keepAlive 和 uploadInterval 只由小程序消费；App 的生产自动交互能力表不因扩端改变。已有 demo 中的 App 配置保留，小程序仅在获得真实账号信息时补充自己的配置。

## 后续验收

微信与支付宝分别补齐开发者工具实际操作，以及 Android／iOS 手机上的宿主版本、基础库、页面生命周期、键盘、各组件事件对象、请求和产品归档。HarmonyOS 宿主和桌面端小程序另列验收。

生产 autoClick、逐组件 autoChange 和 tabBar 当前关闭，验证工程可以显式开放待测链路。取得对应端与组件的真实请求及收数证据后再逐项开放；基础生命周期和手动事件的代码状态不等于已完成设备验收。百度、抖音、QQ、快手、京东和小红书尚未实现适配。
