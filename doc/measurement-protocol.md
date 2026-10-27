# GrowingIO Measurement Protocol（全端）

> 覆盖 **Web / 小程序(MinP) / App(iOS · Android · HarmonyOS)** 的事件上报协议。本文中的 App 列同时覆盖 Android、iOS 和 HarmonyOS；平台专属字段以实际端能力为准。
> 上报方式：`POST` 到 collect 接口，Body 为事件对象数组。每个事件 = 公共字段（context）+ 事件专有字段。
>
> **传统 uni-app 1.0 请求契约：**`serverUrl` 是基础地址，未传时为 `https://napi.growingio.com`，不能传入既有接口路径或 query。每批请求为 `POST {serverUrl}/v3/projects/{accountId}/collect?stm={sendAt}&compress=0`；`sendAt` 是该批实际开始发送时的 Unix 毫秒时间。请求头固定为 `Content-Type: application/json` 与 `Accept: application/json`，Body 是已完成字段清理的 JSON 事件数组。Web / 小程序后续 profile 可以替换请求适配器，但不得让宿主差异渗入 event core。
>
> **传统 uni-app 1.0 范围：**本协议是全端目标协议，不等于一期必须实现所有可选字段。传统 uni-app 一期只发送其开发文档明确列入一期的字段；`idfa`、`idfv`、`oaid`、`googleAdvertisingId`、`androidId`、`imei` 和 `urlScheme` 等原生增强字段属于二期。下文 App 报文仅说明字段格式，不代表一期一定带上全部选填字段。

## 1. 事件类型与适用端

| 事件类型 | 含义 | 发送时机 | Web | 小程序 | App |
|---|---|---|:--:|:--:|:--:|
| `VISIT` | 访问事件 | 产生一个新的访问时 | ✅ | ✅ | ✅ |
| `PAGE` | 页面浏览事件 | 打开一个页面时 | ✅ | ✅ | ✅ |
| `CUSTOM` | 自定义事件 | 主动调用 track 接口 | ✅ | ✅ | ✅ |
| `LOGIN_USER_ATTRIBUTES` | 登录用户属性事件 | 调用 setUserAttributes | ✅ | ✅ | ✅ |
| `APP_CLOSED` | 关闭事件 | App 或小程序进入后台时尽力发送 | — | ✅ | ✅ |
| `VIEW_CLICK` | 元素点击事件 | 点击页面元素时 | ✅ | ✅ | ✅ |
| `VIEW_CHANGE` | 输入元素改变事件 | 输入元素内容改变时 | ✅ | ✅ | ✅ |

---

## 2. 公共字段（context）

所有事件都携带。`●` 必填　`○` 选填　`—` 该端不携带。

