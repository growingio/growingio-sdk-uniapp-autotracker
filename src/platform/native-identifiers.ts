import type { NativeIdentifierField, NativeIdentifiersPort } from '../plugins/gioNativeIdentifiers/index.js'

export type NativePluginHost = Readonly<{ requireNativePlugin?: (name: string) => unknown }>

/** 可选原生增强 module 的 JS 端口；延迟加载，不阻塞 SDK 初始化。 */
export class AppNativeIdentifiersPort implements NativeIdentifiersPort {
  public constructor(private readonly host: NativePluginHost) {}

  public read(fields: readonly NativeIdentifierField[]): Promise<unknown> {
    return new Promise(resolve => {
      let settled = false
      const timer = globalThis.setTimeout(() => finish({}), 1000)
      const finish = (value: unknown): void => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        resolve(value)
      }
      try {
        const module = this.host.requireNativePlugin?.('GrowingIOUniAppEnhance') as { getIdentifiers?: (request: unknown, done: (reply: unknown) => void) => void } | null | undefined
        if (typeof module?.getIdentifiers !== 'function') { finish({}); return }
        module.getIdentifiers({ version: 1, fields: [...fields] }, reply => {
          const result = typeof reply === 'object' && reply !== null ? reply as Record<string, unknown> : null
          finish(result?.version === 1 ? result.identifiers : {})
        })
      } catch { finish({}) }
    })
  }
}
