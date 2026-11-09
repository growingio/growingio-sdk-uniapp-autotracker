import { buildAppEvent, type ProtocolEvent } from './dataStore/protocol.js'

// 非持久化内存队列的总量预算；App 积压由有效期和宿主存储容量约束。
export const MAX_QUEUE_ITEMS = 200
export const MAX_QUEUE_PERSISTED_BYTES = 2 * 1024 * 1024
export const MAX_EVENT_BYTES = 512 * 1024
export const MAX_BATCH_EVENTS = 50
export const MAX_BATCH_BYTES = 512 * 1024
export const APP_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** App 持久队列上限：整队序列化一次的成本与宿主单值存储（含鸿蒙 preferences）都需要有界。 */
export const APP_QUEUE_MAX_ITEMS = 10_000
export const APP_QUEUE_MAX_PERSISTED_BYTES = 4 * 1024 * 1024

export type QueueRetention = Readonly<{
  maxAgeMs: number
  now: () => number
}>

export type QueueLimits = Readonly<{
  maxItems: number
  maxPersistedBytes: number
  maxEventBytes: number
  maxBatchEvents: number
  maxBatchBytes: number
  /** reject：满时拒绝新事件（小程序内存队列）；evict-oldest：淘汰最旧事件以接纳新事件（App 持久队列）。 */
  overflow?: 'reject' | 'evict-oldest'
}>

export type QueueEntry = Readonly<{
  requestId: string
  event: ProtocolEvent
  retryCount: number
}>

export type EnqueueResult =
  | Readonly<{ ok: true; requestId: string; evicted?: number }>
  | Readonly<{ ok: false; code: 'event_not_serializable' | 'event_too_large' | 'queue_full' }>

const DEFAULT_LIMITS: QueueLimits = {
  maxItems: MAX_QUEUE_ITEMS,
  maxPersistedBytes: MAX_QUEUE_PERSISTED_BYTES,
  maxEventBytes: MAX_EVENT_BYTES,
  maxBatchEvents: MAX_BATCH_EVENTS,
  maxBatchBytes: MAX_BATCH_BYTES,
}

/** App 积压有总条数和总字节上限；达到上限时淘汰最旧事件，新事件始终可入队。 */
export const APP_QUEUE_LIMITS: QueueLimits = {
  ...DEFAULT_LIMITS,
  maxItems: APP_QUEUE_MAX_ITEMS,
  maxPersistedBytes: APP_QUEUE_MAX_PERSISTED_BYTES,
  overflow: 'evict-oldest',
}

// 为持久化信封预留最长合法修订号，容量判断包含实际落盘字段。
const QUEUE_ENVELOPE_BYTES = '{"version":1,"revision":9007199254740991,"entries":[]}'.length
type EncodedEvent = Readonly<{ json: string; bytes: number; entryBytes: number }>
type QueueSnapshotNode = Readonly<{ entry: QueueEntry; json: string; previous: QueueSnapshotNode | null }>

/** 拼接内部生成的条目包装；事件已经是独立 JSON，不能再次执行业务序列化逻辑。 */
function encodeEntry(entry: QueueEntry, eventJson: string): string {
  return `{"requestId":${JSON.stringify(entry.requestId)},"event":${eventJson},"retryCount":${entry.retryCount}}`
}

/** 计算序列化事件的 UTF-8 占用，供单事件、批次和持久化限额判断。 */
function utf8ByteLength(value: string): number {
  let size = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) size += 1
    else if (unit <= 0x7ff) size += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        size += 4
        index += 1
      } else size += 3
    } else size += 3
  }
  return size
}

/** 安全序列化协议事件，无法生成 JSON 字符串时返回 null。 */
function serializedEvent(event: ProtocolEvent): string | null {
  try {
    const result = JSON.stringify(event)
    return typeof result === 'string' ? result : null
  } catch {
    return null
  }
}