| 字段 | 类型 | Web | 小程序 | App | 说明 |
|---|---|:--:|:--:|:--:|---|
| `deviceId` | string | ● | ● | ● | 设备 ID（访问用户 ID） |
| `userId` | string | ○ | ○ | ○ | 登录用户 ID |
| `userKey` | string | ○ | ○ | ○ | 登录用户 ID 类型：`phone` / `email` / … |
| `sessionId` | string | ● | ● | ● | 访问会话 ID |
| `dataSourceId` | string | ● | ● | ● | 数据源 ID |
| `eventType` | string | ● | ● | ● | 事件类型（见上表枚举） |
| `platform` | string | ● | ● | ● | Web：`web`；小程序：`MinP`；App 固定映射为 `iOS` / `Android` / `HarmonyOS`，不透传宿主原始字符串；无法确认时初始化失败。 |
| `platformVersion` | string | — | ● | ● | 小程序：宿主（微信等）版本；App：操作系统版本，正常时读取并保留真实格式；读取失败、空白或异常时写 `UNKNOWN` 并记录诊断，不阻塞采集。 |
| `timestamp` | long | ● | ● | ● | 事件创建时的设备当前系统时间，单位毫秒。与 Android/iOS/HarmonyOS 独立 SDK 一致，不因系统时钟回拨而修正或伪造递增值；事件顺序以 `eventSequenceId` 为准 |
| `domain` | string | ● | ● | ● | Web：网页域名；小程序：appId；App：自动读取包标识（iOS BundleID / Android 包名 / HarmonyOS Bundle Name），不可由业务覆盖；读取失败时内部值为空字符串并记录诊断，出站清理时省略该字段，不阻断采集；Hybrid 为 H5 域名 |
| `urlScheme` | string | — | — | ○ | App 链接协议（如 `growing.xxx`）。一期基础 SDK 不读取、存储或上报；以后仅由 Deep Link／圈选等经批准产品插件的专属配置和协议扩展使用 |
| `appState` | string | — | — | ● | 应用前后台：`FOREGROUND` / `BACKGROUND`。`APP_CLOSED` 当前统一采用 `BACKGROUND`，见 3.5 节 |
| `appName` | string | — | — | ● | 自动读取应用名称；不可由业务覆盖，读取失败时内部值为空字符串并记录诊断，出站清理时省略该字段 |
| `path` | string | ● | ● | ○ | 页面路径。App 在存在当前页面上下文时携带 |
| `query` | string | ○ | ○ | ○ | 页面查询参数。App 的普通页面取 `onLoad` 快照；`VISIT` 取 `App.onShow` 的入口参数；Hybrid 取 H5 url query |
| `title` | string | ○ | ○ | ○ | 页面标题（App 仅 `PAGE`） |
| `referralPage` | string | ○ | ○ | ○ | 来源页面。Web 所有事件携带；小程序 / App 仅 `PAGE` 携带 |
| `networkState` | string | — | ● | ● | 网络类型：`2G`/`3G`/`4G`/`5G`/`WIFI`/`UNKNOWN`。App 将宿主小写值规范化为大写；`none`、`unknown`、泛化 `cellular`、超时或错误统一为 `UNKNOWN`，不猜测网络代际。 |
| `appChannel` | string | — | ● | ○ | 小程序：场景值（`scn:xxx`）；App 三端统一使用 init 的非空 `appChannel`，不读取平台专属系统渠道。未传或空白时由出站清理省略。 |
| `screenWidth` | int | ● | ● | ● | 屏幕宽度。小程序为物理像素；App 为设备物理像素的短边，即 `min(rawWidth, rawHeight)`，不随横竖屏交换；两级读取均失败时写 `0` 并记录诊断。 |
| `screenHeight` | int | ● | ● | ● | 屏幕高度。小程序为物理像素；App 为设备物理像素的长边，即 `max(rawWidth, rawHeight)`，不随横竖屏交换；两级读取均失败时写 `0` 并记录诊断。 |
| `deviceBrand` | string | — | ● | ● | 设备品牌。App 保留系统原值；空、异常或不可用时写 `UNKNOWN` 并记录诊断。 |
| `deviceModel` | string | — | ● | ● | 设备型号。App 保留系统原值；空、异常或不可用时写 `UNKNOWN` 并记录诊断。 |
| `deviceType` | string | — | ● | ● | 设备类型。小程序：`Weixin-Android`/…；App 统一为 `PHONE` / `PAD` / `FOLD` / `UNKNOWN`：iOS `iPhone` / `iPad` 分别映射为 `PHONE` / `PAD`，Android 保留同名枚举，HarmonyOS 按系统类型映射；无法可靠识别时写 `UNKNOWN` 并记录诊断。 |
| `operatingSystem` | string | — | ● | — | 同 `deviceType`（仅小程序保留，冗余字段） |
| `appVersion` | string | ○ | ● | ● | 应用版本。App 优先读取安装包版本；读取失败才使用 init 的非空 fallback 配置；两者皆无时内部值为空字符串并记录诊断，出站清理时省略该字段，不阻断采集。 |
| `language` | string | ● | ● | ● | 语言标签。App 统一为规范化 BCP 47：将 `_` 转为 `-` 并规范大小写（如 `zh_CN` → `zh-CN`、`zh-hans` → `zh-Hans`）；原值只有 `zh` 时保留 `zh`，不补造地区或文字。App 读取失败或格式异常时写 `und` 并记录诊断。Web、小程序保持各自既有报文格式。 |
| `timezoneOffset` | string | ● | ● | ● | 时区偏移（分钟），采用 `Date.getTimezoneOffset()` 口径：本地时间转换为 UTC 需增加的分钟数（如中国为 `"-480"`）。App 每条新事件读取；异常时写 `"0"` 并记录诊断。 |
| `latitude` | double | — | ○ | ○ | 纬度（调用 setLocation 后；Web 不支持） |
| `longitude` | double | — | ○ | ○ | 经度（调用 setLocation 后；Web 不支持） |
| `sdkVersion` | string | ● | ● | ● | SDK 版本号 |

