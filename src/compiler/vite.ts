import { NodeTypes, parse, type ElementNode, type TemplateChildNode } from '@vue/compiler-dom'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseScript } from '@babel/parser'
import { CHANGE_ELEMENTS, TEMPLATE_ELEMENTS } from '../plugins/gioEventAutoTracking/contract.js'
import { containsProbe, expression, memberPath, metadataExpression, node, rewriteHandler, walk } from './handler.js'

export type AutoTrackTransformWarning = Readonly<{
  code: 'sfc_parse_error' | 'template_parse_error' | 'dynamic_event' | 'missing_handler' | 'custom_component' | 'unsupported_event' | 'complex_handler' | 'complex_component_options' | 'event_name_fallback' | '.nvue_not_instrumented'
  offset: number
}>
export type AutoTrackTemplateTransform = Readonly<{ code: string; warnings: readonly AutoTrackTransformWarning[]; changed: boolean }>
export type AutoTrackTransformOptions = Readonly<{
  /** true 对应 App 的缓存引用；render 对应小程序渲染时单次读取的原生引用。 */
  references?: boolean | 'render'
}>
export type VueSfcTransform = AutoTrackTemplateTransform

type Replacement = Readonly<{ start: number; end: number; value: string }>
// App 输入组件不会转发原生 change，优先采集实际支持的完成事件。
// 仅声明 change 的模板仍保留兼容路径，不额外注入业务未声明的监听器。
const inputEvents = ['blur', 'confirm', 'change']
const textRenderingDirectives = new Set(['for', 'if', 'else-if', 'else', 'show', 'text', 'html'])
const marker = '#__GIO_AUTOTRACK_V2__'
const npmRuntimeImport = 'gio-uniapp-sdk/autotrack'
/** 将静态文本编码为安全的 JavaScript 字符串字面量。 */
function literal(value: string): string { return JSON.stringify(value) }
/** 转义模板属性中的特殊字符，避免生成的监听器破坏 HTML 语法。 */
function attribute(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;') }
/** 名称冲突检查也覆盖转义标识符；只解码用于比对，不改写业务源码。 */
function bindingNames(source: string): Set<string> {
  const decoded = source.replace(/\\u(?:\{([a-f\d]{1,6})\}|([a-f\d]{4}))/gi, (escape, point: string | undefined, unit: string | undefined) => {
    const value = Number.parseInt(point ?? unit!, 16)
    return value <= 0x10ffff ? String.fromCodePoint(value) : escape
  })
  return new Set(decoded.match(/[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*/gu) ?? [])
}
/** 按源码偏移分段拼接，避免每个监听器替换都复制整份 SFC。 */
function apply(source: string, replacements: Replacement[]): string {
  const chunks: string[] = []
  let end = source.length
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    chunks.push(source.slice(replacement.end, end), replacement.value)
    end = replacement.start
  }
  chunks.push(source.slice(0, end))
  return chunks.reverse().join('')
}
/** 普通成员路径（如 `cities`、`state.cities`）可在事件时只读取一次；含调用、计算键或可选访问的表达式不读取。 */
function lazyReference(source: string): string | null {
  return memberPath(expression(source)) === null ? null : `()=>(${source})`
}
/** 只提取可安全复制的静态绑定；可能被覆盖的授权和元数据不作回填。reference 时把成员路径绑定转为延迟读取。 */
function bound(element: ElementNode, name: string, preserveExclusion = false, reference = false): string | null {
  // 展开绑定或动态属性名可能在渲染时移除或替换字面量绑定。
  // 旧值不能回填为采集授权或已经失效的事件元数据。
  // 静态启用的 ignore 和 sensitive 标记仍按保守拒绝规则处理。
  if (!preserveExclusion && element.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind'
    && (prop.arg === undefined || prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic
      || (prop.arg.content === name && prop.modifiers.length > 0)))) return null
  for (const prop of element.props) {
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name === name) return literal(prop.value?.content ?? '')
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && prop.arg.isStatic && prop.arg.content === name && prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
      return metadataExpression(prop.exp.content) ?? (reference ? lazyReference(prop.exp.content) : null)
    }
  }
  return null
}
/** 检查目标属性是否可能受直接绑定、展开或动态属性名影响。 */
function hasBound(element: ElementNode, name: string): boolean {
  return element.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind'
    && (prop.arg === undefined || prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic || prop.arg.content === name))
}
/** 只认可可静态确认且不会被覆盖的忽略标记，用于抑制非必要告警。 */
function explicitlyIgnored(element: ElementNode): boolean {
  // 展开或动态属性可能覆盖 ignore，此时仍需保留采集边界诊断。
  if (element.props.some(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind'
    && (prop.arg === undefined || prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic))) return false
  const markers = element.props.filter(prop => prop.type === NodeTypes.ATTRIBUTE ? prop.name === 'data-growing-ignore'
    : prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && prop.arg.isStatic && prop.arg.content === 'data-growing-ignore')
  if (markers.length !== 1) return false
  const marker = markers[0]
  let value: unknown
  if (marker?.type === NodeTypes.ATTRIBUTE) value = marker.value?.content ?? ''
  else if (marker?.type === NodeTypes.DIRECTIVE && marker.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
    const parsed = expression(marker.exp.content)
    if (parsed === null || !['BooleanLiteral', 'NumericLiteral', 'StringLiteral'].includes(parsed.type)) return false
    value = parsed.value
  }
  return value === true || value === '' || value === 'true' || value === 1 || value === '1'
}
/** 文件和无法确认类型的动态输入继续拒绝整个探针。 */
function sensitive(element: ElementNode): boolean {
  if (element.tag !== 'input' && element.tag !== 'textarea') return false
  return hasBound(element, 'type') || element.props.some((prop) => prop.type === NodeTypes.ATTRIBUTE
    && prop.name === 'type' && prop.value?.content.toLowerCase() === 'file')
}
/** 密码输入保留完成事件；动态 password 也始终禁读值，不重复求值业务绑定。 */
function password(element: ElementNode): boolean {
  if (element.tag !== 'input' && element.tag !== 'textarea') return false
  return hasBound(element, 'password') || element.props.some((prop) => prop.type === NodeTypes.ATTRIBUTE
    && ((prop.name === 'type' && ['password', 'safe-password'].includes(prop.value?.content.toLowerCase() ?? ''))
      || prop.name === 'password'))
}
/** 递归提取确定会显示的 view/text 文字；动态或条件渲染时返回 null。 */
function staticText(element: ElementNode): string | null {
  if (!['view', 'text'].includes(element.tag)) return null
  if (element.props.some((prop) => prop.type === NodeTypes.DIRECTIVE
    && textRenderingDirectives.has(prop.name))) return null
  let value = ''
  for (const child of element.children) {
    if (child.type === NodeTypes.TEXT) value += child.content
    else if (child.type === NodeTypes.ELEMENT) { const nested = staticText(child); if (nested === null) return null; value += nested }
    else if (child.type !== NodeTypes.COMMENT) return null
  }
  return value.trim()
}

