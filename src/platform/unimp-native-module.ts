import { HybridPortFailure, type UniMPHostPort, type UniMPRequest } from '../plugins/gioHybridAdapter/contract.js'
import type { NativePluginHost } from './native-identifiers.js'

export { HybridPortFailure } from '../plugins/gioHybridAdapter/contract.js'

/** 只有本适配器接触 uni module；不读存储、不创建原生 SDK、不回退网络请求。 */
export class UniMPNativeModulePort implements UniMPHostPort {
  private disposed = false
  private module: { invoke: (request: UniMPRequest, done: (reply: unknown) => void) => void } | null = null
  public constructor(private readonly host: NativePluginHost) {}

  public request(request: UniMPRequest, done: (reply: unknown) => void): void {
    if (this.disposed) return
    if (this.module === null) {
      let module: unknown
      try { module = this.host.requireNativePlugin?.('GrowingIOUniMPBridge') }
      catch { throw new HybridPortFailure('module_missing') }
      if (module == null) throw new HybridPortFailure('module_missing')
      try { if (typeof (module as { invoke?: unknown }).invoke !== 'function') throw new HybridPortFailure('invalid_module') }
      catch { throw new HybridPortFailure('invalid_module') }
      this.module = module as NonNullable<typeof this.module>
    }
    try {
      this.module.invoke(request, reply => { void Promise.resolve().then(() => { if (!this.disposed) done(reply) }) })
    } catch { throw new HybridPortFailure('invoke_error') }
  }

  public dispose(): void { this.disposed = true; this.module = null }
}
