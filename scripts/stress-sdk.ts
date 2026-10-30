import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { arch, cpus, platform } from 'node:os'
import { performance } from 'node:perf_hooks'
import { EventQueue } from '../src/core/queue.js'
import { QueuePersistence } from '../src/core/storage/index.js'
import { normalizeAttributes, type ProtocolEvent } from '../src/core/dataStore/protocol.js'
import { Uploader } from '../src/core/uploader.js'
import { updateIdentity } from '../src/core/userStore.js'
import { transformAutoTrackSfc } from '../src/compiler/vite.js'
import { normalizeAutoTrackCall } from '../src/plugins/gioEventAutoTracking/index.js'
import type { StoragePort, StorageWrite } from '../src/types/index.js'
import { runRuntimeStress } from './sdk-stress-scenarios.js'
import { runRecoveryStress } from './sdk-recovery-stress.js'

/** 使用真实协议形态构造确定性负载，避免宿主、网络和随机时间影响比较。 */
function event(sequence: number, size = 4096): ProtocolEvent {
  return {
    eventType: 'CUSTOM', eventName: 'stress_event', eventSequenceId: sequence,
    deviceId: 'stress-device', sessionId: 'stress-session', dataSourceId: 'stress-source',
    platform: 'Android', platformVersion: '14', timestamp: sequence, domain: 'example.stress',
    appState: 'FOREGROUND', networkState: 'WIFI', screenWidth: 1080, screenHeight: 1920,
    deviceBrand: 'UNKNOWN', deviceModel: 'UNKNOWN', deviceType: 'PHONE', language: 'zh-CN',
    timezoneOffset: '-480', sdkVersion: '0.1.0',
    attributes: { payloadA: '中'.repeat(Math.floor(size / 6)), payloadB: '中'.repeat(Math.floor(size / 6)) },
  }
}

/** 将操作多次计时，记录中位数与尾部样本；断言负责行为，耗时只用于同机对照。 */
function measure(name: string, operations: number, run: () => void, samples = 7) {
  run()
  const timings: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now()
    run()
    timings.push(performance.now() - start)
  }
  timings.sort((a, b) => a - b)
  return { name, operations, samples, medianMs: timings[Math.floor(samples / 2)]!, p95Ms: timings[Math.ceil(samples * 0.95) - 1]! }
}

/** 建立接近 1 MiB 的离线队列，每个场景复用相同输入。 */
function filledQueue(): EventQueue {
  const queue = new EventQueue()
  for (let sequence = 1; sequence <= 200; sequence++) assert.equal(queue.enqueue(event(sequence)).ok, true)
  return queue
}

