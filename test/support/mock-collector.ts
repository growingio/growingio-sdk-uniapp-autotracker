import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'

export type CollectorRequestSummary = Readonly<{
  receivedAt: number
  projectId: string
  eventCount: number
  eventTypes: readonly string[]
  bodyBytes: number
  accepted: boolean
  status: number
  rejectReason?: string
}>

export type MockCollector = Readonly<{
  baseUrl: string
  requests: readonly CollectorRequestSummary[]
  close(): Promise<void>
}>

export type MockCollectorOptions = Readonly<{
  port?: number
  host?: string
  acceptedStatus?: 200 | 204
  /** 只供合成数据链路测试断言；默认仍仅保存脱敏请求摘要。 */
  onAcceptedEvents?: (events: readonly Readonly<Record<string, unknown>>[]) => void
}>

/** 按指定状态发送测试响应；无响应体时保持空响应。 */
function writeJson(response: ServerResponse, status: number, body?: Record<string, unknown>): void {
  response.statusCode = status
  if (body !== undefined) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
    return
  }
  response.end()
}

/** 完整收集请求字节，供采集协议与正文验证。 */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** 记录脱敏拒绝摘要并返回固定错误原因，不保存原始业务报文。 */
function reject(
  requests: CollectorRequestSummary[],
  response: ServerResponse,
  detail: Omit<CollectorRequestSummary, 'accepted' | 'status'>,
  rejectReason: string,
): void {
  requests.push({ ...detail, accepted: false, status: 400, rejectReason })
  writeJson(response, 400, { accepted: false, reason: rejectReason })
}

/** 启动仅供本地合成数据验证的采集服务，严格检查路径、请求头、查询参数和事件数组。 */
export async function createMockCollector(options: MockCollectorOptions = {}): Promise<MockCollector> {
  const requests: CollectorRequestSummary[] = []
  const acceptedStatus = options.acceptedStatus ?? 200
  let server: Server

  server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      writeJson(response, 200, { ok: true })
      return
    }

    const origin = `http://${request.headers.host ?? '127.0.0.1'}`
    const url = new URL(request.url ?? '/', origin)
    const projectMatch = /^\/v3\/projects\/([^/]+)\/collect$/.exec(url.pathname)
    const body = await readBody(request)
    const detail = {
      receivedAt: Date.now(),
      projectId: projectMatch?.[1] ?? '',
      eventCount: 0,
      eventTypes: [] as string[],
      bodyBytes: body.byteLength,
    }

    if (request.method !== 'POST' || projectMatch === null) {
      reject(requests, response, detail, 'invalid_collect_path')
      return
    }
    if (url.searchParams.get('compress') !== '0' || !/^\d+$/.test(url.searchParams.get('stm') ?? '')) {
      reject(requests, response, detail, 'invalid_collect_query')
      return
    }
    if (request.headers['content-type'] !== 'application/json' || request.headers.accept !== 'application/json') {
      reject(requests, response, detail, 'invalid_collect_headers')
      return
    }

    let events: unknown
    try {
      events = JSON.parse(body.toString('utf8'))
    } catch {
      reject(requests, response, detail, 'invalid_json')
      return
    }
    if (!Array.isArray(events) || events.some((event) => event === null || typeof event !== 'object')) {
      reject(requests, response, detail, 'invalid_event_array')
      return
    }

    options.onAcceptedEvents?.(events)
    requests.push({
      ...detail,
      eventCount: events.length,
      eventTypes: events.map((event) => {
        const value = (event as Record<string, unknown>).eventType
        return typeof value === 'string' ? value : 'UNKNOWN'
      }),
      accepted: true,
      status: acceptedStatus,
    })
    writeJson(response, acceptedStatus, acceptedStatus === 200 ? { accepted: true } : undefined)
  })

  const host = options.host ?? '127.0.0.1'
  server.listen(options.port ?? 0, host)
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('mock collector did not expose a TCP port')
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    /** 读取脱敏请求摘要，供集成用例核对采集结果。 */
    get requests() {
      return requests
    },
    /** 关闭测试服务器并等待资源释放，避免端口泄漏到后续用例。 */
    async close(): Promise<void> {
      server.close()
      await once(server, 'close')
    },
  }
}