// picker-view 本身没有 range 属性；从固定列的简单选项模板取得 range，复杂渲染保留下标回退。
/** 从固定 picker-view 列恢复选项；字面量列直接复制，成员路径列在事件时延迟读取；无法确认显示文案时回退下标。 */
function pickerColumns(element: ElementNode): { range: string; key: string | null } | null {
  let dynamic = false
  const ranges: string[] = []
  const keys: (string | null)[] = []
  for (const column of element.children) {
    if (column.type === NodeTypes.TEXT && column.content.trim() === '' || column.type === NodeTypes.COMMENT) continue
    if (column.type !== NodeTypes.ELEMENT || column.tag !== 'picker-view-column' || column.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && textRenderingDirectives.has(prop.name))) return null
    const options = column.children.filter((child) => child.type !== NodeTypes.COMMENT && !(child.type === NodeTypes.TEXT && child.content.trim() === ''))
    const option = options[0]
    if (option?.type === NodeTypes.ELEMENT && !['view', 'text'].includes(option.tag)) return null
    const loop = option?.type === NodeTypes.ELEMENT ? option.props.find((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === 'for') : undefined
    if (options.length === 1 && option?.type === NodeTypes.ELEMENT && loop?.type === NodeTypes.DIRECTIVE && loop.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
      if (option.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name !== 'for' && textRenderingDirectives.has(prop.name))) return null
      const match = /^\s*\(?\s*([\w$]+)(?:\s*,\s*[\w$]+)?\s*\)?\s+(?:in|of)\s+([\s\S]+)$/.exec(loop.exp.content)
      const literalRange = match?.[2] === undefined ? null : metadataExpression(match[2])
      const reference = literalRange === null && match?.[2] !== undefined && memberPath(expression(match[2].trim())) !== null ? `(${match[2].trim()})` : null
      if (reference !== null) dynamic = true
      const range = literalRange ?? reference
      const content = option.children.filter((child) => !(child.type === NodeTypes.TEXT && child.content.trim() === ''))
      if (match === null || range === null || content.length !== 1 || content[0]?.type !== NodeTypes.INTERPOLATION || content[0].content.type !== NodeTypes.SIMPLE_EXPRESSION) return null
      const label = content[0].content.content.trim()
      if (label !== match[1] && !new RegExp(`^${match[1]?.replace(/\$/g, '\\$')}\\.[A-Za-z_$][\\w$]*$`).test(label)) return null
      ranges.push(range)
      keys.push(label === match[1] ? null : label.slice(label.indexOf('.') + 1))
    } else {
      const labels: string[] = []
      for (const child of options) {
        if (child.type !== NodeTypes.ELEMENT || child.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && ['for', 'if'].includes(prop.name))) return null
        const label = staticText(child)
        if (label === null) return null
        labels.push(literal(label))
      }
      ranges.push(`[${labels.join(',')}]`)
      keys.push(null)
    }
  }
  if (ranges.length === 0 || !keys.every((key) => key === keys[0])) return null
  return { range: dynamic ? `()=>([${ranges.join(',')}])` : `[${ranges.join(',')}]`, key: keys[0] ?? null }
}
/** 按组件和事件种类生成受限探针字段，不重新求值业务动态绑定。 */
function probeFields(element: ElementNode, kind: 'click' | 'change', name: string, capture: (value: string) => string = value => value): string {
  const fields = ['schemaVersion:2', 'source:"template"', `kind:${literal(kind)}`, `eventName:${literal(name)}`, `elementType:${literal(element.tag)}`]
  const excluded = sensitive(element) || (kind === 'click' && password(element))
  const names = { 'data-title': 'textValue', 'data-index': 'index', 'data-src': 'hyperlink', 'data-growing-ignore': 'ignored', 'data-growing-track': 'trackValue', 'data-growing-sensitive': 'sensitive' }
  for (const [prop, field] of Object.entries(names)) {
    if (field === 'sensitive' && excluded) continue
    const value = bound(element, prop, field === 'ignored' || field === 'sensitive')
    if (value !== null) fields.push(`${field}:${value}`)
  }
  if (excluded) fields.push('sensitive:true')
  if (kind === 'change' && password(element)) fields.push('redactValue:true')
  if (element.tag === 'uni-link' && bound(element, 'data-src') === null) {
    const href = bound(element, 'href')
    if (href !== null) fields.push(`hyperlink:${href}`)
  }
  if (kind === 'change' && element.tag === 'picker') {
    // 动态 range / range-key 只接受成员路径，并以函数延迟到通过隐私与授权检查后再读取。
    const range = bound(element, 'range', false, true)
    const key = bound(element, 'range-key', false, true)
    const mode = bound(element, 'mode', false, true)
    // 绑定存在但无法安全读取时，不可把未知动态模式误当作默认 selector。
    if (mode !== null) fields.push(`pickerMode:${capture(mode)}`)
    else if (hasBound(element, 'mode')) fields.push('pickerMode:null')
    if (range !== null) fields.push(`pickerRange:${capture(range)}`)
    if (key !== null) fields.push(`pickerRangeKey:${capture(key)}`)
  }
  if (kind === 'change' && element.tag === 'picker-view') {
    const columns = pickerColumns(element)
    if (columns !== null) { fields.push(`pickerRange:${capture(columns.range)}`); if (columns.key !== null) fields.push(`pickerRangeKey:${literal(columns.key)}`) }
  }
  return `{${fields.join(',')}}`
}
/** 跳过引号内字符定位开始标签末尾，供无监听器的链接追加探针。 */
function openingEnd(element: ElementNode): number | null {
  let quote = ''
  for (let i = 0; i < element.loc.source.length; i++) {
    const char = element.loc.source[i]
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '>') return element.loc.start.offset + (element.loc.source[i - 1] === '/' ? i - 1 : i)
  }
  return null
}
/** 提取 v-for 别名和 v-slot 参数中的标识符；宁可多收，也不把作用域变量当成可缓存引用。 */
function scopeNames(element: ElementNode): string[] {
  const names: string[] = []
  for (const prop of element.props) {
    if (prop.type !== NodeTypes.DIRECTIVE || prop.exp?.type !== NodeTypes.SIMPLE_EXPRESSION) continue
    const source = prop.name === 'for' ? prop.exp.content.split(/\s+(?:in|of)\s+/)[0] ?? '' : prop.name === 'slot' ? prop.exp.content : ''
    names.push(...source.match(/[A-Za-z_$][\w$]*/g) ?? [])
  }
  return names
}
type VisitContext = Readonly<{
  dispatcher: string
  locals: string
  references: boolean | 'render'
  /** 外层 v-for / v-slot 引入的作用域变量；Vue 不缓存引用这些变量的监听器。 */
  scope: ReadonlySet<string>
  /** v-once 内的监听器不缓存，引用值固定为首次渲染时的结果。 */
  once: boolean
}>
/** 遍历模板元素并收集可安全插桩的监听器替换及边界告警。 */
function visit(nodes: readonly TemplateChildNode[], context: VisitContext, replacements: Replacement[], warnings: AutoTrackTransformWarning[]): void {
  const { dispatcher } = context
  for (const element of nodes) {
    if (element.type !== NodeTypes.ELEMENT) continue
    const added = scopeNames(element)
    const scope = added.length === 0 ? context.scope : new Set([...context.scope, ...added])
    const once = context.once || element.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === 'once')
    const selected = inputEvents.find((name) => element.props.some((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === 'on' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic && prop.arg.content === name))
    const ignored = explicitlyIgnored(element)
    let hasClick = false
    let hasDynamic = false
    for (const prop of element.props) {
      if (prop.type !== NodeTypes.DIRECTIVE || prop.name !== 'on') continue
      // 明确排除采集的监听不属于漏采目标，但仍保留语法诊断。
      /** 保留语法相关告警，对明确忽略的采集目标省去无意义诊断。 */
      const warn = (code: AutoTrackTransformWarning['code']): void => {
        if (!ignored || code === 'missing_handler') warnings.push({ code, offset: prop.loc.start.offset })
      }
      if (prop.arg?.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic) { hasDynamic = true; warn('dynamic_event'); continue }
      const nativeName = prop.arg.content
      const click = nativeName === 'click' || nativeName === 'tap'
      if (click) hasClick = true
      if (prop.exp?.type !== NodeTypes.SIMPLE_EXPRESSION || prop.exp.content.trim() === '') { warn('missing_handler'); continue }
      const parsed = expression(prop.exp.content)
      if (parsed !== null && containsProbe(parsed, dispatcher)) continue
      if (!(TEMPLATE_ELEMENTS as readonly string[]).includes(element.tag)) { warn('custom_component'); continue }
      if (!click && (!inputEvents.includes(nativeName) || !(CHANGE_ELEMENTS as readonly string[]).includes(element.tag)
        || (nativeName !== 'change' && element.tag !== 'input' && element.tag !== 'textarea'))) { warn('unsupported_event'); continue }
      if (!click && (element.tag === 'input' || element.tag === 'textarea') && nativeName !== selected) continue
      // 修饰符包裹在 handler 外层，探针位于其内，只随业务 handler 实际执行。
      // 只有 Vue 会缓存的引用才改写；作用域变量与 v-once 内的引用按渲染时取值，保持原样。
      const cached = context.references === true && !once && !(prop.exp.content.match(/[A-Za-z_$][\w$]*/g) ?? []).some((name) => scope.has(name))
      const reference = cached || context.references === 'render'
        ? { args: `${context.locals}Args`, handler: `${context.locals}Handler`, mode: context.references === 'render' ? 'render' as const : 'cached' as const } : undefined
      const parameters = new Set<string>()
      if (parsed?.type === 'ArrowFunctionExpression' || parsed?.type === 'FunctionExpression') walk(parsed.params, entry => {
        if (entry.type === 'Identifier') parameters.add(String(entry.name))
      })
      const captures = new Map<string, string>()
      // 元数据 thunk 的词法作用域应属于模板，而不是业务 listener 的参数。
      // 只提升会被遮蔽的 thunk；创建闭包不读取 getter，实际读取仍在授权检查之后。
      const capture = (value: string): string => {
        if (!value.startsWith('()=>') || ![...bindingNames(value)].some(name => parameters.has(name))) return value
        const name = captures.get(value) ?? `${context.locals}Binding${captures.size}`
        captures.set(value, name)
        return name
      }
      const rewritten = rewriteHandler(prop.exp.content, nativeName, dispatcher, (name, event = '$event') => `try{${dispatcher}(${probeFields(element, click ? 'click' : 'change', name, capture)},${event})}catch{}`, reference)
      if (rewritten === null) { warn('complex_handler'); continue }
      if (rewritten.fallback) warn('event_name_fallback')
      const before = element.loc.source[prop.exp.loc.start.offset - element.loc.start.offset - 1]
      // 用转发箭头保持普通函数的裸调用 this、arguments 和全部业务参数，末尾成员访问保留渲染时闭包绑定。
      const forward = `${context.locals}ForwardArgs`
      const code = captures.size === 0 ? rewritten.code
        : `((${[...captures.values()].join(',')})=>({listener:(...${forward})=>(${rewritten.code})(...${forward})}))(${[...captures.keys()].join(',')}).listener`
      const escaped = attribute(code)
      replacements.push({ start: prop.exp.loc.start.offset, end: prop.exp.loc.end.offset, value: before === '"' || before === "'" ? escaped : `"${escaped}"` })
    }
    if (element.tag === 'uni-link' && !hasClick && !hasDynamic) {
      const end = openingEnd(element)
      if (end !== null) replacements.push({ start: end, end, value: ` @click="${attribute(`($event)=>{try{${dispatcher}(${probeFields(element, 'click', 'openURL')},$event)}catch{}}`)}"` })
    }
    visit(element.children, { ...context, scope, once }, replacements, warnings)
  }
}

