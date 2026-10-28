import type { TransportRequest, TransportResult, TransportHandle, TransportPort } from '../types/index.js'
import type { ProtocolEvent } from './dataStore/protocol.js'
import { type QueueEntry, EventQueue } from './queue.js'

export const COLLECT_REQUEST_TIMEOUT_MS = 5_000

export type CollectorRequestResult =
  | Readonly<{ ok: true; request: TransportRequest }>
  | Readonly<{ ok: false; code: 'invalid_send_time' | 'events_not_serializable' }>

/** 构建允许交给平台传输端口的统一采集请求。 */
export function buildCollectorRequest(
  serverUrl: string,
  accountId: string,
  events: readonly ProtocolEvent[],
  sendAt: number,
): CollectorRequestResult {
  if (!Number.isFinite(sendAt) || sendAt < 0) return { ok: false, code: 'invalid_send_time' }
  let body: string
  try {
    body = JSON.stringify(events)
  } catch {
    return { ok: false, code: 'events_not_serializable' }
  }
  return {
    ok: true,
    request: {
      url: `${serverUrl}/v3/projects/${encodeURIComponent(accountId)}/collect?stm=${sendAt}&compress=0`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      timeoutMs: COLLECT_REQUEST_TIMEOUT_MS,
    },
  }
}

/** 采集服务仅以 HTTP 200 或 204 表示接收成功，其他状态均按失败处理。 */
export function normalizeCollectorResult(result: TransportResult): TransportResult {
  if (result.kind === 'success' && result.status !== 200 && result.status !== 204) {
    return { kind: 'http', status: result.status }
  }
  return result
}

/** 只对网络失败、超时和服务端错误使用有限重试。 */
export function isRetryableCollectorFailure(result: TransportResult): boolean {
  return result.kind === 'network' || result.kind === 'timeout' || (result.kind === 'http' && result.status >= 500)
}

export interface TimerPort {
  /** 安排 SDK 自有的超时或延迟重试，返回可取消的句柄。 */
  setTimeout(callback: () => void, delayMs: number): unknown
  /** 取消对应的 SDK 定时器。 */
  clearTimeout(handle: unknown): void
}

export type FinalizedTransport = Readonly<{
  /** 以取消结果唯一结算当前传输并尽力中止底层任务。 */
  cancel: () => void
}>

/** 每次派发只有一个结算出口，超时、取消或同步异常后的宿主回调不能再次修改队列。 */
export function dispatchWithFinalizer(
  transport: TransportPort,
  timer: TimerPort,
  request: TransportRequest,
  done: (result: TransportResult) => void,
): FinalizedTransport {
  let settled = false
  let handle: TransportHandle | void
  let timeoutHandle: unknown

  /** 先锁定唯一结算结果再清理定时器或中止请求，避免宿主同步回调二次结算。 */
  const settle = (result: TransportResult, abort = false): void => {
    if (settled) return
    settled = true
    timer.clearTimeout(timeoutHandle)
    if (abort) {
      try {
        handle?.abort?.()
      } catch {
        // 调用宿主前已锁定权威结果，中止失败不能改变该结果。
      }
    }
    done(result)
  }

  timeoutHandle = timer.setTimeout(() => {
    settle({ kind: 'timeout' }, true)
  }, request.timeoutMs)

  try {
    handle = transport.dispatch(request, settle)
  } catch (error) {
    settle({ kind: 'network', message: error instanceof Error ? error.message : undefined })
  }

  return {
    /** 以取消结果结束请求，并尽力中止底层传输。 */
    cancel: () => { settle({ kind: 'aborted' }, true) },
  }
}

export const MAX_CONCURRENT_UPLOADS = 3
const RETRY_DELAYS_MS = [800, 1_600] as const

export interface UploaderRuntime extends TimerPort {
  /** 读取发送时的毫秒时间戳。 */
  now(): number
  /** 提供退避抖动的随机样本，由上传器限制取值范围。 */
  random(): number
}

export type UploaderDrop = Readonly<{
  requestIds: readonly string[]
  reason: 'non_retryable' | 'retry_exhausted' | 'request_build_failed'
  result?: TransportResult
}>

