import * as Vue from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { transformAutoTrackSfc } from '../../src/compiler/vite.js'
import { CHANGE_ELEMENTS, TEMPLATE_ELEMENTS } from '../../src/plugins/gioEventAutoTracking/contract.js'
import type { AppCapabilityProfile } from '../../src/constants/platform.js'

// 这里只描述受控测试宿主，绝不把测试通过写入生产平台的能力表。
export const testAutoTrackProfile: AppCapabilityProfile = {
  platform: 'Android', appLifecycle: false, pageLifecycle: false, autoClick: true, tabBar: true,
  changeInput: true, changePicker: true, appClosedBestEffort: false,
  autoChange: Object.fromEntries(CHANGE_ELEMENTS.map((element) => [element, true])) as AppCapabilityProfile['autoChange'],
}

type TestNode = {
  type: string; style: { display: string }; props: Record<string, unknown>; children: TestNode[]; parent: TestNode | null; text?: string
  value: unknown
  addEventListener(name: string, listener: (event: unknown) => void): void
  removeEventListener(name: string, listener: (event: unknown) => void): void
  dispatchEvent(event: { type: string }): boolean
}
/** 创建受控渲染节点及事件容器，用真实 Vue 指令验证业务语义。 */
function makeNode(type: string): TestNode {
  // 真实 demo 含 v-model，测试保留 Vue 输入指令，不通过删除指令规避行为验证。
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const node: TestNode = {
    type,
    style: { display: '' },
    props: {},
    children: [],
    parent: null,
    value: '',
    /** 登记受控节点监听器，保留同一事件的多个业务处理。 */
    addEventListener(name, listener) {
      const handlers = listeners.get(name) ?? new Set()
      handlers.add(listener); listeners.set(name, handlers)
    },
    /** 移除指定节点监听器，模拟组件或指令清理。 */
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) },
    /** 向节点监听器分发带目标的事件快照。 */
    dispatchEvent(event) { listeners.get(event.type)?.forEach(listener => listener({ ...event, target: node })); return true },
  }
  return node
}

/** 使用真实 SFC 编译器编译原始或插桩源码，并注入受控模块与探针接收器。 */
export function compileAutoTrackSfc(source: string, dispatch: (...args: unknown[]) => unknown, modules: Record<string, unknown> = {}, instrument = true, componentTags: readonly string[] = []) {
  const transformed = instrument ? transformAutoTrackSfc(source, '@sdk/runtime') : { code: source, warnings: [], changed: false }
  const { descriptor } = parse(transformed.code)
  const script = compileScript(descriptor, { id: 'gio-test', genDefaultAs: '__Component' })
  const isTS = (descriptor.scriptSetup?.lang ?? descriptor.script?.lang) === 'ts'
  // 与 Vite Vue 插件一致，TypeScript 模板必须显式配置表达式解析插件。
  const template = compileTemplate({ source: descriptor.template?.content ?? '', filename: 'fixture.vue', id: 'gio-test', compilerOptions: {
    isTS,
    expressionPlugins: isTS ? ['typescript'] : [],
    bindingMetadata: script.bindings,
    /** 仅将白名单宿主标签视为原生节点，指定组件仍执行真实组件逻辑。 */
    isCustomElement: (tag) => !componentTags.includes(tag) && (TEMPLATE_ELEMENTS as readonly string[]).includes(tag)
  } })
  if (template.errors.length > 0) throw new Error(String(template.errors[0]))
  const javascript = ts.transpileModule(`${script.content}\n${template.code}\n__Component.render=render;\nexport default __Component`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const output = { exports: {} as { default: Vue.Component } }
  /** 将编译结果的依赖限制为 Vue、探针入口和显式注入模块。 */
  const requireModule = (name: string): unknown => {
    if (name === 'vue') return Vue
    if (name === '@sdk/runtime') return { dispatchAutoTrack: dispatch }
    if (name in modules) return modules[name]
    throw new Error(`unexpected_fixture_import:${name}`)
  }
  new Function('require', 'module', 'exports', javascript)(requireModule, output, output.exports)
  return { transformed, component: output.exports.default }
}

/** 以受控 Vue 渲染器挂载编译结果，暴露节点查询、触发和卸载能力。 */
export function mountAutoTrackSfc(source: string, dispatch: (...args: unknown[]) => unknown, modules: Record<string, unknown> = {}, instrument = true, componentTags: readonly string[] = []) {
  const { transformed, component } = compileAutoTrackSfc(source, dispatch, modules, instrument, componentTags)
  const renderer = Vue.createRenderer<TestNode, TestNode>({
    createElement: makeNode,
    /** 创建独立文本节点，保留实际渲染文案。 */
    createText: (text) => ({ ...makeNode('#text'), text }),
    /** 创建注释占位节点，供条件分支渲染使用。 */
    createComment: (text) => ({ ...makeNode('#comment'), text }),
    /** 更新已有文本节点的内容。 */
    setText: (node, text) => { node.text = text },
    /** 设置元素直接文本并清空旧子节点，模拟 Vue 文本替换。 */
    setElementText: (node, text) => { node.text = text; node.children = [] },
    /** 读取节点父级，供 Vue 渲染器执行插入和移动。 */
    parentNode: (node) => node.parent,
    /** 取得同父级下的下一个节点，无后继时返回 null。 */
    nextSibling: (node) => node.parent?.children[(node.parent.children.indexOf(node)) + 1] ?? null,
    /** 按锚点插入或移动节点，同时维护父子关系。 */
    insert: (node, parent, anchor = null) => {
      if (node.parent !== null) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      const at = anchor === null ? parent.children.length : parent.children.indexOf(anchor)
      parent.children.splice(at, 0, node); node.parent = parent
    },
    /** 从父级移除节点并清理父引用。 */
    remove: (node) => { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
    /** 保存 Vue 更新后的属性和监听器，供测试按触发时状态构造事件。 */
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
  })
  const root = makeNode('root')
  const app = renderer.createApp(component)
  const instance = app.mount(root)
  /** 按渲染树顺序返回全部节点，避免测试复制模板结构。 */
  function elements(): TestNode[] {
    const nodes: TestNode[] = []
    /** 递归收集受控节点及其后代。 */
    const visit = (parent: TestNode): void => { for (const child of parent.children) { nodes.push(child); visit(child) } }
    visit(root)
    return nodes
  }
  /** 按匹配监听器的节点顺序触发真实编译函数，并返回业务结果。 */
  function fire(at: number, name: string, ...events: unknown[]): unknown {
    const handler = elements().filter((element) => typeof element.props[name] === 'function')[at]?.props[name]
    if (typeof handler !== 'function') throw new Error(`fixture_handler_missing:${name}:${at}`)
    return handler(...events)
  }
  return {
    transformed,
    instance,
    elements,
    fire,
    /** 卸载测试应用并执行 Vue 的组件与指令清理。 */
    unmount: () => app.unmount()
  }
}
