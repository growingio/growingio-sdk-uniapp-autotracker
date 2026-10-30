import { EventComposer } from './index.js'
import type { ClockPort } from '../../types/index.js'

export type PageSnapshot = Readonly<{
  pageKey: string
  route: string
  query: string
  title: string | null
  referralPage: string | null
  shownAt: number | null
}>

export type PageLoadInput = Readonly<{
  instanceId: string
  route: string
  query: string
  referralPage: string | null
}>

/** 只保存已归一化的生命周期数据，不保留 Vue 或 Page 实例。 */
export class PageStore {
  private readonly pages = new Map<string, PageSnapshot>()
  private currentInstanceId: string | null = null
  private nextPageNumber = 1
  private readonly automaticReferrals = new Set<string>()
  private lastShownRoute: string | null = null
  private lastShownPageKey: string | null = null

  /** 冻结 onLoad query 与显式来源；自动来源在真实页面切换时更新。 */
  public onLoad(input: PageLoadInput, entryReferral: string | null = null): PageSnapshot | null {
    if (!this.validLoadInput(input)) return null
    const existing = this.pages.get(input.instanceId)
    if (existing !== undefined) return existing
    const snapshot: PageSnapshot = {
      pageKey: `page-${this.nextPageNumber++}`,
      route: input.route,
      query: input.query,
      title: null,
      referralPage: input.referralPage ?? this.lastShownRoute ?? entryReferral,
      shownAt: null,
    }
    if (input.referralPage === null) this.automaticReferrals.add(input.instanceId)
    this.pages.set(input.instanceId, snapshot)
    return snapshot
  }

  /** 真实 onShow 选择当前页面，并更新安全读取到的标题与显示时间。 */
  public onShow(instanceId: string, shownAt: number, title: string | null, entryReferral: string | null = null): PageSnapshot | null {
    if (!Number.isFinite(shownAt) || shownAt < 0 || typeof title !== 'string' && title !== null) return null
    const page = this.pages.get(instanceId)
    if (page === undefined) return null
    const referralPage = this.automaticReferrals.has(instanceId) && this.lastShownRoute !== null && this.lastShownPageKey !== page.pageKey
      ? this.lastShownRoute : this.automaticReferrals.has(instanceId) && this.lastShownRoute === null ? entryReferral ?? page.referralPage : page.referralPage
    const snapshot = { ...page, title, shownAt, referralPage }
    this.pages.set(instanceId, snapshot)
    this.currentInstanceId = instanceId
    this.lastShownRoute = page.route
    this.lastShownPageKey = page.pageKey
    return snapshot
  }

  /** 更新已加载页面的标题，不改变页面来源或显示时间。 */
  public setTitle(instanceId: string, title: string): void {
    const page = this.pages.get(instanceId)
    if (page !== undefined) this.pages.set(instanceId, { ...page, title })
  }

  /** 按实例读取独立快照，供特定运行模式校验元信息而不暴露内部记录。 */
  public snapshot(instanceId: string): PageSnapshot | null {
    const page = this.pages.get(instanceId)
    return page === undefined ? null : { ...page }
  }

  /** 仅替换可裁剪的展示元信息，保持页面身份、路径和生命周期状态。 */
  public replaceMetadata(instanceId: string, metadata: Readonly<Pick<PageSnapshot, 'query' | 'title' | 'referralPage'>>): PageSnapshot | null {
    const page = this.pages.get(instanceId)
    if (page === undefined || typeof metadata.query !== 'string'
      || typeof metadata.title !== 'string' && metadata.title !== null
      || typeof metadata.referralPage !== 'string' && metadata.referralPage !== null) return null
    const updated = { ...page, query: metadata.query, title: metadata.title, referralPage: metadata.referralPage }
    this.pages.set(instanceId, updated)
    return updated
  }

  /** 页面隐藏只解除该实例的当前页关联，不推断 App 进入后台。 */
  public onHide(instanceId: string): void {
    if (this.currentInstanceId === instanceId) this.currentInstanceId = null
  }

  /** 移除页面快照及自动来源标记，并清理指向该实例的当前页引用。 */
  public onUnload(instanceId: string): void {
    this.pages.delete(instanceId)
    this.automaticReferrals.delete(instanceId)
    if (this.currentInstanceId === instanceId) this.currentInstanceId = null
  }

  /** 读取当前可见页面；隐藏后或实例不存在时返回 null。 */
  public current(): PageSnapshot | null {
    if (this.currentInstanceId === null) return null
    return this.pages.get(this.currentInstanceId) ?? null
  }

  /** 恢复采集时刷新 PAGE 显示时间，不模拟导航或修改来源页面。 */
  public refreshCurrentShownAt(shownAt: number): PageSnapshot | null {
    const page = this.current()
    if (page === null || this.currentInstanceId === null || !Number.isFinite(shownAt) || shownAt < 0) return null
    const refreshed = { ...page, shownAt }
    this.pages.set(this.currentInstanceId, refreshed)
    return refreshed
  }

