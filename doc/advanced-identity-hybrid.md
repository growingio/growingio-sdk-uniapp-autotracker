# 高级身份、H5 与原生扩展

2026-10-27。当前实现范围为 JS SDK、类型、自动化及交付编译验证。Android / iOS 宿主 module 按本文与 [uniMP v1 契约](./unimp-native-bridge-contract.md) 后续实现、联调；真机、原生队列和 Collector 验收仍后补。

| 能力 | App / 八端小程序 | Native 托管 uniMP |
| --- | --- | --- |
| `forceLogin` + `identify` | 支持，默认关闭 | 不提供，设备身份由宿主管理 |
| 旧独立小程序身份迁移 | 仅八端小程序，显式开启 | 不读取旧存储 |
| `getGioInfo` 给内嵌 H5 | 当前身份查询串 | 返回 null，v1 不返回宿主身份 |
| 原生标识增强 | App 可选插件；小程序拒绝 | 由宿主 SDK 管理 |
| 原生事件 / 身份桥接 | 默认沿用现有本地采集 | 显式 `runtime: 'unimp'` 开启 |

## 分配设备身份

```ts
gdp('init', 'account-id', 'data-source-id', {
  uniVue: app,
  appId: '平台真实 appId', // 小程序必填；App 不消费这个字段
  forceLogin: true,
})

// 身份取得前，生命周期和业务事件按现有限额保留在内存，暂停上传。
gdp('track', 'before_identity', { source: 'example' })
gdp('identify', 'business-device-id')
```

`identify` 分配的是 deviceId；登录用户继续使用 `setUserId` / `clearUserId`。它接受非空字符串或正有限数字，字符串最多 1000 个 Unicode 码点，拒绝未配对代理项及 `-` / `null` / `undefined` 占位值。不会截断身份。每次 JS 运行期只接纳一次成功分配，初始化期间也拒绝重复分配；未启用 `forceLogin` 时返回 false。

分配时只替换本次暂存事件的 deviceId，事件之间原有的用户身份顺序保持不变。App 冷启动恢复的历史队列保留历史身份；等待分配期间不把本次匿名暂存事件写入 App 队列存储。分配后才恢复持久化与上传。如果更长的 ID 会使队列超限，操作返回 false，原队列不变，可更正 ID 后重试。小程序继续使用内存队列。进程在分配前结束，本次暂存事件不会恢复。

身份持久记录增加可选的 `deviceIdAssigned` 内部标记，防止显式身份被早期 App 预览 ID 修复规则替换。默认 App 存储键、编码、会话策略、上传与无埋点能力门控保持现状。

## 从独立小程序 SDK 迁移

```ts
gdp('init', 'account-id', 'data-source-id', {
  uniVue: app,
  appId: 'wx-real-app-id',
  idMapping: true,
  legacyMiniProgramIdentity: {
    appId: 'wx-real-app-id',
    accountId: 'account-id',
    dataSourceId: 'data-source-id',
    // storagePrefix: 'subTrackingId', // 独立 SDK 子实例填写 trackingId，主实例省略
    // plugin: true,                  // 仅旧 SDK 插件命名空间使用
  },
})
```

来源的 appId / accountId / dataSourceId 必须与本次初始化完全一致。旧独立 SDK 的设备键本身未记录项目归属，这份配置是接入方对来源归属的明确确认；SDK 不推断跨项目关系。迁移配置非法、来源不匹配或在 App 中传入时，按默认关闭迁移处理，不阻断 SDK 初始化，也不读取旧身份键。

只有当前 SDK 的身份键缺失时才读取 `_growing_uid_`、`_growing_userId_`、`_growing_userKey_`；插件模式使用 `_growing_plugin_*`，子实例前缀仅作用于用户字段。支持旧 `{ value, expiredAt }` 信封，过期或损坏值不迁入。userKey 仅在 `idMapping` 开启且有 userId 时迁移。

迁入后写入当前平台 / appId / 项目 / 数据源命名空间。已有当前身份优先；当前身份损坏时按现有恢复规则生成新身份，不重新拾取旧账号。旧键始终只读，不导入旧 session、序号或事件队列。不开启此项时不读取旧键。迁移上线时应停用旧 SDK，避免同时采集。

## 内嵌 H5

