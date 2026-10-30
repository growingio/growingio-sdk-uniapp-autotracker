# uniMP Native 打通设计自审

> 后续状态：2026-10-27 已完成 [JS SDK 实现](./advanced-identity-hybrid.md) 与自动化。下文保留 2026-09-11 的设计审查记录，原生 module / 真机结论仍待验证。

> 2026-09-11。审查对象为 [总体设计](./unimp-native-hybrid-design.md) 和 [module 详细契约](./unimp-native-bridge-contract.md)。本轮只修改设计文档，未实现 SDK 或原生 module，未运行 SDK / 设备测试。

## 1. 审查结论

方案可以作为 JS 与 Native 分别开发的契约提案。应保留“Native 统一数据所有权、JS 采集客体页面行为、单一路由”的主体，补齐连接失效、身份阻断和页面依赖三条故障处理链。

上一版存在会导致旧身份生效、错误恢复采集、页面行为失联及发布漏文件的缺口。本轮已在文档中修正，具体见下表；“文档已修正”不等于真实原生已经满足。Android / iOS module 仍按约定能力存在的前提供 JS 开发，真机与服务端验证放在原生完成后。

## 2. 发现的问题与已做的修正

优先级含义：P1 会影响数据正确性、隐私或打通成立；P2 会影响可实现性、诊断或发布。这里只给有具体触发条件的问题，不把未发生的假想风险无限扩张为新系统。

| 编号 | 级别 | 旧设计的触发与问题 | 当前文档修正 | 定位 / 后续验证 |
|---|---|---|---|---|
| R01 | P1 | 身份请求超时后重新握手，只忽略旧 JS 回调；旧 Native 请求仍可能迟到并修改新登录态 | generation + Native connectionId 绑定真实来源，执行前校验；新 hello 不允许旧代次回退 | 契约 3.3–3.4；T05 / T10 |
| R02 | P1 | 登录 A 失败后“重新握手恢复采集”，Native 仍可能是匿名或 B | 保留 identityBlocked；连接恢复仍停采，业务明确设置 / 清身份且 ok 后解锁 | 契约 7；T08 / T09 |
| R03 | P1 | A 在途、B 容量不足，A 的迟到成功可能被当作整体身份恢复 | 合法身份意图入队失败也结束本地代次并阻断；旧 ok 不再有解锁资格 | 契约 6.1 / 7；T11 |
| R04 | P1 | PAGE 被拒绝、过期或丢弃，后续 VIEW / CUSTOM 继续发送，关联不存在或沿用上一页 | 内部 pageViewId 与 pending / accepted / unavailable；PAGE 接纳前不交付依赖，失败后不降成无页面事件 | 契约 6.2；T12 / T13 |
| R05 | P1 | 停采前 onShow 的 shownAt 被恢复 PAGE 继续使用，行为又关联旧时间；同毫秒去重会误合并两次显示 | reportedPageTimestamp 独立于 shownAt；恢复用新观察时间；视图标识用计数而非墙上时钟 | 契约 4 / 6.2；T03 / T14 / T15 / T22 |
| R06 | P1 | 把 Native void 方法或通道 success 当入队成功，原生可能尚未校验或构建 | accepted 必须在受控接纳后；可确认未执行才 rejected，不能确认则 unknown；上传结果另行验证 | 契约 1 / 4.2 / 9；T29 / T35 |
| R07 | P1 | 假设宿主停采可瞬时阻止 JS 所有 getter，忽略异步状态传播 | 明确本地和已知宿主停采的取值门禁；Native 再验总开关；承认获知前短暂滞后，不输出全量报文 | 契约 5 / 6.3 / 8.3；T15 / T16 |
| R08 | P2 | containerState 控制消息绕过事件队列，可能先把容器标隐藏，使合法早发事件被拒；两边维护状态也容易冲突 | 移除该 RPC；原生独占容器聚合，JS App 生命周期只关本地门禁，关闭来源由原生失效 | 总体 5.4；契约 3.4 / 5；T18 / T25 / T27 |
| R09 | P2 | 有 hello / dispatch 方法名但缺少精确关联字段、成功种类、非法应答和超时范围 | 补完整信封、方法白名单、ok / accepted / rejected / unknown、UTF-8 限额、错误分类、有限重连及样例 | 契约 3 / 8 / 9 / 10.1；T19–T21 |
| R10 | P2 | gdp true 只表示排队，只有 debug 时能看到异步失败；握手后身份仍阻断又没有恢复通知 | 可选 onError；onReady 明确报告 collecting / identityBlocked / canWriteIdentity，阻断时也通知 | 契约 8.3；T04 / T09 / T33 |
| R11 | P2 | 新建另一个 runtime 类却继续把它当 GioPluginRuntime；复用 App 平台预检查又强制依赖 storage/request | 保留 TrackerRuntime 门面和插件类型，内部委派；按模式装配依赖，列出现有方法在 unimp 的语义 | 总体 11.1；T01 / T32 |
| R12 | P2 | 原计划放到顶层 hybrid 目录，当前发布白名单与构建 include 不收录 | 拟议模块随当前目录组织归入 src/core/dataStore、src/plugins/gioHybridAdapter 和 src/platform；两渠道检查入口、类型、sourceHash | 总体 11.2；T31 |
| R13 | P2 | “销毁取消监听”没有区分页卸载、mixin 不可卸载及进程死亡 | Page.onUnload 只释放页；内部 dispose 使自有回调失效；原生独立清容器；只移除自有可移除监听 | 总体 11.1；契约 5 / 8.2；T27 / T34 |
| R14 | P2 | 使用 Date.now 计算 TTL 时回拨延长缓存；要求 performance.now 又未证实 uniMP 一定可用 | 期限由可替换定时调度器和到期标记控制，事件时间另用墙上时钟；明确主线程冻结不是硬实时保证 | 契约 5.1；T19 / T22 |
| R15 | P2 | 页面卸载后删掉所有关联状态，已排队 PAGE 的晚到应答可能找不到记录或误改新页面 | 页面交付记录与 PageStore 生命周期分离，按有界队列引用保留，应答按 pageViewId 更新 | 契约 6.2；T13 / T34 |
| R16 | P1 | App 回前台时先为旧 current page 补 PAGE，随后的 Page.onShow 又产生一条 | foregroundEpoch 隔离上轮可见状态；等待本轮 Page.onShow，握手与页面先后两种次序均只安排一条 | 契约 5 / 6.2；T36 |

