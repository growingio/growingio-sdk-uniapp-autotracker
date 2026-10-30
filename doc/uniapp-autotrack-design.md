# 传统 uni-app Vue 3 无埋点方案（1.0）

> **状态：schema v2 代码和受控自动化链路已实现，三端真机验收待完成。** 普通模板在 runtime 生成 `id#eventName`，tabBar 固定为 `#onTabItemTap`。三端尚未取得逐组件设备请求及 collector 接收证据，因此正式构建的 `autoClick`、`tabBar`、逐组件 `autoChange` 仍由能力表禁用；demo 通过独立验证开关开放链路，由用户完成实机验证；不能把静态通过当作三端已支持。

## 1. 目标与结论

传统 uni-app 的协议字段继续叫 `xpath`，但它**不是 DOM XPath，也不是模板层级路径**。普通模板事件的唯一计算公式是：

```text
xpath = `${id}#${eventName}`
```

其中：

- `id` 取触发事件的主目标 `currentTarget || target` 的 `id`；无 id 时为空字符串；
- `eventName` 是模板中实际执行的业务处理函数名；无法确定业务函数名时才使用已声明的原生事件名；
- `xpath` 仅在 runtime 中生成，Vite 不再把模板位置、组件层级或 `v-for` 下标编译进字段；
- tabBar 是宿主生命周期事件，不走普通模板公式，固定为 `#onTabItemTap`。

示例：

| 模板或宿主事件 | `id` | `eventName` | 最终 `xpath` |
|---|---|---|---|
| `<button id="buy" @tap="submitOrder">` | `buy` | `submitOrder` | `buy#submitOrder` |
| `<input @blur="search">` | 空 | `search` | `#search` |
| `<view :id="item.id" @click="select(item)">` | 运行时的 `item.id` | `select` | `sku-1#select` |
| `<uni-link href="/docs">`（没有业务 click） | 空 | `openURL` | `#openURL` |
| `onTabItemTap({ index: 0 })` | — | `onTabItemTap` | `#onTabItemTap` |

这意味着：同一页面的多个元素若使用同一 handler 且没有 id，都会得到同一个 `#handlerName`。这是与小程序一致的结果，不以模板路径偷偷区分。接入方需要稳定区分元素时，应显式提供 `id`；列表项还可用 `data-index` 作为 `VIEW_CLICK.index` 的附加维度。

## 2. 依据、范围与非目标

### 2.1 参考实现

本方案只复用相邻 SDK 已验证的语义，不复制它们的宿主实现：

| 参考端 | 本方案采用的规则 | 不直接复制的部分 |
|---|---|---|
| 小程序 SDK | `currentTarget || target` 选择主目标；`id#eventName` 拼接；ignore 同时检查 `currentTarget` 与原始 `target`；tabBar 使用 `#onTabItemTap`、一基 `index` 与 `pagePath`；`data-index` 只接受正整数 | `App/Page/Component` 及业务方法全局重写 |
| uni-app x SDK | 编译期从事件表达式推导 handler 名；条件表达式按实际分支取名；change 显式传递组件类型、受限值与 picker range；无业务 handler 的 `uni-link` 使用 `openURL`；runtime 再由事件快照生成 `id#eventName` | UTS/uvue bridge 与原生对象模型 |
| 当前传统 uni-app SDK | Vue 3 SFC AST、Vite `pre` 插件、模块内 dispatcher、隐私开关、页面快照与协议事件构建 | 旧版模板结构 xpath 生成逻辑 |