  /** 校验页面实例、路由、query 和可选来源的基础类型。 */
  private validLoadInput(input: PageLoadInput): boolean {
    return typeof input.instanceId === 'string' && input.instanceId.length > 0
      && typeof input.route === 'string' && input.route.length > 0
      && typeof input.query === 'string'
      && (typeof input.referralPage === 'string' || input.referralPage === null)
  }
}

export type PageOrientation = 'PORTRAIT' | 'LANDSCAPE'

export type OrientationInput = Readonly<{
  deviceOrientation?: unknown
  windowWidth?: unknown
  windowHeight?: unknown
}>

/** 将宿主方向字符串转换为协议枚举，其他值返回 null。 */
function normalizedOrientation(value: unknown): PageOrientation | null {
  if (typeof value !== 'string') return null
  const source = value.trim().toLowerCase()
  if (source === 'portrait') return 'PORTRAIT'
  if (source === 'landscape') return 'LANDSCAPE'
  return null
}

/** 通过有效且不相等的窗口宽高推断方向，无法确定时返回 null。 */
function inferredOrientation(width: unknown, height: unknown): PageOrientation | null {
  if (typeof width !== 'number' || typeof height !== 'number'
    || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width === height) return null
  return width > height ? 'LANDSCAPE' : 'PORTRAIT'
}

/** 从宿主快照解析 PAGE 方向，状态中不保留原始宿主对象。 */
export class OrientationResolver {
  private lastObserved: PageOrientation | null = null

  /** 优先采用显式方向或窗口推断，其次保留最近有效值，最终回退竖屏。 */
  public resolve(input: OrientationInput): PageOrientation {
    const observed = normalizedOrientation(input.deviceOrientation) ?? inferredOrientation(input.windowWidth, input.windowHeight)
    if (observed !== null) {
      this.lastObserved = observed
      return observed
    }
    return this.lastObserved ?? 'PORTRAIT'
  }
}

export type PageShowResult = Readonly<{
  page: PageSnapshot | null
  pageQueued: boolean
}>

export type PageLifecycleDependencies = Readonly<{
  pages: PageStore
  composer: EventComposer
  clock: ClockPort
  /** 读取当前页面使用的规范方向值。 */
  orientation: () => PageOrientation
  /** 判断当前意图与采集同意状态是否允许生成 PAGE。 */
  canCollect: () => boolean
  entryReferral?: () => string | null
}>

/** 将已归一化的页面生命周期快照转换为 PAGE，不承担 App 生命周期职责。 */
export class PageLifecycle {
  private replayedPageKey: string | null = null
  /** 注入页面状态、事件组装及采集门控，保持页面逻辑与宿主对象隔离。 */
  public constructor(private readonly dependencies: PageLifecycleDependencies) {}

  /** 登记页面实例的不可变路由和初始 query 快照。 */
  public onLoad(input: PageLoadInput): PageSnapshot | null {
    return this.dependencies.pages.onLoad(input, this.dependencies.entryReferral?.() ?? null)
  }

  /** 以同一时间戳更新当前页的显示时间并生成 PAGE。 */
  public onShow(instanceId: string, title: string | null): PageShowResult {
    const current = this.dependencies.pages.current()
    if (this.replayedPageKey !== null && current?.pageKey === this.replayedPageKey) {
      this.replayedPageKey = null
      const page = this.dependencies.pages.onShow(instanceId, current.shownAt!, title)
      if (page?.pageKey === current.pageKey) return { page, pageQueued: false }
    }
    const page = this.dependencies.pages.onShow(instanceId, this.dependencies.clock.now(), title, this.dependencies.entryReferral?.() ?? null)
    return { page, pageQueued: page !== null && this.emitPage(page) }
  }

  /** 清除该实例的当前页面关联，不将切页误作 App 退后台。 */
  public onHide(instanceId: string): void {
    this.dependencies.pages.onHide(instanceId)
    if (this.dependencies.pages.current()?.pageKey !== this.replayedPageKey) this.replayedPageKey = null
  }

  /** 释放卸载页面的快照与当前页引用。 */
  public onUnload(instanceId: string): void {
    this.dependencies.pages.onUnload(instanceId)
    if (this.dependencies.pages.current()?.pageKey !== this.replayedPageKey) this.replayedPageKey = null
  }

  /** 恢复采集时，在 App 生命周期已生成新 VISIT 后补发当前 PAGE。 */
  public replayCurrentPage(dedupeNextShow = false): boolean {
    if (!this.dependencies.canCollect() || this.dependencies.pages.current() === null) return false
    const page = this.dependencies.pages.refreshCurrentShownAt(this.dependencies.clock.now())
    const queued = page !== null && this.emitPage(page)
    this.replayedPageKey = dedupeNextShow && queued ? page?.pageKey ?? null : null
    return queued
  }

  /** 在允许采集且页面已显示时，携带来源、标题和方向生成 PAGE。 */
  private emitPage(page: PageSnapshot): boolean {
    if (!this.dependencies.canCollect() || page.shownAt === null) return false
    return this.dependencies.composer.compose({
      eventType: 'PAGE',
      timestamp: page.shownAt,
      fields: {
        path: page.route,
        query: page.query,
        title: page.title,
        referralPage: page.referralPage,
        orientation: this.dependencies.orientation(),
      },
    }).ok
  }
}
