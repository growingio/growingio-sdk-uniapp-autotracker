import { describe, expect, it } from 'vitest'

import { LocationState } from '../../src/core/userStore.js'

describe('LocationState', () => {
  it('accepts the inclusive geographic boundaries including zero', () => {
    const location = new LocationState()
    expect(location.set(0, 0)).toBe(true)
    expect(location.current()).toStrictEqual({ latitude: 0, longitude: 0 })
    expect(location.set(-90, 180)).toBe(true)
    expect(location.current()).toStrictEqual({ latitude: -90, longitude: 180 })
  })

  it('rejects invalid coordinates without replacing the previous location', () => {
    const location = new LocationState()
    location.set(1, 2)
    expect(location.set(Number.NaN, 2)).toBe(false)
    expect(location.set(91, 2)).toBe(false)
    expect(location.set(1, -181)).toBe(false)
    expect(location.current()).toStrictEqual({ latitude: 1, longitude: 2 })
  })

  it('clears only in-memory state', () => {
    const location = new LocationState()
    location.set(1, 2)
    location.clear()
    expect(location.current()).toBeNull()
  })
})
