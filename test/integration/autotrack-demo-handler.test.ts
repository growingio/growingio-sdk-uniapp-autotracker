import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeTypes, parse as parseTemplate, type ElementNode } from '@vue/compiler-dom'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { gioUniappAutoTrack } from '../../src/compiler/vite.js'
import { normalizeAutoTrackCall } from '../../src/plugins/gioEventAutoTracking/index.js'
import { mountAutoTrackSfc } from '../support/autotrack-fixture.js'

const pagePath = resolve(import.meta.dirname, '../../demo/pages/autotrack/autotrack.vue')
const pageSource = readFileSync(pagePath, 'utf8')

/** 从真实 demo 模板提取唯一条件按钮，避免复制待测表达式。 */
function conditionalButton(): string {
  const { descriptor, errors } = parseSfc(pageSource)
  if (errors.length > 0 || descriptor.template === null) throw new Error('demo 页面解析失败')
  const matches: ElementNode[] = []
  const visit = (children: ReturnType<typeof parseTemplate>['children']): void => {
    for (const child of children) {
      if (child.type !== NodeTypes.ELEMENT) continue
      if (child.tag === 'button' && child.children.some((text) => text.type === NodeTypes.TEXT && text.content.trim() === '无 id 的条件 handler')) {
        matches.push(child)
      }
      visit(child.children)
    }
  }
  visit(parseTemplate(descriptor.template.content).children)
  if (matches.length !== 1) throw new Error('demo 条件按钮必须唯一存在')
  return matches[0]!.loc.source
}

/** 隔离挂载真实条件按钮，并注入可核对返回值的业务方法。 */
function mountButton(dispatch: (...args: unknown[]) => unknown, template = conditionalButton()) {
  const onAction = vi.fn(() => 'action-result')
  const onInputComplete = vi.fn(() => 'input-result')
  // 读取真实按钮源码，隔离页面其他控件；由 Vue 编译并执行事件监听函数，避免复制待测表达式。
  const source = `<script setup>
    import { ref } from 'vue'
    import { onAction, onInputComplete } from 'fixture'
    const enabled = ref(false)
    defineExpose({ enabled })
  </script><template>${template}</template>`
  const fixture = mountAutoTrackSfc(source, dispatch, { fixture: { onAction, onInputComplete } })
  const state = fixture.instance as unknown as { enabled: boolean }
  return { ...fixture, state, onAction, onInputComplete }
}

describe('demo 条件 handler 代码回归', () => {
  it('真实页面经过 Vite 插件时正常插桩且不产生告警', () => {
    const warn = vi.fn()
    const result = gioUniappAutoTrack().transform.call({ warn }, pageSource, pagePath)
    expect(result).not.toBeNull()
    expect(result?.code).not.toBe(pageSource)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    { enabled: false, probeThrows: false },
    { enabled: true, probeThrows: false },
    { enabled: false, probeThrows: true },
    { enabled: true, probeThrows: true },
  ])('enabled=$enabled、采集抛错=$probeThrows 时只执行对应分支一次', async ({ enabled, probeThrows }) => {
    const dispatch = vi.fn((_probe: unknown, _event: unknown) => {
      if (probeThrows) throw new Error('模拟采集失败')
      return true
    })
    const fixture = mountButton(dispatch)
    try {
      fixture.state.enabled = enabled
      await nextTick()
      const event = { type: 'tap', currentTarget: { dataset: {} }, target: { id: 'child-only-id' } }
      expect(fixture.transformed.warnings).toEqual([])
      expect(fixture.fire(0, 'onTap', event)).toBe(enabled ? 'action-result' : 'input-result')

      const selected = enabled ? fixture.onAction : fixture.onInputComplete
      const skipped = enabled ? fixture.onInputComplete : fixture.onAction
      expect(selected).toHaveBeenCalledExactlyOnceWith(enabled ? '条件分支：开' : event)
      expect(skipped).not.toHaveBeenCalled()
      const eventName = enabled ? 'onAction' : 'onInputComplete'
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        schemaVersion: 2, source: 'template', kind: 'click', eventName,
      }), event)

      const [probe, nativeEvent] = dispatch.mock.calls[0]!
      expect(nativeEvent).toBe(event)
      expect(normalizeAutoTrackCall(probe, nativeEvent)).toMatchObject({ kind: 'click', xpath: `#${eventName}` })
    } finally {
      fixture.unmount()
    }
  })

  it('同一按钮在关闭、开启、再次关闭后使用最新状态选择分支', async () => {
    const dispatch = vi.fn()
    const fixture = mountButton(dispatch)
    try {
      for (const enabled of [false, true, false]) {
        fixture.state.enabled = enabled
        await nextTick()
        fixture.fire(0, 'onTap', { currentTarget: {} })
      }
      expect(fixture.onAction).toHaveBeenCalledTimes(1)
      expect(fixture.onInputComplete).toHaveBeenCalledTimes(2)
      expect(dispatch.mock.calls.map(([probe]) => probe.eventName)).toEqual(['onInputComplete', 'onAction', 'onInputComplete'])
    } finally {
      fixture.unmount()
    }
  })

  it('旧的混合调用与函数引用表达式保持原行为并明确告警', async () => {
    const dispatch = vi.fn()
    const fixture = mountButton(dispatch, `<button @tap="enabled ? onAction('条件分支：开') : onInputComplete" />`)
    try {
      expect(fixture.transformed.changed).toBe(false)
      expect(fixture.transformed.warnings).toMatchObject([{ code: 'complex_handler' }])
      expect(fixture.fire(0, 'onTap', {})).toBe(fixture.onInputComplete)
      expect(fixture.onInputComplete).not.toHaveBeenCalled()

      fixture.state.enabled = true
      await nextTick()
      expect(fixture.fire(0, 'onTap', {})).toBe('action-result')
      expect(fixture.onAction).toHaveBeenCalledExactlyOnceWith('条件分支：开')
      expect(fixture.onInputComplete).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      fixture.unmount()
    }
  })
})
