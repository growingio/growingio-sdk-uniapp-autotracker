import { AUTO_TRACK_SCHEMA_VERSION, CHANGE_ELEMENTS, TEMPLATE_ELEMENTS, type NormalizedAutoTrackCall, type AutoTrackCall } from './contract.js'

const templateFields = new Set(['schemaVersion', 'source', 'kind', 'eventName', 'elementType', 'pickerRange', 'pickerRangeKey', 'textValue', 'index', 'hyperlink', 'ignored', 'trackValue', 'sensitive', 'redactValue'])
const tabFields = new Set(['schemaVersion', 'source', 'kind', 'xpath', 'index', 'textValue', 'hyperlink'])
export const MAX_RANGE_ITEMS = 1000
export const MAX_PICKER_COLUMNS = 20

/** 为探针和宿主事件提供非数组对象视图，不序列化原始对象。 */
export function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null
}
/** 只认可字符串、布尔和有限数字作为可采集基础值。 */
function scalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}
/** 允许字段缺省或显式为空，其余值必须是可采集标量。 */
function optionalScalar(value: unknown): boolean { return value == null || scalar(value) }
/** 清理基础值中的控制字符和首尾空白，完整链接不套用显示文案上限。 */
function scalarText(value: unknown): string | null {
  return scalar(value) ? String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim() : null
}
/** 控制字符归一为空格后也属于文案首尾应去除的空白。 */
function textWhitespace(character: string): boolean {
  const code = character.charCodeAt(0)
  return code <= 0x20 || code === 0x7f || character.trim() === ''
}
/** 只构造最多 100 码点的拼接结果；全局首尾裁剪不改变分项内部或分隔符旁的空白。 */
function displayText(parts: readonly string[]): string {
  let result = ''
  let length = 0
  for (let part = 0; part < parts.length; part += 1) {
    if (part > 0) {
      for (const character of '||') {
        result += character
        if (++length === 100) return result
      }
    }
    const source = parts[part] as string
    let start = 0
    let end = source.length
    if (part === 0) while (start < end && textWhitespace(source[start] as string)) start += 1
    if (part === parts.length - 1) while (end > start && textWhitespace(source[end - 1] as string)) end -= 1
    // 按下标读取原串，避免非 V8 宿主为 slice 分配整段未采集文本。
    for (let offset = start; offset < end;) {
      const code = source.codePointAt(offset) as number
      result += code <= 0x1f || code === 0x7f ? ' ' : String.fromCodePoint(code)
      offset += code > 0xffff ? 2 : 1
      if (++length === 100) return result
    }
  }
  return result
}
/** 将显示文案限制为最多 100 个 Unicode 码点，保留整体首尾裁剪，避免整串复制及拆开代理对。 */
function text(value: unknown): string | null { return scalar(value) ? displayText([String(value)]) : null }
/** 统一识别空标记、true、1 及其约定字符串形式。 */
export function enabledMarker(value: unknown): boolean { return value === true || value === '' || value === 'true' || value === 1 || value === '1' }
/** 只读取对象自身的数据属性，避免执行 dataset 或 range 上的属性访问器。 */
function ownValue(value: Readonly<Record<string, unknown>>, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field !== undefined && 'value' in field ? field.value : undefined
}
/** 兼容 dataset 的驼峰与连字符键，区分缺失与存在但不可安全读取的字段。 */
function dataField(dataset: Readonly<Record<string, unknown>> | null, name: string): PropertyDescriptor | undefined {
  if (dataset === null) return undefined
  const camel = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
  return Object.getOwnPropertyDescriptor(dataset, camel) ?? Object.getOwnPropertyDescriptor(dataset, name)
}
/** 只读取 dataset 自有数据属性，不执行宿主属性访问器。 */
function data(dataset: Readonly<Record<string, unknown>> | null, name: string): unknown { return dataField(dataset, name)?.value }
/** 优先使用触发时的 dataset；只有字段确实缺失时才采用受限静态补充。 */
function metadata(dataset: Readonly<Record<string, unknown>> | null, name: string, fallback: unknown): unknown {
  const field = dataField(dataset, name)
  return field === undefined ? fallback : field.value
}
/** 判断 dataset 上的隐私或采集标记是否明确启用。 */
function marked(dataset: Readonly<Record<string, unknown>> | null, name: string): boolean { return enabledMarker(data(dataset, name)) }
/** 解析规范十进制整数下标，拒绝负数、小数、前导零和协议上限外的值。 */
function index(value: unknown, minimum: number): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (!/^(0|[1-9]\d*)$/.test(String(value))) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= minimum && result < 2147483647 ? result : null
}
/** 同时检查目标与宿主 attr 的类型，兼容 type 为组件名的事件包装。 */
function inputType(target: Readonly<Record<string, unknown>> | null, types: readonly string[]): boolean {
  return [target?.type, record(target?.attr)?.type].some(kind => typeof kind === 'string' && types.includes(kind.toLowerCase()))
}
/** 识别宿主暴露的密码类型或布尔属性，不读取输入值。 */
function passwordTarget(target: Readonly<Record<string, unknown>> | null): boolean {
  return inputType(target, ['password', 'safe-password']) || enabledMarker(target?.password) || enabledMarker(record(target?.attr)?.password)
}

