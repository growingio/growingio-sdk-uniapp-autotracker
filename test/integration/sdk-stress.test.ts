import { describe, expect, it } from 'vitest'
import { runRuntimeStress } from '../../scripts/sdk-stress-scenarios.js'
import { APP_QUEUE_MAX_ITEMS } from '../../src/core/queue.js'

describe('SDK 大流量与离线恢复', () => {
  it('一万次在线事件和两万次离线提交后，接纳计数、序号、并发与资源全部一致；离线积压按上限保留最新事件', async () => {
    const report = await runRuntimeStress()
    expect(report.online.received).toBe(10_005)
    expect(report.offline).toMatchObject({ accepted: 20_000, rejected: 0, maxActive: 3, active: 0, lastSequence: 20_002 })
    expect(report.offline.received).toBeGreaterThan(0)
    expect(report.offline.received).toBeLessThanOrEqual(APP_QUEUE_MAX_ITEMS)
    expect(report.offline.evicted).toBe(20_002 - report.offline.received)
    expect(report.offline.firstSequence).toBe(report.offline.evicted + 1)
  }, 30_000)
})