组件参数参考官方 [picker](https://uniapp.dcloud.net.cn/component/picker) 与 [swiper](https://uniapp.dcloud.net.cn/component/swiper.html) 文档；官方组件事件描述不能代替本 SDK 的逐端采集验收。

### 2.2 一期范围

| 范围 | 结论 |
|---|---|
| 技术栈 | 传统 uni-app Vue 3、Vite、`.vue` SFC |
| 运行端 | Android、iOS、HarmonyOS App |
| 支持动作 | 内置组件的 `click` / `tap`；白名单组件的 `change`；input / textarea 独立声明的 `blur` 或 `confirm`；`uni-link`；tabBar |
| Vite 顺序 | `gioUniappAutoTrack()` 必须在 `uni()` 前 |
| 不支持 | `.nvue`、Vue 2 / Webpack、H5 DOM 委托、web-view 内 H5、动态事件名、自定义组件、带事件修饰符的 listener、无法安全改写的复杂表达式 |

不支持不等于业务报错：插桩器保持原模板表达式不变，输出可定位的构建告警；SDK 不尝试全局 DOM 监听或全局改写 `App/Page/Component` 来补采。

### 2.3 已确认的产品口径

以下三项不再作为实现阶段的开放问题：

1. 敏感组件直接忽略，整个自动采集事件不生成；`data-growing-track` 不能覆盖；
2. 普通模板 `data-index` 与小程序、uni-app x 对齐，只接受大于 0 且小于 2147483647 的规范十进制整数；
3. 事件修饰符不纳入一期支持，原模板保持不变并输出构建告警。

## 3. 协议和内部数据边界

### 3.1 `xpath` 的最终语义

`VIEW_CLICK.xpath` 与 `VIEW_CHANGE.xpath` 是最终协议字段，始终由 runtime 产生。`eventName` 仅是 Vite 到 dispatcher 的内部输入，绝不作为新的 wire 字段上报，也不适用 CUSTOM `eventName` 的正则限制。

主目标必须严格沿用小程序的选择规则：

```ts
const primaryTarget = record(event.currentTarget) ?? record(event.target)
const id = scalarText(primaryTarget?.id) ?? ''
const xpath = `${id}#${eventName}`
```

这里不能改为“`currentTarget.id || target.id`”。若 `currentTarget` 存在但没有 id，小程序会使用空 id；改拿子节点 `target.id` 会把一次绑定在父节点上的交互误标为子节点。

`scalarText` 只接受 string 或 number，并转为字符串；其余 id 值一律视为空。`eventName` 必须是非空字符串，否则该 probe 被拒绝。运行时只保留纯 JSON 数据，原始 native event、组件实例和 Vue 实例不得穿过 dispatcher。

### 3.2 版本化 call 合约

旧版 `schemaVersion: 1` 的 call 把 `xpath` 当作编译期输入。该含义改变必须升级为 `schemaVersion: 2`，不能兼容地把旧结构路径当作 `eventName` 使用。

```ts
type TemplateAutoTrackProbe = Readonly<{
  schemaVersion: 2
  source: 'template'
  kind: 'click' | 'change'
  eventName: unknown
  elementType?: unknown
  pickerRange?: unknown
  pickerRangeKey?: unknown
  textValue?: unknown
  index?: unknown
  hyperlink?: unknown
  ignored?: unknown
  trackValue?: unknown
  sensitive?: unknown
  redactValue?: unknown
}>

type TabBarAutoTrackProbe = Readonly<{
  schemaVersion: 2
  source: 'tabbar'
  kind: 'click'
  xpath: '#onTabItemTap'
  index: unknown
  textValue?: unknown
  hyperlink?: unknown
}>

type NormalizedAutoTrackCall =
  | Readonly<{
      kind: 'click'
      xpath: string
      textValue: string | null
      index: number | null
      hyperlink: string | null
    }>
  | Readonly<{
      kind: 'change'
      xpath: string
      textValue: string | null
    }>
```

`elementType` 只允许 Vite 从白名单内置组件写入稳定的小写组件名；`pickerRange` 对 picker 只允许有界一维 JSON 数组，对 picker-view 只允许按列组织的有界二维 JSON 数组，`pickerRangeKey` 只允许非空字符串。实现边界为 range 总计最多 1000 项、picker-view 最多 20 列、对象项最多 32 个标量属性，拒绝嵌套对象和访问器；picker-view 的文案或下标统一以 `||` 连接。编译器只复制固定 picker-view-column 的静态文本或字面量 v-for range；动态 range、复杂列渲染只保留规范下标回退，不在事件阶段重复求值业务绑定。原始 change payload 不重复塞进 probe，而是由 dispatcher 从第二参数 native event 中即时裁出 `detail.value/current/source`、`target.value`、`target.attr.value` 等受限快照。它们只用于 runtime 的 change 值归一化，不能直接作为协议字段或绕过 `data-growing-track`。picker 优先使用合法 range 中的显示值，无法解析时才保留原始下标；switch 必须保留布尔值语义，swiper 仍按 autoplay 与 `data-title` 规则处理。

Vite 只能生成 `TemplateAutoTrackProbe`，page lifecycle bridge 只能生成 `TabBarAutoTrackProbe`；normalizer 产出的 `NormalizedAutoTrackCall` 才能进入 `EventDispatcher`。ignore、敏感、未授权的 change 值等策略在生成 normalized call 前完成：被拒绝的 probe 直接返回 `false`，不能以 `ignored` / `sensitive` 标志继续向下游传递。分类型 union 也保证 `VIEW_CHANGE` 在类型层面没有 `index`、`hyperlink`。版本不匹配、source 与字段组合不匹配、空事件名、非白名单 `elementType`、超限数组或非法 host 值均安全返回 `false`，并只产生脱敏 debug 诊断。原始 native event 仍作为 dispatcher 的瞬时第二参数传入；其 `type`、`timeStamp`、`currentTarget`、`target`、`detail` 只在本次调用内读取，不进入 probe、日志、队列或协议事件。

发布时必须整体重新构建 App。旧 Vite 编译产物传入新版 runtime 时会因版本不匹配被拒绝，不能静默继续发送旧路径；新版 Vite 编译产物传入旧 runtime 同样安全不采集。

## 4. 事件名推导与编译插桩

### 4.1 推导规则

Vite 先使用 `@vue/compiler-sfc.parse()` 取得完整 template block 和准确源码偏移，再使用 Vue template AST 查找静态 `v-on`，最后使用事件表达式 AST 推导名称。不能再用 `/<template>(.*?)<\/template>/` 一类正则提取 SFC；它会在嵌套 `<template v-for>`、`<template v-if>` 或 slot template 的第一个闭合标签处提前截断。实现采用与 uni-app x 相同的“可读成员路径”规则，将 `@vue/compiler-sfc`、`@vue/compiler-dom`、`@babel/parser` 随 Vite 工具打包，不进入 App 运行时。

| 表达式 | 传入的 `eventName` | 说明 |
|---|---|---|
| `@tap="submit"` | 不插桩 | 保留 Vue 对函数引用的求值、缓存和调用语义 |
| `@tap="submit(item)"` | `submit` | 取 CallExpression 的 callee |
| `@click="actions.save"` | 不插桩 | 不额外读取 getter 或改写引用 |
| `@click="actions.save(item)"` | `actions.save` | 非计算成员调用 |
| `@click="ready ? save : cancel"` | 不插桩 | 原表达式返回函数，绝不能改成调用 |
| `@click="ready ? save($event) : cancel($event)"` | `save` 或 `cancel` | 条件只求值一次，保持原分支执行 |
| `@click="(event) => save(event)"` | `save` | 可从匿名表达式内找到唯一可读方法路径 |
| 无可读方法路径但可安全改写 | 对应静态原生事件名，如 `click` / `tap` / `change` | 与 uni-app x 的明确 fallback 一致 |
| `v-on:[name]`、无 handler、无法安全改写 | 不插桩 | 保留原表达式并给出 warning |

计算属性路径（如 `actions[key]`）不能伪造成 `actions.key`，一期直接按 `complex_handler` 跳过，不以原生事件名冒充一个动态业务 handler。支持的条件表达式按“条件只求值一次 → 选择分支 → 派发该分支名 → 执行原表达式”处理，不能在条件外预先报固定的 `save` 或 `cancel`。所有重写保持：原 handler 一次调用、完整参数列表、this、arguments、返回值、抛错和求值次数不变；SDK 探针及元数据求值异常隔离，不得影响后续业务表达式。

Options API、普通 `setup()` 与 `<script setup>` 的最终事件口径相同，但代码生成路径必须分开验证，不能用一个字符串前缀覆盖全部场景：

| 原 listener 形态 | 插桩要求 |
|---|---|
| 纯方法引用 `@click="submit"` | 原样保留，不插桩并输出 `complex_handler` |
| 内联调用 `@click="submit(item)"` | probe 后执行原表达式一次，参数和返回/抛错保持不变 |
| 箭头或函数表达式 | 保留原函数与参数，仅在函数体插入探针；异步、生成器、无首参数、解构首参数、严格模式指令等不支持写法原样跳过 |
| 顶层条件表达式 | 条件只求值一次，probe 与业务调用必须命中同一分支 |
| 计算成员、嵌套条件、多语句歧义表达式 | 保留原代码，输出 `complex_handler`，一期不插桩 |

普通 Options / setup 组件仅向可静态确认的 methods 字面量插入独立名称，不复制组件对象、不改写 setup 的返回值。导出变量、工厂调用、动态 methods、顶层 spread / 计算选项等输出 `complex_component_options` 并保持整份 SFC 原样。

注入 import 时必须根据 SFC 的 script、script setup 和 template bindings 选择不冲突的局部别名，不能固定假设 `__gioAutoTrack` 未被业务占用。名称判断包含 AST 解码后的 Identifier / 字符串方法键，以及模板中 Unicode 转义的循环或 slot 别名；只用于冲突判断，不改写业务源码。幂等判断也必须识别 SDK 自己生成的 import/调用标记，不能用全文 `includes()`，避免业务注释或字符串导致整页漏插桩。

无业务 click 的 `uni-link` 由 Vite 额外插入只采集 handler，事件名固定为 `openURL`。同时将静态 `href` 或动态 `:href` 映射为 `data-src` 等价值，使最终 `VIEW_CLICK.hyperlink` 与实际链接一致；不把未序列化对象作为 metadata 传入。

### 4.2 支持事件与单次变更选择

| 动作 | 模板事件 | 生成 `kind` | 名称来源 |
|---|---|---|---|
| 点击 | `click` / `tap` | `click` | 业务 handler，或仅在无法取得时为原生事件名 |
| 输入完成 | 优先 `blur`，其次 `confirm`；仅 `change` 时保留兼容路径 | `change` | 选中的业务 handler |
| `uni-link` | 自动补充 `click` | `click` | `openURL` |
| tabBar | `onTabItemTap` | `click` | `onTabItemTap` |

同一 input / textarea 按确定性顺序 `blur → confirm → change` 选择一个已声明的完成事件，只插入一个 `VIEW_CHANGE` probe；未选中的业务 handler 仍完全保留。传统 App 的输入组件不转发底层 DOM change，因此应使用 blur / confirm；仅声明 change 时保留兼容插桩，不承诺 App 会触发，也不注入未声明的监听器或补发业务事件。选中的监听器含不支持的修饰符或表达式时仍保守跳过，不改用低优先级事件。`switch`、`slider`、`radio-group`、`checkbox-group`、`picker`、`picker-view`、`swiper` 的 change 支持仍以白名单和三端真机结果为准。

### 4.3 不插桩与告警

下列情况不改写业务代码，并输出文件名、偏移量和原因：`sfc_parse_error`、`template_parse_error`、`dynamic_event`、`missing_handler`、`event_modifiers`、`custom_component`、`unsupported_event`、`complex_handler`、`event_name_fallback`、`.nvue_not_instrumented`。其中 `event_name_fallback` 只表示仍可安全插桩但无法获得业务函数名；它上报静态原生事件名，不上报模板路径。

事件修饰符不是一期能力。遇到 `.stop`、`.prevent`、`.once`、`.capture`、`.self` 等修饰符时，不改写 handler、不添加 probe，只输出 `event_modifiers`；原修饰符继续完全由 uni-app/Vue 编译器处理。

当前 Vite 插件必须把 AST 返回的 warnings 通过 Vite `this.warn()` 输出；仅生成 warnings 而不透出会让接入方误以为被采集。

### 4.4 `<script setup>`、动态渲染与循环

模板插桩只关心 template 中的**可执行事件表达式**，不反查业务函数的来源。Options API、普通 `setup()` 与 `<script setup>` 共享事件名口径，但分别使用上一节约束的代码生成路径：

| 场景 | 采集口径 | 必须保证的实现行为 |
|---|---|---|
| `<script setup> const submit = ...`，模板 `@tap="submit"` | `eventName = submit` | dispatcher import 注入同一个 `<script setup>`；不改写 `submit` 定义或闭包 |
| `setup() { return { submit: saveOrder } }`，模板 `@tap="submit"` | `eventName = submit` | import 注入普通 script；通过唯一 methods 别名暴露 dispatcher，原 setup 保持不变（含 reactive、异步和 render function 返回值），避免新增 script setup 覆盖原 setup；记录模板可见的别名 |
| Options API `methods: { submit() {} }` | `eventName = submit` | 无原 setup 块时新增只含 dispatcher import 的 setup 块；Options methods 仍由原 Vue 模板上下文解析 |
| import、composable 或 ref 暴露给模板的函数 | 使用模板表达式中的名称或成员路径 | 不分析 import 来源、不序列化 ref / reactive / 组件实例 |
| `defineExpose()` | 不改变模板事件名 | 它面向父组件公开，不是模板 handler 名解析来源 |
| `v-if` / `v-else-if` / `v-else` | 仅实际渲染并触发的分支采集 | 两边 template 都可被转换；未渲染分支不会产生 native event，也不会上报 |
| `v-show` | 事件可达时照常采集 | 不把显示状态写进 xpath；隐藏节点未触发就没有事件 |
| `v-for` 的内置组件 | 每个运行时实例独立读取 id/dataset | Vite 只转换一次源码，绝不把编译时循环位置、`key` 或数组下标拼进 xpath |
| `v-for` 中的 `:id` / `:data-index` / `:data-title` / `:data-src` | 取触发瞬间值 | `id` 进入 `xpath`；`data-index` 只进入 `VIEW_CLICK.index`；其余进入各自允许字段 |
| `@click="select(item)"` 或 `@click="() => select(item)"` | `eventName = select` | 闭包参数照常由原 Vue listener 求值；SDK 不保存 `item` |
| `@click="ready ? save(item) : cancel(item)"` | `save` 或 `cancel` | 运行时按真实分支先派发相应名称，再执行该分支 listener |
| `@click="handlers[item.type]"` | 不采集 | 计算成员不是稳定业务 handler 名，输出 `complex_handler` 并保持原代码 |
| `v-on:[eventName]` | 不采集 | 事件种类和 handler 无法在构建期可靠归类，输出 `dynamic_event` |

`v-for` 的 `:key` 只服务 Vue 的虚拟节点复用，不能当作自动采集 id。列表需要稳定元素标识时，业务必须同时提供稳定 `:id`；只有 `data-index` 的列表仍会上报相同的 `#handlerName`，外加合法的 click index。空 id 是正常口径，不回退到模板路径。

动态组件和非模板渲染边界必须明确：`<component :is="...">`、业务自定义组件的 emit、render function / JSX / TSX、`v-html` 生成的内容、`.nvue` 与 web-view 内 H5 均不插桩。插槽中由**声明该 slot 内容的 SFC**写出的内置组件，会在那个 SFC 自己的 Vite 转换中处理；组件内部的 slot 实现不会被父组件转换器穿透。SFC parser 必须保证嵌套 `<template v-for>`、`<template v-if>` 和具名/作用域 slot 的 template block 不被截断。需要覆盖其他边界时，业务使用手动 `gdp('track')`，或后续另行设计有明确宿主契约的适配器。

## 5. runtime 归一化、隐私和去重

### 5.1 运行时顺序

```text
模板 probe（eventName + 静态 metadata）
  → dispatchAutoTrack(probe, nativeEvent)
  → 分别保留 currentTarget、原始 target，并选择 primaryTarget = currentTarget || target
  → 先检查双目标 ignore、敏感组件与 autoplay
  → 从 primaryTarget 读取 runtime id 和普通 metadata
  → 使用 elementType、受限 event detail/target 快照、pickerRange 归一化 change
  → 生成 xpath = id#eventName
  → 同对象去重 + 有效时间戳窄窗去重
  → EventDispatcher
  → VIEW_CLICK / VIEW_CHANGE
```

目标用途必须分开，不能把所有策略压成一个 `primaryTarget`：

- `xpath` 的 id、`data-title`、`data-index`、`data-src` 使用 `primaryTarget = currentTarget || target`；`currentTarget` 存在但没有 id 时不能回退 `target.id`；
- `data-growing-ignore` 和 `data-growing-sensitive` 同时检查 `currentTarget.dataset` 与原始 `target.dataset`，任意一处命中就拒绝；
- `detail.source === 'autoplay'` 时，仅检查原始 `target.dataset.growingTrack` 是否显式放行；
- 模板中的静态 metadata 只作为宿主 event 对应字段缺失时的受限补充，动态 `id`、`data-title`、`data-index`、`data-src` 以触发瞬间值为准。存在 `v-bind` 展开、动态属性名或对应绑定修饰符时，不复制可能被覆盖的授权、文案、链接、index 或 picker range；静态 ignore/sensitive 仍保守拒绝整个 probe。

### 5.2 字段与隐私规则

| 规则 | 行为 |
|---|---|
| `data-growing-ignore` | 最高优先级；currentTarget 或原始 target 任意命中都拒绝整个 probe |
| `data-growing-sensitive` | currentTarget、原始 target 或编译期静态标记任意命中都拒绝整个 probe |
| 密码、安全密码 input | 保留 `VIEW_CHANGE`，不读取输入值或文案，协议省略 `textValue`；track 不能覆盖 |
| 动态 `:password` | 保留 `VIEW_CHANGE`，所有状态下都保守禁读值，不重复求值业务绑定 |
| 文件 input | 拒绝整个 probe，不生成 `VIEW_CHANGE` |
| 动态 `:type` | 一期按敏感处理并拒绝整个 probe，不根据运行时偶然值放宽 |
| `data-growing-track` | 仅允许非敏感 `VIEW_CHANGE` 写入归一化后的值 |
| `data-title` | `VIEW_CLICK.textValue`；以及没有被允许采集值的必要 change 文案 |
| `data-index` | 仅 `VIEW_CLICK.index`；只接受大于 `0` 且小于 `2147483647` 的规范十进制整数 |
| `data-src` / `uni-link.href` | 仅 `VIEW_CLICK.hyperlink` |

`data-growing-track` 不能覆盖 ignore 或敏感规则。敏感 probe 必须在读取、字符串化或记录 change value 之前终止，因此其内容不能进入 debug 日志、去重键、队列或协议事件。`NormalizedAutoTrackCall` 的 change 分支在类型层面不提供 `index`、`hyperlink`，Protocol 字段白名单继续作为第二道防线。原始 native event 和 Vue/宿主对象同样不得越过 dispatcher。

### 5.3 change 组件归一化

只有通过敏感检查后才读取 change value；没有 `data-growing-track` 时除 swiper 文案规则外均生成 `textValue: null`。字段优先级和输出固定为：

| `elementType` / 组件 | 瞬时值来源 | 允许 track 时的 `textValue` |
|---|---|---|
| input / textarea | `detail.value → target.value → target.attr.value` | 标量字符串 |
| switch | `detail.value` | 严格保留布尔语义为 `"true"` / `"false"` |
| slider | `detail.value` | 有限数字字符串 |
| radio-group | `detail.value` | 标量字符串 |
| checkbox-group | `detail.value` | 一维标量数组按既有 `||` 规则连接 |
| picker | `detail.value` 的下标 + `pickerRange` / `pickerRangeKey` | 优先选中项文案，失败回退规范下标 |
| picker-view | `detail.value` 的下标数组 + 各列 range | 能完整映射时连接各列文案，否则连接规范下标 |
| swiper | `detail.current` / `detail.source` | autoplay 未显式放行则拒绝；无可采值时允许 `data-title` 作为变更文案 |

每类组件必须有独立 normalizer，不能用真值判断读取值。空字符串或空数组可以使最终 `textValue` 为空并被 Protocol 清理，但不能因此丢弃整条 `VIEW_CHANGE`；`0` 和 `false` 必须分别保留为 `"0"`、`"false"`。某端无法证明事件结构时，该 `elementType` 在对应 capability profile 中保持禁用。

picker-view 只复制固定列中能静态确认的 view/text 文字。列或嵌套文字存在循环、条件显示、`v-text` / `v-html`、自定义组件，或字面量 v-for 选项同时带条件显示时，使用规范下标回退，不拼接未渲染分支或不能代表组件实际显示的 slot 文字。简单字面量 v-for 仍可提取已确认的选项文案。自动采集文案以 Unicode 码点计数，最多保留 100 个字符，不截断 emoji 的代理对。hyperlink 使用完整目标地址，不复用文案长度限制；超大事件仍受队列字节上限保护。

### 5.4 去重规则

去重发生在隐私判断、字段归一化和最终 `xpath` 生成之后，分为两层。

第一层使用 `WeakMap<nativeEvent, Set<dedupeKey>>`，只抑制同一个事件对象上的相同 probe：

```text
kind + xpath + textValue + index + hyperlink + 无 id 时的绑定目标身份
```

第二层覆盖宿主为同一次交互创建不同 JS 包装对象的情况。每个 tracker 只保存当前 shown page 的最近一条有效事件快照：

```text
pageKey + nativeEvent.type + kind + xpath + textValue + index + hyperlink + 无 id 时的绑定目标身份
```

仅当两条事件的键完全相同、`timeStamp` 都是有限正数且绝对差小于 `10ms` 时判重。`timeStamp` 为 `0`、缺失、NaN 或非有限数时跳过第二层，不能用零值把后续事件永久吞掉。页面切换、重新显示和恢复采集补发 PAGE 时清空去重状态；不建立跨页面或只按事件类型判断的全局时间窗。

同一个 probe 被重复执行时只采集一次；父子元素绑定的目标不同，即使无 id、同 handler 且文案相同，也各自可采集。无 id 时仅在 WeakMap 中为 `currentTarget || target` 分配内部身份；没有目标则使用事件对象身份，无法确认同一目标的独立包装不合并。目标对象只作为弱键，内部身份不进入日志、队列或协议，`xpath` 仍为 `#handlerName`。不同值、index、title/link 或事件类型的连续操作不合并。input / textarea 同时声明 `change`、`blur`、`confirm` 时仍由 Vite 只选择一个完成事件插针，不依赖运行时跨类型猜测。swiper autoplay 必须先按上一节规则过滤，再进入去重。

## 6. tabBar 与页面上下文

tabBar 不从模板 native event 取 id。页面 lifecycle bridge 将 `onTabItemTap` 归一化为：

```ts
{
  schemaVersion: 2,
  source: 'tabbar',
  kind: 'click',
  xpath: '#onTabItemTap',
  index: tabItem.index + 1,
  textValue: tabItem.text,
  hyperlink: tabItem.pagePath,
}
```

这与小程序一致：tab index 是一基，且 `pagePath` 进入 `hyperlink`。它取代旧版 tabBar 结构路径与零基 `index` 的行为。普通模板事件和 tabBar 都必须在当前 shown page 的 snapshot 下构建 `VIEW_CLICK`；没有当前页面、插件未注册、`dataCollect=false` 或 normalizer 失败时，安全不采集。

## 7. 代码改动清单

| 文件 | 必做改动 |
|---|---|
| `src/plugins/gioEventAutoTracking/contract.ts` | 定义 schema v2 的 template / tabbar probe union，加入受限 `elementType`、`pickerRange`，分离最终 normalized call；拒绝旧 v1 与混合字段 |
| `src/compiler/vite.ts` | 使用 `@vue/compiler-sfc` 提取完整 template；删除结构 xpath 递归生成；加入事件表达式 AST 名称推导、分形态 handler 改写、条件分支、`openURL`、change metadata、唯一 import 别名与 warning 透出 |
| `src/plugins/gioEventAutoTracking/index.ts` | 分开处理 currentTarget、原始 target 与 primaryTarget；由 `id + eventName` 生成 xpath；实现敏感短路、组件级 change 归一和两层去重 |
| `src/adapters/uniapp.ts` | tabBar 改为 `#onTabItemTap`、一基 index、`pagePath` hyperlink，并改用 schema v2 |
| `src/core/dataStore/index.ts` | 保持只接收 normalized call，确认 change 仍裁剪 `index` / `hyperlink` |
| `package.json` | 将 `@vue/compiler-sfc`、`@vue/compiler-dom` 与事件表达式 AST parser 作为构建侧运行依赖；不得依赖使用方未安装的 devDependency |
| `scripts/check-release.ts` | 校验 release 包保留全部构建侧运行依赖，不能只检查 `@vue/compiler-dom` |
| `test/unit/*autotrack*`、`test/unit/page-bridge.test.ts` | 将所有结构 xpath 断言替换为事件标识断言，并新增第 8 节测试向量 |
| `README.md`、Protocol、开发计划 | 只描述 `id#eventName` 口径，并链接本文 |

不在本次实施中修改 core 事件协议、上传、session、身份、页面生命周期机制或业务侧 `gdp()` API。

## 8. 验证矩阵

### 8.1 静态与单元测试

| 场景 | 必须断言 |
|---|---|
| 有静态 id 的方法引用 | 编译输出携带 `eventName`，runtime 产出 `buy#submitOrder` |
| 动态 `:id` | Vite 不写入 id；runtime 用触发时值生成 xpath |
| 无 id | 产出 `#handlerName`，不回退为模板路径 |
| `currentTarget` 有对象但 id 为空、`target.id` 非空 | 产出 `#handlerName`，证明严格遵循小程序主目标规则 |
| `currentTarget` 缺失 | 回退 `target.id` |
| `<script setup>`、`setup()` 返回别名、Options API methods | import 注入位置正确；模板可见名称而非闭包/导入原名进入 `eventName` |
| import 名称冲突、源码含幂等标记字样、Vite 重复 transform | 选择唯一别名；注释/字符串不导致漏插桩；同一 handler 不重复包裹 |
| 嵌套 `<template v-for>` / `<template v-if>` / slot template | SFC 不被提前截断；内部白名单元素正常转换；解析失败输出可定位 warning |
| `v-if` / `v-show` | 仅真实触发的可见/可达分支产生一次事件；不改变 xpath 公式 |
| `v-for` 动态 id 和 metadata | 每个实例取触发瞬间的 id/dataset；`key` 与循环下标不进入 xpath；`data-index=0` 被忽略，正整数保留 |
| `v-for` 无 id | 多个实例均为 `#handlerName`；测试明确证明没有结构路径兜底 |
| 动态计算 handler、动态事件名、动态组件、事件修饰符与 JSX | 输出对应 warning、完全跳过插桩，且业务代码与行为不变 |
| 方法调用、成员路径、箭头、条件分支 | 名称正确；业务 listener 调用次数、参数、返回值、抛错保持不变 |
| 无可读名称 | 仅安全可改写时回退静态原生事件名并告警；其余不插桩 |
| `uni-link` | `#openURL` 与静态/动态 href 的 hyperlink 正确 |
| tabBar | `#onTabItemTap`、一基 index、pagePath hyperlink 正确 |
| v1 call / 非法 v2 call | 不采集，不能把旧路径误解释为事件名 |
| currentTarget / target 任一 ignore、敏感 input、动态 type | 不生成协议事件；`data-growing-track` 不能覆盖；读取值前即短路 |
| `data-growing-track` change | 非敏感值可采；`0`、`false`、空字符串不被真值判断丢弃 |
| switch / picker / picker-view / swiper | elementType、布尔值、picker range 显示值和 autoplay/title 规则各自正确 |
| 同一 native event / 不同包装对象 / 无效时间戳 / 冒泡父子节点 | 两层去重只吞相同交互；零时间戳不参与窄窗去重；不同 currentTarget 各上报一次 |

完整链路测试必须经过“源 SFC → 转换代码 → dispatcher → EventDispatcher → protocol event → mock collector”，断言 collector 收到的 `VIEW_CLICK` / `VIEW_CHANGE.xpath` 都不含 `/view[`、`/input[` 等结构片段。

### 8.2 真机与服务端证据

静态通过不等于 App 支持。Android、iOS、HarmonyOS 各自至少完成以下证据，并归档 Vite 版本、HBuilderX 版本、SDK 版本、页面源码、设备与 collector 接收记录：

1. 有 id / 无 id 的 click 与 tap；
2. input / textarea 的 selected completion event；
3. switch、slider、radio-group、checkbox-group、picker、picker-view、swiper 的每个已宣传 change 组件；
4. `<script setup>`、`setup()` 返回别名、Options API methods、`v-if` / `v-show`、`v-for` 动态 id 与 metadata、`uni-link`、tabBar；
5. ignore、敏感输入、`data-growing-track` 与 swiper autoplay 的反向用例；
6. 业务 handler 仍只执行一次，以及网络请求与服务端最终接收的 xpath 一致。

HarmonyOS 任一 `VIEW_CHANGE` 组件不能证明事件到达、值归一、业务不回归和 collector 接收时，该组件必须保留禁用状态。`.nvue` 只验证生命周期和手动埋点，不纳入无埋点验收。

## 9. 发布与数据迁移

这次是 `xpath` 取值语义变更，同一交互的历史结构路径与新事件标识不可直接等价比较。发布说明必须明确：

- 从发布版本起，普通模板 `xpath` 改为 `id#eventName`；空 id 合法，结果形如 `#eventName`；
- 不发送旧、新两份事件，不保存结构路径兼容字段，也不以模板序号回退；
- 圈选、看板和下游规则若依赖旧结构路径，必须按新标识重新配置；
- 需要稳定区分同名 handler 的业务元素，应补充稳定 `id`，列表展示使用 `data-index`；
- release 包、demo 产物和使用方 App 必须由同一 SDK 版本重新构建，避免 v1/v2 probe 混用。

## 10. 完成定义

只有满足全部条件，才能把本方案标记为已完成：

1. 文档、Vite 插桩、runtime、tabBar 和测试都不再使用结构 xpath；
2. 所有 v2 probe 只在 runtime 生成 `id#eventName`，且严格采用 `currentTarget || target`；
3. 静态、单元、集成和 release 检查通过；
4. Android、iOS、HarmonyOS 对每项已宣传能力都有编译、真机请求和 collector / 服务端接收证据；
5. 未验证能力在 capability profile、README 和发布说明中明确禁用，不以代码存在或 mock collector 成功代替端侧验收。


## 业务行为保护补充

动态 `data-title`、`data-index`、`data-src` 和隐私标记依赖原生事件的 dataset；编译器仅复制无副作用的字面量。动态 href 不会在点击时再次读取，需采集时可在业务模板中明确声明 `data-src`。不应为增加采集范围而把客户原有函数引用改成调用。源码转换前后使用真实 Vue listener 对照验证参数、this、返回值、异常、条件/元数据 getter 次数和组件选项 getter 时机；不支持的写法保持整份表达式或 SFC 原样。
