import type { AppPlatform } from '../../types/index.js'

export const NATIVE_IDENTIFIER_FIELDS = ['idfa', 'idfv', 'oaid', 'googleAdvertisingId', 'androidId', 'imei'] as const
export type NativeIdentifierField = typeof NATIVE_IDENTIFIER_FIELDS[number]
export type NativeIdentifiers = Readonly<Partial<Record<NativeIdentifierField, string>>>
export type NativeIdentifierOptions = Readonly<{ fields: readonly NativeIdentifierField[] }>

export interface NativeIdentifiersPort {
  /** 只读取已有授权可取得的标识，不申请权限；失败返回空对象。 */
  read(fields: readonly NativeIdentifierField[]): Promise<unknown>
}

export function validNativeIdentifierOptions(value: unknown): value is NativeIdentifierOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return Object.keys(input).length === 1 && Array.isArray(input.fields) && input.fields.length > 0
    && input.fields.length <= NATIVE_IDENTIFIER_FIELDS.length && new Set(input.fields).size === input.fields.length
    && input.fields.every(field => NATIVE_IDENTIFIER_FIELDS.includes(field))
}

/** 非空有界标识；全零、控制字符、占位字符串和无效 Unicode 均省略。 */
export function validNativeIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256
    || /[\u0000-\u0020\u007f]/.test(value) || /^(unknown|null|undefined|0+|[0-]+)$/i.test(value)) return false
  for (const part of value) if (part.length === 1 && /[\ud800-\udfff]/.test(part)) return false
  return true
}

/** 代次隔离停采前的晚到结果；新增标识仅作用于后续事件。 */
export class NativeIdentifierState {
  private generation = 0
  private value: NativeIdentifiers = {}

  public constructor(private readonly port: NativeIdentifiersPort | undefined, private readonly fields: readonly NativeIdentifierField[], private readonly platform: AppPlatform) {}

  public current(): NativeIdentifiers { return this.value }

  public clear(): void { this.generation++; this.value = {} }

  public refresh(): void {
    const generation = ++this.generation
    const fields = this.fields.filter(field => this.platform === 'iOS' ? field === 'idfa' || field === 'idfv'
      : this.platform === 'Android' ? field !== 'idfa' && field !== 'idfv' : false)
    if (this.port === undefined || fields.length === 0) return
    let reading: Promise<unknown>
    try { reading = this.port.read(fields) } catch { return }
    void reading.then(raw => {
      if (generation !== this.generation || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
      const input = raw as Record<string, unknown>
      this.value = Object.fromEntries(fields.flatMap(field => validNativeIdentifier(input[field]) ? [[field, input[field]]] : []))
    }).catch(() => undefined)
  }
}
