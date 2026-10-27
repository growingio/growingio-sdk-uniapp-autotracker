import type { AppEntrySnapshot } from '../core/dataStore/app.js'
import type { PageLoadInput } from '../core/dataStore/page.js'
import type { AutoTrackCall } from '../plugins/gioEventAutoTracking/contract.js'
import type { MiniProgramTarget } from '../types/index.js'
import { readHostRecord } from '../platform/resolve.js'

type LifecycleTarget = AppLifecycleTarget & PageLifecycleTarget
type PageBridge = ReturnType<typeof createPageLifecycleBridge>
type VueInstance = Record<string, unknown>

export type UniAppVueApp = Readonly<{
  /** 将 SDK 生命周期转发器安装到全局 Vue mixin。 */
  mixin: (options: Readonly<Record<string, unknown>>) => void
}>

/** 读取宿主对象的受限记录视图，过滤空值、数组和标量。 */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 抖音原生入口使用 refererInfo；其他目标只读取自己的标准字段。 */
function entryReferrer(source: Record<string, unknown> | null, target?: MiniProgramTarget): Record<string, unknown> | null {
  const standard = record(source?.referrerInfo)
  if (target !== 'mp-toutiao' || standard !== null && Object.keys(standard).length > 0) return standard
  return record(source?.refererInfo) ?? standard
}

/** 读取并移除页面路由的前导斜杠；不可用时返回 null。 */
function routeOf(instance: VueInstance, miniprogram = false): string | null {
  const page = record(instance.$page)
  const route = page?.route ?? instance.__route__ ?? (miniprogram ? record(instance.$scope)?.route ?? instance.route
    ?? (typeof page?.fullPath === 'string' ? page.fullPath.split('?')[0] : null) : null)
  if (typeof route !== 'string') return null
  const normalized = route.replace(/^\/+/, '')
  return normalized === '' ? null : normalized
}

/** 根据页面类型和有效路由区分页面实例与 App 实例。 */
function isPage(instance: VueInstance, miniprogram = false): boolean {
  return (instance.$mpType ?? (miniprogram ? record(instance.$options)?.mpType : undefined)) === 'page' && routeOf(instance, miniprogram) !== null
}

/** 保留宿主 this 与参数，并隔离 SDK 异常，避免打断业务生命周期。 */
function isolatedLifecycleHook<Args extends unknown[]>(hook: (this: VueInstance, ...args: Args) => void) {
  return function(this: VueInstance, ...args: Args): void {
    try { hook.apply(this, args) } catch { /* SDK 生命周期转发异常不能打断业务钩子。 */ }
  }
}

/** 按业务标题、页面元数据和路由配置依次解析标题；读取异常时省略。 */
function pageTitle(instance: VueInstance, appRoutes = true): string | null {
  try {
    if (typeof instance.gioPageTitle === 'string') return instance.gioPageTitle
    const page = record(instance.$page)
    const routes = appRoutes ? (globalThis as Record<string, unknown>).__uniRoutes : undefined
    const route = Array.isArray(routes) ? routes.find((item) => {
      const path = record(item)?.path
      return typeof path === 'string' && path.replace(/^\/+/, '') === routeOf(instance)
    }) : null
    const meta = record(page?.meta) ?? record(record(route)?.meta)
    const title = record(meta?.navigationBar)?.titleText ?? meta?.navigationBarTitleText ?? page?.navigationBarTitleText
    return typeof title === 'string' ? title : null
  } catch { return null }
}