App 事件先按字段表构建内部快照，再在进入队列、持久化和发送前经过同一份出站清理：移除 `null`、`undefined`、空字符串、空对象和空数组；保留数值 `0`（包括 `screenWidth`、`screenHeight`、经纬度与时区 `"0"`）。这与 Web / 小程序 `eventConverter` 的“空值不进入请求、`0` 保留”路径一致。`attributes` 中的布尔值在属性归一化阶段已转成字符串（如 `"false"`），不是空值，不能清掉。清理后的对象才是最终 wire event；因此表中的必填标记表示正常可用时必须构建，不要求为读取失败的系统字段伪造值。

---

## 3. 各事件专有字段

在公共字段之上叠加。`●` 必填　`○` 选填　`—` 不携带。

### `eventSequenceId` 通用规则

SDK 维护一份持久化的全局计数器：`VISIT`、`PAGE`、`CUSTOM`、`VIEW_CLICK`、`VIEW_CHANGE` 在事件创建时各取下一个正整数，冷启动后继续递增，不按 session 重置。其他事件不分配该编号，字段省略。该规则三端一致。

### 3.1 VISIT（访问事件）

| 字段 | 类型 | Web | 小程序 | App | 说明 |
|---|---|:--:|:--:|:--:|---|
| `eventSequenceId` | long | ● | ● | ● | 事件请求编号 |
| `idfa` | string | — | — | ○ | iOS 广告标识符 |
| `idfv` | string | — | — | ○ | iOS 应用开发商标识符 |
| `oaid` | string | — | — | ○ | Android 广告 ID（国内） |
| `googleAdvertisingId` | string | — | — | ○ | Android Google 广告 ID |
| `androidId` | string | — | — | ○ | Android ID |
| `imei` | string | — | — | ○ | Android IMEI |

### 3.2 PAGE（页面浏览事件）

| 字段 | 类型 | Web | 小程序 | App | 说明 |
|---|---|:--:|:--:|:--:|---|
| `eventSequenceId` | long | ● | ● | ● | 事件请求编号 |
| `orientation` | string | — | — | ● | 屏幕方向：`PORTRAIT` / `LANDSCAPE` |
| `protocolType` | string | ○ | — | ○ | 页面 url 协议头（如 `https`）；App 为 Hybrid 页面 |

> Web 端：同站不同页可能集成不同 SDK，`PAGE` 会再次携带 `sdkVersion` / `appVersion`。

### 3.3 CUSTOM（自定义事件）

| 字段 | 类型 | Web | 小程序 | App | 说明 |
|---|---|:--:|:--:|:--:|---|
| `eventSequenceId` | long | ● | ● | ● | 事件请求编号 |
| `eventName` | string | ● | ● | ● | 自定义事件名称 |
| `attributes` | Map<string,string> | ○ | ○ | ○ | 自定义事件属性 |

`eventName` 的全端写入规则为 `^[A-Za-z_][A-Za-z0-9_]{0,99}$`：首字符只能是英文字母或下划线，其余只能是英文字母、数字或下划线，且总长度不超过 100 字符。SDK 不自动转换或截断非法名称；空白、中文、空格、连字符、数字开头和超长名称均整条拒绝并记录脱敏诊断。

### 3.4 LOGIN_USER_ATTRIBUTES（登录用户属性事件）

| 字段 | 类型 | Web | 小程序 | App | 说明 |
|---|---|:--:|:--:|:--:|---|
| `attributes` | Map<string,string> | ● | ● | ● | 登录用户属性 |

### 3.5 APP_CLOSED（关闭事件）

无专有字段，仅携带公共字段。App 和微信小程序会在进入后台时尽力发送；Web 不产生此事件。进程被系统直接终止、崩溃或网络未完成时，不保证事件一定送达，不能把它当作可靠的“应用已关闭”确认。

`APP_CLOSED.appState` 当前统一采用 `BACKGROUND`：事件由 `App.vue` 的 `onHide` 触发，语义就是“应用已进入后台”。这是简化实现和数据消费的共同口径，不是强制抹平平台差异；只有平台差异会改变事件含义、字段可用性或数据正确性时，才在 Protocol 中列出有证据的例外。Android 原生 SDK 的既有取值源于内部触发时机，不改变此事件的业务含义，因此不作为例外。

### 3.6 VIEW_CLICK（元素点击事件）