/** 从 JSON 文本创建独立事件副本，拒绝非对象形态。 */
function cloneEvent(serialized: string): ProtocolEvent | null {
  try {
    const value: unknown = JSON.parse(serialized)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as ProtocolEvent
  } catch {
    return null
  }
}

/** 队列状态与宿主无关，快照编码及有序宿主写入由存储模块负责。 */
export class EventQueue {
  private readonly entries: QueueEntry[] = []
  private readonly claimed = new Set<string>()
  private readonly encoded = new Map<string, EncodedEvent>()
  private persistedBytes = QUEUE_ENVELOPE_BYTES
  private serializedSnapshot: string | null = null
  private persistenceTail: QueueSnapshotNode | null = null
  private persistenceDirty = false
  private nextExpiryAt = Infinity
  private removedRevision = 0
  private nextRequestNumber = 1
  private restoreDropped = 0

  /** 注入容量限制与事件协议；仅 App 装配按事件时间清理的保留策略。 */
  public constructor(
    private readonly limits: QueueLimits = DEFAULT_LIMITS,
    private readonly buildEvent = buildAppEvent,
    private readonly retention?: QueueRetention,
  ) {}

  /** 清理到期或缺少产生时间的条目，同时释放条数、字节和上传占用。 */
  public pruneExpired(): readonly string[] {
    const retention = this.retention
    if (retention === undefined) return []
    let now: number
    try { now = retention.now() } catch { return [] }
    if (!Number.isFinite(now) || now < 0 || now < this.nextExpiryAt) return []
    const expired: string[] = []
    let nextExpiryAt = Infinity
    for (const entry of this.entries) {
      if (typeof entry.event.timestamp !== 'number' || now - entry.event.timestamp >= retention.maxAgeMs) expired.push(entry.requestId)
      else nextExpiryAt = Math.min(nextExpiryAt, this.eventExpiry(entry.event))
    }
    this.remove(expired)
    this.nextExpiryAt = nextExpiryAt
    return expired
  }

  /** 仅对可精确计算的到期时间跳过扫描，未知时间和超出安全整数的值继续逐项判断。 */
  private eventExpiry(event: ProtocolEvent): number {
    if (this.retention === undefined) return Infinity
    const expiresAt = typeof event.timestamp === 'number' ? event.timestamp + this.retention.maxAgeMs : NaN
    return Number.isSafeInteger(expiresAt) ? expiresAt : -Infinity
  }

  /** 只有删除或替换队列才推进修订号，上传器无需在每次追加时检查全部旧标识。 */
  public removalRevision(): number {
    return this.removedRevision
  }

  /** 读取事件当前的持久重试计数；事件不在队列时返回 null。 */
  public retryCountOf(requestId: string): number | null {
    if (!this.encoded.has(requestId)) return null
    return this.entries.find(entry => entry.requestId === requestId)?.retryCount ?? null
  }

  /** 检查事件是否仍在队列，避免延迟重试重新发送已过期的批次副本。 */
  public has(requestId: string): boolean {
    return this.encoded.has(requestId)
  }

