import { describe, expect, it } from 'vitest'

import { hydrateTrackerState } from '../../src/core/lifecycle.js'

const context = {
  platform: 'Android' as const, platformVersion: '14', domain: 'com.example', appState: 'FOREGROUND' as const,
  appName: 'Example', networkState: 'WIFI' as const, screenWidth: 1080, screenHeight: 1920,
  deviceBrand: 'brand', deviceModel: 'model', deviceType: 'PHONE' as const, appVersion: '1.0', language: 'zh-CN', sdkVersion: '0.1',
}

describe('hydrateTrackerState', () => {
  it('waits for every independent record plus SystemContext before becoming ready', async () => {
    let releaseIdentity: ((value: { identity: { deviceId: string; userId: null; userKey: null }; source: 'restored' }) => void) | undefined
    const identity = new Promise<{ identity: { deviceId: string; userId: null; userKey: null }; source: 'restored' }>((resolve) => { releaseIdentity = resolve })
    const result = hydrateTrackerState({
      hydrateIdentity: () => identity,
      hydrateSession: async () => ({ snapshot: null, source: 'missing' }),
      hydrateMeta: async () => ({ snapshot: { eventSequenceId: 4 }, source: 'restored' }),
      hydrateQueue: async () => 'restored',
      loadSystemContext: async () => context,
    })
    releaseIdentity?.({ identity: { deviceId: 'visitor', userId: null, userKey: null }, source: 'restored' })
    await expect(result).resolves.toMatchObject({ ok: true, state: { meta: { snapshot: { eventSequenceId: 4 } }, systemContext: context } })
  })

  it('keeps the tracker unready if SystemContext cannot resolve', async () => {
    await expect(hydrateTrackerState({
      hydrateIdentity: async () => ({ identity: { deviceId: 'visitor', userId: null, userKey: null }, source: 'generated' }),
      hydrateSession: async () => ({ snapshot: null, source: 'missing' }),
      hydrateMeta: async () => ({ snapshot: { eventSequenceId: 0 }, source: 'missing' }),
      hydrateQueue: async () => 'missing',
      loadSystemContext: async () => { throw new Error('unavailable') },
    })).resolves.toStrictEqual({ ok: false, code: 'system_context_unavailable' })
  })
})