```ts
// 页面显示并建立会话后调用；下面的基础地址不含已有 gio* 参数。
const info = gdp('getGioInfo')
if (info !== null) {
  webViewSrc.value = `https://h5.example.com/page?${info}`
}
```

返回字段与 Web SDK `gioEmbeddedAdapter` 对齐：`gioappid`、`gioprojectid`、`giodatasourceid`、`gioplatform`、`gios`、`giou`、`giocs1`、`gionewdevice`、`giodatacollect`，以及启用 idMapping 时的 `giouserkey`。值已按 URI 查询参数编码。`gionewdevice` 仅表示本地新建身份的首个会话，恢复或迁入身份不标为新设备。

未就绪、缺少真实宿主 appId、开启采集但没有会话或仍等待 identify 时返回 null。停采时返回 `gioappid`、`gioprojectid`、`giodatasourceid` 和 `giodatacollect=false`，用于让 Web 接收端选择正确的宿主配置；不包含设备、用户或 session 身份。单独的 false 标记会被既有 Web 接收端忽略，不能替代完整的停采路由信息。查询不会生成会话或事件。已有 URL 应合并 query、保留 fragment，并替换旧 `gio*` 字段；不要把新的停采标记追加在仍含旧身份的 URL 后。返回 null 时不要复用旧身份串创建页面；宿主 App 需要提供可用包名 / Bundle ID，不能伪造 appId。仅把身份串用于业务信任的 H5 页面，H5 端需接入对应 Web 适配插件。

该接口提供创建 / 更新 H5 地址时的身份快照。登录、退出或同意状态变化后，接入方应刷新快照并更新页面；没有后台向 H5 推送身份变化的通道。它不安装浏览器原生桥，也不把 `web-view @message` 当作实时原生应答。

## App 原生标识增强

```ts
gdp('registerPlugins', [{
  name: 'gioNativeIdentifiers',
  options: { fields: ['oaid', 'googleAdvertisingId', 'androidId'] },
}])
```

插件必须显式列出字段。iOS 只读取 `idfa` / `idfv`；Android 只读取 `oaid` / `googleAdvertisingId` / `androidId` / `imei`；HarmonyOS 不读取这些字段。小程序及 uniMP 托管模式拒绝此插件。

JS 仅在已同意采集后延迟加载 `uni.requireNativePlugin('GrowingIOUniAppEnhance')`，请求接口为：

```ts
getIdentifiers(
  { version: 1, fields: ['oaid', 'androidId'] },
  reply => { /* { version: 1, identifiers: { oaid: '...', androidId: '...' } } */ },
)
```

宿主只返回已有授权可安全取得的值，不主动申请权限。JS 等待上限为 1 秒；module 缺失、异常、超时、重复回调、未知字段及空 / 全零 / 占位标识均安全省略。默认不加载 module，不等待它完成首个 VISIT / PAGE。结果仅补充后续 **VISIT**，不修改已有事件、deviceId 或 session；其他事件不携带这些字段。停采立即清内存标识并使旧回调失效，恢复后重新读取。

本仓库此次只交付 JS 端口；原生 module 的权限、字段获取和设备可用性仍需两端实现并验收。

## Native 托管 uniMP

```ts
gdp('registerPlugins', [
  { name: 'gioEventAutoTracking' },
  {
    name: 'gioHybridAdapter',
    options: {
      transport: 'native-module',
      penetrateHybrid: true,
      onReady: ({ collecting, identityBlocked, canWriteIdentity }) => {
        // 握手成功；身份阻断时，由业务重新确认后调用 setUserId 或 clearUserId。
      },
      onError: ({ code, method, outcome }) => {
        // outcome 区分未发送、明确拒绝与结果未知；不要据此盲目重投事件。
      },
    },
  },
])
gdp('init', 'host-account-id', 'host-data-source-id', {
  uniVue: app,
  runtime: 'unimp',
  appId: '宿主允许的真实客体 appId',
  idMapping: true,
})
```

JS 使用 `GrowingIOUniMPBridge.invoke(request, callback)`，具体字段与响应规则见 [v1 契约](./unimp-native-bridge-contract.md)。初始化不会探测 App 存储、系统、网络或建立本地设备身份；首次真实 App 前台才握手。模块缺失通过异步 onError 报告，不回退 HTTP。普通 Vue 子组件的 onShow 不当作 App 前台。

托管模式拒绝非 undefined 的 serverUrl / sessionExpires / appChannel / appVersion / keepAlive / uploadInterval / forceLogin / legacyMiniProgramIdentity。不能与原生标识插件混用。未选择 unimp 时，不能注册 Native Hybrid 插件。`penetrateHybrid` 默认 true，仍需 Native 授予 identityWrite；关闭时身份和用户属性调用返回 false，普通事件继续使用宿主身份。

Native 独占 deviceId、userId、session、序号、domain、队列及上传，JS 不生成 VISIT / APP_CLOSED。业务与身份操作共用一个 FIFO，一次只交付一条；最多 50 条 / 256 KiB，包含在途项。握手最多 5 秒 / 5 次，待发项最多 5 秒，在途应答最多 1 秒，超时由定时调度而非墙上时间差决定。

操作已交付后不自动重投。身份失败、结果未知、容量不足或后续丢弃会保留 identityBlocked；重新握手也不解除。业务需显式重设已确认的身份并得到 Native ok，之后才恢复 PAGE 与事件。事件只能依赖本连接已接纳的 PAGE；PAGE 失败后，在读取后续属性或输入前拒绝，直到新的页面显示或明确恢复。

Native 明确撤销 identityWrite 后，尚未交付的身份和用户属性不会继续发送；若队列中有身份意图，同步阻断并结束本轮，避免错误回调重入时接纳后续行为。只有用户属性被拒绝时，普通事件仍按原顺序处理。页面元信息在补齐自动来源后写回有界快照，未显示和隐藏页同样受 16 KiB 限制；标题在框架缓存前受 8 KiB 限制，Native 入口仅保留有界明确来源，不缓存无用启动 query。

`init` / `track` / 身份命令返回 true 仅表示 JS 接纳。`onReady` 是握手完成通知；`accepted` 表示原生受控接纳，均不代表 Collector 收数。生产无埋点能力门控继续保持未验收状态，验证构建可测试链路。

## 验证与后续

`pnpm run release:prepare` 包含类型、全量测试、逐文件覆盖率、SDK 构建、两渠道解包运行、编译消费者和八端构建。发布包消费者分别验证默认 App、高级身份 / 原生标识和 uniMP JS 桥接；八端消费者分别验证默认和迁移 / identify 流程。

自动化宿主可分开执行原生副作用与交付回调，覆盖身份结果未知、代次隔离、丢包、迟到 / 重复 / 非法回复、队列与 UTF-8 预算、停采、后台、页面关联及清理。它证明 JS 按契约工作，不证明真实 Android / iOS SDK、容器多进程、域归属或 Collector 已完成打通。

多实例、原生宿主 module、uni-app x、H5 实时推送、宿主身份快照、事件 exactly-once 和生产无埋点真机验收不随本次 JS 实现交付。