/** 协调队列批次占用、有限并发槽位和分阶段退避重试。 */
export class Uploader {
  private aggregateTimer: unknown
  private aggregationPending = false
  private active = 0
  private pendingRetries = 0
  private readonly readyRetries: Array<{ batch: readonly QueueEntry[]; attempt: number }> = []
  private flushing = false
  /** 已接纳且正在等待空闲传输槽位的事件标识。 */
  private readonly readyRequests = new Set<string>()
  private readonly reservedRequests = new Set<string>()
  private readonly drainWaiters = new Set<() => void>()

  /** 注入队列、传输、时间与连接状态，回调仅用于持久化、诊断和发送前观察。 */
  public constructor(
    private readonly queue: EventQueue,
    private readonly transport: TransportPort,
    private readonly runtime: UploaderRuntime,
    private readonly serverUrl: string,
    private readonly accountId: string,
    private readonly onDrop: (drop: UploaderDrop) => void = () => undefined,
    private readonly onQueueChanged: () => void = () => undefined,
    /** 仅在请求实际派发前接收已清理的协议事件。 */
    private readonly onBeforeDispatch?: (events: readonly ProtocolEvent[]) => void,
    private readonly canDispatch: () => boolean = () => true,
    private readonly uploadIntervalMs = 0,
  ) {}

  /** App 事件入队后立即具备发送资格，仅传输槽位与重试可能使派发延后。 */
  public schedule(): void {
    if (this.uploadIntervalMs === 0) { this.flush(); return }
    if (this.aggregationPending || this.queue.size() === 0) return
    this.aggregationPending = true
    this.aggregateTimer = this.runtime.setTimeout(() => {
      this.aggregationPending = false
      this.flush()
    }, this.uploadIntervalMs)
  }

  /** 将未被预留的队列事件标记为可发送，并尝试占用空闲上传槽位。 */
  public flush(): void {
    if (this.aggregationPending) {
      this.runtime.clearTimeout(this.aggregateTimer)
      this.aggregationPending = false
    }
    for (const requestId of this.queue.requestIds()) {
      if (!this.reservedRequests.has(requestId)) this.readyRequests.add(requestId)
    }
    this.drain()
  }

  /** 在连接允许和并发上限内优先处理重试，再领取新批次；防止同步回调导致调度重入。 */
  private drain(): void {
    if (this.flushing) return
    this.flushing = true
    this.pruneExpired()
    while (this.active < MAX_CONCURRENT_UPLOADS && this.canDispatch()) {
      const retry = this.readyRetries.shift()
      if (retry !== undefined) {
        this.dispatch(retry.batch, retry.attempt)
        continue
      }
      const claimed = this.queue.claimNextBatch()
      const batch = claimed.filter(entry => this.readyRequests.has(entry.requestId))
      this.queue.release(claimed.filter(entry => !this.readyRequests.has(entry.requestId)).map(entry => entry.requestId))
      if (batch.length === 0) break
      for (const entry of batch) {
        this.readyRequests.delete(entry.requestId)
        this.reservedRequests.add(entry.requestId)
      }
      const attempt = batch[0]!.retryCount
      if (attempt > RETRY_DELAYS_MS.length) {
        const requestIds = batch.map((entry) => entry.requestId)
        this.queue.remove(requestIds)
        this.releaseReserved(requestIds)
        this.onQueueChanged()
        this.onDrop({ requestIds, reason: 'retry_exhausted' })
        continue
      }
      this.dispatch(batch, attempt)
    }
    this.flushing = false
    this.notifyDrain()
  }

  /** 读取当前在途请求数，供诊断和测试核对并发。 */
  public activeCount(): number {
    return this.active
  }

