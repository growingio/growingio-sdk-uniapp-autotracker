import { describe, expect, it } from 'vitest'

import {
  APP_ALLOWED_FIELDS,
  APP_COMMON_REQUIRED_FIELDS,
  APP_EVENT_FIXTURES,
  APP_EVENT_REQUIRED_FIELDS,
  APP_EVENT_TYPES,
  APP_V1_EXCLUDED_FIELDS,
  EVENT_SEQUENCE_EVENT_TYPES,
  OUTBOUND_SANITIZATION_VECTORS,
} from '../contracts/app-protocol.fixture.js'
import type { AppEventType } from '../contracts/app-protocol.fixture.js'

describe('App Protocol fixture', () => {
  it('covers every App event with only allowed fields and all required fields', () => {
    for (const eventType of APP_EVENT_TYPES) {
      const event = APP_EVENT_FIXTURES[eventType]
      const allowed = new Set(APP_ALLOWED_FIELDS[eventType])

      expect(Object.keys(event).every((key) => allowed.has(key))).toBe(true)
      expect(APP_COMMON_REQUIRED_FIELDS.every((key) => key in event)).toBe(true)
      expect(APP_EVENT_REQUIRED_FIELDS[eventType].every((key) => key in event)).toBe(true)
    }
  })

  it('keeps eventSequenceId only on its five eligible event types', () => {
    for (const eventType of APP_EVENT_TYPES) {
      expect('eventSequenceId' in APP_EVENT_FIXTURES[eventType]).toBe(
        (EVENT_SEQUENCE_EVENT_TYPES as readonly AppEventType[]).includes(eventType),
      )
    }
  })

  it('keeps title/referral PAGE-only and index/hyperlink out of VIEW_CHANGE', () => {
    for (const eventType of APP_EVENT_TYPES) {
      const event = APP_EVENT_FIXTURES[eventType]
      expect('title' in event).toBe(eventType === 'PAGE')
      expect('referralPage' in event).toBe(eventType === 'PAGE')
    }

    expect(APP_ALLOWED_FIELDS.VIEW_CHANGE).not.toContain('index')
    expect(APP_ALLOWED_FIELDS.VIEW_CHANGE).not.toContain('hyperlink')
  })

  it('excludes native-enhancement fields from the 1.0 base event contract', () => {
    for (const event of Object.values(APP_EVENT_FIXTURES)) {
      for (const field of APP_V1_EXCLUDED_FIELDS) {
        expect(field in event).toBe(false)
      }
    }
  })

  it('preserves the outbound-sanitization vectors for zero and string false', () => {
    for (const vector of OUTBOUND_SANITIZATION_VECTORS) {
      const expected = new Set<string>(vector.expectedKeys)
      for (const [key, value] of Object.entries(vector.input)) {
        const shouldRemain = value !== '' && value !== null && !Array.isArray(value) && !(typeof value === 'object')
        expect(expected.has(key)).toBe(shouldRemain)
      }
    }
  })
})
