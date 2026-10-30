import { describe, expect, it } from 'vitest'

import { EVENT_SEQUENCE_EVENT_TYPES } from '../contracts/app-protocol.fixture.js'
import {
  EVENT_SEQUENCE_ASSIGNMENT_VECTORS,
  EVENT_SEQUENCE_META_FIXTURE,
  EVENT_SEQUENCE_MIGRATION_VECTORS,
  GIO_STORAGE_PREFIX,
} from '../contracts/event-sequence.fixture.js'

describe('persistent eventSequenceId fixture', () => {
  it('uses the versioned SDK meta envelope and a positive stored sequence', () => {
    expect(GIO_STORAGE_PREFIX).toBe('gio:v1:')
    expect(EVENT_SEQUENCE_META_FIXTURE).toStrictEqual({
      version: 1,
      expiresAt: null,
      value: { eventSequenceId: 41 },
    })
  })

  it('covers continuation, first initialization, and corrupt-meta recovery', () => {
    expect(EVENT_SEQUENCE_MIGRATION_VECTORS.map((vector) => vector.expectedNextSequenceId)).toStrictEqual([42, 1, 1])
    expect(EVENT_SEQUENCE_MIGRATION_VECTORS[2]).toMatchObject({ diagnostic: 'meta_corrupt' })
  })

  it('assigns a sequence exactly for the protocol-eligible event types', () => {
    expect(
      EVENT_SEQUENCE_ASSIGNMENT_VECTORS.filter((vector) => vector.assignsSequenceId).map((vector) => vector.eventType),
    ).toStrictEqual(EVENT_SEQUENCE_EVENT_TYPES)
  })
})