/** 安装一个全局 Vue mixin，以 WeakMap 保存宿主页面与桥接器的对应关系；核心仅接收路由、query 和标题快照。 */
export function installUniAppLifecycle(app: UniAppVueApp, target: LifecycleTarget, options: Readonly<{ host?: unknown; miniprogram?: MiniProgramTarget; unimp?: boolean }> = {}): void {
  const host = record(options.host ?? (globalThis as Record<string, unknown>).uni)
  const miniprogram = options.miniprogram
  const appBridge = createAppLifecycleBridge(target)
  let launch: AppEntrySnapshot | null = null
  let firstShow = true
  const isApp = (instance: VueInstance) => options.miniprogram === undefined && !options.unimp ? !isPage(instance)
    : (instance.$mpType ?? record(instance.$options)?.mpType) === 'app'
  const entry = (value: unknown, launching: boolean): AppEntrySnapshot => {
    if (options.miniprogram === undefined) return appEntrySnapshot(value)
    const supplied = record(value)
    const fallback = host === null ? {} : readHostRecord(host, launching ? 'getLaunchOptionsSync' : 'getEnterOptionsSync')
    const source = typeof supplied?.path === 'string' && supplied.path !== '' ? supplied
      : typeof fallback.path === 'string' && fallback.path !== '' ? {
        path: fallback.path,
        query: Object.keys(record(fallback.query) ?? {}).length > 0 ? fallback.query : supplied?.query ?? fallback.query,
        scene: fallback.scene ?? supplied?.scene,
        referrerInfo: Object.keys(entryReferrer(fallback, miniprogram) ?? {}).length > 0 ? entryReferrer(fallback, miniprogram) : entryReferrer(supplied, miniprogram),
      } : supplied ?? {}
    const snapshot = appEntrySnapshot(source, options.miniprogram)
    if (!launching && firstShow && snapshot.path === null && launch !== null) return launch
    return snapshot
  }
  const pages = new WeakMap<object, PageBridge>()
  let nextPageId = 1
  let currentPage: VueInstance | null = null
  const titles = new WeakMap<object, string>()
  const titleCallbacks = new WeakMap<object, unknown>()

  /** 按页面实例缓存桥接器，为同路由的不同实例分配独立标识。 */
  const pageBridge = (instance: VueInstance): PageBridge | null => {
    if (!isPage(instance, miniprogram !== undefined)) return null
    const existing = pages.get(instance)
    if (existing !== undefined) return existing
    const route = routeOf(instance, miniprogram !== undefined)
    if (route === null) return null
    const instanceId = options.unimp ? `unimp-page-${nextPageId++}` : `${route}-${nextPageId++}`
    const bridge = createPageLifecycleBridge(target, instanceId, options.miniprogram)
    pages.set(instance, bridge)
    return bridge
  }

  app.mixin({
    onLaunch: isolatedLifecycleHook(function(this: VueInstance, options: unknown) {
      if (isApp(this)) {
        launch = entry(options, true)
        firstShow = true
        target.onAppLaunch(launch)
      }
    }),
    onShow: isolatedLifecycleHook(function(this: VueInstance, options: unknown) {
      const bridge = pageBridge(this)
      if (bridge !== null) {
        currentPage = this
        bridge.onShow(typeof this.gioPageTitle === 'string' ? this.gioPageTitle : titles.get(this) ?? pageTitle(this, miniprogram === undefined))
      }
      else if (isApp(this)) { target.onAppShow(entry(options, false)); firstShow = false }
    }),
    onHide: isolatedLifecycleHook(function(this: VueInstance) {
      try {
        const bridge = pageBridge(this)
        if (bridge !== null) bridge.onHide()
        else if (isApp(this)) appBridge.onHide()
      } finally { if (currentPage === this) currentPage = null }
    }),
    onLoad: isolatedLifecycleHook(function(this: VueInstance, query: unknown) {
      const bridge = pageBridge(this)
      const route = routeOf(this, miniprogram !== undefined)
      if (bridge !== null && route !== null) { currentPage = this; bridge.onLoad(route, query) }
    }),
    onUnload: isolatedLifecycleHook(function(this: VueInstance) {
      try { pageBridge(this)?.onUnload() }
      finally {
        pages.delete(this)
        titles.delete(this)
        if (currentPage === this) currentPage = null
      }
    }),
    onTabItemTap: isolatedLifecycleHook(function(this: VueInstance, options: unknown) {
      pageBridge(this)?.onTabItemTap(options)
    }),
  })

  try {
    if (typeof host?.addInterceptor === 'function') {
      host.addInterceptor('setNavigationBarTitle', {
        /** 仅在标题设置成功后更新对应页面快照，并保留原业务成功回调。 */
        invoke(options: unknown) {
          try {
            const args = record(options)
            const page = currentPage
            if (args === null || page === null || typeof args.title !== 'string') return
            const title = args.title
            const previous = args.success
            // 宿主参数可能重复用于多次调用；剥离自己的旧包装，避免回放过期标题及递归增长。
            const success = typeof previous === 'function' && titleCallbacks.has(previous) ? titleCallbacks.get(previous) : previous
            const wrapped = function(this: unknown, ...values: unknown[]) {
              try {
                if (pages.has(page)) {
                  titles.set(page, title)
                  pages.get(page)?.onTitleChanged(typeof page.gioPageTitle === 'string' ? page.gioPageTitle : title)
                }
              } catch { /* 采集状态更新不得影响业务回调。 */ }
              if (typeof success === 'function') return success.apply(this, values)
            }
            titleCallbacks.set(wrapped, success)
            args.success = wrapped
          } catch { /* 不可写的宿主参数保持原样。 */ }
        },
      })
    }
  } catch { /* 标题增强不可用时，基础生命周期仍正常安装。 */ }
}

