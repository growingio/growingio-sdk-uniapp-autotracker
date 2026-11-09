import { describe, expect, it } from 'vitest'

import { CHANGE_ELEMENTS } from '../../src/plugins/gioEventAutoTracking/contract.js'
import { allAppCapabilityProfiles, appCapabilityProfile } from '../../src/constants/platform.js'

describe('App capability profiles', () => {
  it('enables automatic interactions in production only on HarmonyOS', () => {
    expect(allAppCapabilityProfiles()).toHaveLength(3)
    expect(appCapabilityProfile('HarmonyOS')).toStrictEqual({
      platform: 'HarmonyOS', appLifecycle: false, pageLifecycle: false, autoClick: true,
      autoChange: Object.fromEntries(CHANGE_ELEMENTS.map((element) => [element, true])),
      changeInput: true, changePicker: true, tabBar: true, appClosedBestEffort: false,
    })
    for (const platform of ['Android', 'iOS']) {
      const profile = appCapabilityProfile(platform)
      expect(profile).toMatchObject({ autoClick: false, changeInput: false, changePicker: false, tabBar: false })
      expect(Object.values(profile!.autoChange)).toEqual(CHANGE_ELEMENTS.map(() => false))
    }
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
