import { describe, expect, it } from 'vitest'

import { BootstrapBuffer } from '../../src/core/lifecycle.js'

describe('BootstrapBuffer', () => {
  it.each(['é', '中文', '😀', '\ud800'])('按实际 UTF-8 字节数限制 %s，包含 JSON 数组开销', (text) => {
    const bytes = Buffer.byteLength(JSON.stringify([{ text }]), 'utf8')
    const exact = new BootstrapBuffer({ maxItems: 2, maxBytes: bytes })
    const short = new BootstrapBuffer({ maxItems: 2, maxBytes: bytes - 1 })
    expect(exact.push({ text })).toBe(true)
    expect(short.push({ text })).toBe(false)
    expect(exact.drain()).toEqual([{ text }])
    expect(short.drain()).toEqual([])
  })

  it.each([undefined, () => undefined, Symbol('unsupported'), 1n])('拒绝非 JSON 启动指令 %s', (value) => {
    const buffer = new BootstrapBuffer()
    expect(buffer.push(value)).toBe(false)
    expect(buffer.size()).toBe(0)
  })
  it('keeps an immutable JSON snapshot in original order until hydration drains it', () => {
    const buffer = new BootstrapBuffer()
    const intent = { type: 'track', name: 'first' }
    expect(buffer.push(intent)).toBe(true)
    intent.name = 'mutated-after-buffering'
    expect(buffer.push({ type: 'track', name: 'second' })).toBe(true)
    expect(buffer.drain()).toStrictEqual([{ type: 'track', name: 'first' }, { type: 'track', name: 'second' }])
    expect(buffer.size()).toBe(0)
  })

  it('keeps existing intents when item or exact UTF-8 array-byte limits are reached', () => {
    const byCount = new BootstrapBuffer({ maxItems: 1, maxBytes: 1_000 })
    expect(byCount.push({ id: 1 })).toBe(true)
    expect(byCount.push({ id: 2 })).toBe(false)
    expect(byCount.drain()).toStrictEqual([{ id: 1 }])

    const byBytes = new BootstrapBuffer({ maxItems: 5, maxBytes: 18 })
    expect(byBytes.push({ value: '中' })).toBe(true)
    expect(byBytes.push({ value: 'x' })).toBe(false)
    expect(byBytes.drain()).toStrictEqual([{ value: '中' }])
  })

  it('rejects an unserializable intent without disturbing the prior buffer', () => {
    const buffer = new BootstrapBuffer()
    const cyclic: Record<string, unknown> = { type: 'track' }
    cyclic.self = cyclic
    buffer.push({ type: 'track', name: 'kept' })
    expect(buffer.push(cyclic)).toBe(false)
    expect(buffer.drain()).toStrictEqual([{ type: 'track', name: 'kept' }])
  })
})