上述问题均有最终规则和后续用例对应；没有把“重新握手”当作对所有错误都有效的万能恢复动作。

## 3. 三条链路的桌面推演

### 3.1 身份结果未知

客体先发 setUserId(A)，Native 已经生效但应答丢失。JS 超时后不重投，丢弃后面的 E1，置 identityBlocked。下一次前台 hello 成功也不发送 PAGE / 业务事件，onReady 报阻断。业务确认当前账号 B 后发新 setUserId(B)，Native ok 后才建立当前 PAGE 和接纳新的 E2。旧 A 的回调无效；若旧 A 尚未执行，新代次使其在原生执行前失败。

此推演能避免 JS 自动重放旧账号的积压事件，但不能消除其他原生页面恰好在事件被接纳前切换账号的情况。方案明确定义按 Native 接纳时身份归属，未承诺捕获时历史身份。

### 3.2 恢复采集与 PAGE 失败

页面在停采时显示，恢复许可后 hello 成功，以恢复时刻建立 PAGE。点击可排在 pending PAGE 后；若 PAGE 被原生拒绝，点击随依赖结束，下一次点击在读取 value 前拒绝。下次真实页面显示或显式关闭再恢复，才建立新观察 PAGE。没有回填停采阶段 PAGE，也没有去掉页面字段来偷渡点击。

### 3.3 后台与多容器

页面事件已调用 module 后发生 App.onHide：JS 清未发项，停止采集；已交付事件可能仍被原生接纳。Native 依真实容器可见性聚合宿主生命周期，不因收到旧事件重新标前台。容器关闭后连接失效；同 appId 重开得到新来源生命期，旧回复不能影响新实例。两个不同客体只共享宿主身份 / session / 队列，不共享 JS 页面状态。

这些是按文档规则推演的结果，不是运行日志或真机证据。

## 4. 保留、简化与本期不建设

