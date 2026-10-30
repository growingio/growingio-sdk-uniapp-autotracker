import { describe, expect, it } from 'vitest'

import {
  ENTRY_VISIT_FIXTURE,
  PAGE_CONTEXT_EVENT_TYPES,
  PAGE_CONTEXT_FIXTURE,
  PAGE_CONTEXT_VECTORS,
} from '../contracts/page-context.fixture.js'

describe('page and entry context fixture', () => {
  it('keeps page-bound events on the onLoad snapshot', () => {
    expect(PAGE_CONTEXT_EVENT_TYPES).toContain('PAGE')
    expect(PAGE_CONTEXT_EVENT_TYPES).toContain('APP_CLOSED')
    expect(PAGE_CONTEXT_FIXTURE.pageKey).not.toBe(PAGE_CONTEXT_FIXTURE.route)
    expect(PAGE_CONTEXT_FIXTURE.query).toBe('id=42&from=card')
  })

  it('prevents a VISIT from taking the current page query', () => {
    const visit = PAGE_CONTEXT_VECTORS.find((vector) => vector.eventType === 'VISIT')

    expect(visit?.expected).toStrictEqual(ENTRY_VISIT_FIXTURE)
    expect(visit?.expected.query).not.toBe(PAGE_CONTEXT_FIXTURE.query)
  })

  it('allows referralPage only on the PAGE vector', () => {
    for (const vector of PAGE_CONTEXT_VECTORS) {
      expect('referralPage' in vector.expected && vector.expected.referralPage !== undefined).toBe(
        vector.eventType === 'PAGE',
      )
    }
  })
})