export interface AppLifecycleTarget {
  /** 接纳 App 启动入口快照，建立冷启动边界。 */
  onAppLaunch(entry: AppEntrySnapshot): boolean
  /** 接纳前台入口快照，按会话规则决定是否生成 VISIT。 */
  onAppShow(entry: AppEntrySnapshot): boolean
  /** 接纳后台观察，尽力生成关闭事件并刷新队列。 */
  onAppHide(): boolean
}



/** 将 query 支持的基础值转为字符串；复杂值不进入路由快照。 */
function scalar(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** App 和 Page 桥接共用 query 序列化规则，避免保留原始宿主参数对象。 */
export function querySnapshot(value: unknown): string | null {
  if (typeof value === 'string') return value
  const query = record(value)
  if (query === null) return null
  try {
    return Object.keys(query).flatMap((key) => {
      try {
        const normalized = scalar(query[key])
        return normalized === null ? [] : [`${encodeURIComponent(key)}=${encodeURIComponent(normalized)}`]
      } catch {
        // 单个宿主字段损坏时仍保留其余有效路由上下文。
        return []
      }
    }).join('&')
  } catch { return null }
}

/** 将 App 生命周期参数裁剪为纯 JSON 入口，省略不支持的 query 值。 */
export function appEntrySnapshot(options: unknown, target?: MiniProgramTarget): AppEntrySnapshot {
  const source = record(options)
  const path = typeof source?.path === 'string' && source.path.length > 0 ? source.path : null
  if (target === undefined) return { path, query: querySnapshot(source?.query) }
  const referrer = entryReferrer(source, target)
  const query = miniProgramQueryRecord(source?.query)
  let shoppingScene: string | null = null
  try { shoppingScene = miniProgramScene(query?.wxShoppingListScene) } catch { /* 单字段读取失败时仍采用原始场景。 */ }
  return {
    path: path?.replace(/^\/+/, '') ?? null,
    query: miniProgramQuery(query, referrer?.extraData),
    scene: shoppingScene ?? miniProgramScene(source?.scene),
    referralPage: typeof referrer?.appId === 'string' ? referrer.appId : null,
  }
}

function miniProgramScene(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function miniProgramQueryRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value)
  const query: Record<string, unknown> = Object.create(null)
  for (const part of value.split('&')) {
    try {
      const index = part.indexOf('=')
      const key = decodeURIComponent(index < 0 ? part : part.slice(0, index))
      if (key !== '') query[key] = decodeURIComponent(index < 0 ? '' : part.slice(index + 1))
    } catch { /* 损坏的 URL 编码不进入入口快照。 */ }
  }
  return query
}

/** 对齐小程序入口参数清理；附加参数不覆盖 query，单字段损坏不影响其余字段。 */
function miniProgramQuery(value: unknown, extraData: unknown): string {
  const result: Record<string, unknown> = Object.create(null)
  const dirty = ['wxShoppingListScene', '$taroTimestamp', 'gdpCircleRoomCollectUrl']
  const parse = (source: unknown): Record<string, unknown> | null => {
    if (typeof source !== 'string') return record(source)
    try { return record(JSON.parse(source)) } catch { return null }
  }
  const query = miniProgramQueryRecord(value)
  for (const source of [query, parse(extraData)]) {
    if (source === null) continue
    for (const key of Object.keys(source)) {
      try {
        if (source !== query && query !== null && Object.prototype.hasOwnProperty.call(query, key)) continue
        const value = source[key]
        if (Object.prototype.hasOwnProperty.call(result, key) || dirty.some(part => key.includes(part) || typeof value === 'string' && value.includes(part))) continue
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) result[key] = value
      } catch { /* 宿主参数访问失败时保留其余有效字段。 */ }
    }
  }
  return querySnapshot(result) ?? ''
}

/** 为 App 的三个生命周期钩子提供桥接，不将宿主或 Vue 对象传入核心。 */
export function createAppLifecycleBridge(target: AppLifecycleTarget): Readonly<{
  /** 裁剪宿主启动参数后转发给运行时。 */
  onLaunch: (options: unknown) => boolean
  /** 转发显示状态及当前入口或页面标题。 */
  onShow: (options: unknown) => boolean
  /** 转发隐藏状态，由对应生命周期决定影响范围。 */
  onHide: () => boolean
}> {
  return {
    /** 转发经过裁剪的启动入口信息，由运行时建立冷启动边界。 */
    onLaunch: (options) => target.onAppLaunch(appEntrySnapshot(options)),
    /** 转发显示生命周期；页面路径只接受有效的可选标题。 */
    onShow: (options) => target.onAppShow(appEntrySnapshot(options)),
    /** 转发隐藏生命周期，由 App 或 Page 路由维护各自状态。 */
    onHide: () => target.onAppHide(),
  }
}