  /** 依次校验事件和队列容量，成功后以独立 JSON 副本入队并分配请求标识。 */
  public enqueue(event: ProtocolEvent): EnqueueResult {
    const serialized = serializedEvent(event)
    if (serialized === null) return { ok: false, code: 'event_not_serializable' }
    const byteLength = utf8ByteLength(serialized)
    if (byteLength > this.limits.maxEventBytes || byteLength + 2 > this.limits.maxBatchBytes) {
      return { ok: false, code: 'event_too_large' }
    }
    this.pruneExpired()
    const evict = this.limits.overflow === 'evict-oldest'
    if (!evict && this.entries.length >= this.limits.maxItems) return { ok: false, code: 'queue_full' }
    const normalized = cloneEvent(serialized)
    if (normalized === null) return { ok: false, code: 'event_not_serializable' }

    const requestId = this.allocateRequestId()
    const entry = { requestId, event: normalized, retryCount: 0 }
    const entryBytes = utf8ByteLength(encodeEntry(entry, serialized))
    if (QUEUE_ENVELOPE_BYTES + entryBytes > this.limits.maxPersistedBytes || this.limits.maxItems < 1) return { ok: false, code: 'queue_full' }
    let evicted = 0
    if (evict) {
      // 按入队顺序淘汰最旧事件，直到新事件能放入条数和字节预算。
      let count = 0
      let bytes = this.persistedBytes
      let length = this.entries.length
      while (length > 0 && (length >= this.limits.maxItems || bytes + entryBytes + 1 > this.limits.maxPersistedBytes)) {
        bytes -= this.encoded.get(this.entries[count]!.requestId)!.entryBytes + (length > 1 ? 1 : 0)
        length -= 1
        count += 1
      }
      if (count > 0) {
        this.remove(this.entries.slice(0, count).map(item => item.requestId))
        evicted = count
      }
    }
    const nextBytes = this.persistedBytes + entryBytes + (this.entries.length === 0 ? 0 : 1)
    if (nextBytes > this.limits.maxPersistedBytes) {
      return { ok: false, code: 'queue_full' }
    }
    this.entries.push(entry)
    this.encoded.set(requestId, { json: serialized, bytes: byteLength, entryBytes })
    if (!this.persistenceDirty) this.persistenceTail = { entry, json: serialized, previous: this.persistenceTail }
    this.nextExpiryAt = Math.min(this.nextExpiryAt, this.eventExpiry(normalized))
    this.persistedBytes = nextBytes
    this.serializedSnapshot = null
    return evicted > 0 ? { ok: true, requestId, evicted } : { ok: true, requestId }
  }

  /** 选取最早的合法 JSON 数组批次，不从队列删除记录。 */
  public nextBatch(): readonly QueueEntry[] {
    return this.selectBatch(false)
  }

  /** 领取批次并登记占用，避免多个并发上传槽位重复发送同一事件。 */
  public claimNextBatch(): readonly QueueEntry[] {
    const batch = this.selectBatch(true)
    for (const entry of batch) this.claimed.add(entry.requestId)
    return batch
  }

  /** 释放指定请求的上传占用，允许后续调度重新选择。 */
  public release(requestIds: readonly string[]): void {
    for (const requestId of requestIds) this.claimed.delete(requestId)
  }

  /** 在数量与字节限制内选取最早批次；并发上传时跳过已占用记录并隔离重试预算。 */
  private selectBatch(excludeClaimed: boolean): readonly QueueEntry[] {
    const batch: QueueEntry[] = []
    let bytes = 2
    for (const entry of this.entries) {
      if (excludeClaimed && this.claimed.has(entry.requestId)) continue
      // 冷启动后的混合队列按剩余重试次数分批，旧事件不能借用新事件的额度。
      if (excludeClaimed && batch.length > 0 && entry.retryCount !== batch[0]!.retryCount) break
      if (batch.length >= this.limits.maxBatchEvents) break
      const encoded = this.encoded.get(entry.requestId)!
      const nextBytes = bytes + encoded.bytes + (batch.length === 0 ? 0 : 1)
      if (nextBytes > this.limits.maxBatchBytes) break
      bytes = nextBytes
      // 批次和诊断回调均不能修改内部事件，缓存字节数始终对应真实内容。
      batch.push({ ...entry, event: cloneEvent(encoded.json)! })
    }
    return batch
  }