const measurements = []
measurements.push(measure('queue_fill_200', 200, () => { filledQueue() }))
const queue = filledQueue()
measurements.push(measure('batch_select_200', 200, () => {
  const ids: string[] = []
  for (let batch = queue.claimNextBatch(); batch.length > 0; batch = queue.claimNextBatch()) ids.push(...batch.map(entry => entry.requestId))
  assert.equal(ids.length, 200)
  queue.release(ids)
}))
const uploader = new Uploader(queue, { dispatch: () => { throw new Error('offline_dispatch') } }, {
  now: () => 100, random: () => 0.5, setTimeout: () => 0, clearTimeout: () => undefined,
}, 'https://collector.invalid', 'stress', undefined, undefined, undefined, () => false)
measurements.push(measure('offline_schedule_200', 200, () => { for (let call = 0; call < 200; call++) uploader.schedule() }))
const longText = '😀'.repeat(1_000_000)
measurements.push(measure('long_identity_10', 10, () => {
  for (let call = 0; call < 10; call++) {
    const result = updateIdentity({ deviceId: 'stress-device', userId: null, userKey: null }, longText, null, true)
    assert.equal(result.ok, false)
    assert.equal(result.changed, false)
  }
}, 7))
measurements.push(measure('long_attribute_10', 10, () => {
  for (let call = 0; call < 10; call++) assert.equal(normalizeAttributes({ text: longText }).attributes.get('text'), '😀'.repeat(1000))
}, 5))
const longArray = Array<string>(100).fill('😀'.repeat(100_000))
measurements.push(measure('long_attribute_array_3', 3, () => {
  for (let call = 0; call < 3; call++) assert.equal(normalizeAttributes({ text: longArray }).attributes.get('text'), '😀'.repeat(1000))
}, 5))
const longDisplayText = ` \u0000${longText}\n`
measurements.push(measure('autotrack_long_text_10', 10, () => {
  for (let call = 0; call < 10; call++) assert.equal(normalizeAutoTrackCall({
    schemaVersion: 2, source: 'template', kind: 'change', eventName: 'save', elementType: 'input', trackValue: true,
  }, { detail: { value: longDisplayText } })?.textValue, '😀'.repeat(100))
}, 5))
measurements.push(measure('autotrack_long_array_3', 3, () => {
  for (let call = 0; call < 3; call++) assert.equal(normalizeAutoTrackCall({
    schemaVersion: 2, source: 'template', kind: 'change', eventName: 'save', elementType: 'checkbox-group', trackValue: true,
  }, { detail: { value: longArray } })?.textValue, '😀'.repeat(100))
}, 5))
const largeSfc = `<script setup>const save = event => event</script><template><view>${Array.from({ length: 2000 }, (_, index) => `<button id="button-${index}" @tap="save($event)">Button ${index}</button>`).join('')}</view></template>`
measurements.push(measure('compiler_2000_handlers', 2000, () => {
  const transformed = transformAutoTrackSfc(largeSfc)
  assert.equal(transformed.changed, true)
  assert.equal(transformed.warnings.length, 0)
  assert.equal((transformed.code.match(/schemaVersion:2/g) ?? []).length, 2000)
}, 5))

let releaseWrite: (result: StorageWrite) => void = () => { throw new Error('write_not_started') }
let writes = 0
let bytesWritten = 0
let latest = ''
const storage: StoragePort = {
  persistentQueue: true, read: async () => ({ kind: 'missing' }), remove: async () => ({ kind: 'ok' }),
  write: (_area, _key, value) => {
    writes++
    bytesWritten += Buffer.byteLength(value)
    latest = value
    return writes === 1 ? new Promise(resolve => { releaseWrite = resolve }) : Promise.resolve({ kind: 'ok' })
  },
}
const persistence = new QueuePersistence(storage, 'stress-queue')
globalThis.gc?.()
const heapBefore = process.memoryUsage().heapUsed
const pending: Promise<StorageWrite>[] = [persistence.persist(queue)]
await Promise.resolve()
const start = performance.now()
for (let call = 0; call < 200; call++) pending.push(persistence.persist(queue))
globalThis.gc?.()
const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore)
const burstMs = performance.now() - start
releaseWrite({ kind: 'ok' })
await Promise.all(pending)
const recovered = new EventQueue()
assert.equal(recovered.restore(JSON.parse(latest).entries), true)
assert.equal(recovered.snapshot().length, 200)
const report = {
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, gcAvailable: typeof globalThis.gc === 'function' },
  measurements,
  persistenceBurst: { calls: pending.length, burstMs, retainedHeapBytes, writes, bytesWritten, queueBytes: Buffer.byteLength(latest) },
  runtimeStress: process.argv.includes('--micro-only') ? undefined
    : process.argv.includes('--extended') ? await runRuntimeStress(100_000, 200_000) : await runRuntimeStress(),
  recoveryStress: process.argv.includes('--micro-only') ? undefined
    : process.argv.includes('--extended') ? await runRecoveryStress(250, 190) : await runRecoveryStress(),
}
const output = process.argv[process.argv.indexOf('--output') + 1]
if (process.argv.includes('--output') && output !== undefined) {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify(report, null, 2))