| 判断 | 内容 | 原因 |
|---|---|---|
| 保留 | 独立 unimp 运行模式、纯事件草稿、Native 所有权 | 当前 App composer 会创建本地身份 / session，仅更换 TransportPort 无法满足需求 |
| 保留 | 单 FIFO、受限内存、结果未知停止、身份阻断 | 都有真实故障触发，直接决定重复 / 错归属风险 |
| 保留 | 来源 + 代次 + connectionId、PAGE 关联 | 处理晚到操作和孤立行为的最小关联状态，不是通用账户或消息系统 |
| 简化 | 四个 method、协议版本统一硬约束 | 不做任意 RPC 反射、几十个可选能力开关或全部身份字段同步 |
| 简化 | 原生管理容器、JS 管本地生命周期 | 去掉双向 containerState、常驻轮询和第二套访问状态机 |
| 简化 | 一个内部 HostPort 与现有目录 | 给 uni-app x 留替换入口，不提前建立空实现、UTS 包或新框架层 |
| 本期不建 | JS HTTP 降级、持久化重发、全局 exactly-once | 会引入第二数据源 / 身份与可靠消息系统，超出这次托管语义 |
| 本期不建 | 微信等 mp-* profile、ABTest、圈选、getGioInfo、定位写入 | 各有独立平台或权限语义，均非原生 uniMP 打通前置条件 |

## 5. 仍需原生完成后验证的事实

以下不阻塞 JS 按契约开发，也没有要求本次实现原生 module；但它们决定何时可以对外声明真实打通。

| 待验证事实 | 当前明确的默认设计 | 所需证据与责任 |
|---|---|---|
| module 名称、签名、真实来源 / 执行进程 | JS 面向 invoke(request, callback)，平台适配器映射实际注册名 | Android / iOS 各一次真实 wgt 请求与串行执行记录 |
| 宿主会话与容器生命周期 | Native 聚合原生页和 uniMP；客体不产 VISIT / APP_CLOSED | 多进程、预加载、全屏切换、桌面与关闭路径的真机事件 |
| 两端 builder 与序列化保留字段 | 全部草稿时间、guest domain 均保留，身份在 Native 固定 | 原生队列、JSON / Protobuf、Collector 对照，不能只看 HTTP 成功 |
| domain=appId、platform=原生 OS | 沿 Hybrid 宿主数据源，客体通过 domain 区分 | 服务端归档、页面统计、两个客体同路径查询结果；该组合仍是协议扩展提案 |
| Native 身份 / session 更新时的页面关联 | 不让 JS 猜测宿主新 session；保持当前页面观察时间 | T07 / T29 核验服务端是否接受跨原生会话的页面观察关联；若要求新会话 PAGE，先补明确通知 / 补页契约 |
| 原生自动采集壳层重复 | 仅排除 uniMP 壳 / 渲染视图重复采集，保留其他原生页 | 原生与客体事件对照，不提前标记两端 autoClick / autoChange 支持 |
| 定时器与生命周期顺序、默认限额 | 1 秒应答、5 秒握手 / 待发、50 条 / 256 KiB | 真实 JS 线程阻塞、后台冻结与桥接延迟测试；需要调整时两端 fixture 同步 |
| uni-app x 宿主 | 只预留 transport 和宿主接收 adapter 边界 | 后续单独核对 Host API / 插件兼容性，不计入本期完成度 |

如果后续原生只提供“把 JSON 丢给旧 Hybrid void 方法”而无上述结果和字段保障，应记录为原生契约未满足，不将 JS 适配成永远成功来掩盖缺口。

## 6. 本轮核对依据与实际交付边界

本轮直接核对当前仓库 `index.ts` 的单例和插件类型、`src/constants/config.ts` 的 App 配置、`src/core/lifecycle.ts` 的启动重放、`src/core/dataStore/page.ts` / `src/core/dataStore/page.ts` 的显示时间、`src/adapters/uniapp.ts` 的安装方式、`src/core/userStore.ts` 与 `src/core/dataStore/protocol.ts` 的值规范化、`src/plugins/gioEventAutoTracking/index.ts` 的文本与敏感规则，以及发布目录规则。兄弟 SDK 证据和官方链接汇总在总体设计第 2 / 3 节与详细契约第 12 节。

交付物是三份互相链接的设计文档及现有文档入口。验证仅包括设计推演、源码对照、Markdown 链接 / 示例 / 格式检查；36 条测试向量是后续实现的验收清单，不能记录为 36 条已通过测试。现有 `demo/manifest.json` 修改与本需求无关，保持原状。