/** 解析模板并应用探针替换；语法错误时保留原模板和诊断。 */
export function transformAutoTrackTemplate(template: string, dispatcher = 'gioAutoTrack', options: AutoTrackTransformOptions = {}): AutoTrackTemplateTransform {
  const warnings: AutoTrackTransformWarning[] = []
  let root
  try { root = parse(template, {
    /** 将模板解析器错误记录为带源码偏移的构建诊断。 */
    onError: (error) => { warnings.push({ code: 'template_parse_error', offset: error.loc?.start.offset ?? 0 }) }
  }) }
  catch { return { code: template, warnings: [{ code: 'template_parse_error', offset: 0 }], changed: false } }
  if (warnings.length > 0) return { code: template, warnings, changed: false }
  const replacements: Replacement[] = []
  const names = bindingNames(template)
  let locals = dispatcher
  for (let suffix = 1; [...names].some(name => name.startsWith(locals)); suffix++) locals = `${dispatcher}${suffix}`
  visit(root.children, { dispatcher, locals, references: options.references ?? false, scope: new Set(), once: false }, replacements, warnings)
  return { code: apply(template, replacements), warnings, changed: replacements.length > 0 }
}

/** 处理完整 Vue SFC，选择无名称冲突的运行时导入并保持重复处理幂等。 */
export function transformAutoTrackSfc(source: string, runtimeImport = npmRuntimeImport, options: AutoTrackTransformOptions = {}): VueSfcTransform {
  const parsed = parseSfc(source)
  if (parsed.errors.length > 0) return { code: source, changed: false, warnings: parsed.errors.map((error) => ({ code: 'sfc_parse_error', offset: typeof error === 'object' && 'loc' in error ? error.loc?.start.offset ?? 0 : 0 })) }
  const { template, script, scriptSetup } = parsed.descriptor
  if (template === null) return { code: source, warnings: [], changed: false }
  if (template.src || (template.lang && template.lang !== 'html') || scriptSetup?.src || script?.src) return { code: source, changed: false, warnings: [{ code: 'sfc_parse_error', offset: template.loc.start.offset }] }
  let existing: string | null = null
  let methodsInsertion: { offset: number; existing: boolean } | null = null
  let unsafeOptions = false
  const names = bindingNames(source)
  try {
    for (const block of [scriptSetup, script]) {
      if (block === null) continue
      const ast = parseScript(block.content, { sourceType: 'module', plugins: ['typescript'] })
      walk(ast.program, (entry) => {
        if (entry.type === 'Identifier' && typeof entry.name === 'string') names.add(entry.name)
        if (entry.type === 'StringLiteral' && typeof entry.value === 'string') names.add(entry.value)
      })
      for (const entry of ast.program.body) {
        if (block === script && scriptSetup === null && entry.type === 'ExportDefaultDeclaration') {
          const options = entry.declaration
          if (options.type !== 'ObjectExpression' || options.properties.some((prop) => prop.type === 'SpreadElement' || prop.computed)) {
            unsafeOptions = true
          } else {
            const methods = options.properties.filter((prop) => prop.type !== 'SpreadElement' && (prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : '') === 'methods')
            const method = methods[0]
            if (methods.length > 1 || (method !== undefined && (method.type !== 'ObjectProperty' || method.value.type !== 'ObjectExpression' || method.value.properties.some((prop) => prop.type === 'SpreadElement' || prop.computed)))) unsafeOptions = true
            else if (method?.type === 'ObjectProperty' && method.value.type === 'ObjectExpression' && method.value.start != null) methodsInsertion = { offset: method.value.start + 1, existing: true }
            else if (options.start != null) methodsInsertion = { offset: options.start + 1, existing: false }
          }
        }
        if (entry.type !== 'ImportDeclaration' || entry.source.value !== runtimeImport || !entry.leadingComments?.some((comment) => comment.value.trim() === marker)) continue
        for (const specifier of entry.specifiers) if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'dispatchAutoTrack') existing = specifier.local.name
      }
    }
  } catch { return { code: source, warnings: [{ code: 'sfc_parse_error', offset: scriptSetup?.loc.start.offset ?? script?.loc.start.offset ?? 0 }], changed: false } }
  let dispatcher = 'gioAutoTrack'
  for (let suffix = 1; [...names].some((name) => name.startsWith(dispatcher)); suffix++) dispatcher = `gioAutoTrack${suffix}`
  dispatcher = existing ?? dispatcher
  const transformed = transformAutoTrackTemplate(template.content, dispatcher, options)
  const warnings = transformed.warnings.map((warning) => ({ ...warning, offset: warning.offset + template.loc.start.offset }))
  if (!transformed.changed) return { code: source, warnings, changed: false }
  if (unsafeOptions) return { code: source, changed: false, warnings: [...warnings, { code: 'complex_component_options', offset: script?.loc.start.offset ?? 0 }] }
  const replacements: Replacement[] = [{ start: template.loc.start.offset, end: template.loc.end.offset, value: transformed.code }]
  if (existing === null) {
    const imported = `\n/* ${marker} */\nimport { dispatchAutoTrack as ${dispatcher} } from ${literal(runtimeImport)}\n`
    if (scriptSetup !== null) replacements.push({ start: scriptSetup.loc.start.offset, end: scriptSetup.loc.start.offset, value: imported })
    else if (script !== null && methodsInsertion !== null) {
      // 直接向静态 methods 对象插入独立名称，不复制组件或提前读取业务属性访问器。
      replacements.push({ start: script.loc.start.offset, end: script.loc.start.offset, value: imported })
      const offset = script.loc.start.offset + methodsInsertion.offset
      replacements.push({ start: offset, end: offset, value: methodsInsertion.existing ? `${dispatcher},` : `methods:{${dispatcher}},` })
    } else replacements.push({ start: 0, end: 0, value: `<script setup${script?.lang ? ` lang="${attribute(script.lang)}"` : ''}>${imported}</script>\n` })
  }
  return { code: apply(source, replacements), warnings, changed: true }
}