// 只接受有界、无属性访问器的 JSON range；不序列化整个组件、响应式对象或宿主事件。
/** 复制有数量上限且没有空洞或属性访问器的数组元素，拒绝不可安全读取的范围。 */
function arrayValues(value: unknown, maximum: number): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (field === undefined || !('value' in field)) return null
    result.push(field.value)
  }
  return result
}
/** 验证 picker 范围为有界的纯数据，避免把响应式对象或宿主组件传入报文链路。 */
function validRange(value: unknown, columns: boolean): boolean {
  let count = 0
  /** 逐项累计范围预算，只允许基础值或有限属性的纯记录。 */
  const item = (entry: unknown): boolean => {
    count += 1
    if (count > MAX_RANGE_ITEMS) return false
    if (scalar(entry) || entry === null) return true
    const object = record(entry)
    if (object === null || ![Object.prototype, null].includes(Object.getPrototypeOf(object))) return false
    const descriptors = Object.values(Object.getOwnPropertyDescriptors(object))
    return descriptors.length <= 32 && descriptors.every((field) => 'value' in field && (field.value === null || scalar(field.value)))
  }
  /** 校验一个选项数组及其全部元素，共享总范围预算。 */
  const list = (entries: unknown): boolean => {
    const values = arrayValues(entries, MAX_RANGE_ITEMS)
    return values !== null && values.every(item)
  }
  if (!columns) return list(value)
  const values = arrayValues(value, MAX_PICKER_COLUMNS)
  return values !== null && values.every(list)
}
/** 按下标和可选键安全读取选项文案，不触发对象属性访问器。 */
function pickerLabel(range: unknown, at: number, key: unknown): string | null {
  if (!Array.isArray(range)) return null
  const value = Object.getOwnPropertyDescriptor(range, String(at))
  if (value === undefined || !('value' in value)) return null
  const object = record(value.value)
  return text(typeof key === 'string' && object !== null ? ownValue(object, key) : value.value)
}
/** 校验并以约定分隔符拼接多选值，再应用文案长度限制。 */
function scalarArray(value: unknown): string | null {
  const values = arrayValues(value, MAX_RANGE_ITEMS)
  return values !== null && values.every(scalar) ? displayText(values.map(String)) : null
}
/** 优先将合法 picker 下标映射为文案，缺少可靠范围时保留下标。 */
function pickerValue(value: unknown, range: unknown, key: unknown): string | null {
  const at = index(value, 0)
  return at === null ? null : pickerLabel(range, at, key) ?? String(at)
}
/** 仅在列数与全部选项可确认时拼接文案，否则统一使用规范下标。 */
function pickerViewValue(value: unknown, range: unknown, key: unknown): string | null {
  const values = arrayValues(value, MAX_PICKER_COLUMNS)
  if (values === null) return null
  const indices = values.map((entry) => index(entry, 0))
  if (indices.some((entry) => entry === null)) return null
  const columns = arrayValues(range, MAX_PICKER_COLUMNS)
  const labels = indices.map((at, column) => pickerLabel(columns?.[column], at as number, key))
  return text(columns !== null && columns.length === indices.length && labels.every((label) => label !== null)
    ? labels.join('||') : indices.join('||'))
}
/** 按受支持的宿主字段顺序读取已获授权的输入完成值，保留零与 false。 */
function inputValue(detail: Readonly<Record<string, unknown>> | null, target: Readonly<Record<string, unknown>> | null): string | null {
  return text(detail?.value ?? target?.value ?? record(target?.attr)?.value)
}
/** 按组件种类解释已获授权的完成值，拒绝不匹配的宿主数据形态。 */
function changeValue(element: unknown, detail: Readonly<Record<string, unknown>> | null, target: Readonly<Record<string, unknown>> | null, range: unknown, key: unknown): string | null {
  switch (element) {
    case 'input': case 'textarea': return inputValue(detail, target)
    case 'switch': return typeof detail?.value === 'boolean' ? String(detail.value) : null
    case 'slider': return typeof detail?.value === 'number' && Number.isFinite(detail.value) ? text(detail.value) : null
    case 'radio-group': return text(detail?.value)
    case 'checkbox-group': return scalarArray(detail?.value)
    case 'picker': return pickerValue(detail?.value, range, key)
    case 'picker-view': return pickerViewValue(detail?.value, range, key)
    case 'swiper': { const at = index(detail?.current, 0); return at === null ? null : String(at) }
    default: return null
  }
}

