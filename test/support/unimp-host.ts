import { vi } from 'vitest'
import { UniMPRuntime, type UniMPDependencies } from '../../src/plugins/gioHybridAdapter/runtime.js'
import { HYBRID_EVENTS, type HybridOptions, type HostGate, type UniMPHostPort, type UniMPRequest, type UniMPConfig } from '../../src/plugins/gioHybridAdapter/contract.js'
import { testAutoTrackProfile } from './autotrack-fixture.js'

export const unimpConfig = { runtime: 'unimp' as const, appId: '__UNI__test', accountId: 'account', dataSourceId: 'source', idMapping: true }
export const unimpResolved: UniMPConfig = { appId: unimpConfig.appId, accountId: 'account', dataSourceId: 'source', idMapping: true, dataCollect: true, debug: false }
export const hybridFlush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve() }

type PendingCall = { request: UniMPRequest; done: (reply: unknown) => void; result?: unknown }

/** 可分别执行原生副作用和交付应答的串行宿主模型，故障测试可丢应答、迟执行或改写回调。 */
export class NativeExecutor implements UniMPHostPort {
  public readonly calls: PendingCall[] = []
  public readonly events: Record<string, unknown>[] = []
  public gate: HostGate = { dataCollect: true, containerVisible: true }
  public identityWrite = true
  public userId: string | null = null
  public userKey: string | null = null
  public generation = 0
  public connectionId = ''
  public disposed = false
  private highestRequest = 0
  private page: { id?: string; path: unknown; query: unknown } | null = null
  public request(request: UniMPRequest, done: (reply: unknown) => void): void { this.calls.push({ request: structuredClone(request), done }) }
  public dispose(): void { this.disposed = true }
  public execute(index = this.calls.length - 1): unknown {
    const call = this.calls[index]!
    if (call.result !== undefined) return call.result
    const request = call.request
    const { version, requestId, instanceId, generation } = request
    const header = { version, requestId, instanceId, generation }
    const rejection = (code: string) => ({ ...header, status: 'rejected', code, ...(request.method === 'hello' ? {} : { connectionId: request.connectionId }), host: { ...this.gate } })
    if (request.method === 'hello') {
      if (generation <= this.generation) return call.result = rejection('stale_connection')
      this.generation = generation; this.connectionId = `connection-${generation}`; this.page = null; this.highestRequest = requestId
      const { sdkVersion: _, ...identity } = request.payload
      return call.result = { ...header, status: 'ok', connectionId: this.connectionId, payload: { ...identity,
        hostType: 'native', platform: 'Android', nativeSdkVersion: '4.4.0', host: { ...this.gate }, events: [...HYBRID_EVENTS], identityWrite: this.identityWrite } }
    }
    if (generation !== this.generation || request.connectionId !== this.connectionId) return call.result = rejection('stale_connection')
    if (requestId <= this.highestRequest) return call.result = rejection('duplicate_request')
    this.highestRequest = requestId
    if (!this.gate.dataCollect) return call.result = rejection('collection_disabled')
    if ((request.method !== 'dispatchEvent' || request.payload.event.eventType === 'LOGIN_USER_ATTRIBUTES') && !this.identityWrite) return call.result = rejection('identity_not_allowed')
    if (request.method === 'setUserId') { this.userId = request.payload.userId; this.userKey = request.payload.userKey ?? null }
    else if (request.method === 'clearUserId') { this.userId = null; this.userKey = null }
    else {
      const { event, pageViewId } = request.payload
      if (event.eventType === 'PAGE') this.page = { id: pageViewId, path: event.path, query: event.query }
      else if (pageViewId !== undefined && (this.page?.id !== pageViewId || this.page.path !== event.path || this.page.query !== event.query)) return call.result = rejection('page_unavailable')
      this.events.push({ ...event, deviceId: 'native-device', userId: this.userId, userKey: this.userKey, sessionId: 'native-session', domain: request.instanceId === '' ? '' : unimpConfig.appId, platform: 'Android' })
    }
    return call.result = { ...header, connectionId: this.connectionId, status: request.method === 'dispatchEvent' ? 'accepted' : 'ok', host: { ...this.gate } }
  }
  public reply(index = this.calls.length - 1): void {
    const result = this.execute(index)
    // 真实 module 只返回 JSON；模型也移除 undefined，避免测试偷偷接受它。
    this.calls[index]!.done(JSON.parse(JSON.stringify(result)))
  }
  public deliver(index: number, reply: unknown): void { this.calls[index]!.done(reply) }
  public rejected(index: number, code: string, host?: HostGate): unknown {
    const request = this.calls[index]!.request
    return { version: 1, requestId: request.requestId, instanceId: request.instanceId, generation: request.generation,
      ...(request.method === 'hello' ? {} : { connectionId: request.connectionId }), status: 'rejected', code, ...(host === undefined ? {} : { host }) }
  }
}

export function hybridFixture(options: HybridOptions = {}, dependencies: Partial<UniMPDependencies> = {}) {
  const native = new NativeExecutor()
  let wall = 100
  const ready = vi.fn(options.onReady)
  const error = vi.fn(options.onError)
  const warn = vi.fn()
  const runtime = new UniMPRuntime({ port: native, clock: { now: () => wall }, instanceIdFactory: () => 'guest-runtime',
    scheduler: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    autoTrackProfile: testAutoTrackProfile, warn, ...dependencies })
  runtime.registerPlugins({ name: 'gioHybridAdapter', options: { ...options, onReady: ready, onError: error } }, { name: 'gioEventAutoTracking' })
  runtime.init(unimpConfig)
  const page = (id = 'home', route = 'pages/home', query = 'a=%E4%B8%AD') => {
    runtime.onPageLoad({ instanceId: id, route, query, referralPage: null }); runtime.onPageShow(id, 'Home')
  }
  const connect = async (withPage = true) => {
    runtime.onAppShow({ path: 'pages/home', query: '' }); if (withPage) page()
    native.reply(); await hybridFlush()
  }
  const accept = async () => { native.reply(); await hybridFlush() }
  return { runtime, native, ready, error, warn, page, connect, accept, setWall: (value: number) => { wall = value } }
}