| 字段 | 类型 | Web | 小程序 | App | 说明 |
|---|---|:--:|:--:|:--:|---|
| `eventSequenceId` | long | ● | ● | ● | 事件请求编号 |
| `textValue` | string | ○ | ○ | ○ | `data-title` 标记的元素文案 |
| `xpath` | string | ● | ● | ● | 元素标识符，不要求是 DOM XPath |
| `index` | int | ○ | ○ | ○ | `data-index` 标记的列表元素序号 |
| `hyperlink` | string | ○ | ○ | ○ | `data-src` 标记的目标地址，或 `uni-link` 的 href |

### 3.7 VIEW_CHANGE（输入元素改变事件）

| 字段 | 类型 | Web | 小程序 | App | 说明 |
|---|---|:--:|:--:|:--:|---|
| `eventSequenceId` | long | ● | ● | ● | 事件请求编号 |
| `textValue` | string | ○ | ○ | ○ | 标记的组件值，或 swiper 的 `data-title` 文案 |
| `xpath` | string | ● | ● | ● | 元素标识符，不要求是 DOM XPath |
| `index` | int | — | — | — | `VIEW_CHANGE` 不产生该字段 |
| `hyperlink` | string | — | — | — | `VIEW_CHANGE` 不产生该字段 |

---

### 3.8 传统 uni-app App 的 `xpath` 口径

传统 uni-app Vue 3 模板无埋点沿用小程序的逻辑元素标识，不生成 DOM 或模板结构 XPath：普通模板事件使用 `${id}#${eventName}`，其中 `id` 来自 `currentTarget || target` 的 `id`，`eventName` 是实际业务 handler 名；缺少 id 时仍保留 `#eventName`。没有业务 click 的 `uni-link` 使用 `#openURL`，tabBar 使用 `#onTabItemTap`。普通模板 `data-index` 只接受大于 0 且小于 2147483647 的整数，tabBar index 单独转为一基。显式敏感标记、password / safe-password / file input 与一期无法确认安全性的动态 input type 会拒绝整个自动采集事件，`data-growing-track` 不能覆盖。`eventName` 仅为 SDK 内部生成 xpath 的输入，不新增为协议字段。详见[传统 uni-app 无埋点方案](./uniapp-autotrack-design.md)。

---

## 4. 端间口径差异速查

| 维度 | Web | 小程序 | App |
|---|---|---|---|
| `platform` | `web` | `MinP` | `iOS` / `Android` / `HarmonyOS` |
| `domain` | 网页域名 | 小程序 appId | 包标识（iOS BundleID / Android 包名 / HarmonyOS Bundle Name） |
| `screenWidth/Height` | 逻辑像素 | 物理像素 | 物理像素，固定为短边 / 长边 |
| `path`/`title`/`referralPage` | 公共字段 | 公共字段 | 仅关联页面的事件 |
| `referralPage` | 所有事件 | 仅 PAGE | 仅 PAGE |
| `appChannel` | 无 | 场景值 | 三端 App：统一使用 init 显式值；未传则省略 |
| `operatingSystem` | 无 | 有 | 无 |
| `networkState`/设备型号品牌 | 无 | 有 | 有 |
| `APP_CLOSED` | 无此事件 | 有（进入后台时尽力发送） | 有（进入后台时尽力发送）；三端 `appState` 均为 `BACKGROUND` |
| App 基础专属字段 | — | — | `appState` / `appName` |
| App 插件扩展字段 | — | — | `urlScheme`（以后仅由 Deep Link／圈选等产品插件使用） |
| App 专属标识 | — | — | `idfa`/`idfv`（iOS）、`oaid`/`androidId`/`imei`（Android）；HarmonyOS 不承诺这些 iOS/Android 专属标识 |

---

## 5. 报文示例

### Web — PAGE

```json
{
  "deviceId": "7196f014-d7bc-4bd8-b920-757cb2375ff6",
  "userId": "张三",
  "sessionId": "d5cbcf77-b38b-4223-954f-c6a2fdc0c098",
  "dataSourceId": "ab66825b9f9c701a",
  "eventType": "PAGE",
  "platform": "web",
  "timestamp": 1506069592985,
  "domain": "test-browser.growingio.com",
  "path": "/push/cdp/web.html",
  "query": "a=1&b=2",
  "title": "CDP-Web弹窗",
  "referralPage": "http://test-browser.growingio.com/push/cdp",
  "eventSequenceId": 3,
  "protocolType": "https",
  "screenWidth": 1080,
  "screenHeight": 1920,
  "language": "zh-CN",
  "timezoneOffset": "-480",
  "appVersion": "1.2.4",
  "sdkVersion": "3.0.1"
}
```

