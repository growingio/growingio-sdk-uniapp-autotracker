# GrowingIO uni-app SDK Showcase

这是传统 uni-app Vue 3 App 的可运行 showcase。它与 uni-app x demo 对齐展示已实现的功能：生命周期、`PAGE` 上下文、自定义事件、用户身份/属性、Vite 无埋点业务交互、路由 query 和 `dataCollect` 动态开关。

微信、支付宝、百度、抖音、QQ、快手、京东和小红书复用同一工程：在 `manifest.json` 对应目标中填写真实 appId，并按需填写 `miniprogram-config.ts` 的平台标识。`main.ts` 优先采用显式平台配置，其次读取可用账号信息；百度、抖音等无账号接口时必须显式填写。账号读取仅在 MP 条件编译中执行。运行前重新构建 SDK，并配置测试采集域名及平台网络白名单。小程序的保活默认为五分钟、事件按秒聚合、session 和事件队列不落盘；生产自动交互门控及真机状态见[小程序接入](../doc/miniprogram.md)。本 demo 的内部验证开关只用于验收，不能作为能力已经通过真机的证据。

默认开启 `dataCollect`，因此首次 `App:onShow` 会创建 `VISIT`，随后在 uploader 真正发起请求前以 Debug JSON 输出。若业务需要等待隐私同意，可在 `sdk-state.ts` 将 `enabled` 设为 `false`（main.ts 与示例页面共用此状态），再通过「采集开关」页开启。SDK 的完整初始化与 App/Page 生命周期接入只在 `main.ts` 里使用小程序同款的 `gdp('registerPlugins')` 与 `gdp('init', ..., { uniVue: app })`；`App.vue` 和各演示页面都不需要 bridge 或 tracker import，业务调用也全部使用 `gdp('xxx')`，不暴露 `$gio` 或内部 tracker。`gioABTest`、微信分享和 `.nvue` 自动采集并非当前传统 App SDK 的能力；首页的“当前能力边界”区会明确说明，绝不伪造成功结果。

先执行一次 `pnpm build:sdk`。它会将 SDK 编译为 `demo/uni_modules/gio-uniapp-autotracker`；demo 只从该产物导入，绝不跨目录引用仓库源码。随后在 HBuilderX 中打开此 `demo/` 目录并运行 App。`vite.config.ts` 已把 `gioUniappAutoTrack()` 放在 `uni()` 前面，因此原生 `.vue` 页面会在构建时插入无埋点 dispatcher。

边界场景归属于对应功能页：自定义事件页验证空事件名、未知命令和属性过滤；用户页验证非字符串身份、位置设置/清除与越界位置；生命周期页验证初始化后不能再注册插件；采集开关页验证 `setOptions` 只接受 `{ dataCollect: boolean }`。属性过滤是不同于失败的边界：事件成功入队，但嵌套对象和非有限数不会进入 collector。`pnpm test` 中的 demo 场景会覆盖：`main.ts` 的唯一接入点与菜单页面映射、实际无埋点页面的编译输出、以及从 `gdp` 初始化到生命周期、隐私开关、身份、属性、自定义事件、普通无埋点和敏感值拦截的完整 mock-collector 链路。它不替代 HBuilderX/真机上的页面点击、切后台或截图验证。

`idMapping` 只在首次成功的 `init` 中读取。修改 `main.ts` 后需停止运行并重新启动，使 SDK 进入新的 JS 运行期；再次 `init` 或调用 `setOptions({ idMapping: ... })` 都返回 `false`，继续使用首次配置。`false` 时 `setUserId(userId, userKey)` 仍接纳 userId，但忽略 userKey；`true` 时才保存并上报两者。此前关闭映射时被忽略的 userKey 不会自动恢复，开启后应重新调用 `setUserId` 传入 userKey。

用户页的“设置用户身份”会在设置成功后发送 `review_identity_set`。请用这条事件核对更新后的 `userId` / `userKey`；按钮自身的 `VIEW_CLICK` 在业务处理前生成，使用更新前的身份，`setUserId` 也不会改写已生成的事件。若采集关闭，身份仍可更新，页面会明确提示核对事件未入队。

