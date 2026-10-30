# 无埋点 schema v2 实施与验证说明

本次代码迁移已实现。[2026-10-19 安卓真机报告](./android-device-validation-2026-10-19.md)和[鸿蒙实机报告](./harmony-device-validation-2026-10-19.md)已记录各自单台设备验收及能力限制；iOS、多设备和生产服务端验收仍待完成，尚未发布或打 tag。

## 行为与升级

- 普通模板 `VIEW_CLICK/VIEW_CHANGE.xpath` 在运行时生成 `id#eventName`。严格选择 `currentTarget || target`；主目标没有 id 时生成 `#eventName`，不会借用子节点 id。
- Vite 用 Vue SFC/template AST 与 Babel 事件表达式 AST 插桩。可安全分析的显式调用、同步函数与显式调用条件分支可插桩；函数引用、返回函数的条件表达式和复杂组件选项保持原样。普通 `setup()` 保持原实现，通过静态 methods 别名暴露 dispatcher，不复制组件。
- 双目标 ignore/sensitive、文件和动态 type 输入会拒绝整条自动事件。密码、安全密码及动态 password 保留 `VIEW_CHANGE`，但始终不读取、不上报 `textValue`，track 不能覆盖；显式 sensitive 的密码框仍整条忽略。非敏感 change 仅在 track 放行后读取值；swiper 保留 autoplay 与 title 专属规则。
- change 按组件处理 input、textarea、switch、slider、radio-group、checkbox-group、picker、picker-view、swiper；保留 `0`、`false` 和空值事件。picker 优先使用 range 文案，无法映射时使用规范下标。
- input / textarea 输入完成按 `blur → confirm → change` 选择一个已声明的监听器，避免 App 不转发原生 change 时漏采；原业务回调保留，上报仍为 `VIEW_CHANGE`。仅声明 change 的输入框应改用 blur / confirm。
- 同一事件对象去重，加上每 tracker/当前页面的有限正数时间戳窄窗去重；零时间戳不参与窄窗判断。父子不同标识、不同类型和值不会合并。
- tabBar 为 `#onTabItemTap`、一基 index，pagePath 进入 hyperlink。普通 click 的 data-index 只接受大于 0 且小于 2147483647 的规范十进制整数。
- v1/v2 编译探针互不兼容。SDK、demo 与使用方 App 必须整体重建，不能混用旧产物；历史结构路径的圈选、看板和规则须按新标识重新配置。

动态事件、自定义组件、事件修饰符、计算成员和无法安全改写的复杂 handler 保持原样并产生构建告警；`.nvue` 不插桩。picker-view 仅从固定列的静态文本或字面量 v-for 提取 range；动态 range 回退规范下标，不重复读取业务 getter。完整边界见[设计文档](./uniapp-autotrack-design.md)。

明确标记静态 `data-growing-ignore` 的监听已经主动排除采集，不再报告上述采集边界告警，原监听不改写。可正常插桩的 ignore 控件仍保留探针与运行时隐私检查。只有确定启用的标记（空值、true、1 及对应字符串字面量）适用；false / 0、动态绑定、对象或动态属性 v-bind 可能覆盖的标记仍保留诊断。模板语法和缺失 handler 的错误不受此规则影响。

## 编译依赖修复

`@vue/compiler-dom`、`@vue/compiler-sfc` 与本工程 Vue 统一锁定为 `3.4.21`，对应当前 HBuilderX 5.24 工具链。此前新增的 compiler-sfc 3.5.42 在 HBuilderX 对 `@vue/shared` 设置全局别名后，复现了 `shared.genCacheKey is not a function`；统一版本后，同一混用场景已通过。新增子进程回归测试模拟该别名边界，发布时解析器已经打包进 Vite 工具，检查还会在仓库外执行真实压缩包中的编译插件并验证 App 运行时依赖隔离。

## 验证构建与验收状态

正式构建继续由 `src/constants/platform.ts` 禁用尚未验收的 autoClick、tabBar 和逐组件 autoChange。demo 的 `vite.config.ts` 独立设置 `__GIO_AUTOTRACK_VERIFICATION__: true`，只用于开放待验收采集链路；该开关不回写生产验收矩阵，正式应用不要复制。

本地验证包括 TypeScript、实际 Vue listener 执行、源 SFC 到协议再到 HTTP mock collector、编译产物消费者类型、demo 结构及 release 包检查。安卓与鸿蒙各自单台设备的实际请求和本地 collector 接收证据见上述实机报告；尚未取得三端及生产服务端的完整验收证据。

## 手工验证入口

重新编译 demo 后进入“无埋点”页，检查以下结果；业务行为应与未插桩时一致；原本仅返回函数的表达式不会被强制执行：

| 操作 | 预期结果 |
|---|---|
| 普通点击 / 卡片 tap | `plain-action#onAction` / `tap-card#onAction` |
| 父节点无 id、子节点有 id | `#onParentWithoutId`，不能借用子节点 id |
| 商品一、商品二 | `sku-1#onListAction` / `sku-2#onListAction`，index 分别为 1、2 |
| 无 id 列表 | 每项都是 `#onNoIdListAction`，没有结构路径兜底 |
| `v-if` / `v-show` | 只有实际可见、可达并被点击的按钮产生事件 |
| 无 id 条件按钮 | 订阅开关开启时为 `#onAction`，关闭时为 `#onInputComplete`；只执行命中的分支，业务计数增加 1，无编译警告 |
| Options / `<script setup>` / `setup()` 别名按钮 | 分别使用模板可见 handler 名；页面计数每次只增加 1 |
| 昵称失焦 / 备注完成 | `nickname#onInputComplete` / `note#onInputComplete`；备注仅 blur 插桩 |
| 未放行的普通输入 | 生成 `VIEW_CHANGE`，但不包含 `textValue` |
| 密码 / 安全密码 / 动态 password | 生成不含 `textValue` 的 `VIEW_CHANGE`，即使带 track 也不读取密码值；业务 handler 保留 |
| sensitive、currentTarget/target ignore | 无自动事件，包括显式 sensitive 的密码框；业务 handler 保留，输入原文不进入日志 |
| 开关关闭 / 滑块归零 | textValue 分别为 `"false"` / `"0"` |
| 单选 / 多选 | 对应标量值 / `||` 拼接的标量数组 |
| 城市选择 / 多列选择 | 动态 range 回退下标，多列用 `||` 拼接；字面量 range 可采集文案 |
| 手动轮播 / 自动轮播 | 手动轮播可携带 `轮播文案`；未放行 autoplay 无事件 |
| `uni-link` | `#openURL`，静态 href 或原生 dataset.src 进入 hyperlink，内外层同一交互只发送一次 |
| 底部 tabBar | `#onTabItemTap`，index 从 1 开始，hyperlink 为页面路径 |

调试日志使用 `action=click/change`；最终请求中不会新增 eventName、elementType、schemaVersion 等内部字段，VIEW_CHANGE 不包含 index/hyperlink。请同时对照设备请求和 collector 最终收到的数据，记录平台、设备、HBuilderX/SDK 版本与触发页面。