### 小程序 — VISIT

```json
{
  "deviceId": "d8367487-404f-41a8-bc20-55d083fc43e7",
  "sessionId": "85830a6a-1651-4b00-ba48-5f1df1d00aa9",
  "dataSourceId": "datasource-id-121212",
  "userId": "4444",
  "eventType": "VISIT",
  "platform": "MinP",
  "platformVersion": "Weixin 7.0.19",
  "timestamp": 1607416671122,
  "domain": "wx265d0fa6fa70fae9",
  "path": "pages/index/index",
  "eventSequenceId": 1,
  "networkState": "WIFI",
  "appChannel": "scn:1001",
  "screenWidth": 1080,
  "screenHeight": 2400,
  "deviceBrand": "HONOR",
  "deviceModel": "BMH-AN10",
  "deviceType": "Weixin-Android",
  "operatingSystem": "Weixin-Android",
  "appVersion": "1.0",
  "language": "zh_CN",
  "timezoneOffset": "-480",
  "sdkVersion": "1.3"
}
```

### App — VISIT

```json
{
  "deviceId": "7196f014-d7bc-4bd8-b920-757cb2375ff6",
  "userId": "张三",
  "sessionId": "d5cbcf77-b38b-4223-954f-c6a2fdc0c098",
  "dataSourceId": "ab66825b9f9c701a",
  "eventType": "VISIT",
  "platform": "Android",
  "platformVersion": "7.1.2",
  "timestamp": 1506069592985,
  "domain": "com.growingio.app",
  "appState": "FOREGROUND",
  "eventSequenceId": 3,
  "networkState": "4G",
  "appChannel": "应用宝",
  "screenWidth": 1080,
  "screenHeight": 1920,
  "deviceBrand": "google",
  "deviceModel": "Nexus 5",
  "deviceType": "PHONE",
  "appName": "看数小助手",
  "appVersion": "1.2.4",
  "language": "zh-Hans",
  "timezoneOffset": "-480",
  "oaid": "eeefbf75-3df7-15e0-ffb5-ff1ff09f1ec3",
  "sdkVersion": "3.0.1"
}
```

### App — PAGE

```json
{
  "deviceId": "7196f014-d7bc-4bd8-b920-757cb2375ff6",
  "userId": "张三",
  "sessionId": "d5cbcf77-b38b-4223-954f-c6a2fdc0c098",
  "dataSourceId": "ab66825b9f9c701a",
  "eventType": "PAGE",
  "platform": "Android",
  "platformVersion": "7.1.2",
  "timestamp": 1506069592985,
  "domain": "com.growingio.app",
  "appState": "FOREGROUND",
  "eventSequenceId": 3,
  "path": "/NestedFragmentActivity/GreenFragment[fragment1]",
  "orientation": "PORTRAIT",
  "title": "GreenFragment",
  "networkState": "4G",
  "appChannel": "应用宝",
  "screenWidth": 1080,
  "screenHeight": 1920,
  "deviceBrand": "google",
  "deviceModel": "Nexus 5",
  "deviceType": "PHONE",
  "appName": "看数小助手",
  "appVersion": "1.2.4",
  "language": "zh-Hans",
  "timezoneOffset": "-480",
  "sdkVersion": "3.0.1"
}
```

### App — APP_CLOSED

```json
{
  "deviceId": "7196f014-d7bc-4bd8-b920-757cb2375ff6",
  "userId": "张三",
  "sessionId": "d5cbcf77-b38b-4223-954f-c6a2fdc0c098",
  "dataSourceId": "ab66825b9f9c701a",
  "eventType": "APP_CLOSED",
  "platform": "Android",
  "platformVersion": "7.1.2",
  "timestamp": 1506069592985,
  "domain": "com.growingio.app",
  "appState": "BACKGROUND",
  "networkState": "4G",
  "appChannel": "应用宝",
  "screenWidth": 1080,
  "screenHeight": 1920,
  "deviceBrand": "google",
  "deviceModel": "Nexus 5",
  "deviceType": "PHONE",
  "appName": "看数小助手",
  "appVersion": "1.2.4",
  "language": "zh-Hans",
  "timezoneOffset": "-480",
  "sdkVersion": "3.0.1"
}
```

> Android、iOS、HarmonyOS 的同类事件均使用 `appState: "BACKGROUND"`。