本次审查修复新增的实机场景：

| 入口 | 操作 | 核对依据 |
| --- | --- | --- |
| 无埋点第 2 组 | 依次点击括号调用、对象返回、多层括号箭头按钮 | 能正常构建；各有一次 `VIEW_CLICK`，业务计数每次增加 1，xpath 使用对应业务函数名 |
| 无埋点第 4 / 6 组 | 在字符串 `"1"` 和动态数字 `1` 输入框中填演示值并失焦；点击两种 ignore 按钮 | track 放行值；sensitive 即使带 track 也无 `VIEW_CHANGE`；ignore 无 `VIEW_CLICK`，业务处理仍执行 |
| 用户身份 | 分别运行 A→退出→A、A→退出→B | 同一 `runId` 下三条 `review_identity_step`：同账号保持 session，不同账号更新 session，退出事件不携带 userId；不额外生成 PAGE |
| 用户身份 | 运行非法编码身份场景 | 非法参数被拒绝；两条 `review_identity_encoding` 仍为 A 且 session 相同 |
| 采集开关 | 先开启采集，第 1 步暂停，等几秒后在本页执行第 2 步恢复 | `review_collection_blocked` 不入队；新 PAGE.timestamp 为恢复时刻；`review_collection_resumed` 使用新 sessionId 和当前页 path |
| 生命周期 | 断网冷启动发送离线标记，退后台恢复网络，回前台发送恢复标记 | collector 最终接收到同一 `runId` 的两条 `review_network_step`；局域网 collector 要恢复同一 Wi-Fi |
| 生命周期 | 读取屏幕信息并发送核对事件 | `review_screen_context` 的 screenWidth / screenHeight 等于逻辑尺寸 × 有效 DPR 后的物理短边 / 长边；例如 390×844、DPR=3 对应 1170×2532 |

上述控制按钮均忽略自动点击采集，避免干扰标记事件；箭头与隐私控件则保留待验收的自动采集。身份场景使用固定演示账号并改变当前身份，结束后可手动清除。所有成功提示只确认命令或入队结果，最终接收结果需查看请求或 collector。按同一 `runId` 对照 SDK Debug JSON，collector 默认仅保留脱敏统计，不保存这些原始事件字段。当前 App 事件即时进入发送调度；断网、请求槽位或失败重试可能延后发送。首次异步网络查询前 `networkState=UNKNOWN` 不等于事件丢失。

真机断网恢复场景能验证实际前后台路径；网络监听 API 缺失/抛错、迟到回调等宿主异常由受控集成测试覆盖，不在 demo 中改写宿主 API。屏幕读取失败或没有有效 DPR 时页面会明确提示无法核对，不将推测值当成通过。折叠或显示配置变化后应重新启动再核对初始化时的屏幕上下文。

开发机启动脱敏 collector：

```sh
pnpm mock:collector
```

collector 默认监听 `127.0.0.1:3100`，并只保存项目 ID、事件类型、数量、字节数、状态和拒绝原因。真机验证时用下列方式显式监听局域网网卡：

```sh
MOCK_COLLECTOR_HOST=0.0.0.0 pnpm mock:collector
```

随后在 `main.ts` 中填写开发机实际局域网 IP（不能填 `0.0.0.0`）、测试账号和数据源。初始状态由 `sdk-state.ts` 统一控制；可在运行中的“采集开关”页先关闭再开启，同时验证 `setOptions({ dataCollect })`。不得把身份或输入原文写进 demo 日志。

提交前可运行：

```sh
pnpm demo:check
```

