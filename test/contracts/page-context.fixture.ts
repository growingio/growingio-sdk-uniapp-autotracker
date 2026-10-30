/** 阶段 0 的页面与入口数据边界；阶段 3 的运行时以此实现页面状态存储。 */
export type PageContextEventType = 'PAGE' | 'CUSTOM' | 'VIEW_CLICK' | 'VIEW_CHANGE' | 'APP_CLOSED'

export type PageContextSnapshot = Readonly<{
  pageKey: string
  route: string
  query: string
  title: string | null
  referralPage: string | null
  shownAt: number
}>

export const PAGE_CONTEXT_FIXTURE: PageContextSnapshot = {
  pageKey: 'page-1',
  route: 'pages/detail/index',
  query: 'id=42&from=card',
  title: '详情',
  referralPage: 'pages/index/index',
  shownAt: 1_700_000_000_000,
}

export const PAGE_CONTEXT_EVENT_TYPES: readonly PageContextEventType[] = [
  'PAGE',
  'CUSTOM',
  'VIEW_CLICK',
  'VIEW_CHANGE',
  'APP_CLOSED',
]

export const ENTRY_VISIT_FIXTURE = {
  path: 'pages/landing/index',
  query: 'campaign=summer',
} as const

export const PAGE_CONTEXT_VECTORS = [
  {
    name: 'PAGE 复用 onLoad query 与冻结 referral',
    eventType: 'PAGE' as const,
    expected: {
      path: PAGE_CONTEXT_FIXTURE.route,
      query: PAGE_CONTEXT_FIXTURE.query,
      referralPage: PAGE_CONTEXT_FIXTURE.referralPage,
    },
  },
  {
    name: 'CUSTOM 复用当前 page query，不携带 referral',
    eventType: 'CUSTOM' as const,
    expected: {
      path: PAGE_CONTEXT_FIXTURE.route,
      query: PAGE_CONTEXT_FIXTURE.query,
      referralPage: undefined,
    },
  },
  {
    name: 'VISIT 只取 App onShow 入口，不读取当前页面 query',
    eventType: 'VISIT' as const,
    expected: ENTRY_VISIT_FIXTURE,
  },
] as const
