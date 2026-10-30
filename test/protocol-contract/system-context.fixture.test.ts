import { describe, expect, it } from 'vitest'

import { DYNAMIC_CONTEXT_VECTORS, SYSTEM_CONTEXT_VECTORS } from '../contracts/system-context.fixture.js'

describe('SystemContext fixture', () => {
  it('covers all three first-release App platforms and rejects non-App hosts', () => {
    expect(SYSTEM_CONTEXT_VECTORS.map((vector) => vector.platform)).toStrictEqual([
      'Android',
      'iOS',
      'HarmonyOS',
      'unsupported',
    ])
    expect(SYSTEM_CONTEXT_VECTORS[3]?.expected).toStrictEqual({ initError: 'unsupported_platform' })
  })

  it('keeps defined fallback values explicit instead of omitting the decision', () => {
    const harmony = SYSTEM_CONTEXT_VECTORS[2]?.expected
    expect(harmony).toMatchObject({
      platformVersion: 'UNKNOWN',
      screenWidth: 0,
      screenHeight: 0,
      language: 'und',
    })
  })

  it('records per-event timezone and lifecycle context separately from stable system context', () => {
    expect(DYNAMIC_CONTEXT_VECTORS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ timezoneOffset: '-480' }),
        expect.objectContaining({ timezoneOffset: '0' }),
        expect.objectContaining({ appState: 'BACKGROUND' }),
      ]),
    )
  })
})
