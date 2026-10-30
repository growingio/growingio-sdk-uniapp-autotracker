import { describe, expect, it, vi } from 'vitest'
import { mountAutoTrackSfc } from '../support/autotrack-fixture.js'
import { transformAutoTrackSfc } from '../../src/compiler/vite.js'

describe('无埋点不得改变 Vue listener 的业务语义', () => {
  it('keeps the dispatcher distinct from escaped v-for aliases', () => {
    const source = `<script setup>import { business } from 'fixture'; const items = [1, 2]</script><template><button v-for="\\u0067ioAutoTrack of items" @tap="business($event)"/></template>`
    for (const instrument of [false, true]) {
      const business = vi.fn(event => event)
      const dispatch = vi.fn()
      const fixture = mountAutoTrackSfc(source, dispatch, { fixture: { business } }, instrument)
      try {
        const event = {}
        expect(fixture.fire(0, 'onTap', event)).toBe(event)
        expect(fixture.fire(1, 'onTap', event)).toBe(event)
        expect(business).toHaveBeenCalledTimes(2)
        expect(dispatch).toHaveBeenCalledTimes(instrument ? 2 : 0)
      } finally { fixture.unmount() }
    }
  })
  it.each([
    `<script setup>import { business } from 'fixture'; const \\u0067ioAutoTrack = 1; const save = event => business(event)</script>`,
    `<script setup>import { business } from 'fixture'; const \\u{67}ioAutoTrack = 1; const save = event => business(event)</script>`,
    `<script setup>import { business, unused as \\u0067ioAutoTrack } from 'fixture'; const save = event => business(event)</script>`,
    `<script>import { business, unused } from 'fixture'; export default { methods: { '\\u0067ioAutoTrack': unused, save: event => business(event) } }</script>`,
    `<script>import { business, unused } from 'fixture'; export default { methods: { '\\x67ioAutoTrack': unused, save: event => business(event) } }</script>`,
  ])('does not collide with escaped business identifiers or method keys: %s', (script) => {
    const run = (instrument: boolean) => {
      const business = vi.fn(event => event)
      const unused = vi.fn()
      const dispatch = vi.fn()
      const fixture = mountAutoTrackSfc(`${script}<template><button @tap="save($event)"/></template>`, dispatch, { fixture: { business, unused } }, instrument)
      try {
        const event = { value: 'business' }
        expect(fixture.fire(0, 'onTap', event)).toBe(event)
        expect(business).toHaveBeenCalledExactlyOnceWith(event)
        expect(unused).not.toHaveBeenCalled()
        if (instrument) expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventName: 'save' }), event)
      } finally { fixture.unmount() }
    }
    run(false)
    run(true)
  })
  it('leaves non-JavaScript Unicode escape text intact while selecting the dispatcher alias', () => {
    const business = vi.fn(event => event)
    const dispatch = vi.fn()
    const source = `<script setup>import { business } from 'fixture'</script><template><button @tap="business($event)">literal \\u{110000}</button></template>`
    const fixture = mountAutoTrackSfc(source, dispatch, { fixture: { business } })
    try {
      const event = {}
      expect(fixture.transformed.code).toContain('literal \\u{110000}')
      expect(fixture.fire(0, 'onTap', event)).toBe(event)
      expect(business).toHaveBeenCalledExactlyOnceWith(event)
      expect(dispatch).toHaveBeenCalledOnce()
    } finally { fixture.unmount() }
  })
  it.each(['save!', 'save as Handler', '(save as Handler)!', 'save satisfies Handler', 'save<string>'])('TypeScript 函数引用保持 Vue 的原始调用：%s', (handler) => {
    const source = `<script setup lang="ts">import { save } from 'fixture'; type Handler = (...args: any[]) => unknown</script><template><button @click="${handler}" /></template>`
    expect(transformAutoTrackSfc(source).code).toBe(source)
    const run = (instrument: boolean) => {
      const calls: unknown[][] = []
      const save = (...values: unknown[]) => { calls.push(values); return values.length }
      const fixture = mountAutoTrackSfc(source, () => { throw new Error('不应采集') }, { fixture: { save } }, instrument)
      try { return { result: fixture.fire(0, 'onClick', 'event', 'second'), calls } }
      finally { fixture.unmount() }
    }
    const original = run(false)
    expect(original.calls).toEqual([['event', 'second']])
    expect(run(true)).toEqual(original)
  })

  it('动态元数据和组件 getter 的读取次数、发生时机与原始 Vue 一致', () => {
    const run = (instrument: boolean) => {
      const calls: string[] = []
      const model = { get title() { calls.push('title'); return '业务标题' }, get range() { calls.push('range'); return ['a', 'b'] } }
      const source = `<script>import { model, calls } from 'fixture'; export default { get custom() { calls.push('options-getter'); return 1 }, setup() { return { model, save: () => calls.push('business') } } }</script><template><picker :range="model.range" :data-title="model.title" @change="save($event)" /></template>`
      const fixture = mountAutoTrackSfc(source, () => undefined, { fixture: { model, calls } }, instrument)
      const afterRender = [...calls]
      fixture.fire(0, 'onChange', {})
      fixture.unmount()
      return { afterRender, calls }
    }
    expect(run(true)).toEqual(run(false))
  })

  it.each([
    '<script>import component from "fixture"; export default component</script>',
    '<script>export default { setup() {}, get methods() { throw new Error("业务 getter") } }</script>',
    '<script>import methods from "fixture"; export default { methods }</script>',
  ])('不能安全插入 dispatcher 的组件保持整份源码不变', (script) => {
    const source = `${script}<template><button @click="save($event)" /></template>`
    const result = transformAutoTrackSfc(source)
    expect(result.code).toBe(source)
    expect(result.warnings.some((warning) => warning.code === 'complex_component_options')).toBe(true)
  })

  it('严格模式函数保留指令位置，空值和 handler 数组引用不被包装', () => {
    for (const handler of ["function(e) { 'use strict'; return this }", 'handlers', 'empty']) {
      const source = `<script setup>const handlers = [() => 1, () => 2]; const empty = null</script><template><button @click="${handler}" /></template>`
      expect(transformAutoTrackSfc(source).code).toBe(source)
    }
  })

  it.each([
    'save', 'actions.save', 'save($event)', 'actions.save($event)',
    'e => (save(e))', 'e => ({ saved: save(e) })', '(e) => ((save(e)))',
    '(e => (actions.save(e)))', 'e => (save(e) /* inside expression */)',
    '(first, second) => save(first, second)', 'function(first, second) { return save(first, second) }',
    'ready() ? save : cancel', 'ready() ? save($event) : cancel($event)',
    'ready() ? e => save(e) : e => cancel(e)', 'count++',
  ])('对照原始 listener：%s', (handler) => {
    const run = (instrument: boolean) => {
      const calls: unknown[] = []
      const actions = { save: function(this: unknown, ...args: unknown[]) { calls.push(['actions', this === actions, args]); return args.length } }
      const save = (...args: unknown[]) => { calls.push(['save', args]); return args.length }
      const cancel = (...args: unknown[]) => { calls.push(['cancel', args]); return args.length }
      let condition = true
      const ready = () => { calls.push(['condition']); condition = !condition; return condition }
      const source = `<script setup>import { save, cancel, actions, ready } from 'fixture'; let count = 0</script><template><button @click="${handler}" /></template>`
      const fixture = mountAutoTrackSfc(source, () => { throw new Error('采集失败') }, { fixture: { save, cancel, actions, ready } }, instrument)
      const returned = [fixture.fire(0, 'onClick', 'event', 'extra'), fixture.fire(0, 'onClick', 'event2', 'extra2')]
        .map((value) => typeof value === 'function' ? ['function', value('later')] : value)
      fixture.unmount()
      return { calls, returned }
    }
    expect(run(true)).toEqual(run(false))
  })

  it('业务抛出的异常保持原对象，采集失败不能阻断业务', () => {
    const failure = new Error('业务异常')
    for (const handler of ['save($event)', 'e => (save(e))', 'e => ({ saved: save(e) })']) for (const instrument of [false, true]) {
      const fixture = mountAutoTrackSfc(`<script setup>import { save } from 'fixture'</script><template><button @click="${handler}" /></template>`,
        () => { throw new Error('采集异常') }, { fixture: { save: () => { throw failure } } }, instrument)
      let caught: unknown
      try { fixture.fire(0, 'onClick', {}) } catch (error) { caught = error }
      expect(caught).toBe(failure)
      fixture.unmount()
    }
  })
})