/** 所有隐私策略都在这里完成；下游只接收协议可用的纯 JSON 字段。 */
export function normalizeAutoTrackCall(value: unknown, nativeEvent?: unknown): NormalizedAutoTrackCall | null {
  try {
    const probe = record(value)
    if (probe === null || probe.schemaVersion !== AUTO_TRACK_SCHEMA_VERSION) return null
    if (probe.source === 'tabbar') {
      if (Object.keys(probe).some((key) => !tabFields.has(key)) || probe.kind !== 'click' || probe.xpath !== '#onTabItemTap') return null
      const at = index(probe.index, 1)
      if (at === null || typeof probe.index !== 'number' || !optionalScalar(probe.textValue) || !optionalScalar(probe.hyperlink)) return null
      return { kind: 'click', xpath: '#onTabItemTap', index: at, textValue: text(probe.textValue), hyperlink: scalarText(probe.hyperlink) }
    }
    if (probe.source !== 'template' || Object.keys(probe).some((key) => !templateFields.has(key))
      || (probe.kind !== 'click' && probe.kind !== 'change') || typeof probe.eventName !== 'string' || probe.eventName.trim() === '') return null
    if (probe.elementType !== undefined && !(TEMPLATE_ELEMENTS as readonly unknown[]).includes(probe.elementType)) return null
    if (probe.kind === 'change' && !(CHANGE_ELEMENTS as readonly unknown[]).includes(probe.elementType)) return null
    const event = record(nativeEvent)
    const current = record(event?.currentTarget)
    const target = record(event?.target)
    const primary = current ?? target
    const currentData = record(current?.dataset)
    const targetData = record(target?.dataset)
    const dataset = current === null ? targetData : currentData
    // 必须先短路，连 detail.value、range、textValue 的属性访问器都不能触碰。
    if (enabledMarker(probe.ignored) || enabledMarker(probe.sensitive)
      || marked(currentData, 'growing-ignore') || marked(targetData, 'growing-ignore')
      || marked(currentData, 'growing-sensitive') || marked(targetData, 'growing-sensitive')
      || inputType(current, ['file']) || inputType(target, ['file'])) return null
    const redacted = enabledMarker(probe.redactValue) || passwordTarget(current) || passwordTarget(target)
    if (redacted && (probe.kind !== 'change' || !['input', 'textarea'].includes(String(probe.elementType)))) return null
    const detail = probe.elementType === 'swiper' ? record(event?.detail) : null
    if (probe.elementType === 'swiper' && detail?.source === 'autoplay' && !marked(targetData, 'growing-track')) return null
    for (const key of ['textValue', 'index', 'hyperlink', 'ignored', 'trackValue', 'sensitive', 'redactValue']) {
      if (redacted && key === 'textValue') continue
      if (!optionalScalar(probe[key])) return null
    }
    if (probe.pickerRangeKey !== undefined && (typeof probe.pickerRangeKey !== 'string' || probe.pickerRangeKey.trim() === '')) return null
    if ((probe.pickerRange !== undefined || probe.pickerRangeKey !== undefined) && !['picker', 'picker-view'].includes(String(probe.elementType))) return null
    if (probe.pickerRange !== undefined && !validRange(probe.pickerRange, probe.elementType === 'picker-view')) return null
    const rawId = primary?.id
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : ''
    const xpath = `${id}#${probe.eventName}`
    const title = redacted ? null : metadata(dataset, 'title', probe.textValue)
    if (!optionalScalar(title)) return null
    if (probe.kind === 'click') {
      const rawIndex = metadata(dataset, 'index', probe.index)
      const link = metadata(dataset, 'src', probe.hyperlink)
      if (!optionalScalar(rawIndex) || !optionalScalar(link)) return null
      return { kind: 'click', xpath, textValue: text(title), index: index(rawIndex, 1), hyperlink: scalarText(link) }
    }
    const tracked = !redacted && enabledMarker(metadata(dataset, 'growing-track', probe.trackValue))
    const result = tracked ? changeValue(probe.elementType, detail ?? record(event?.detail), target, probe.pickerRange, probe.pickerRangeKey) : null
    return { kind: 'change', xpath, textValue: result ?? (probe.elementType === 'swiper' ? text(title) : null) }
  } catch {
    return null
  }
}

