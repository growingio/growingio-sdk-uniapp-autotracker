import type { StorageArea, StoragePort, StorageRead, StorageWrite, TransportHandle, TransportPort, TransportRequest, TransportResult } from '../types/index.js'

/** 可注入的最小同步 uni 存储接口，便于平台端口独立测试。 */
export interface AppStorageApi {
  /** 读取宿主键值，返回值仍需由存储端口校验。 */
  getStorageSync(key: string): unknown
  /** 同步写入已编码字符串，异常由存储端口分类。 */
  setStorageSync(key: string, value: string): void
  /** 同步移除指定键，不执行全局存储清理。 */
  removeStorageSync(key: string): void
}

/** 将宿主写入异常区分为容量不足或一般失败，保持端口结果稳定。 */
function writeFailure(error: unknown): StorageWrite {
  const message = error instanceof Error ? error.message : undefined
  return message !== undefined && /(quota|full|space)/i.test(message)
    ? { kind: 'quota', message }
    : { kind: 'failed', message }
}

/** App 存储适配器只转换宿主调用，不解释 SDK 记录内容。 */
export class AppStoragePort implements StoragePort {

  /** 保存同步 uni 存储 API，不在构造时读取或修改业务数据。 */
  public constructor(private readonly api: AppStorageApi, public readonly persistentQueue = true) {}

  /** 将宿主读取结果区分为值、缺失、损坏或不可用；只接受字符串记录。 */
  public async read(_area: StorageArea, key: string): Promise<StorageRead> {
    if (_area === 'queue' && !this.persistentQueue) return { kind: 'missing' }
    try {
      const value = this.api.getStorageSync(key)
      if (value === undefined || value === null || value === '') return { kind: 'missing' }
      return typeof value === 'string' ? { kind: 'value', value } : { kind: 'corrupt', message: 'storage_value_not_string' }
    } catch (error) {
      return { kind: 'unavailable', message: error instanceof Error ? error.message : undefined }
    }
  }

  /** 以 Promise 端口包装同步写入，并将宿主异常转换为标准结果。 */
  public async write(_area: StorageArea, key: string, value: string): Promise<StorageWrite> {
    if (_area === 'queue' && !this.persistentQueue) return { kind: 'ok' }
    try {
      this.api.setStorageSync(key, value)
      return { kind: 'ok' }
    } catch (error) {
      return writeFailure(error)
    }
  }

  /** 仅删除调用方指定的 SDK 键，隔离宿主删除异常。 */
  public async remove(_area: StorageArea, key: string): Promise<StorageWrite> {
    if (_area === 'queue' && !this.persistentQueue) return { kind: 'ok' }
    try {
      this.api.removeStorageSync(key)
      return { kind: 'ok' }
    } catch (error) {
      return writeFailure(error)
    }
  }
}

export type AppRequestTask = Readonly<{
  /** 可选宿主中止能力，不能自行改变上层已锁定的结果。 */
  abort?: () => void
}>
export type AppRequestResponse = Readonly<{ statusCode: number; data?: unknown }>
export type AppRequestFailure = Readonly<{ errMsg?: string }>

export interface AppRequestApi {
  /** 按 uni.request 约定发送请求，底层任务可选提供 abort。 */
  request(options: Readonly<{
    url: string
    method: 'POST'
    header: Readonly<Record<string, string>>
    data: string
    timeout: number
    /** 收到 HTTP 响应；是否为采集服务成功状态仍由核心判断。 */
    success: (response: AppRequestResponse) => void
    /** 报告网络或超时失败。 */
    fail: (failure: AppRequestFailure) => void
    /** 通知宿主请求结束，不作为第二次权威结果。 */
    complete: () => void
  }>): AppRequestTask | void
}

/** 仅转换 App 的 uni.request 调用，批次、重试和最终结算仍由核心管理。 */
export class AppRequestPort implements TransportPort {
  /** 绑定 uni.request，批次与重试策略仍由核心上传器管理。 */
  public constructor(private readonly api: AppRequestApi) {}

  /** 将标准请求转换为 uni.request 调用，统一成功、失败和可选中止接口。 */
  public dispatch(request: TransportRequest, done: (result: TransportResult) => void): TransportHandle | void {
    let completed = false
    /** 只向上层提交第一次宿主结果，忽略重复回调。 */
    const finish = (result: TransportResult): void => {
      if (completed) return
      completed = true
      done(result)
    }
    try {
      const task = this.api.request({
        url: request.url,
        method: request.method,
        header: request.headers,
        data: request.body,
        timeout: request.timeoutMs,
        /** 透传 HTTP 状态码，由采集服务规则判断是否真正接收成功。 */
        success: (response) => finish({ kind: 'success', status: response.statusCode }),
        /** 区分宿主超时与普通网络错误，保留可诊断的失败信息。 */
        fail: (failure) => {
          const message = failure.errMsg
          finish(/timeout/i.test(message ?? '') ? { kind: 'timeout', message } : { kind: 'network', message })
        },
        /** 宿主 complete 不重复结算请求，结果由 success 或 fail 提交。 */
        complete: () => undefined,
      })
      return task?.abort === undefined ? undefined : {
        /** 代理底层请求任务的可选中止方法。 */
        abort: () => task.abort?.()
      }
    } catch (error) {
      finish({ kind: 'network', message: error instanceof Error ? error.message : undefined })
      return undefined
    }
  }
}