  /** 按请求标识移除事件，同时清理其上传占用。 */
  public remove(requestIds: readonly string[]): void {
    if (requestIds.length === 0) return
    const ids = new Set(requestIds)
    let removed = false
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.entries[index]!.requestId)) {
        const requestId = this.entries[index]!.requestId
        this.persistedBytes -= this.encoded.get(requestId)!.entryBytes + (this.entries.length > 1 ? 1 : 0)
        this.encoded.delete(requestId)
        this.claimed.delete(requestId)
        this.entries.splice(index, 1)
        removed = true
      }
    }
    if (removed) {
      this.invalidateSnapshots()
      this.advanceRemovalRevision()
      if (this.entries.length === 0) this.nextExpiryAt = Infinity
    }
  }

  /** 只增加指定事件的已用重试次数，供持久化与后续批次分组。 */
  public incrementRetries(requestIds: readonly string[]): void {
    const ids = new Set(requestIds)
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!
      if (ids.has(entry.requestId) && entry.retryCount < Number.MAX_SAFE_INTEGER) {
        const next = { ...entry, retryCount: entry.retryCount + 1 }
        const encoded = this.encoded.get(entry.requestId)!
        const extraBytes = String(next.retryCount).length - String(entry.retryCount).length
        // 重试元数据也不能使持久队列越界，无法扩容时保留已用预算。
        if (this.persistedBytes + extraBytes > this.limits.maxPersistedBytes) continue
        this.entries[index] = next
        this.encoded.set(entry.requestId, { ...encoded, entryBytes: encoded.entryBytes + extraBytes })
        this.persistedBytes += extraBytes
        this.invalidateSnapshots()
      }
    }
  }

  /**
   * 严格校验后按条恢复：无效或重复标识的条目单独丢弃，超出容量时保留最新事件。
   * 只有存在输入但没有任何条目可恢复时返回 false，并保留现有队列。
   * strict 用于运行期整体改写（如 identify）：任一条目无法保留即返回 false，现有队列不变。
   */
  public restore(entries: readonly QueueEntry[], strict = false): boolean {
    this.restoreDropped = 0
    if (!Array.isArray(entries)) return false
    const seen = new Set<string>()
    const normalized: QueueEntry[] = []
    for (const raw of entries) {
      if (!this.validEntry(raw) || seen.has(raw.requestId)) continue
      const entry = raw as QueueEntry
      seen.add(entry.requestId)
      normalized.push({ requestId: entry.requestId, event: cloneEvent(JSON.stringify(entry.event))!, retryCount: entry.retryCount })
    }
    if ((entries.length > 0 && normalized.length === 0) || (strict && normalized.length !== entries.length)) { this.restoreDropped = entries.length - normalized.length; return false }
    const encodedList = normalized.map(entry => {
      const json = JSON.stringify(entry.event)
      return { json, bytes: utf8ByteLength(json), entryBytes: utf8ByteLength(encodeEntry(entry, json)) }
    })
    // 容量不足时从最旧条目开始舍弃，与入队时的淘汰顺序一致。
    let first = 0
    let persistedBytes = QUEUE_ENVELOPE_BYTES + encodedList.reduce((sum, entry) => sum + entry.entryBytes, 0) + Math.max(0, normalized.length - 1)
    while (first < normalized.length && (normalized.length - first > this.limits.maxItems || persistedBytes > this.limits.maxPersistedBytes)) {
      persistedBytes -= encodedList[first]!.entryBytes + (normalized.length - first > 1 ? 1 : 0)
      first += 1
    }
    const kept = normalized.slice(first)
    this.restoreDropped = entries.length - kept.length
    if ((entries.length > 0 && kept.length === 0) || (strict && this.restoreDropped > 0)) return false
    this.entries.length = 0
    for (const entry of kept) this.entries.push(entry)
    this.encoded.clear()
    kept.forEach((entry, index) => this.encoded.set(entry.requestId, encodedList[first + index]!))
    this.persistedBytes = persistedBytes
    this.invalidateSnapshots()
    this.advanceRemovalRevision()
    this.nextExpiryAt = kept.length === 0 ? Infinity : -Infinity
    this.claimed.clear()
    const largestRequestNumber = kept.reduce((largest, entry) => {
      const match = /^q(\d+)$/.exec(entry.requestId)
      return match === null ? largest : Math.max(largest, Number(match[1]))
    }, 0)
    this.nextRequestNumber = largestRequestNumber === Number.MAX_SAFE_INTEGER ? 1 : largestRequestNumber + 1
    return true
  }

  /** 最近一次 restore 丢弃的条目数（无效、重复或超出容量），供持久层决定是否重写清理后的快照。 */
  public lastRestoreDropped(): number {
    return this.restoreDropped
  }

  /** 生成不与当前队列冲突的标识，到达安全整数上限后循环寻找空位。 */
  private allocateRequestId(): string {
    let requestId: string
    do {
      requestId = `q${this.nextRequestNumber}`
      this.nextRequestNumber = this.nextRequestNumber === Number.MAX_SAFE_INTEGER ? 1 : this.nextRequestNumber + 1
    } while (this.encoded.has(requestId))
    return requestId
  }

  /** 返回事件内容也已复制的队列快照，避免外部修改内部记录。 */
  public snapshot(): readonly QueueEntry[] {
    return JSON.parse(this.serializedEntries()) as QueueEntry[]
  }

  /** 为调度提供轻量标识快照，不复制事件载荷。 */
  public requestIds(): readonly string[] {
    return this.entries.map(entry => entry.requestId)
  }

  /** 读取队列长度，不创建任何事件副本。 */
  public size(): number {
    return this.entries.length
  }

  /** 只在队列内容变化后生成新的不可变 JSON，供诊断快照读取。 */
  public serializedEntries(): string {
    this.serializedSnapshot ??= `[${this.entries.map(entry => encodeEntry(entry, this.encoded.get(entry.requestId)!.json)).join(',')}]`
    return this.serializedSnapshot
  }

  /** 不可变链共享已有条目，连续追加时只捕获链尾，不逐次复制整个积压数组。 */
  public captureSerializedEntries(): () => string {
    if (this.persistenceDirty) {
      this.persistenceTail = null
      for (const entry of this.entries) {
        this.persistenceTail = { entry, json: this.encoded.get(entry.requestId)!.json, previous: this.persistenceTail }
      }
      this.persistenceDirty = false
    }
    const tail = this.persistenceTail
    return () => {
      const parts: string[] = []
      for (let node = tail; node !== null; node = node.previous) parts.push(encodeEntry(node.entry, node.json))
      return `[${parts.reverse().join(',')}]`
    }
  }

  /** 删除、重试或恢复后重建下一份快照，已经捕获的链仍保持原内容。 */
  private invalidateSnapshots(): void {
    this.serializedSnapshot = null
    this.persistenceTail = null
    this.persistenceDirty = this.entries.length > 0
  }

  /** 修订号仅供当前进程识别删除，不能增长到不精确的整数。 */
  private advanceRemovalRevision(): void {
    this.removedRevision = this.removedRevision === Number.MAX_SAFE_INTEGER ? 0 : this.removedRevision + 1
  }

  /** 校验缓存条目、请求标识、重试次数和完整协议，阻止损坏数据恢复。 */
  private validEntry(entry: unknown): entry is QueueEntry {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const candidate = entry as Readonly<Record<string, unknown>>
    if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0
      || typeof candidate.retryCount !== 'number' || !Number.isSafeInteger(candidate.retryCount) || candidate.retryCount < 0
      || typeof candidate.event !== 'object' || candidate.event === null || Array.isArray(candidate.event)) return false
    const requestNumber = /^q([1-9]\d*)$/.exec(candidate.requestId)?.[1]
    if (requestNumber === undefined || !Number.isSafeInteger(Number(requestNumber))) return false
    const serialized = serializedEvent(candidate.event as ProtocolEvent)
    if (serialized === null || utf8ByteLength(serialized) > this.limits.maxEventBytes || utf8ByteLength(`[${serialized}]`) > this.limits.maxBatchBytes) return false
    const event = candidate.event as ProtocolEvent
    if (typeof event.eventType !== 'string') return false
    const rebuilt = this.buildEvent(event.eventType, event, true)
    return rebuilt.ok && JSON.stringify(rebuilt.event) === serialized
  }
}
