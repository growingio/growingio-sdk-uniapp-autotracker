import { describe, expect, it } from 'vitest'

import { EventSequence } from '../../src/core/dataStore/index.js'

describe('EventSequence', () => {
  it('uses one positive, monotonic sequence for every protocol event that requires it', () => {
    const sequence = new EventSequence(41)

    expect(sequence.next('VISIT')).toBe(42)
    expect(sequence.next('PAGE')).toBe(43)
    expect(sequence.next('CUSTOM')).toBe(44)
    expect(sequence.next('VIEW_CLICK')).toBe(45)
    expect(sequence.next('VIEW_CHANGE')).toBe(46)
    expect(sequence.current()).toStrictEqual({ eventSequenceId: 46 })
  })

  it('does not allocate a sequence for non-sequenced events', () => {
    const sequence = new EventSequence()
    expect(sequence.next('LOGIN_USER_ATTRIBUTES')).toBeNull()
    expect(sequence.next('APP_CLOSED')).toBeNull()
    expect(sequence.current()).toStrictEqual({ eventSequenceId: 0 })
  })

  it('recovers a corrupted stored value as an empty counter and refuses overflow', () => {
    expect(new EventSequence(-1).next('VISIT')).toBe(1)
    expect(new EventSequence(1.5).next('VISIT')).toBe(1)
    expect(() => new EventSequence(Number.MAX_SAFE_INTEGER).next('VISIT')).toThrow('event_sequence_overflow')
  })
})
