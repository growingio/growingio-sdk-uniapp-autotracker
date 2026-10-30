import { parseExpression } from '@babel/parser'

export type AstNode = { type: string; start?: number | null; end?: number | null; [key: string]: unknown }
/** 识别带 type 字段的 AST 节点，供容错遍历使用。 */
export function node(value: unknown): AstNode | null {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string' ? value as AstNode : null
}
/** 递归访问 AST 节点与数组，跳过位置、注释和词法标记等非语义信息。 */
export function walk(value: unknown, visit: (value: AstNode) => void): void {
  if (Array.isArray(value)) { value.forEach((entry) => walk(entry, visit)); return }
  const current = node(value)
  if (current === null) return
  visit(current)
  for (const [key, child] of Object.entries(current)) if (!['loc', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens'].includes(key)) walk(child, visit)
}
/** 按 TypeScript 表达式语法解析监听器；解析失败时返回 null。 */
export function expression(source: string): AstNode | null {
  try { return parseExpression(source, { plugins: ['typescript'] }) as unknown as AstNode } catch { return null }
}
/** 提取普通标识符或静态成员路径；计算属性和可选访问不作猜测。 */
export function memberPath(value: unknown): string | null {
  const current = node(value)
  if (current?.type === 'Identifier') return String(current.name)
  if (current?.type !== 'MemberExpression' || current.computed || current.optional) return null
  const object = memberPath(current.object)
  const property = node(current.property)
  return object !== null && property?.type === 'Identifier' ? `${object}.${String(property.name)}` : null
}
/** 识别当前派发器的第二版结构探针调用，避免重复插桩。 */
export function containsProbe(root: AstNode, dispatcher: string): boolean {
  let found = false
  walk(root, (entry) => {
    if (entry.type !== 'CallExpression' || memberPath(entry.callee) !== dispatcher || !Array.isArray(entry.arguments)) return
    const argument = node(entry.arguments[0])
    if (argument?.type !== 'ObjectExpression' || !Array.isArray(argument.properties)) return
    const fields = new Map(argument.properties.map((property) => {
      const field = node(property)
      return [node(field?.key)?.name, node(field?.value)?.value]
    }))
    if (fields.get('schemaVersion') === 2 && fields.get('source') === 'template') found = true
  })
  return found
}

/** 排除多分支、异步、可选调用等无法保证原求值语义的节点。 */
function safeLeaf(root: AstNode): boolean {
  let safe = true
  walk(root, (entry) => {
    if (entry.type === 'ConditionalExpression' || entry.type === 'SequenceExpression' || entry.type === 'AwaitExpression'
      || entry.type === 'YieldExpression' || entry.type === 'OptionalCallExpression' || entry.type === 'OptionalMemberExpression'
      || entry.type === 'NewExpression' || entry.type === 'TaggedTemplateExpression'
      || (entry.type === 'MemberExpression' && entry.computed)) safe = false
  })
  return safe
}

/** 只复制字面量元数据；动态绑定由原模板求值，事件阶段从原生 dataset 读取。 */
export function metadataExpression(source: string): string | null {
  const root = expression(source)
  /** 递归确认元数据仅含可复制字面量，拒绝属性访问器、展开和动态求值。 */
  const literal = (value: AstNode | null): boolean => {
    if (value === null) return false
    if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(value.type)) return true
    if (value.type === 'UnaryExpression' && ['+', '-'].includes(String(value.operator))) return node(value.argument)?.type === 'NumericLiteral'
    if (value.type === 'ArrayExpression') return Array.isArray(value.elements) && value.elements.every((item) => item === null || literal(node(item)))
    if (value.type === 'ObjectExpression') return Array.isArray(value.properties) && value.properties.every((item) => {
      const property = node(item)
      return property?.type === 'ObjectProperty' && !property.computed && !property.shorthand && literal(node(property.value))
    })
    return false
  }
  return literal(root) ? `(${source})` : null
}

type Branch = Readonly<{ name: string; original: string; fallback: boolean }>
/** 剥离仅影响类型的包装，以沿用 Vue 对函数引用的识别语义。 */
function unwrapTypeExpression(root: AstNode): AstNode {
  // Vue 会穿透这些 TypeScript 包装识别函数引用，不能误改成返回函数的事件闭包。
  const wrappers = ['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSInstantiationExpression', 'TSSatisfiesExpression']
  let current = root
  while (wrappers.includes(current.type)) {
    const inner = node(current.expression)
    if (inner === null) break
    current = inner
  }
  return current
}

/** 分析一个可安全改写的业务分支，提取事件名及原源码范围。 */
function branch(root: AstNode, source: string, nativeName: string, inline = false): Branch | null {
  if (!safeLeaf(root)) return null
  const original = source.slice(root.start ?? 0, root.end ?? source.length)
  const reference = memberPath(unwrapTypeExpression(root))
  // 函数引用由 Vue 决定求值、缓存、空值及多个处理函数的行为，不能擅自替换成调用。
  if (reference !== null) return null
  const calls: AstNode[] = []
  const functions: AstNode[] = []
  walk(root, (entry) => {
    if (entry.type === 'CallExpression') calls.push(entry)
    if (entry.type === 'ArrowFunctionExpression' || entry.type === 'FunctionExpression') functions.push(entry)
  })
  if (calls.length > 1 || calls.some((call) => memberPath(call.callee) === null)) return null
  const name = calls.length === 1 ? memberPath(calls[0]?.callee) as string : nativeName
  if (root.type === 'ArrowFunctionExpression' || root.type === 'FunctionExpression') {
    if (inline) return null
    if (functions.length !== 1 || root.async || root.generator) return null
    const body = node(root.body)
    if (body?.type === 'BlockStatement') {
      if (Array.isArray(body.directives) && body.directives.length > 0) return null
      const statements = Array.isArray(body.body) ? body.body : []
      if (statements.length > 1 || statements.some((statement) => !['ReturnStatement', 'ExpressionStatement'].includes(node(statement)?.type ?? ''))) return null
    }
    return { name, original, fallback: calls.length === 0 }
  }
  if (functions.length > 0 || (root.type !== 'CallExpression' && calls.length > 0)) return null
  return { name, original, fallback: calls.length === 0 }
}

/** 在安全监听器中插入隔离异常的探针，保留业务参数、this、返回值与条件执行。无法保证语义时返回 null。 */
export function rewriteHandler(source: string, nativeName: string, _dispatcher: string, probe: (name: string, event?: string) => string): Readonly<{ code: string; fallback: boolean }> | null {
  const root = expression(source)
  if (root === null) return null
  if (root.type === 'ArrowFunctionExpression' || root.type === 'FunctionExpression') {
    const checked = branch(root, source, nativeName)
    const body = node(root.body)
    const parameter = Array.isArray(root.params) ? node(root.params[0]) : null
    if (checked === null || body?.start == null || body.end == null || parameter?.type !== 'Identifier') return null
    const capture = probe(checked.name, String(parameter.name))
    // 保留原函数的参数、this、arguments、求值位置和返回行为，只插入失败隔离的探针。
    // Babel 的表达式节点范围不含外围括号；箭头整体终点才包含这些括号及内部注释。
    const extra = typeof body.extra === 'object' && body.extra !== null ? body.extra as Record<string, unknown> : null
    const start = body.type === 'BlockStatement' ? body.start + 1
      : typeof extra?.parenStart === 'number' ? extra.parenStart : body.start
    const end = root.end ?? body.end
    const code = body.type === 'BlockStatement'
      ? `${source.slice(0, start)}${capture}${source.slice(start)}`
      : `${source.slice(0, start)}{${capture}return (${source.slice(start, end)})}${source.slice(end)}`
    return { code, fallback: checked.fallback }
  }
  if (root.type === 'ConditionalExpression') {
    const test = node(root.test)
    const yes = node(root.consequent)
    const no = node(root.alternate)
    if (test === null || yes === null || no === null || !safeLeaf(test)) return null
    const left = branch(yes, source, nativeName, true)
    const right = branch(no, source, nativeName, true)
    if (left === null || right === null) return null
    return {
      code: `($event)=>{if(${source.slice(test.start ?? 0, test.end ?? 0)}){${probe(left.name)};return (${left.original})}else{${probe(right.name)};return (${right.original})}}`,
      fallback: left.fallback || right.fallback,
    }
  }
  const result = branch(root, source, nativeName)
  return result === null ? null : { code: `($event)=>{${probe(result.name)};return (${result.original})}`, fallback: result.fallback }
}
