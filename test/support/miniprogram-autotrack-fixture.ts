import { createRequire } from 'node:module'
import { transformAutoTrackTemplate } from '../../src/compiler/vite.js'

const require = createRequire(import.meta.url)
const hostRequire = createRequire(require.resolve('@dcloudio/uni-mp-weixin/package.json'))
const { compile } = hostRequire('@dcloudio/uni-mp-compiler') as {
  compile(template: string, options: Record<string, unknown>): { code: string }
}
const { isMiniProgramNativeTag } = hostRequire('@dcloudio/uni-shared') as { isMiniProgramNativeTag: (tag: string) => boolean }
const runtime = hostRequire('@dcloudio/uni-mp-vue/dist/vue.runtime.esm.js') as {
  setCurrentRenderingInstance(instance: unknown): unknown
}
type Handler = (...args: unknown[]) => unknown
type Invoker = Handler & { value: unknown }

/** 以实际微信模板编译器和 uni-mp-vue 的 v-on 宿主执行监听器，独立于 Vue Web renderer。 */
export function compileMiniAutoTrack(template: string, context: Record<string, unknown>, instrument = true) {
  const transformed = instrument
    ? transformAutoTrackTemplate(template, 'gioAutoTrack', { references: 'render' })
    : { code: template, changed: false, warnings: [] }
  let native = ''
  const compiled = compile(transformed.code, {
    filename: '/private/tmp/gio-mini-autotrack-regression.vue', prefixIdentifiers: true, mode: 'module', isNativeTag: isMiniProgramNativeTag,
    miniProgram: { directive: 'wx:', slot: { fallbackContent: false, dynamicSlotNames: true }, event: { key: true },
      component: { dir: 'wxcomponents', vShow: 'hidden' }, emitFile: (file: { source: string }) => { native = file.source } },
  })
  const scope: Record<string, Invoker> = {}
  const errors: unknown[] = []
  const instance = { ctx: { $mpPlatform: 'mp-weixin', $scope: scope }, $ei: 0, type: {}, parent: null,
    appContext: { config: { errorHandler: (error: unknown) => { errors.push(error) } } } }
  // 编译器只为宿主原生标签导入 Vue runtime helpers；保留实际的 o/f/t 等 helper 实现。
  const javascript = compiled.code.replace(/^import \{([^}]+)\} from "vue"\s*/gm,
    (_, names: string) => `const {${names.replace(/\s+as\s+/g, ':')}}=__runtime;\n`).replace('export function render', 'function render')
  const render = new Function('__runtime', `"use strict";${javascript};return render;`)(runtime) as (ctx: unknown, cache: unknown[]) => Record<string, unknown>
  runtime.setCurrentRenderingInstance(instance)
  let data: Record<string, unknown>
  try { data = render(context, []) } finally { runtime.setCurrentRenderingInstance(null) }
  const invokers = Object.values(scope)
  const invoker = invokers[0]
  return {
    transformed, compiled: compiled.code, native, errors, data, listenerValue: invoker?.value,
    /** 经过真实小程序 invoker（包括参数解包、空值和数组处理）触发宿主事件。 */
    fire: (event: unknown): unknown => invoker?.(event),
    /** 触发循环模板中指定位置的真实原生 invoker。 */
    fireAt: (at: number, event: unknown): unknown => invokers[at]?.(event),
    /** 只执行已编译业务 listener，用于区分宿主预处理与采集代码对隐私 getter 的读取。 */
    callListener: (...args: unknown[]): unknown => {
      const listener = invoker?.value
      if (typeof listener !== 'function') throw new Error('fixture_callable_listener_missing')
      return (listener as Handler)(...args)
    },
  }
}