export interface PageLifecycleTarget {
  /** 登记由页面实例绑定的路由、query 和来源快照。 */
  onPageLoad(input: PageLoadInput): boolean
  /** 更新该页面实例的显示时间与可选标题。 */
  onPageShow(instanceId: string, title: string | null): boolean
  /** 清除该实例的当前页面关联。 */
  onPageHide(instanceId: string): boolean
  /** 释放该页面实例的状态。 */
  onPageUnload(instanceId: string): boolean
  /** 可选标题增强，只更新指定页面快照。 */
  onPageTitleChanged?(instanceId: string, title: string): boolean
  /** 可选自动采集入口，由运行时继续执行全部门控。 */
  autoTrack?(call: AutoTrackCall): boolean
}

/** 只接受非空路由字符串，避免将宿主对象带入核心状态。 */
function routeSnapshot(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}



/** 将宿主 tab 下标转换为协议的一基下标，构建第二版结构点击探针。 */
function tabClickCall(value: unknown): AutoTrackCall | null {
  const source = record(value)
  const index = source?.index
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= 2147483646) return null
  const text = source?.text
  const pagePath = source?.pagePath
  if ((text != null && typeof text !== 'string') || (pagePath != null && typeof pagePath !== 'string')) return null
  return {
    schemaVersion: 2,
    source: 'tabbar',
    kind: 'click',
    xpath: '#onTabItemTap',
    index: index + 1,
    ...(typeof text === 'string' ? { textValue: text } : {}),
    ...(typeof pagePath === 'string' ? { hyperlink: pagePath } : {}),
  }
}

/** 将宿主页面实例绑定到稳定标识，调用方只提交快照，不传入 Vue 或 Page 对象。 */
export function createPageLifecycleBridge(target: PageLifecycleTarget, instanceId: string, miniprogram?: MiniProgramTarget): Readonly<{
  /** 将宿主页面参数转换为纯数据后提交。 */
  onLoad: (route: unknown, query: unknown, referralPage?: unknown) => boolean
  /** 转发显示状态及当前入口或页面标题。 */
  onShow: (title?: unknown) => boolean
  /** 转发隐藏状态，由对应生命周期决定影响范围。 */
  onHide: () => boolean
  /** 转发绑定实例的卸载通知。 */
  onUnload: () => boolean
  /** 规范 tabBar 点击并提交版本化探针。 */
  onTabItemTap: (options: unknown) => boolean
  /** 更新绑定页面的标题，不模拟导航。 */
  onTitleChanged: (title: string) => void
}> {
  const stableInstanceId = typeof instanceId === 'string' && instanceId.length > 0 ? instanceId : ''
  return {
    /** 更新绑定页面的标题，不模拟页面重新显示。 */
    onTitleChanged: (title) => { target.onPageTitleChanged?.(stableInstanceId, title) },
    /** 裁剪路由、query 和来源信息，建立当前页面实例的快照。 */
    onLoad: (route, query, referralPage = null) => {
      const normalizedRoute = routeSnapshot(route)
      if (stableInstanceId === '' || normalizedRoute === null) return false
      return target.onPageLoad({
        instanceId: stableInstanceId,
        route: normalizedRoute,
        query: miniprogram === undefined ? querySnapshot(query) ?? '' : miniProgramQuery(query, undefined),
        referralPage: typeof referralPage === 'string' && referralPage.length > 0 ? referralPage : null,
      })
    },
    /** 转发显示生命周期；页面路径只接受有效的可选标题。 */
    onShow: (title = null) => target.onPageShow(stableInstanceId, typeof title === 'string' && title.length > 0 ? title : null),
    /** 转发隐藏生命周期，由 App 或 Page 路由维护各自状态。 */
    onHide: () => target.onPageHide(stableInstanceId),
    /** 释放绑定页面的生命周期状态。 */
    onUnload: () => target.onPageUnload(stableInstanceId),
    /** 校验 tab 点击参数后提交探针；异常或缺少接收端时安全拒绝。 */
    onTabItemTap: (options) => {
      try {
        const call = tabClickCall(options)
        return call === null ? false : target.autoTrack?.(call) ?? false
      } catch { return false }
    },
  }
}
