import { describe, expect, it } from 'vitest'
import { runRecoveryStress } from '../../scripts/sdk-recovery-stress.js'
import { TrackerRuntime } from '../../src/core/growingIO.js'

describe('SDK 多轮冷启动持久化恢复压测', () => {
  it.each(['drop', 'corrupt'] as const)('拒绝把 SDK %s 初始业务事件误判为恢复成功', async (fault) => {
    const originalTrack = TrackerRuntime.prototype.track
    TrackerRuntime.prototype.track = function (eventName, properties) {
      if (eventName === 'recovery_event' && typeof properties === 'object' && properties !== null
        && 'index' in properties && properties.index === 0) {
        if (fault === 'drop') return true
        return originalTrack.call(this, eventName, { ...properties, index: -999 })
      }
      return originalTrack.call(this, eventName, properties)
    }
    try {
      await expect(runRecoveryStress(1, 3)).rejects.toThrow(fault === 'drop'
        ? 'accepted_custom_count_mismatch' : 'custom_event_payload_changed')
    } finally {
      TrackerRuntime.prototype.track = originalTrack
    }
  })

  it('75 轮离线积累、模拟存储写入、重建运行时和重连后，无丢失/重复，身份会话与资源保持一致', async () => {
    const report = await runRecoveryStress()
    expect(report).toMatchObject({
      rounds: 75, eventsPerRound: 150, acceptedCustom: 11_325, recoveredEvents: 11_474,
      received: 11_624, lastSequence: 11_624, requests: 300, maxActive: 3, active: 0, sessions: 224, pendingTimers: 0,
    })
    expect(report.storageWrites).toBeGreaterThan(75 * 4)
  }, 30_000)
})
