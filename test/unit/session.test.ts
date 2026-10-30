import { describe, expect, it } from 'vitest'

import { SessionManager } from '../../src/core/userStore.js'

/** 顺序生成确定的会话标识，便于区分续用与新建会话。 */
function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? 'unexpected-id'
}

describe('SessionManager', () => {
  it.each(['user', 'collection'])('后台因 %s 换会话后，仍按离开时间判断超时', (reason) => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('initial', 'background', 'resumed'))
    session.resume(1)
    session.hide(100)
    const transition = reason === 'user' ? session.onUserIdChange('A', 'B') : session.onCollectionResumed()
    expect(transition.snapshot).toEqual({ sessionId: 'background', lastCloseTime: 100 })
    expect(session.resume(30_101)).toMatchObject({ startedNew: true, reason: 'timeout', snapshot: { sessionId: 'resumed', lastCloseTime: null } })
  })

  it('后台更新身份后，超时边界内仍沿用新身份会话', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('initial', 'background'))
    session.resume(1)
    session.hide(100)
    session.onUserIdChange('A', 'B')
    expect(session.resume(30_100)).toMatchObject({ startedNew: false, snapshot: { sessionId: 'background', lastCloseTime: null } })
  })

  it('starts the first session and keeps it across an App.onShow without a close time', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('first'))

    expect(session.resume(1)).toMatchObject({ startedNew: true, reason: 'initial', snapshot: { sessionId: 'first', lastCloseTime: null } })
    expect(session.resume(2)).toMatchObject({ startedNew: false, reason: null, snapshot: { sessionId: 'first', lastCloseTime: null } })
  })

  it('replaces a persisted session when a new App process launches', () => {
    const session = new SessionManager(
      { timeoutMs: 30_000 },
      ids('fresh'),
      { sessionId: 'persisted', lastCloseTime: 100 },
    )

    expect(session.onProcessLaunch()).toMatchObject({
      startedNew: true,
      reason: 'cold_start',
      snapshot: { sessionId: 'fresh', lastCloseTime: null },
    })
  })

  it('records App.onHide and resumes the same session through the exact timeout boundary', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('first', 'second'))
    session.resume(1)
    expect(session.hide(100)).toStrictEqual({ sessionId: 'first', lastCloseTime: 100 })
    expect(session.resume(30_100)).toMatchObject({ startedNew: false, snapshot: { sessionId: 'first', lastCloseTime: null } })

    session.hide(31_000)
    expect(session.resume(61_001)).toMatchObject({ startedNew: true, reason: 'timeout', snapshot: { sessionId: 'second', lastCloseTime: null } })
  })

  it('does not turn a clock rollback into a new session', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('first', 'unexpected'))
    session.resume(100)
    session.hide(200)
    expect(session.resume(199)).toMatchObject({ startedNew: false, snapshot: { sessionId: 'first', lastCloseTime: null } })
  })

  it('only starts a session when one logged-in user changes to another', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('first', 'second'))
    session.resume(1)

    expect(session.onUserIdChange(null, 'A').startedNew).toBe(false)
    expect(session.onUserIdChange('A', 'A').startedNew).toBe(false)
    expect(session.onUserIdChange('A', '').startedNew).toBe(false)
    expect(session.onUserIdChange('A', 'B')).toMatchObject({ startedNew: true, reason: 'user_changed', snapshot: { sessionId: 'second' } })
  })

  it('remembers the last logged-in user through logout and renews only for a different login', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('first', 'second'))
    session.resume(1)
    expect(session.onUserIdChange(null, 'A').startedNew).toBe(false)
    expect(session.onUserIdChange('A', null).startedNew).toBe(false)
    expect(session.onUserIdChange(null, 'A').startedNew).toBe(false)
    session.onUserIdChange('A', null)
    expect(session.onUserIdChange(null, 'B')).toMatchObject({ startedNew: true, reason: 'user_changed', snapshot: { sessionId: 'second' } })
  })

  it('compares accepted user IDs without trimming whitespace', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('first', 'second', 'third'))
    session.resume(1)
    session.onUserIdChange(null, 'A')
    expect(session.onUserIdChange('A', ' ')).toMatchObject({ startedNew: true, snapshot: { sessionId: 'second' } })
    session.onUserIdChange(' ', null)
    expect(session.onUserIdChange(null, 'B')).toMatchObject({ startedNew: true, snapshot: { sessionId: 'third' } })
  })

  it('always starts a new session when collection resumes', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids('fresh'))
    expect(session.onCollectionResumed()).toMatchObject({ startedNew: true, reason: 'collection_resumed', snapshot: { sessionId: 'fresh', lastCloseTime: null } })
  })

  it('rejects invalid timestamps and an empty session id from the injected factory', () => {
    const session = new SessionManager({ timeoutMs: 30_000 }, ids(''))
    expect(() => session.resume(-1)).toThrow('invalid_session_timestamp')
    expect(() => session.resume(0)).toThrow('session_id_factory_returned_empty')
  })
})