无埋点页按真机验收顺序分为六组，包含有/无 id 的 click 与 tap、严格主目标、动态 id/metadata、无 id 列表、`v-if` / `v-show`、条件 handler、Options API、`<script setup>`、普通 `setup()` 返回别名、input/textarea 完成事件、所有已支持 change 组件、`uni-link` 与 tabBar。页面会显示业务 handler 执行次数和每项预期 xpath，便于同时确认业务没有被重复调用。此 demo 的 vite.config.ts 显式设置 `__GIO_AUTOTRACK_VERIFICATION__: true`，用于开放三端待验收的无埋点链路；它不会把生产能力表标为已验收，正式应用不要复制。密码、显式 sensitive、currentTarget/target 任一 ignore 和未放行的 autoplay 不生成自动事件。生产开放必须以逐端真机请求和 collector 接收证据为准。

函数引用及条件返回函数等不安全写法不会插桩，编译器会给出告警；当前页面的条件调用和括号箭头场景应无告警。列表动态元数据从原生 dataset 获取；动态 picker range 回退下标，不能再按显示文案验收。

无埋点覆盖补齐后的操作矩阵：

| 场景 | 入口 / 操作 | 应核对的结果 |
| --- | --- | --- |
| 动态隐私 | 第 4 组反复切换 ignore、sensitive、track，再点击 / 输入 | 隐私标记优先；关闭隐私后恢复采集；track 关闭时不读取 / 上报输入原文 |
| 禁用标记 | 第 4 组选择 false、0、"0"、"false" | 四种值都不启用 ignore / sensitive / track；点击保留，输入事件不含值 |
| 敏感类型 | 静态 password，动态 type / password 切换后失焦 | 动态类型始终保守拦截，业务照常执行，不生成自动事件 |
| 完成事件 | 独立 confirm；input / textarea 三事件控件 | 三事件只为 blur 插桩，失焦生成一条 VIEW_CHANGE；独立 confirm 正常采集，其他原业务回调保留 |
| 冒泡 | 第 1 组点击父层中的子按钮 | 父子不同 xpath 各保留一次，业务总计数增加 2 |
| 去重与切页 | 连续独立点击重复按钮，去路由页后通过导航返回再点 | 独立操作保留，页面返回后不被此前的去重记录误吞 |
| 动态列表 | 第 2 组重排、保留 key 修改首项、增删、重置后点商品 | xpath / title / index / hyperlink 都取当前值；复用节点也不串旧数据 |
| picker 文案 | 第 5 组字面量城市、对象 range、固定列 | 采集真实选中文案，与原动态 range 下标回退形成对照 |
| swiper 正反分支 | 对照两组 swiper，开启 / 关闭自动轮播并手动滑动 | 未放行 autoplay 拦截；原始 target 放行的 autoplay 采集当前下标，保留 0 |
| 文本边界 | 第 4 组填长文本 / 特殊字符 / 清空，再聚焦并失焦；取消全部多选 | 填充按钮不伪造完成事件；长文本截到 100 字符，控制字符归为空格；空值事件保留但省略 textValue |
| 采集关闭与恢复 | 采集开关页暂停后点击 / 输入，恢复后重复 | 业务计数始终增加；关闭无 VIEW；恢复后 VIEW 使用新 sessionId 和当前页 path |
| uni-link 真实组合 | 第 6 组点击链接 | navigator 内部探针和父层监听共同走真实 emit 路径，最终同一交互只发送一次 |
| 编译边界 | 第 6 组进入“预期不采集”页面 | 函数引用、计算成员、.stop、动态事件名、自定义组件 emit、input 打字均只执行业务；.stop 保留阻止冒泡的行为 |