export type UniAppAutoTrackViteContext = Readonly<{
  /** 将带文件与偏移信息的采集边界诊断交给宿主构建器。 */
  warn?: (message: string) => void
}>
export type UniAppAutoTrackVitePlugin = Readonly<{
  name: string;
  enforce: 'pre';
  config: () => Readonly<{ define: Readonly<Record<string, string>> }>;
  /** 返回实际改写源码；不支持或无需改写时返回 null。 */
  transform: (this: UniAppAutoTrackViteContext | void, source: string, id: string) => Readonly<{ code: string }> | null
}>
export type UniAppAutoTrackViteOptions = Readonly<{ enabled?: boolean; runtimeImport?: string }>
/** 创建在 uni 编译器前执行的 Vite 插件，支持关闭插桩和指定探针导入路径。 */
export function gioUniappAutoTrack(options?: string | UniAppAutoTrackViteOptions): UniAppAutoTrackVitePlugin {
  const runtimeImport = typeof options === 'string' ? options : options?.runtimeImport ?? npmRuntimeImport
  return {
    name: 'gio-uniapp-autotrack',
    enforce: 'pre',
    config: () => ({ define: { __GIO_UNI_PLATFORM__: JSON.stringify(process.env.UNI_PLATFORM ?? '') } }),
    /** 只处理支持的 Vue 文件，透传采集边界告警并返回实际改写结果。 */
    transform(source, id) {
      if (typeof options !== 'string' && options?.enabled === false) return null
      if (id.endsWith('.nvue')) { this?.warn?.(`[gio-uniapp-autotrack] ${id}:0 .nvue_not_instrumented`); return null }
      if (!id.endsWith('.vue')) return null
      // App 固定开启 cacheHandlers；小程序由 _o 在渲染时接收单次读取的引用。
      const platform = process.env.UNI_PLATFORM ?? ''
      const references = ['app', 'app-plus', 'app-harmony'].includes(platform) ? true : platform.startsWith('mp-') ? 'render' : false
      const result = transformAutoTrackSfc(source, runtimeImport, { references })
      for (const warning of result.warnings) this?.warn?.(`[gio-uniapp-autotrack] ${id}:${warning.offset} ${warning.code}`)
      return result.changed ? { code: result.code } : null
    },
  }
}
