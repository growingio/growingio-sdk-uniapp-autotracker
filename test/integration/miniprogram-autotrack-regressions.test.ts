import { describe, expect, it, vi } from 'vitest'
import { gioUniappAutoTrack, transformAutoTrackTemplate } from '../../src/compiler/vite.js'
import { normalizeAutoTrackCall } from '../../src/plugins/gioEventAutoTracking/index.js'
import { compileMiniAutoTrack } from '../support/miniprogram-autotrack-fixture.js'

const nativeEvent = (value: unknown, dataset: Record<string, unknown> = { growingTrack: true }) => ({
  type: 'change', target: { id: 'control', dataset }, currentTarget: { id: 'control', dataset }, detail: { value },
})

describe('real mini-program listener regressions', () => {
  it.each(['password', 'password="false"', 'password="0"', 'password="anything"', 'type="password"', 'type="safe-password"', ':password="false"'])
  ('never reads a password completion even with explicit tracking: %s', (attribute) => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const done = vi.fn(event => event)
    const fixture = compileMiniAutoTrack(`<input ${attribute} data-growing-track @blur="done($event)"/>`, { gioAutoTrack: dispatch, done })
    const read = vi.fn(() => 'SECRET')
    const event = { ...nativeEvent(undefined), get detail() { return { get value() { return read() } } } }
    expect(fixture.callListener(event)).toBe(event)
    expect(dispatch.mock.results[0]?.value).toEqual({ kind: 'change', xpath: 'control#done', textValue: null })
    expect(read).not.toHaveBeenCalled()
    expect(done).toHaveBeenCalledExactlyOnceWith(event)
    if (attribute === 'password="false"') expect(fixture.native).toContain('password="false"')
  })

  it.each(['handleTap', 'actions.save'])('captures %s once at render and keeps arguments, receiver, result and exceptions', (handler) => {
    const run = (instrument: boolean) => {
      const calls: unknown[][] = []
      const receivers: unknown[] = []
      const reads = vi.fn()
      const dispatch = vi.fn(() => { throw new Error('isolated collection failure') })
      const business = function(this: unknown, ...args: unknown[]) { calls.push(args); receivers.push(this); return args.length }
      let current: unknown = business
      const actions = { get save() { reads(); return current } }
      const context = { get handleTap() { reads(); return current }, actions, gioAutoTrack: dispatch }
      const fixture = compileMiniAutoTrack(`<button @tap="${handler}"/>`, context, instrument)
      expect(reads).toHaveBeenCalledOnce()
      current = () => { throw new Error('must use the rendered listener') }
      const payload = { business: true }
      const event = { type: 'tap', target: { dataset: { eventsync: true } }, detail: { __args__: [payload, 'second'] } }
      expect(fixture.fire(event)).toBe(2)
      expect(reads).toHaveBeenCalledOnce()
      expect(calls).toEqual([[payload, 'second']])
      expect(receivers).toEqual([undefined])
      expect(dispatch).toHaveBeenCalledTimes(instrument ? 1 : 0)
      if (instrument) expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ eventName: handler }), payload)
      return fixture.transformed.changed
    }
    expect(run(false)).toBe(false)
    expect(run(true)).toBe(true)
    const failure = new Error('business error')
    for (const instrument of [false, true]) {
      const throwing = () => { throw failure }
      const fixture = compileMiniAutoTrack(`<button @tap="${handler}"/>`, { handleTap: throwing, actions: { save: throwing }, gioAutoTrack: () => { throw new Error('probe') } }, instrument)
      expect(() => fixture.callListener({})).toThrow(failure)
      fixture.fire({ type: 'tap', target: { dataset: { eventsync: true } } })
      expect(fixture.errors).toEqual([failure])
    }
  })

  it.each([null, undefined, false, [() => 'first', () => 'second']])('preserves non-function references at the native runtime boundary: %j', (handler) => {
    const dispatch = vi.fn()
    const fixture = compileMiniAutoTrack('<button @tap="handler"/>', { handler, gioAutoTrack: dispatch })
    if (Array.isArray(handler)) {
      expect(fixture.listenerValue).toBe(handler)
      expect(fixture.fire({ type: 'tap', target: { dataset: { eventsync: true } } })).toEqual(['first', 'second'])
    } else expect(fixture.fire({})).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('captures each loop-scoped function reference in the same render as the native compiler', () => {
    const rows = [{ save: vi.fn(() => 'first') }, { save: vi.fn(() => 'second') }]
    const dispatch = vi.fn()
    const fixture = compileMiniAutoTrack('<button v-for="row in rows" @tap="row.save"/>', { rows, gioAutoTrack: dispatch })
    const event = { type: 'tap', target: { dataset: { eventsync: true } } }
    expect(fixture.fireAt(0, event)).toBe('first')
    expect(fixture.fireAt(1, event)).toBe('second')
    expect(rows[0]!.save).toHaveBeenCalledExactlyOnceWith(event)
    expect(rows[1]!.save).toHaveBeenCalledExactlyOnceWith(event)
    expect(dispatch.mock.calls.map(([probe]) => probe.eventName)).toEqual(['row.save', 'row.save'])
  })

  it('propagates a reference getter failure during the original render phase', () => {
    const failure = new Error('render getter failure')
    for (const instrument of [false, true]) expect(() => compileMiniAutoTrack('<button @tap="actions.save"/>', {
      actions: { get save() { throw failure } }, gioAutoTrack: () => undefined,
    }, instrument)).toThrow(failure)
  })

  it.each(['actions[key]', 'actions?.save', 'lookup().save', 'save as Handler'])('keeps complex reference boundaries: %s', (handler) => {
    const template = `<button @tap="${handler}"/>`
    expect(transformAutoTrackTemplate(template, 'gioAutoTrack', { references: 'render' })).toMatchObject({ code: template, changed: false, warnings: [{ code: 'complex_handler' }] })
  })

  it('enables render-time reference capture for mini-program Vite builds', () => {
    const previous = process.env.UNI_PLATFORM
    try {
      process.env.UNI_PLATFORM = 'mp-weixin'
      const result = gioUniappAutoTrack().transform.call(undefined, '<script setup>const handleTap = e => e</script><template><button @tap="handleTap"/></template>', 'page.vue')
      expect(result).not.toBeNull()
    } finally {
      if (previous === undefined) delete process.env.UNI_PLATFORM
      else process.env.UNI_PLATFORM = previous
    }
  })

  it.each([
    ['selector', ':range="[\'zero\',\'one\']"', 1, 'one'],
    ['multiSelector', ':range="[[\'A\',\'B\'],[\'X\',\'Y\']]"', [1, 0], 'B||X'],
    ['date', '', '2026-11-13', '2026-11-13'],
    ['time', '', '14:35', '14:35'],
    ['region', '', ['浙江省', '杭州市', '西湖区'], '浙江省||杭州市||西湖区'],
  ])('normalizes authorized picker %s with the native value shape', (mode, range, value, expected) => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const fixture = compileMiniAutoTrack(`<picker mode="${mode}" ${range} data-growing-track @change="done($event)"/>`, { gioAutoTrack: dispatch, done: (event: unknown) => event })
    const event = nativeEvent(value)
    expect(fixture.callListener(event)).toBe(event)
    expect(dispatch.mock.results[0]?.value).toEqual({ kind: 'change', xpath: 'control#done', textValue: expected })
    expect(dispatch.mock.results[0]?.value).not.toHaveProperty('pickerMode')
  })

  it.each([
    ['<picker :range="items" @change="items=>done(items)"/>', { items: ['zero', 'one'] }, 1, 'one'],
    ['<picker :range="items" :range-key="labelKey" @change="(items,labelKey)=>done(items,labelKey)"/>', { items: [{ name: 'zero' }, { name: 'one' }], labelKey: 'name' }, 1, 'one'],
    ['<picker-view @change="items=>done(items)"><picker-view-column><view v-for="item in items">{{item}}</view></picker-view-column></picker-view>', { items: ['zero', 'one'] }, [1], 'one'],
  ])('keeps lazy metadata outside business parameter scope: %s', (template, bindings, value, expected) => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const done = vi.fn((...args: unknown[]) => args)
    const fixture = compileMiniAutoTrack(template, { ...bindings, gioAutoTrack: dispatch, done })
    const event = nativeEvent(value)
    expect(fixture.callListener(event, 'business-second')).toEqual(template.includes('labelKey)=>') ? [event, 'business-second'] : [event])
    expect(dispatch.mock.results[0]?.value?.textValue).toBe(expected)
  })

  it('does not shadow unrelated business bindings with generated forwarding arguments', () => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const done = vi.fn((...args: unknown[]) => args)
    const fixture = compileMiniAutoTrack('<picker :range="items" @change="items=>done(items,gioAutoTrackForwardArgs)"/>', {
      items: ['zero', 'one'], gioAutoTrackForwardArgs: 'business-binding', gioAutoTrack: dispatch, done,
    })
    const event = nativeEvent(1)
    expect(fixture.callListener(event)).toEqual([event, 'business-binding'])
    expect(dispatch.mock.results[0]?.value?.textValue).toBe('one')
  })

  it.each([
    ['<picker :range="\\u0069tems" @change="items=>done(items)"/>', { items: ['zero', 'one'] }, 1, 'one'],
    ['<picker :range="items" :range-key="label\\u004Bey" @change="labelKey=>done(labelKey)"/>', { items: [{ name: 'zero' }, { name: 'one' }], labelKey: 'name' }, 1, 'one'],
    ['<picker :mode="\\u006Dode" :range="items" @change="mode=>done(mode)"/>', { mode: 'multiSelector', items: [['A', 'B'], ['X']] }, [1, 0], 'B||X'],
    ['<picker-view @change="items=>done(items)"><picker-view-column><view v-for="item in \\u0069tems">{{item}}</view></picker-view-column></picker-view>', { items: ['zero', 'one'] }, [1], 'one'],
  ])('resolves escaped metadata identifiers in template scope: %s', (template, bindings, value, expected) => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const fixture = compileMiniAutoTrack(template, { ...bindings, gioAutoTrack: dispatch, done: (event: unknown) => event })
    const event = nativeEvent(value)
    expect(fixture.callListener(event)).toBe(event)
    expect(dispatch.mock.results[0]?.value?.textValue).toBe(expected)
  })

  it.each(['数据', '$数据', '_数据', 'étiquette', 'e\u0301tiquette', '\u{10400}data', 'a\u200Cb', 'a\u200Db'].flatMap(identifier => [
    { identifier, field: 'range', template: `<picker :range="${identifier}" data-growing-track @change="(${identifier})=>done(${identifier})"/>`, bindings: { [identifier]: ['zero', 'one'] }, value: 1, expected: 'one' },
    { identifier, field: 'range-key', template: `<picker :range="items" :range-key="${identifier}" data-growing-track @change="(${identifier})=>done(${identifier})"/>`, bindings: { items: [{ name: 'zero' }, { name: 'one' }], [identifier]: 'name' }, value: 1, expected: 'one' },
    { identifier, field: 'mode', template: `<picker :mode="${identifier}" :range="items" data-growing-track @change="(${identifier})=>done(${identifier})"/>`, bindings: { items: [['A', 'B'], ['X']], [identifier]: 'multiSelector' }, value: [1, 0], expected: 'B||X' },
    { identifier, field: 'picker-view', template: `<picker-view data-growing-track @change="(${identifier})=>done(${identifier})"><picker-view-column><view v-for="item in ${identifier}">{{item}}</view></picker-view-column></picker-view>`, bindings: { [identifier]: ['zero', 'one'] }, value: [1], expected: 'one' },
  ]))('keeps Unicode metadata binding $identifier in template scope for $field', ({ template, bindings, value, expected }) => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const done = vi.fn((event: unknown) => event)
    const fixture = compileMiniAutoTrack(template, { ...bindings, gioAutoTrack: dispatch, done })
    const event = nativeEvent(value)
    expect(fixture.transformed.warnings).toEqual([])
    expect(fixture.callListener(event)).toBe(event)
    expect(done).toHaveBeenCalledExactlyOnceWith(event)
    expect(dispatch.mock.results[0]?.value?.textValue).toBe(expected)
  })

  it.each([
    { field: 'range', template: '<picker :range="数据.items" data-growing-track @change="(数据)=>done(数据)"/>', bindings: { 数据: { items: ['zero', 'one'] } }, property: 'items', privateValue: ['event-private-zero', 'event-private-one'], value: 1, expected: 'one' },
    { field: 'range-key', template: '<picker :range="items" :range-key="数据.key" data-growing-track @change="(数据)=>done(数据)"/>', bindings: { items: [{ name: 'zero', privateName: 'event-private-zero' }, { name: 'one', privateName: 'event-private-one' }], 数据: { key: 'name' } }, property: 'key', privateValue: 'privateName', value: 1, expected: 'one' },
    { field: 'mode', template: '<picker :mode="数据.mode" :range="items" data-growing-track @change="(数据)=>done(数据)"/>', bindings: { items: [['A', 'B'], ['X']], 数据: { mode: 'multiSelector' } }, property: 'mode', privateValue: 'selector', value: [1, 0], expected: 'B||X' },
    { field: 'picker-view', template: '<picker-view data-growing-track @change="(数据)=>done(数据)"><picker-view-column><view v-for="item in 数据.items">{{item}}</view></picker-view-column></picker-view>', bindings: { 数据: { items: ['zero', 'one'] } }, property: 'items', privateValue: ['event-private-zero', 'event-private-one'], value: [1], expected: 'one' },
  ])('never reads business event properties for Unicode template metadata $field', ({ template, bindings, property, privateValue, value, expected }) => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const fixture = compileMiniAutoTrack(template, { ...bindings, gioAutoTrack: dispatch, done: (event: unknown) => event })
    const read = vi.fn(() => privateValue)
    const event = nativeEvent(value)
    Object.defineProperty(event, property, { get: read })
    expect(fixture.callListener(event)).toBe(event)
    expect(dispatch.mock.results[0]?.value?.textValue).toBe(expected)
    expect(read).not.toHaveBeenCalled()
  })

  it('reads dynamic multiSelector mode and columns lazily after privacy and consent checks', () => {
    const reads: string[] = []
    const model = { get mode() { reads.push('mode'); return 'multiSelector' }, get ranges() { reads.push('range'); return [['A', 'B'], ['X', 'Y']] }, get key() { reads.push('key'); return '' } }
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const done = (event: unknown) => event
    const fixture = compileMiniAutoTrack('<picker :mode="model.mode" :range="model.ranges" data-growing-track @change="model=>done(model)"/>', { model, done, gioAutoTrack: dispatch })
    expect(reads).toEqual(['mode', 'range'])
    for (const dataset of [{ growingIgnore: true }, { growingSensitive: true }, { growingTrack: false }]) {
      reads.length = 0
      const value = vi.fn(() => [1, 0])
      const event = { ...nativeEvent(undefined, dataset), detail: { get value() { return value() } } }
      fixture.callListener(event)
      expect(reads).toEqual([])
      expect(value).not.toHaveBeenCalled()
    }
    fixture.callListener(nativeEvent([1, 0]))
    expect(reads).toEqual(['mode', 'range'])
    expect(dispatch.mock.results.at(-1)?.value?.textValue).toBe('B||X')
  })

  it('retains picker metadata for a directly referenced change handler', () => {
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const done = vi.fn((event: unknown) => event)
    const fixture = compileMiniAutoTrack('<picker mode="multiSelector" :range="items" data-growing-track @change="done"/>', {
      items: [['A', 'B'], ['X']], done, gioAutoTrack: dispatch,
    })
    const event = nativeEvent([1, 0])
    expect(fixture.fire(event)).toBe(event)
    expect(done).toHaveBeenCalledExactlyOnceWith(event)
    expect(dispatch.mock.results[0]?.value?.textValue).toBe('B||X')
  })

  it.each([':mode="lookupMode()"', ':mode="unknownMode"'])('does not read values or ranges for unknown dynamic mode: %s', (mode) => {
    const reads = vi.fn(() => ['private'])
    const dispatch = vi.fn(normalizeAutoTrackCall)
    const fixture = compileMiniAutoTrack(`<picker ${mode} :range="model.items" data-growing-track @change="done($event)"/>`, {
      lookupMode: () => 'unrecognized', unknownMode: 'unrecognized', model: { get items() { return reads() } }, gioAutoTrack: dispatch, done: (event: unknown) => event,
    })
    reads.mockClear()
    const value = vi.fn(() => 0)
    fixture.callListener({ ...nativeEvent(undefined), detail: { get value() { return value() } } })
    expect(dispatch.mock.results[0]?.value).toEqual({ kind: 'change', xpath: 'control#done', textValue: null })
    expect(value).not.toHaveBeenCalled()
    expect(reads).not.toHaveBeenCalled()
  })
})
