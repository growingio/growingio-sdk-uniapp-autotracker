import { describe, expect, it } from 'vitest'

import { guid } from '../../src/utils/tools.js'

describe('guid', () => {
  it('generates the mini-program SDK UUID v4 format', () => {
    const value = guid()
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