  /** onHide 期间只允许短时等待，未完成事件仍保留在持久队列。 */
  public forceFlush(maxWaitMs = 1_000): Promise<boolean> {
    this.flush()
    if (this.isDrained()) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const timeout = this.runtime.setTimeout(() => {
        if (settled) return
        settled = true
        this.drainWaiters.delete(onDrain)
        resolve(false)
      }, maxWaitMs)
      /** 队列与所有在途、延迟重试均清空后，结束短时强制刷新等待。 */
      const onDrain = (): void => {
        if (settled || !this.isDrained()) return
        settled = true
        this.runtime.clearTimeout(timeout)
        this.drainWaiters.delete(onDrain)
        resolve(true)
      }
      this.drainWaiters.add(onDrain)
      onDrain()
    })
  }

  /** 构建并派发一个批次，按权威结果删除、延迟重试或保留离线事件，并释放对应资源。 */
  private dispatch(claimed: readonly QueueEntry[], attempt: number): void {
    this.pruneExpired()
    const batch = claimed.filter(entry => this.queue.has(entry.requestId))
    if (batch.length === 0) return
    const requestResult = buildCollectorRequest(this.serverUrl, this.accountId, batch.map((entry) => entry.event), this.runtime.now())
    const requestIds = batch.map((entry) => entry.requestId)
    if (!requestResult.ok) {
      this.queue.remove(requestIds)
      this.releaseReserved(requestIds)
      this.onQueueChanged()
      this.onDrop({ requestIds, reason: 'request_build_failed' })
      this.notifyDrain()
      return
    }

    try {
      this.onBeforeDispatch?.(JSON.parse(requestResult.request.body) as ProtocolEvent[])
    } catch {
      // 调试观察器异常不能改变采集请求的派发语义。
    }
    this.active += 1
    dispatchWithFinalizer(this.transport, this.runtime, requestResult.request, (rawResult) => {
      const result = normalizeCollectorResult(rawResult)
      this.active -= 1
      if (result.kind === 'success') {
        this.queue.remove(requestIds)
        this.releaseReserved(requestIds)
        this.queue.release(requestIds)
        this.onQueueChanged()
      } else if ((result.kind === 'network' || result.kind === 'timeout') && !this.canDispatch()) {
        // 飞行中遇到明确断网也保留事件；恢复网络后继续，不额外消耗重试额度。
        this.readyRetries.push({ batch, attempt })
      } else if (isRetryableCollectorFailure(result) && attempt < RETRY_DELAYS_MS.length) {
        this.queue.incrementRetries(requestIds)
        this.onQueueChanged()
        this.pendingRetries += 1
        this.runtime.setTimeout(() => {
          this.pendingRetries -= 1
          this.readyRetries.push({ batch, attempt: attempt + 1 })
          this.drain()
        }, this.retryDelay(attempt))
      } else {
        this.queue.remove(requestIds)
        this.releaseReserved(requestIds)
        this.queue.release(requestIds)
        this.onQueueChanged()
        this.onDrop({
          requestIds,
          reason: isRetryableCollectorFailure(result) ? 'retry_exhausted' : 'non_retryable',
          result,
        })
      }
      this.drain()
      this.notifyDrain()
    })
  }

  /** 离线时也清理过期缓存，并清除入队清理留下的调度标识。 */
  private pruneExpired(): void {
    const expired = this.queue.pruneExpired()
    for (const requestId of this.readyRequests) {
      if (!this.queue.has(requestId)) this.readyRequests.delete(requestId)
    }
    for (const requestId of this.reservedRequests) {
      if (!this.queue.has(requestId)) this.reservedRequests.delete(requestId)
    }
    for (let index = this.readyRetries.length - 1; index >= 0; index--) {
      const retry = this.readyRetries[index]!
      const batch = retry.batch.filter(entry => this.queue.has(entry.requestId))
      if (batch.length === 0) this.readyRetries.splice(index, 1)
      else if (batch.length !== retry.batch.length) this.readyRetries[index] = { ...retry, batch }
    }
    if (expired.length > 0) this.onQueueChanged()
  }

  /** 在分阶段退避时间上加入受限随机抖动，避免客户端同时重试。 */
  private retryDelay(attempt: number): number {
    const random = Math.min(1, Math.max(0, this.runtime.random()))
    return Math.round(RETRY_DELAYS_MS[attempt]! * (0.8 + random * 0.4))
  }

  /** 清除已完成批次的预留标识，避免后续请求被永久阻塞。 */
  private releaseReserved(requestIds: readonly string[]): void {
    for (const requestId of requestIds) this.reservedRequests.delete(requestId)
  }

  /** 同时检查队列、在途请求和延迟重试，判断是否已完全排空。 */
  private isDrained(): boolean {
    return this.active === 0 && this.pendingRetries === 0 && this.readyRetries.length === 0 && this.queue.size() === 0
  }

  /** 状态变化后通知刷新等待者，由各等待者判断是否完成。 */
  private notifyDrain(): void {
    for (const waiter of this.drainWaiters) waiter()
  }
}
