import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { normalizeInitOptions } from '../../src/constants/config.js'
import { dispatchWithFinalizer, isRetryableCollectorFailure, normalizeCollectorResult } from '../../src/core/uploader.js'
import { MiniProgramSystemContextPort, type MiniProgramHost } from '../../src/platform/miniprogram.js'
import { AppRequestPort, type AppRequestApi } from '../../src/platform/uni.js'
import type { TransportRequest, TransportResult } from '../../src/types/index.js'

type NativeResponse = { status?: unknown; headers: Record<string, string>; data: unknown; error?: number; errorMessage?: string }
type NativeRequestOptions = {
  dataType?: string
  success: (response: NativeResponse) => void
  fail: (response: NativeResponse) => void
  complete?: (response: NativeResponse) => void
}
type UniRequestHost = AppRequestApi & {
  addInterceptor(name: string, hooks: { success?: (response: unknown) => void; fail?: (response: unknown) => void }): void
  removeInterceptor(name: string): void
}

const request: TransportRequest = { url: 'https://collector.example/v3/projects/account/collect', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]', timeoutMs: 5000 }
let directory: string
let alipay: UniRequestHost
let baidu: MiniProgramHost
let response: { status: unknown; body: string; parseFailure?: boolean; deferred?: boolean }
let pending: NativeRequestOptions | undefined
let aborts = 0

// 只替换 native my/swan；请求参数、回调状态映射及系统信息保留锁定 DCloud 的真实包装层。
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gio-mini-platform-'))
  vi.stubGlobal('getApp', () => undefined)
  vi.stubGlobal('swan', {
    getSystemInfoSync: () => ({ platform: 'Android', system: '14', language: 'zh_CN', swanNativeVersion: '13.0', devicePixelRatio: 3, screenWidth: 390, screenHeight: 844, brand: 'fixture', model: 'phone' }),
    getStorageSync: () => 'dcloud-device', setStorage: () => undefined,
    getEnvInfoSync: () => ({ appKey: 'baidu-id', sdkVersion: '3.0' }),
  })
  vi.stubGlobal('my', {
    canIUse: (name: string) => name === 'request',
    request: (options: NativeRequestOptions) => {
      pending = options
      if (!response.deferred) {
        const result: NativeResponse = { status: response.status, headers: {}, data: response.body }
        if (typeof response.status === 'number' && response.status >= 400) {
          options.fail({ ...result, error: 19, errorMessage: 'HTTP error' })
        } else {
          try {
            if (response.parseFailure) throw new Error('JSON parse data error')
            options.success({ ...result, data: (options.dataType ?? 'json') === 'json' ? JSON.parse(response.body) : response.body })
          } catch {
            options.fail({ ...result, error: 14, errorMessage: 'JSON parse data error' })
          }
        }
        options.complete?.(result)
      }
      return { abort: () => { aborts++; options.fail({ status: 200, headers: {}, data: 'late', error: 14, errorMessage: 'aborted' }) } }
    },
  })
  const require = createRequire(import.meta.url)
  for (const name of ['baidu', 'alipay'] as const) {
    const entry = require.resolve(`@dcloudio/uni-mp-${name}/dist/uni.api.esm.js`)
    const hostRequire = createRequire(entry)
    const outfile = join(directory, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', alias: { vue: hostRequire.resolve('@dcloudio/uni-mp-vue/dist/vue.runtime.esm.js') }, define: { 'process.env.UNI_PLATFORM': JSON.stringify(`mp-${name}`) }, logLevel: 'silent' })
    const module = await import(/* @vite-ignore */ pathToFileURL(outfile).href)
    if (name === 'baidu') baidu = module.default as MiniProgramHost
    else alipay = module.default as UniRequestHost
  }
}, 15_000)

afterEach(() => { alipay.removeInterceptor('request'); pending = undefined })
afterAll(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })

describe('locked DCloud mini-program platform adapters', () => {
  it('converts Baidu devicePixelRatio from the real legacy system wrapper to physical screen pixels', async () => {
    const config = normalizeInitOptions({ accountId: 'account', dataSourceId: 'source', appId: 'baidu-id' }, 'mp-baidu')
    if (!config.ok) throw new Error('invalid_fixture')
    expect(await new MiniProgramSystemContextPort(baidu, config.config, 'fixture').load()).toMatchObject({ screenWidth: 1170, screenHeight: 2532 })
  })

  it('receives a plain-text HTTP 200 through the Alipay wrapper success callback without JSON parsing', () => {
    response = { status: 200, body: 'OK' }
    const success: unknown[] = [], failure: unknown[] = [], results: TransportResult[] = []
    alipay.addInterceptor('request', { success: result => { success.push(result) }, fail: result => { failure.push(result) } })
    new AppRequestPort(alipay).dispatch(request, result => results.push(normalizeCollectorResult(result)))
    expect(results).toEqual([{ kind: 'success', status: 200 }])
    expect(success).toEqual([expect.objectContaining({ statusCode: 200, data: 'OK' })])
    expect(failure).toEqual([])
  })

  it.each([
    { status: 400, result: { kind: 'http', status: 400 }, retry: false },
    { status: 422, result: { kind: 'http', status: 422 }, retry: false },
    { status: 500, result: { kind: 'http', status: 500 }, retry: true },
  ])('keeps HTTP $status from Alipay native fail for collector rejection and retry classification', ({ status, result, retry }) => {
    response = { status, body: 'HTTP error' }
    const results: TransportResult[] = []
    new AppRequestPort(alipay).dispatch(request, result => results.push(normalizeCollectorResult(result)))
    expect(results).toEqual([result])
    expect(isRetryableCollectorFailure(results[0]!)).toBe(retry)
  })

  it('preserves HTTP 200 when Alipay still reports a native response parse failure', () => {
    response = { status: 200, body: 'OK', parseFailure: true }
    const results: TransportResult[] = []
    new AppRequestPort(alipay).dispatch(request, result => results.push(normalizeCollectorResult(result)))
    expect(results).toEqual([{ kind: 'success', status: 200 }])
  })

  it('keeps cancellation authoritative when native abort and late callbacks carry HTTP status', () => {
    response = { status: 200, body: 'OK', deferred: true }
    aborts = 0
    const results: TransportResult[] = []
    const timer = { setTimeout: () => 1, clearTimeout: () => undefined }
    const handle = dispatchWithFinalizer(new AppRequestPort(alipay), timer, request, result => results.push(result))
    handle.cancel()
    pending?.success({ status: 204, headers: {}, data: '' })
    pending?.complete?.({ status: 204, headers: {}, data: '' })
    handle.cancel()
    expect(aborts).toBe(1)
    expect(results).toEqual([{ kind: 'aborted' }])
  })
})
