import { describe, expect, it } from 'vitest'

import { OrientationResolver } from '../../src/core/dataStore/page.js'

describe('OrientationResolver', () => {
  it('uses standard orientation before a meaningful window dimension inference', () => {
    const resolver = new OrientationResolver()
    expect(resolver.resolve({ deviceOrientation: 'portrait', windowWidth: 1200, windowHeight: 800 })).toBe('PORTRAIT')
    expect(resolver.resolve({ windowWidth: 1200, windowHeight: 800 })).toBe('LANDSCAPE')
  })

  it('uses its last real observation and only then falls back to PORTRAIT', () => {
    const resolver = new OrientationResolver()
    expect(resolver.resolve({})).toBe('PORTRAIT')
    expect(resolver.resolve({ deviceOrientation: 'landscape' })).toBe('LANDSCAPE')
    expect(resolver.resolve({ windowWidth: 0, windowHeight: 100 })).toBe('LANDSCAPE')
  })
})
