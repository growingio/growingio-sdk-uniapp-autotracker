import { describe, expect, it } from 'vitest'

import { CHANGE_ELEMENTS } from '../../src/plugins/gioEventAutoTracking/contract.js'
import { allAppCapabilityProfiles, appCapabilityProfile } from '../../src/constants/platform.js'

describe('App capability profiles', () => {
  it('keeps every unverified App feature disabled until device evidence is recorded', () => {
    expect(allAppCapabilityProfiles()).toHaveLength(3)
    expect(appCapabilityProfile('HarmonyOS')).toStrictEqual({
      platform: 'HarmonyOS', appLifecycle: false, pageLifecycle: false, autoClick: false,
      autoChange: Object.fromEntries(CHANGE_ELEMENTS.map((element) => [element, false])),
      changeInput: false, changePicker: false, tabBar: false, appClosedBestEffort: false,
    })
  })

  it('opens a separate verification profile without changing the acceptance matrix', () => {
    const profile = appCapabilityProfile('Android', true)
    expect(profile?.autoClick).toBe(true)
    expect(profile?.tabBar).toBe(true)
    expect(Object.values(profile?.autoChange ?? {})).toEqual(CHANGE_ELEMENTS.map(() => true))
    expect(appCapabilityProfile('Android')?.autoClick).toBe(false)
    expect(appCapabilityProfile('Android')?.autoChange.input).toBe(false)
  })

  it('does not invent a profile for unsupported platforms', () => {
    for (const platform of ['web', 'toString', '__proto__']) expect(appCapabilityProfile(platform)).toBeNull()
  })
})
