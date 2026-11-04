import { describe, expect, it } from 'vitest'

import { appSystem, runtimeFixture } from '../support/runtime-fixture.js'

describe('异步恢复失败后的重新初始化', () => {
  it('失败期间拒绝业务事件、暂存生命周期；重新 init 成功后回放并生成首个会话', async () => {
    let available = false
    const { tracker } = runtimeFixture({ systemContext: { load: async () => {
      if (!available) throw new Error('unsupported_platform')
      return appSystem
    } } })
    expect(tracker.init({ accountId: 'account', dataSourceId: 'source' })).toBe(true)
    expect(await tracker.whenReady()).toBe(false)
    expect(tracker.failed()).toBe(true)
    expect(tracker.canRetryInit()).toBe(true)
    expect(tracker.track('while_failed')).toBe(false)
    expect(tracker.onAppLaunch({ path: 'pages/home', query: '' })).toBe(true)
    expect(tracker.onAppShow({ path: 'pages/home', query: '' })).toBe(true)
    expect(tracker.setUserId('user-1')).toBe(true)

    available = true
    expect(tracker.init({ accountId: 'account', dataSourceId: 'source' })).toBe(true)
    expect(tracker.failed()).toBe(false)
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.canRetryInit()).toBe(false)
    expect(tracker.track('after_retry')).toBe(true)
    expect(tracker.queuedEvents().map(event => event.eventName ?? event.eventType)).toEqual(['VISIT', 'after_retry'])
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ userId: 'user-1' })
    expect(tracker.init({ accountId: 'account', dataSourceId: 'source' })).toBe(false)
  })

  it('配置非法的重试保持失败状态，之后仍可用合法配置重试', async () => {
    let available = false
    const { tracker } = runtimeFixture({ systemContext: { load: async () => {
      if (!available) throw new Error('unsupported_platform')
      return appSystem
    } } })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await tracker.whenReady()
    expect(tracker.init({ accountId: '', dataSourceId: 'source' })).toBe(false)
    expect(tracker.canRetryInit()).toBe(true)
    available = true
    expect(tracker.init({ accountId: 'account', dataSourceId: 'source' })).toBe(true)
    expect(await tracker.whenReady()).toBe(true)
  })
})
