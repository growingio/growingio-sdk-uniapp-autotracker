import { describe, expect, it } from 'vitest'

import { TrackerEventGate } from '../../src/core/lifecycle.js'
import { TrackerLifecycle } from '../../src/core/lifecycle.js'
import { BootstrapBuffer } from '../../src/core/lifecycle.js'

const options = { accountId: 'account', dataSourceId: 'source' }

describe('TrackerEventGate', () => {
  it('未初始化的生命周期和重复 release 被拒绝，就绪后的派发异常被隔离', () => {
    const lifecycle = new TrackerLifecycle()
    const gate = new TrackerEventGate(lifecycle)
    const intent = { kind: 'app-show', payload: {} }
    expect(gate.submitLifecycle(intent, () => true)).toBe(false)
    expect(gate.release(() => true)).toBe(false)
    lifecycle.init(options)
    expect(gate.release(() => true)).toBe(true)
    expect(gate.release(() => true)).toBe(false)
    const fail = () => { throw new Error('emitter failure') }
    expect(gate.submit({ kind: 'track', payload: {} }, fail)).toBe(false)
    expect(gate.submitLifecycle(intent, fail)).toBe(false)
    expect(gate.submit({ kind: 'track', payload: {} }, () => true)).toBe(true)
  })
  it('业务字节容量耗尽仍接收生命周期，按跨缓冲原始顺序回放', () => {
    const lifecycle = new TrackerLifecycle()
    const gate = new TrackerEventGate(lifecycle, new BootstrapBuffer({ maxItems: 50, maxBytes: 200 }))
    lifecycle.init(options)
    const emitted: string[] = []
    const emit = (intent: { kind: string }) => { emitted.push(intent.kind); return true }
    expect(gate.submit({ kind: 'first', payload: { text: 'x'.repeat(100) } }, emit)).toBe(true)
    expect(gate.submitLifecycle({ kind: 'app-launch', payload: {} }, emit)).toBe(true)
    expect(gate.submitLifecycle({ kind: 'user-id', payload: { userId: 'B' } }, emit)).toBe(false)
    expect(gate.submitLifecycle({ kind: 'app-show', payload: {} }, emit)).toBe(true)
    expect(gate.release(emit)).toBe(true)
    expect(emitted).toEqual(['first', 'app-launch', 'app-show'])
  })

  it('生命周期缓冲也有独立上限，不挤掉已接受的业务指令', () => {
    const lifecycle = new TrackerLifecycle()
    const gate = new TrackerEventGate(lifecycle)
    lifecycle.init(options)
    for (let i = 0; i < 50; i++) expect(gate.submitLifecycle({ kind: 'page-title', payload: { title: String(i) } }, () => true)).toBe(true)
    expect(gate.submitLifecycle({ kind: 'page-title', payload: {} }, () => true)).toBe(false)
    expect(gate.submit({ kind: 'track', payload: {} }, () => true)).toBe(true)
    expect(gate.bufferedCount()).toBe(51)
  })

  it('rejects calls before init, buffers only while hydrating, then releases in order', () => {
    const lifecycle = new TrackerLifecycle()
    const gate = new TrackerEventGate(lifecycle)
    const emitted: string[] = []
    const emit = (intent: { kind: string }): boolean => { emitted.push(intent.kind); return true }

    expect(gate.submit({ kind: 'before-init', payload: {} }, emit)).toBe(false)
    lifecycle.init(options)
    expect(gate.submit({ kind: 'first', payload: {} }, emit)).toBe(true)
    expect(gate.submit({ kind: 'second', payload: {} }, emit)).toBe(true)
    expect(emitted).toStrictEqual([])
    expect(gate.release(emit)).toBe(true)
    expect(emitted).toStrictEqual(['first', 'second'])
    expect(gate.submit({ kind: 'ready', payload: {} }, emit)).toBe(true)
    expect(emitted).toStrictEqual(['first', 'second', 'ready'])
  })

  it('does not construct, buffer, or emit behavior events when dataCollect is false', () => {
    const lifecycle = new TrackerLifecycle()
    lifecycle.init({ ...options, dataCollect: false })
    const gate = new TrackerEventGate(lifecycle)
    const emit = (): boolean => { throw new Error('must not emit') }
    expect(gate.submit({ kind: 'track', payload: {} }, emit)).toBe(false)
    expect(gate.bufferedCount()).toBe(0)
    expect(gate.release(emit)).toBe(true)
  })

  it('does not let one buffered emitter failure block later intents', () => {
    const lifecycle = new TrackerLifecycle()
    lifecycle.init(options)
    const gate = new TrackerEventGate(lifecycle)
    gate.submit({ kind: 'bad', payload: {} }, () => true)
    gate.submit({ kind: 'good', payload: {} }, () => true)
    const emitted: string[] = []
    gate.release((intent) => {
      if (intent.kind === 'bad') throw new Error('bad event')
      emitted.push(intent.kind)
      return true
    })
    expect(emitted).toStrictEqual(['good'])
  })

  it('immediately blocks new behavior events after collection is disabled without clearing ready state', () => {
    const lifecycle = new TrackerLifecycle()
    lifecycle.init(options)
    const gate = new TrackerEventGate(lifecycle)
    gate.release(() => true)
    expect(lifecycle.setDataCollect(false)).toMatchObject({ ok: true, changed: true })
    expect(gate.submit({ kind: 'blocked', payload: {} }, () => true)).toBe(false)
    expect(lifecycle.status()).toBe('ready')
  })
})
