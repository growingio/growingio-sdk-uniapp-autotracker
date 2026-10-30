import { createMockCollector } from '../test/support/mock-collector.js'

const port = Number.parseInt(process.env.MOCK_COLLECTOR_PORT ?? '3100', 10)
const host = process.env.MOCK_COLLECTOR_HOST ?? '127.0.0.1'
const collector = await createMockCollector({ port: Number.isFinite(port) ? port : 3100, host })

console.log(`Mock collector listening at ${collector.baseUrl}`)
console.log('It stores redacted request summaries only. Press Ctrl+C to stop.')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void collector.close().finally(() => process.exit(0))
  })
}
