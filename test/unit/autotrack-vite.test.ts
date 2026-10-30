import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { NodeTypes, parse } from '@vue/compiler-dom'
import { gioUniappAutoTrack, transformAutoTrackSfc, transformAutoTrackTemplate } from '../../src/compiler/vite.js'
import { mountAutoTrackSfc } from '../support/autotrack-fixture.js'
import { normalizeAutoTrackCall } from '../../src/plugins/gioEventAutoTracking/index.js'

/** 解析转换后模板并提取监听器源码，避免依赖属性转义后的原文本。 */
function handlers(code: string): string[] {
  const result: string[] = []
  const visit = (children: ReturnType<typeof parse>['children']): void => {
    for (const child of children) if (child.type === NodeTypes.ELEMENT) {
      for (const prop of child.props) if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'on' && prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION) result.push(prop.exp.content)
      visit(child.children)
    }
  }
  visit(parse(code).children)
  return result
}
/** 将给定模板和可选业务脚本组合为待测 SFC。 */
const source = (template: string, script = 'export default { methods: { save(e) { return e }, cancel(e) { return e } } }') => `<template>${template}</template><script>${script}</script>`

describe('schema v2 Vue instrumentation', () => {
  it.each([
    '<view><label-component>raw slot text</label-component></view>',
    '<label-component v-for="item in [\'A\', \'B\']">{{item}}</label-component>',
  ])('does not infer picker labels from custom component slots: %s', (option) => {
    const labelComponent = defineComponent({ setup: () => () => h('text', 'actual rendered label') })
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>import { labelComponent } from 'fixture'; const save = event => event</script><template><picker-view data-growing-track @change="save($event)"><picker-view-column>${option}</picker-view-column></picker-view></template>`, dispatch, { fixture: { labelComponent } })
    try {
      expect(fixture.elements().some(element => element.text === 'actual rendered label')).toBe(true)
      fixture.fire(0, 'onChange', { detail: { value: [0] } })
      expect(dispatch.mock.results[0]?.value).toMatchObject({ textValue: '0' })
    } finally { fixture.unmount() }
  })
  it('preserves a long uni-link destination through its compiled click probe', () => {
    const href = `https://example.com/detail?return=${'a'.repeat(140)}&item=last`
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>const value = 1</script><template><uni-link href="${href.replace(/&/g, '&amp;')}"/></template>`, dispatch)
    try {
      fixture.fire(0, 'onClick', {})
      expect(dispatch.mock.results[0]?.value).toMatchObject({ hyperlink: href })
    } finally { fixture.unmount() }
  })
  it.each(['ignore', 'sensitive'])('retains a static %s exclusion when spread metadata is unavailable in the native event', (marker) => {
    const read = vi.fn(() => ({ value: true }))
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>const save = event => event; const attributes = { title: 'unrelated' }</script><template><switch data-growing-${marker} v-bind="attributes" @change="save($event)"/></template>`, dispatch)
    try {
      fixture.fire(0, 'onChange', { currentTarget: { dataset: { growingTrack: true } }, get detail() { return read() } })
      expect(dispatch.mock.results[0]?.value).toBeNull()
      expect(read).not.toHaveBeenCalled()
    } finally { fixture.unmount() }
  })
  it.each([
    '<picker-view-column v-show="ready"><view>A</view></picker-view-column>',
    '<picker-view-column><view v-for="item in [\'A\', \'B\']" v-show="ready">{{item}}</view></picker-view-column>',
  ])('uses indices when an otherwise literal picker column has conditional rendering: %s', (columns) => {
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>const save = event => event; const ready = true</script><template><picker-view data-growing-track @change="save($event)">${columns}</picker-view></template>`, dispatch)
    try {
      fixture.fire(0, 'onChange', { detail: { value: [0] } })
      expect(dispatch.mock.results[0]?.value).toMatchObject({ textValue: '0' })
    } finally { fixture.unmount() }
  })
  it.each(['v-bind="attributes"', 'v-bind:[attribute]="marker"'])('does not restore static change consent overridden by %s', (binding) => {
    const business = vi.fn((event) => event)
    const read = vi.fn(() => ({ value: true }))
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>import { business } from 'fixture'; const attributes = { 'data-growing-track': null }; const attribute = 'data-growing-track'; const marker = null</script><template><switch data-growing-track ${binding} @change="business($event)"/></template>`, dispatch, { fixture: { business } })
    try {
      // 渲染属性被移除后，原生 dataset 中也不会再有对应授权。
      expect(fixture.elements().find(element => element.type === 'switch')?.props['data-growing-track']).toBeNull()
      const event = { currentTarget: { dataset: {} }, get detail() { return read() } }
      expect(fixture.fire(0, 'onChange', event)).toBe(event)
      expect(dispatch.mock.results[0]?.value).toMatchObject({ kind: 'change', textValue: null })
      expect(read).not.toHaveBeenCalled()
      expect(business).toHaveBeenCalledExactlyOnceWith(event)
    } finally { fixture.unmount() }
  })
  it('does not copy stale click metadata or picker ranges that a spread can override', () => {
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>const save = event => event; const attributes = { 'data-title': null, 'data-index': null, 'data-src': null }; const options = { range: ['live zero', 'live one'] }</script><template><button data-title="stale" data-index="2" data-src="/stale" v-bind="attributes" @click="save($event)"/><picker :range="['old zero', 'old one']" v-bind="options" data-growing-track @change="save($event)"/></template>`, dispatch)
    try {
      fixture.fire(0, 'onClick', { currentTarget: { dataset: {} } })
      fixture.fire(0, 'onChange', { currentTarget: { dataset: { growingTrack: true } }, detail: { value: 1 } })
      expect(dispatch.mock.results.map(result => result.value)).toEqual([
        { kind: 'click', xpath: '#save', textValue: null, index: null, hyperlink: null },
        { kind: 'change', xpath: '#save', textValue: '1' },
      ])
    } finally { fixture.unmount() }
  })
  it.each([
    '<view><text v-if="ready">A</text><text v-else>B</text></view>',
    '<view><text v-for="item in items">A</text></view>',
    '<view><text v-text="label"/></view>',
    '<view><text v-show="ready">A</text></view>',
  ])('uses picker-view indices when nested option text depends on rendering: %s', (option) => {
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>const save = event => event; const ready = true; const items = [1, 2]; const label = 'live'</script><template><picker-view data-growing-track @change="save($event)"><picker-view-column>${option}</picker-view-column></picker-view></template>`, dispatch)
    try {
      expect(fixture.transformed.warnings).toEqual([])
      fixture.fire(0, 'onChange', { detail: { value: [0] } })
      expect(dispatch.mock.results[0]?.value).toMatchObject({ textValue: '0' })
    } finally { fixture.unmount() }
  })
  it('静态 picker-view 嵌套文字和注释生成可用选项文案，动态文字回退为下标', () => {
    const template = '<picker-view data-growing-track @change="save($event)"><picker-view-column><view><text>杭州</text><!-- comment --></view><view>上海</view></picker-view-column></picker-view>'
    const fixture = mountAutoTrackSfc(source(template), vi.fn())
    try {
      expect(fixture.transformed.warnings).toEqual([])
      expect(handlers(fixture.transformed.code)[0]).toContain('pickerRange:[["杭州","上海"]]')
      const dynamic = transformAutoTrackTemplate(template.replace('<text>杭州</text>', '{{ label }}'))
      expect(dynamic.warnings).toEqual([])
      expect(handlers(dynamic.code)[0]).not.toContain('pickerRange:')
    } finally { fixture.unmount() }
  })
  it.each([
    ['save($event)', 'save'], ['actions.save($event)', 'actions.save'],
    ['e => (save(e))', 'save'], ['(e) => ((save(e)))', 'save'],
    ['(event) => save(event)', 'save'], ['function(event) { return save(event) }', 'save'], ['(event) => 42', 'click'], ['count++', 'click'],
  ])('derives the readable name for %s and preserves return values and native arguments', (handler, eventName) => {
    const calls = vi.fn()
    const fixture = mountAutoTrackSfc(source(`<button @click="${handler}" />`, `export default { data() { return { count: 0, actions: { save: e => e } } }, methods: { save(e) { return e } } }`), calls)
    const event = { value: 'native' }
    const returned = fixture.fire(0, 'onClick', event)
    expect(calls).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ schemaVersion: 2, source: 'template', kind: 'click', eventName }), event)
    expect(returned).toBe(handler === 'count++' ? 0 : handler === '(event) => 42' ? 42 : event)
    expect(calls.mock.calls[0]?.[0]).not.toHaveProperty('xpath')
    fixture.unmount()
  })
  it('preserves handler call count, receiver, return and throw after the probe', () => {
    const sequence: string[] = []
    const business = { save: vi.fn(function(this: unknown, event: unknown) { sequence.push('business'); expect(this).toBe(business); return event }) }
    const fixture = mountAutoTrackSfc('<script setup>import { business } from "fixture"</script><template><button @tap="business.save($event)" /></template>', () => sequence.push('probe'), { fixture: { business } })
    const event = {}
    expect(fixture.fire(0, 'onTap', event)).toBe(event)
    expect(sequence).toEqual(['probe', 'business'])
    expect(business.save).toHaveBeenCalledTimes(1)
    const error = new Error('business error')
    business.save.mockImplementation(() => { throw error })
    expect(() => fixture.fire(0, 'onTap', event)).toThrow(error)
    expect(business.save).toHaveBeenCalledTimes(2)
    fixture.unmount()
  })
  it.each(['ready() ? save($event) : cancel($event)'])('chooses one branch and evaluates its condition once: %s', (handler) => {
    const ready = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const save = vi.fn((e) => e)
    const cancel = vi.fn((e) => e)
    const dispatch = vi.fn()
    const fixture = mountAutoTrackSfc(`<script setup>import { ready, save, cancel } from 'fixture'</script><template><button @click="${handler}" /></template>`, dispatch, { fixture: { ready, save, cancel } })
    const first = {}, second = {}
    expect(fixture.fire(0, 'onClick', first)).toBe(first)
    expect(fixture.fire(0, 'onClick', second)).toBe(second)
    expect(ready).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledExactlyOnceWith(first)
    expect(cancel).toHaveBeenCalledExactlyOnceWith(second)
    expect(dispatch.mock.calls.map((args) => args[0].eventName)).toEqual(['save', 'cancel'])
    fixture.unmount()
  })
  it.each([
    '<script setup>const submit = e => e</script>',
    '<script>export default { setup() { const saveOrder = e => e; return { submit: saveOrder } } }</script>',
    '<script lang="ts">export default { methods: { submit(e: unknown) { return e } } }</script>',
  ])('compiles and executes the template-visible binding in each SFC script form', (script) => {
    const dispatch = vi.fn()
    const fixture = mountAutoTrackSfc(`${script}<template><button id="buy" @click="submit($event)" /></template>`, dispatch)
    const event = {}
    expect(fixture.fire(0, 'onClick', event)).toBe(event)
    expect(dispatch.mock.calls[0]?.[0].eventName).toBe('submit')
    fixture.unmount()
  })
  it('preserves a reactive object returned directly from an ordinary setup', async () => {
    const fixture = mountAutoTrackSfc(`<script>
      import { reactive } from 'vue'
      export default { setup() { const state = reactive({ count: 0, increment: () => 0 }); state.increment = () => ++state.count; return state } }
      </script><template><text>{{ count }}</text><button @click="increment($event)" /></template>`, () => true)
    expect(fixture.fire(0, 'onClick', {})).toBe(1)
    await nextTick()
    expect(fixture.elements().find((element) => element.type === 'text')?.text).toBe('1')
    expect(fixture.fire(0, 'onClick', {})).toBe(2)
    await nextTick()
    expect(fixture.elements().find((element) => element.type === 'text')?.text).toBe('2')
    fixture.unmount()
  })

  it('processes nested template and slot declarations, dynamic branches and v-for instances', async () => {
    const dispatch = vi.fn()
    const fixture = mountAutoTrackSfc(`<script setup>
      import { ref } from 'vue'
      const show = ref(true); const items = ref([{ id:'sku-1', title:'one' }, { id:'sku-2', title:'two' }]);
      const save = item => item.id; defineExpose({ show, items })
      </script><template><template v-if="show"><template v-for="(item, i) in items" :key="item.id"><button :id="item.id" :data-title="item.title" :data-index="i + 1" @click="save(item)" /></template></template><button v-show="show" @tap="save({ id:'tail' })" /></template>`, dispatch)
    expect(fixture.fire(0, 'onClick', {})).toBe('sku-1')
    expect(fixture.fire(1, 'onClick', {})).toBe('sku-2')
    expect(dispatch.mock.calls.map((args) => args[0])).toMatchObject([{ eventName: 'save' }, { eventName: 'save' }])
    expect(dispatch.mock.calls.every((args) => !('textValue' in args[0]) && !('index' in args[0]))).toBe(true)
    expect(dispatch.mock.calls.every((args) => !('id' in args[0]) && !('xpath' in args[0]))).toBe(true)
    ;(fixture.instance as unknown as { show: boolean }).show = false
    await nextTick()
    expect(fixture.elements().filter((element) => typeof element.props.onClick === 'function')).toHaveLength(0)
    expect(dispatch).toHaveBeenCalledTimes(2)
    fixture.unmount()
    const slot = transformAutoTrackSfc(source('<card><template #default="slot"><button @tap="save(slot)" /></template></card>'))
    expect(slot.changed).toBe(true)
    expect(slot.warnings).toEqual([])
  })
  it('handles alias collisions and does not mistake strings or comments for SDK imports', () => {
    const sfc = `<script setup>const gioAutoTrack = 1; const gioAutoTrack1Listener = 2; const str = 'dispatchAutoTrack as gioAutoTrack'; const save = e => e</script><template><button @click="save($event)" /></template>`
    const first = transformAutoTrackSfc(sfc, '@sdk/runtime')
    expect(first.code).toContain('dispatchAutoTrack as gioAutoTrack2')
    const second = transformAutoTrackSfc(first.code, '@sdk/runtime')
    expect(second.code).toBe(first.code)
    expect(second.changed).toBe(false)
    const added = transformAutoTrackSfc(first.code.replace('</template>', '<button @tap="save($event)" /></template>'), '@sdk/runtime')
    expect(added.changed).toBe(true)
    expect(added.code.match(/dispatchAutoTrack as /g)).toHaveLength(2)
  })
  it.each(['save', 'actions.save', 'ready ? save : cancel', '() => 42', 'handlers[key]', 'handlers[key]()', 'ready ? (other ? save : cancel) : save', 'save(); cancel()', 'items.map(item => save(item))', '() => { save(); cancel() }', 'async e => save(e)'])('leaves ambiguous expressions untouched: %s', (handler) => {
    const template = `<button @click="${handler}" />`
    expect(transformAutoTrackTemplate(template)).toMatchObject({ code: template, changed: false, warnings: [{ code: 'complex_handler' }] })
  })
  it('warns for dynamic events, custom components, modifiers, missing and unsupported events', () => {
    const template = '<button v-on:[name]="save"/><component :is="which" @click="save($event)"/><button @click.stop="save($event)"/><button @tap/><input @input="save"/>'
    expect(transformAutoTrackTemplate(template)).toMatchObject({ code: template, changed: false })
    expect(transformAutoTrackTemplate(template).warnings.map((warning) => warning.code)).toEqual(['dynamic_event', 'custom_component', 'event_modifiers', 'missing_handler', 'unsupported_event'])
  })
  it.each(['data-growing-ignore', 'data-growing-ignore="true"', 'data-growing-ignore="1"', ':data-growing-ignore="true"', ':data-growing-ignore="1"', ':data-growing-ignore="\'1\'"'])('does not diagnose intentionally excluded listeners: %s', (ignore) => {
    const template = `<button ${ignore} @tap="save"/><button ${ignore} @tap="handlers[key]($event)"/><button ${ignore} @tap.stop="save($event)"/><button ${ignore} v-on:[name]="save($event)"/><custom-button ${ignore} @click="save($event)"/><input ${ignore} @input="save($event)"/>`
    expect(transformAutoTrackTemplate(template)).toEqual({ code: template, changed: false, warnings: [] })
    const warnings: string[] = []
    expect(gioUniappAutoTrack().transform.call({ warn: warning => warnings.push(warning) }, source(template), 'ignored.vue')).toBeNull()
    expect(warnings).toEqual([])
  })
  it.each(['data-growing-ignore="false"', 'data-growing-ignore="0"', ':data-growing-ignore="false"', ':data-growing-ignore="0"', ':data-growing-ignore="ignore"', 'data-growing-ignore v-bind="attributes"', 'data-growing-ignore v-bind:[attribute]="value"', 'data-growing-ignore :data-growing-ignore="ignore"'])('retains diagnostics when exclusion is false or can change: %s', (ignore) => {
    expect(transformAutoTrackTemplate(`<button ${ignore} @tap.stop="save($event)"/>`).warnings.map(warning => warning.code)).toEqual(['event_modifiers'])
  })
  it('keeps valid ignored probes, descendant diagnostics, and malformed handler diagnostics', () => {
    const result = transformAutoTrackTemplate('<view data-growing-ignore @tap="save($event)"><button @tap.stop="save($event)"/></view><button data-growing-ignore @tap/>')
    expect(handlers(result.code)[0]).toContain('ignored:""')
    expect(result.warnings.map(warning => warning.code)).toEqual(['event_modifiers', 'missing_handler'])
    expect(transformAutoTrackTemplate('<view data-growing-ignore><button></view>').warnings[0]?.code).toBe('template_parse_error')
  })
  it.each(['input', 'textarea'])('selects blur before confirm before change on %s while preserving unselected listeners', (tag) => {
    const transformed = transformAutoTrackTemplate(`<${tag} @change="change($event)" @confirm="confirm($event)" @blur="blur($event)"/><${tag} @change="change($event)" @confirm="finish($event)"/>`)
    const listeners = handlers(transformed.code)
    expect(listeners[0]).toBe('change($event)')
    expect(listeners[1]).toBe('confirm($event)')
    expect(listeners[2]).toContain('eventName:"blur"')
    expect(listeners[3]).toBe('change($event)')
    expect(listeners[4]).toContain('eventName:"finish"')
    const unsupported = transformAutoTrackTemplate(`<${tag} @blur.stop="blur($event)" @change="change($event)"/>`)
    expect(unsupported.changed).toBe(false)
  })
  it.each(['type="password"', 'type="safe-password"', 'password', 'password="true"', ':password="true"', ':password="false"'])('retains a compiled password change without reading values: %s', (attr) => {
    const business = vi.fn(event => event)
    const read = vi.fn(() => { throw new Error('password must not be read') })
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(`<script setup>import { business } from 'fixture'</script><template><input id="password" ${attr} data-growing-track data-title="never a password value" @blur="business($event)"/></template>`, dispatch, { fixture: { business } })
    try {
      const event = { currentTarget: { id: 'password', dataset: { growingTrack: true } }, get detail() { return read() } }
      expect(fixture.fire(0, 'onBlur', event)).toBe(event)
      expect(dispatch.mock.results[0]?.value).toStrictEqual({ kind: 'change', xpath: 'password#business', textValue: null })
      expect(read).not.toHaveBeenCalled()
      expect(business).toHaveBeenCalledTimes(1)
      expect(business.mock.calls[0]?.[0]).toBe(event)
    } finally { fixture.unmount() }
  })
  it('keeps explicit sensitivity on password inputs and file/dynamic-type exclusions', () => {
    const dispatch = vi.fn((probe, event) => normalizeAutoTrackCall(probe, event))
    const fixture = mountAutoTrackSfc(source('<input password data-growing-sensitive data-growing-track @blur="save($event)"/>'), dispatch)
    try {
      fixture.fire(0, 'onBlur', { detail: { value: 'must-not-leak' } })
      expect(dispatch.mock.results[0]?.value).toBeNull()
    } finally { fixture.unmount() }
    for (const attr of ['type="file"', ':type="type"']) {
      expect(handlers(transformAutoTrackTemplate(`<input ${attr} data-growing-track @blur="save($event)"/>`).code)[0]).toContain('sensitive:true')
    }
    expect(handlers(transformAutoTrackTemplate('<button data-growing-ignore="false" :data-growing-sensitive="privateValue" @click="save($event)"/>').code)[0]).toContain('ignored:"false"')
  })
  it('creates openURL probes with static and dynamic href and preserves a business click name', () => {
    const values = handlers(transformAutoTrackTemplate('<uni-link href="/docs"/><uni-link :href="link"/><uni-link href="/docs" @click="save($event)"/>').code)
    expect(values[0]).toContain('eventName:"openURL"')
    expect(values[0]).toContain('hyperlink:"/docs"')
    expect(values[1]).not.toContain('hyperlink:')
    expect(values[2]).toContain('eventName:"save"')
  })
  it('passes picker range and derives fixed picker-view column ranges', () => {
    const values = handlers(transformAutoTrackTemplate(`<picker :range="['A','B']" range-key="name" @change="save($event)"/><picker-view @change="save($event)"><picker-view-column><view v-for="item in first">{{item}}</view></picker-view-column><picker-view-column><view>A</view><view>B</view></picker-view-column></picker-view> `).code)
    expect(values[0]).toContain("pickerRange:(['A','B']),pickerRangeKey:\"name\"")
    expect(values[1]).not.toContain('pickerRange:')
  })
  it('keeps quote and entity contents intact in generated attributes', () => {
    const dispatch = vi.fn()
    const fixture = mountAutoTrackSfc(source('<button data-title="A &quot; B &amp; C" @click="save($event)"/>'), dispatch)
    fixture.fire(0, 'onClick', {})
    expect(dispatch.mock.calls[0]?.[0].textValue).toBe('A " B & C')
    fixture.unmount()
  })
  it('reports parser failures and forwards all warnings with file and source offset', () => {
    expect(transformAutoTrackTemplate('<view><button></view>').warnings[0]?.code).toBe('template_parse_error')
    expect(transformAutoTrackSfc('<template><view></template>').warnings[0]?.code).toBe('sfc_parse_error')
    const warnings: string[] = []
    const plugin = gioUniappAutoTrack()
    expect(plugin).toMatchObject({ name: 'gio-uniapp-autotrack', enforce: 'pre' })
    expect(plugin.transform.call({ warn: (warning) => warnings.push(warning) }, source('<button @click.stop="save($event)"/>'), 'page.vue')).toBeNull()
    expect(warnings[0]).toMatch(/page.vue:\d+ event_modifiers/)
    plugin.transform.call({ warn: (warning) => warnings.push(warning) }, '<view/>', 'page.nvue')
    expect(warnings[1]).toContain('page.nvue:0 .nvue_not_instrumented')
    expect(plugin.transform.call(undefined, 'const a = 1', 'entry.tsx')).toBeNull()
    expect(gioUniappAutoTrack({ enabled: false }).transform.call(undefined, source('<button @tap="save($event)"/>'), 'page.vue')).toBeNull()
  })
})
