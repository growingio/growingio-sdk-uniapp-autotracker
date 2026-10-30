import { describe, expect, it, vi } from 'vitest'
import { normalizeAutoTrackCall, MAX_RANGE_ITEMS } from '../../src/plugins/gioEventAutoTracking/index.js'

const click = { schemaVersion: 2, source: 'template', kind: 'click', eventName: 'submitOrder', elementType: 'button' } as const
const change = { ...click, kind: 'change', elementType: 'input', trackValue: true } as const

describe('schema v2 normalization', () => {
  it.each(['template', 'tabbar'])('preserves the complete %s hyperlink beyond the display-text limit', (source) => {
    const hyperlink = `https://example.com/detail?return=${'a'.repeat(140)}&item=last`
    const probe = source === 'template' ? { ...click, hyperlink }
      : { schemaVersion: 2, source: 'tabbar', kind: 'click', xpath: '#onTabItemTap', index: 1, hyperlink }
    expect(normalizeAutoTrackCall(probe)).toMatchObject({ hyperlink })
    expect(normalizeAutoTrackCall(click, { currentTarget: { dataset: { src: hyperlink } } })).toMatchObject({ hyperlink })
  })
  it.each(['click', 'change'] as const)('keeps complete Unicode characters at the %s text limit', (kind) => {
    for (const [value, expected] of [[`${'a'.repeat(99)}😀tail`, `${'a'.repeat(99)}😀`], ['😀'.repeat(101), '😀'.repeat(100)]]) {
      const probe = kind === 'click' ? { ...click, textValue: value } : change
      const event = kind === 'click' ? {} : { detail: { value } }
      expect(normalizeAutoTrackCall(probe, event)?.textValue).toBe(expected)
    }
  })
  it.each([
    [{ currentTarget: { id: 'buy' }, target: { id: 'child' } }, 'buy#submitOrder'],
    [{ currentTarget: {}, target: { id: 'child' } }, '#submitOrder'],
    [{ currentTarget: { id: '' }, target: { id: 'child' } }, '#submitOrder'],
    [{ target: { id: 0 } }, '0#submitOrder'],
    [{ currentTarget: { id: {} } }, '#submitOrder'],
    [{}, '#submitOrder'],
  ])('uses the primary target without a structural fallback', (event, xpath) => {
    expect(normalizeAutoTrackCall(click, event)).toMatchObject({ xpath })
  })
  it.each([null, undefined, {}, { ...click, schemaVersion: 1 }, { ...click, source: 'other' }, { ...click, xpath: '/old' },
    { ...click, eventName: '' }, { ...click, eventName: {} }, { ...click, elementType: 'business-card' },
    { ...change, elementType: 'button' }, { ...click, textValue: {} }, { ...click, index: NaN }, { ...click, index: Infinity }, { ...change, pickerRange: [] },
    { schemaVersion: 2, source: 'tabbar', kind: 'change', xpath: '#onTabItemTap', index: 1 },
    { schemaVersion: 2, source: 'tabbar', kind: 'click', xpath: '#onTabItemTap', index: '1' },
  ])('rejects incompatible or non-JSON probe fields', (probe) => { expect(normalizeAutoTrackCall(probe)).toBeNull() })
  it.each([0, -1, '01', '+1', '1.0', ' 1', '1e2', 1.5, 2147483647])('rejects noncanonical click index %s', (index) => {
    expect(normalizeAutoTrackCall({ ...click, index })).toMatchObject({ index: null })
  })
  it.each([1, '1', 2147483646])('preserves positive click index %s', (index) => {
    expect(normalizeAutoTrackCall({ ...click, index })).toMatchObject({ index: Number(index) })
  })
  it('uses current event metadata ahead of static or dynamic fallback', () => {
    expect(normalizeAutoTrackCall({ ...click, textValue: 'fallback', index: 9, hyperlink: '/old' }, {
      currentTarget: { dataset: { title: 'live', index: '2', src: '/new' } }, target: { dataset: { title: 'child' } },
    })).toStrictEqual({ kind: 'click', xpath: '#submitOrder', textValue: 'live', index: 2, hyperlink: '/new' })
  })
  it.each(['currentTarget', 'target'])('rejects ignore and sensitive markers on %s without reading any change value', (target) => {
    for (const marker of ['growingIgnore', 'growingSensitive', 'growing-ignore', 'growing-sensitive']) for (const value of [true, '', 'true', 1, '1']) {
      const read = vi.fn(() => { throw new Error('secret') })
      const event = { [target]: { dataset: { [marker]: value, growingTrack: true }, get value() { return read() } }, get detail() { return read() } }
      expect(normalizeAutoTrackCall(change, event)).toBeNull()
      expect(read).not.toHaveBeenCalled()
    }
  })
  it.each(['password', 'safe-password'])('keeps the %s change without reading a value even with track enabled', (type) => {
    const read = vi.fn(() => { throw new Error('password must not be read') })
    for (const targetName of ['currentTarget', 'target']) {
      for (const metadata of [{ type }, { attr: { type } }, { type: 'input', attr: { type: type.toUpperCase() } }, { password: true }, { attr: { password: true } }]) {
        const target = { ...metadata, id: 'password', dataset: { growingTrack: true, get title() { return read() } }, get value() { return read() } }
        expect(normalizeAutoTrackCall({ ...change, get textValue() { return read() } }, { [targetName]: target, get detail() { return read() } }))
          .toStrictEqual({ kind: 'change', xpath: 'password#submitOrder', textValue: null })
      }
    }
    expect(read).not.toHaveBeenCalled()
  })
  it.each([true, '', 'true', 1, '1'])('compiler password redaction %s cannot be overridden by native track or title', (redactValue) => {
    const read = vi.fn(() => { throw new Error('password must not be read') })
    expect(normalizeAutoTrackCall({ ...change, redactValue, get textValue() { return read() } }, {
      currentTarget: { id: 'password', dataset: { growingTrack: true, get title() { return read() } } }, get detail() { return read() },
    })).toStrictEqual({ kind: 'change', xpath: 'password#submitOrder', textValue: null })
    expect(read).not.toHaveBeenCalled()
    expect(normalizeAutoTrackCall({ ...change, redactValue, sensitive: true }, {})).toBeNull()
    expect(normalizeAutoTrackCall({ ...change, redactValue }, { target: { dataset: { growingSensitive: true } } })).toBeNull()
  })
  it('still ignores file input events even with track enabled', () => {
    const read = vi.fn()
    expect(normalizeAutoTrackCall(change, { currentTarget: { type: 'file' }, get detail() { return read() } })).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('redacts a password target behind an ordinary currentTarget without using its value or title', () => {
    const read = vi.fn(() => { throw new Error('password must not be read') })
    expect(normalizeAutoTrackCall(change, {
      currentTarget: { id: 'wrapper', type: 'input', dataset: { growingTrack: true, title: 'not a password value' } },
      target: { attr: { type: 'password', get value() { return read() } } }, get detail() { return read() },
    })).toStrictEqual({ kind: 'change', xpath: 'wrapper#submitOrder', textValue: null })
    expect(read).not.toHaveBeenCalled()
    expect(normalizeAutoTrackCall({ ...change, kind: 'click' }, { target: { type: 'password' } })).toBeNull()
    expect(normalizeAutoTrackCall({ ...change, elementType: 'slider', redactValue: true }, {})).toBeNull()
    expect(normalizeAutoTrackCall({ ...change, redactValue: {} }, {})).toBeNull()
  })
  it('rejects static sensitivity before reading probe metadata and isolates throwing host accessors', () => {
    for (const marker of ['ignored', 'sensitive']) for (const value of [true, '', 'true', 1, '1']) {
      const read = vi.fn(() => 'secret')
      const probe = { ...change, [marker]: value, get textValue() { return read() }, get pickerRange() { return read() } }
      expect(normalizeAutoTrackCall(probe, { get detail() { return read() } })).toBeNull()
      expect(read).not.toHaveBeenCalled()
    }
    expect(normalizeAutoTrackCall(click, { get currentTarget() { throw new Error('host') } })).toBeNull()
  })
  it.each([false, 0, '0', 'false', null, undefined])('does not enable privacy or input consent for false marker %s', (marker) => {
    const read = vi.fn(() => ({ value: 'secret' }))
    expect(normalizeAutoTrackCall({ ...change, ignored: marker, sensitive: marker, trackValue: marker, redactValue: marker }, { get detail() { return read() } }))
      .toStrictEqual({ kind: 'change', xpath: '#submitOrder', textValue: null })
    expect(read).not.toHaveBeenCalled()
  })
  it.each([1, '1'])('accepts numeric input consent %s from probe or native dataset', (marker) => {
    expect(normalizeAutoTrackCall({ ...change, trackValue: marker }, { detail: { value: 'consented' } })?.textValue).toBe('consented')
    expect(normalizeAutoTrackCall({ ...change, trackValue: false }, { currentTarget: { dataset: { growingTrack: marker } }, detail: { value: 'consented' } })?.textValue).toBe('consented')
  })
  it('does not read unauthorized change data or let false runtime consent fall back to a true template marker', () => {
    const read = vi.fn()
    expect(normalizeAutoTrackCall(change, { currentTarget: { dataset: { growingTrack: false } }, get detail() { return read() } })).toStrictEqual({ kind: 'change', xpath: '#submitOrder', textValue: null })
    expect(read).not.toHaveBeenCalled()
  })
  it('does not restore static consent when the runtime dataset owns an unreadable or undefined marker', () => {
    for (const dataset of [{ growingTrack: undefined }, Object.defineProperty({}, 'growingTrack', { get: () => { throw new Error('host getter') } })]) {
      const read = vi.fn(() => ({ value: 'private input' }))
      expect(normalizeAutoTrackCall(change, { currentTarget: { dataset }, get detail() { return read() } }))
        .toStrictEqual({ kind: 'change', xpath: '#submitOrder', textValue: null })
      expect(read).not.toHaveBeenCalled()
    }
  })
  it.each([
    ['input', { value: 0 }, '0'], ['textarea', { value: '' }, ''], ['radio-group', { value: false }, 'false'],
    ['switch', { value: false }, 'false'], ['switch', { value: true }, 'true'], ['switch', { value: 'false' }, null],
    ['slider', { value: 0 }, '0'], ['slider', { value: '2' }, null], ['slider', { value: Infinity }, null],
    ['checkbox-group', { value: [0, false, 'a'] }, '0||false||a'], ['checkbox-group', { value: [] }, ''],
    ['checkbox-group', { value: [{}] }, null], ['swiper', { current: 0, source: 'touch' }, '0'],
  ])('normalizes %s values by their component contract', (elementType, detail, textValue) => {
    expect(normalizeAutoTrackCall({ ...change, elementType }, { detail })).toStrictEqual({ kind: 'change', xpath: '#submitOrder', textValue })
  })
  it('uses input target fallbacks and preserves zero and false', () => {
    expect(normalizeAutoTrackCall(change, { detail: { value: '' }, target: { value: 'wrong' } })?.textValue).toBe('')
    expect(normalizeAutoTrackCall(change, { target: { value: 0 } })?.textValue).toBe('0')
    expect(normalizeAutoTrackCall(change, { target: { attr: { value: false } } })?.textValue).toBe('false')
  })
  it('maps picker labels, falls back to canonical indices and bounds ranges', () => {
    const probe = { ...change, elementType: 'picker', pickerRange: [{ name: 'zero' }, { name: 'one' }], pickerRangeKey: 'name' }
    expect(normalizeAutoTrackCall(probe, { detail: { value: '0' } })?.textValue).toBe('zero')
    expect(normalizeAutoTrackCall(probe, { detail: { value: 5 } })?.textValue).toBe('5')
    expect(normalizeAutoTrackCall(probe, { detail: { value: '01' } })?.textValue).toBeNull()
    for (const pickerRange of [Array(MAX_RANGE_ITEMS + 1).fill('a'), [[1]], [{ nested: {} }], [new Date()], [{ get name() { throw new Error('host') } }]]) {
      expect(normalizeAutoTrackCall({ ...probe, pickerRange }, { detail: { value: 0 } })).toBeNull()
    }
  })
  it('bounds large checkbox labels before concatenating them into display text', () => {
    const value = Array(1000).fill('x'.repeat(1_000_000))
    expect(normalizeAutoTrackCall({ ...change, elementType: 'checkbox-group' }, { detail: { value } }))
      .toStrictEqual({ kind: 'change', xpath: '#submitOrder', textValue: 'x'.repeat(100) })
  })
  it.each([
    ['', ''], ['\u0000\t  a\u0001b\u007f \n', 'a b'], ['😀'.repeat(101), '😀'.repeat(100)],
    [['  ', ' a ', '  '], '|| a ||'], [['\u0000first\u007f', '\tsecond\n'], 'first || second'],
    [[`${'a'.repeat(98)} `, 'b'], `${'a'.repeat(98)} |`],
    [[`${'a'.repeat(98)}😀`, 'b'], `${'a'.repeat(98)}😀|`],
  ])('preserves control normalization, global whitespace and Unicode limits: %j', (value, expected) => {
    const elementType = Array.isArray(value) ? 'checkbox-group' : 'input'
    expect(normalizeAutoTrackCall({ ...change, elementType }, { detail: { value } })?.textValue).toBe(expected)
  })
  it('does not execute range accessors or use inherited dataset metadata', () => {
    const read = vi.fn(() => ['private'])
    const columns: unknown[] = []
    Object.defineProperty(columns, '0', { enumerable: true, get: read })
    expect(normalizeAutoTrackCall({ ...change, elementType: 'picker-view', pickerRange: columns }, { detail: { value: [0] } })).toBeNull()
    expect(read).not.toHaveBeenCalled()

    const dataset = Object.create({ title: 'inherited', index: 9, src: '/inherited' }) as Record<string, unknown>
    expect(normalizeAutoTrackCall(click, { currentTarget: { dataset } })).toStrictEqual({
      kind: 'click', xpath: '#submitOrder', textValue: null, index: null, hyperlink: null,
    })
  })
  it('maps all picker-view columns or falls back to all indices', () => {
    const probe = { ...change, elementType: 'picker-view', pickerRange: [['A', 'B'], ['X', 'Y']] }
    expect(normalizeAutoTrackCall(probe, { detail: { value: [1, 0] } })?.textValue).toBe('B||X')
    expect(normalizeAutoTrackCall(probe, { detail: { value: [1, 8] } })?.textValue).toBe('1||8')
    expect(normalizeAutoTrackCall(probe, { detail: { value: [] } })?.textValue).toBe('')
  })
  it('filters autoplay using only original target consent and permits swiper title fallback', () => {
    const probe = { ...change, elementType: 'swiper', textValue: 'banner' }
    expect(normalizeAutoTrackCall(probe, { currentTarget: { dataset: { growingTrack: true } }, detail: { source: 'autoplay', current: 0 } })).toBeNull()
    expect(normalizeAutoTrackCall(probe, { target: { dataset: { growingTrack: true } }, detail: { source: 'autoplay', current: 0 } })?.textValue).toBe('0')
    expect(normalizeAutoTrackCall({ ...probe, trackValue: false }, { detail: { source: 'touch', current: 0 } })?.textValue).toBe('banner')
    expect(normalizeAutoTrackCall({ ...change, trackValue: false, textValue: 'private' }, {})?.textValue).toBeNull()
  })
  it('keeps eventName internal, trims text and excludes click-only fields from change', () => {
    expect(normalizeAutoTrackCall({ ...change, eventName: 'actions.save', index: 1, hyperlink: '/private' }, { detail: { value: 'a'.repeat(101) } }))
      .toStrictEqual({ kind: 'change', xpath: '#actions.save', textValue: 'a'.repeat(100) })
    expect(normalizeAutoTrackCall({ schemaVersion: 2, source: 'tabbar', kind: 'click', xpath: '#onTabItemTap', index: 1, hyperlink: 'pages/home/index' }))
      .toStrictEqual({ kind: 'click', xpath: '#onTabItemTap', index: 1, textValue: null, hyperlink: 'pages/home/index' })
  })
})