传统 input 的[官方事件列表](https://uniapp.dcloud.net.cn/component/input.html#属性说明)明确列出 blur / confirm；当前 Android 与鸿蒙 App 输入组件不转发原生 change。SDK 按 `blur → confirm → change` 选择一个已声明的完成事件：三事件控件在 blur 时生成一条 `VIEW_CHANGE`，xpath 使用 `onCompletionBlur`，confirm 和 change 原业务回调保留。独立 change 控件仅观察兼容路径，不能将受控测试中手动触发 change 当成 App 支持证据；仅绑定 change 的业务应改用 blur / confirm。验收时使用真实失焦和键盘完成操作，不从页面代码手动派发生命周期或原生完成事件。

所有 demo 页面均要求无采集编译告警。“预期不采集”页面对边界监听显式声明 `data-growing-ignore`，保留函数引用、计算成员、修饰符、动态事件、自定义组件 emit 和 input 打字的原业务行为。编译器只对可确定启用的静态 ignore 跳过采集边界诊断；ignore 为 false / 0、动态表达式或可能被 v-bind 覆盖时仍保留诊断，语法错误和缺失 handler 也仍会报告。自定义组件内部按钮同样明确 ignore，不会把内部事件混入父组件 emit 的边界验证。

受控集成测试直接编译并挂载这些真实页面和子组件，执行按钮 listener，再经公共 gdp、生产 dispatcher 和协议到模拟 request 接收端。uni-link 使用真实组件组合，不再作为原生标签或空组件替身；测试验证两个探针只产生一条 VIEW_CLICK。它们仍不替代 Android / iOS / HarmonyOS 设备上的原生事件、冒泡、键盘行为和最终 collector 接收验证。

## 鸿蒙实机与自动化

2026-10-19 的实机记录见[鸿蒙验证报告](../doc/harmony-device-validation-2026-10-19.md)。SDK 的 App 运行时不得包含 Unicode 属性正则字面量；当前鸿蒙 JSVM 无法编译该语法，会使整个 demo 白屏。采集地址的 Unicode 扩展能力现已改为按需检测，ASCII 域名和 IP 不依赖该能力。

禁用标记 picker 在本轮设备上出现确认回调缺少下标的情况。demo 会保留原选择，并提供“切换到下一种禁用标记”按钮，实际遍历 false、0、"0"、"false"。边界页的动态事件使用原生 click；动态 tap 在本轮传统 App 宿主没有触发业务回调。

已安装 HBuilderX 官方自动化测试插件及其依赖后，可执行：

```sh
/Applications/HBuilderX.app/Contents/MacOS/cli uniapp.test app-harmony --project /absolute/path/to/demo --testcaseFile pages/index/harmony-smoke.test.js
```

测试配置使用 CommonJS，demo 的 `package.json` 为自动生成的配置提供独立模块作用域。插件生成的 `env.js` 包含本机工具路径和设备信息，已排除提交。USB 测试连接可将其中的 `UNI_TEST_CUSTOM_ENV` 配置为 `UNI_AUTOMATOR_HOST: "127.0.0.1"`、`UNI_AUTOMATOR_PORT: "9520"`，并运行 `hdc rport tcp:9520 tcp:9520`。原生点击、键盘和最终收数仍需按报告中的矩阵核对；冒烟用例不替代完整实机验收。


## 安卓真机与自动化

2026-10-19 的小米 MI 6 / Android 9 验证见[安卓真机报告](../doc/android-device-validation-2026-10-19.md)，涵盖公共逻辑、原生无埋点交互、上传错误、真实断网、会话超时和进程重启。当前宿主未触发 input/textarea 的原生 change；独立 blur / confirm 已通过。安卓 picker 本轮能正常返回确认下标。

先构建 SDK，并在 `main.ts` 设置测试 collector 地址；使用本机 collector 时可通过 USB 连接。默认 mock collector 端口为 3100：

```sh
adb reverse tcp:3100 tcp:3100
```

本轮为隔离此前鸿蒙证据使用 3103，手机保留的验证产物连接 `http://127.0.0.1:3103`。源码中的临时地址已撤回；实际端口需与运行中的测试 collector 及 USB 映射一致。

官方插件的启动冒烟入口：

```sh
/Applications/HBuilderX.app/Contents/MacOS/cli uniapp.test app-android --project /absolute/path/to/demo --device_id YOUR_DEVICE_ID --testcaseFile pages/index/android-smoke.test.js
```

用例文件放在页面同级，验证首页六个入口及真实无埋点页的业务回调。完整真机验收另使用 ADB 原生点击、键盘、滑动、Home、网络切换和进程操作，并核对原始请求及 collector 接收；两项启动冒烟不替代完整矩阵。设备与路径配置继续保存在不提交的 `env.js` 中。生产无埋点能力表未因本轮验证自动开放。