export interface AutoTrackTarget {
  /** 接收编译探针与原始事件；运行时负责门控、隐私和协议裁剪。 */
  autoTrack(call: AutoTrackCall, nativeEvent?: unknown): boolean
}
let target: AutoTrackTarget | null = null

/** 每个跟踪实例各自持有去重状态；原始事件和目标仅作为 WeakMap 弱键，不进入队列或日志。 */
export class AutoTrackDispatcher {
  private seen = new WeakMap<object, Set<string>>()
  private targets = new WeakMap<object, number>()
  private nextTargetId = 1
  private previous: Readonly<{ key: string; timeStamp: number }> | null = null
  private pageKey: string | null = null

  /** 清空事件弱键、无 id 目标身份及时间窗，建立新的页面去重边界。 */
  public reset(): void {
    this.seen = new WeakMap()
    this.targets = new WeakMap()
    this.nextTargetId = 1
    this.previous = null
    this.pageKey = null
  }

  /** 隐私归一化后进行对象与窄时间窗去重，只有下游接纳成功才登记已见状态。 */
  public dispatch(call: AutoTrackCall, nativeEvent: unknown, pageKey: string | null, emit: (call: NormalizedAutoTrackCall) => boolean): boolean {
    try {
      if (this.pageKey !== pageKey) { this.reset(); this.pageKey = pageKey }
      if (pageKey === null) return false
      const normalized = normalizeAutoTrackCall(call, nativeEvent)
      if (normalized === null) return false
      const event = record(nativeEvent)
      // 绑定 id 为空时，相同出站 xpath 不能证明是同一元素。
      // 内部只保存弱引用目标身份，不将其作为协议字段上报。
      const primary = record(event?.currentTarget) ?? record(event?.target)
      const rawId = primary?.id
      const hasId = (typeof rawId === 'string' || typeof rawId === 'number') && String(rawId) !== ''
      const identityTarget = primary ?? event
      let targetId: number | null = null
      if (!hasId && identityTarget !== null) {
        targetId = this.targets.get(identityTarget) ?? this.nextTargetId++
        this.targets.set(identityTarget, targetId)
      }
      const key = JSON.stringify([normalized.kind, normalized.xpath, normalized.textValue,
        normalized.kind === 'click' ? normalized.index : null, normalized.kind === 'click' ? normalized.hyperlink : null, targetId])
      if (event !== null && this.seen.get(event)?.has(key)) return false
      const timeStamp = event?.timeStamp
      const timedKey = JSON.stringify([pageKey, typeof event?.type === 'string' ? event.type : '', key])
      const timed = typeof timeStamp === 'number' && Number.isFinite(timeStamp) && timeStamp > 0
      if (timed && this.previous?.key === timedKey && Math.abs(timeStamp - this.previous.timeStamp) < 10) return false
      if (!emit(normalized)) return false
      if (event !== null) {
        const keys = this.seen.get(event) ?? new Set<string>()
        keys.add(key)
        this.seen.set(event, keys)
      }
      if (timed) this.previous = { key: timedKey, timeStamp }
      return true
    } catch {
      return false
    }
  }
}

/** 安装当前单例运行时作为编译探针的接收端。 */
export function installAutoTrackDispatcher(next: AutoTrackTarget): void { target = next }
/** 将编译探针交给已安装运行时，缺失接收端或发生异常时返回 false。 */
export function dispatchAutoTrack(call: AutoTrackCall, nativeEvent?: unknown): boolean {
  try { return target?.autoTrack(call, nativeEvent) ?? false } catch { return false }
}
