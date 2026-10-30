import { describe, expect, it, vi } from 'vitest'
import { AutoTrackDispatcher, dispatchAutoTrack, installAutoTrackDispatcher } from '../../src/plugins/gioEventAutoTracking/index.js'

const click = { schemaVersion: 2, source: 'template', kind: 'click', eventName: 'save' } as const
/** 构造带稳定目标和可调时间戳的点击事件，隔离去重条件。 */
const event = (timeStamp: unknown = 10, id = 'buy', type = 'tap') => ({ type, timeStamp, currentTarget: { id, dataset: { title: 'Buy' } } })

describe('autotrack dispatcher', () => {
  it('treats ids starting with a hash as stable nonempty ids for wrapper deduplication', () => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    expect(dispatcher.dispatch(click, event(100, '#buy'), 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, event(101, '#buy'), 'home', emit)).toBe(false)
    expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: 'click', xpath: '#buy#save', textValue: 'Buy', index: null, hyperlink: null })
  })
  it('preserves bubbling listeners on different idless targets with the same handler and metadata', () => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    const native = { type: 'tap', timeStamp: 100, currentTarget: { dataset: {} } }
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(false)
    native.currentTarget = { dataset: {} }
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(false)
    expect(emit.mock.calls).toEqual(Array(2).fill([{ kind: 'click', xpath: '#save', textValue: null, index: null, hyperlink: null }]))
  })
  it('merges idless wrappers only when they identify the same bound target', () => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    const currentTarget = { dataset: {} }
    expect(dispatcher.dispatch(click, { type: 'tap', timeStamp: 100, currentTarget }, 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, { type: 'tap', timeStamp: 100, currentTarget }, 'home', emit)).toBe(false)
    expect(dispatcher.dispatch(click, { type: 'tap', timeStamp: 100, currentTarget: { dataset: {} } }, 'home', emit)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(2)
  })
  it('does not infer a shared target from timestamps or top-level event ids when both targets are absent', () => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    const native = { type: 'tap', timeStamp: 100, id: 'event-id' }
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(false)
    expect(dispatcher.dispatch(click, { ...native }, 'home', emit)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(2)
  })
  it('isolates missing targets and SDK errors', () => {
    expect(dispatchAutoTrack(click)).toBe(false)
    installAutoTrackDispatcher({ autoTrack: () => { throw new Error('SDK') } })
    expect(dispatchAutoTrack(click)).toBe(false)
    installAutoTrackDispatcher({ autoTrack: () => true })
    expect(dispatchAutoTrack(click)).toBe(true)
  })
  it('deduplicates normalized probes on one object while preserving different bound targets', () => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    const native = event()
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(false)
    native.currentTarget.id = 'parent'
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[0]).toEqual([{ kind: 'click', xpath: 'buy#save', textValue: 'Buy', index: null, hyperlink: null }])
  })
  it('deduplicates separate wrappers only within a finite positive timestamp window', () => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    expect(dispatcher.dispatch(click, event(20), 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, event(29), 'home', emit)).toBe(false)
    expect(dispatcher.dispatch(click, event(30), 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, event(25), 'home', emit)).toBe(false)
    expect(dispatcher.dispatch(click, event(31, 'buy', 'click'), 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, event(31, 'buy'), 'other', emit)).toBe(true)
    dispatcher.reset()
    expect(dispatcher.dispatch(click, event(31), 'home', emit)).toBe(true)
  })
  it.each([0, undefined, NaN, Infinity, -1, '10'])('does not merge distinct events with timestamp %s', (timeStamp) => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    const first = { ...event(), timeStamp }
    expect(dispatcher.dispatch(click, first, 'home', emit)).toBe(true)
    expect(dispatcher.dispatch(click, { ...first }, 'home', emit)).toBe(true)
  })
  it('preserves changes in normalized text, index, hyperlink, kind and native type', () => {
    const dispatcher = new AutoTrackDispatcher()
    const emit = vi.fn(() => true)
    for (const dataset of [{ title: 'A' }, { title: 'B' }, { title: 'B', index: 1 }, { title: 'B', index: 1, src: '/docs' }]) {
      expect(dispatcher.dispatch(click, { ...event(), currentTarget: { id: 'buy', dataset } }, 'home', emit)).toBe(true)
    }
    expect(dispatcher.dispatch({ ...click, kind: 'change', elementType: 'input', trackValue: true }, { ...event(), detail: { value: false } }, 'home', emit)).toBe(true)
    expect(emit).toHaveBeenCalledTimes(5)
  })
  it('does not deduplicate rejected private probes, failed downstream dispatches, or other trackers', () => {
    const dispatcher = new AutoTrackDispatcher()
    const native = event()
    const emit = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    expect(dispatcher.dispatch({ ...click, ignored: true }, native, 'home', emit)).toBe(false)
    expect(dispatcher.dispatch(click, native, null, emit)).toBe(false)
    expect(emit).not.toHaveBeenCalled()
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(false)
    expect(dispatcher.dispatch(click, native, 'home', emit)).toBe(true)
    expect(new AutoTrackDispatcher().dispatch(click, native, 'home', emit)).toBe(true)
  })
})
