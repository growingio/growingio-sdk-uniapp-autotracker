import { describe, expect, it } from 'vitest'

import type { AppSystemContext, ClockPort, StoragePort, SystemContextPort, TimezonePort, TransportPort } from '../../src/types/index.js'

describe('阶段 0 ports contract', () => {
  it('keeps stable system context separate from per-event clock and timezone reads', async () => {
    const context: AppSystemContext = {
      platform: 'HarmonyOS',
      platformVersion: '5.0',
      domain: 'com.example.fixture',
      appState: 'FOREGROUND',
      appName: 'Fixture',
      networkState: 'UNKNOWN',
      screenWidth: 0,
      screenHeight: 0,
      deviceBrand: 'UNKNOWN',
      deviceModel: 'UNKNOWN',
      deviceType: 'UNKNOWN',
      appVersion: '',
      language: 'und',
      sdkVersion: '0.1.0',
    }
    const system: SystemContextPort = { load: async () => context }
    const clock: ClockPort = { now: () => 1_700_000_000_000 }
    const timezone: TimezonePort = { getOffsetMinutes: () => -480 }

    expect(await system.load()).toStrictEqual(context)
    expect(clock.now()).toBe(1_700_000_000_000)
    expect(timezone.getOffsetMinutes()).toBe(-480)
  })
})

describe('core ports', () => {
  it('keeps storage and transport as host-owned boundaries', () => {
    const storage: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'missing' }),
      write: async () => ({ kind: 'ok' }),
      remove: async () => ({ kind: 'ok' }),
    }
    const transport: TransportPort = {
      dispatch: (_request, done) => { done({ kind: 'success', status: 204 }) },
    }

    expect(storage.persistentQueue).toBe(true)
    transport.dispatch({ url: 'https://collector.example/v3/projects/a/collect?stm=1&compress=0', method: 'POST', headers: {}, body: '[]', timeoutMs: 5_000 }, (result) => {
      expect(result).toStrictEqual({ kind: 'success', status: 204 })
    })
  })
})
