import { describe, expect, it } from 'vitest'
import { runRuntimeStress } from '../../scripts/sdk-stress-scenarios.js'

describe('SDK 大流量与离线恢复', () => {
  it('一万次在线事件和两万次离线提交后，接纳计数、序号、并发与资源全部一致', async () => {
    const report = await runRuntimeStress()
    expect(report.online.received).toBe(10_005)
    expect(report.offline).toMatchObject({ accepted: 20_000, rejected: 0, received: 20_002, requests: 401, maxActive: 3, active: 0 })
  }, 30_000)
})
