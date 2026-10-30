import { afterEach, describe, expect, it } from 'vitest'

import { createMockCollector, type MockCollector } from '../support/mock-collector.js'

const collectors: MockCollector[] = []

afterEach(async () => {
  await Promise.all(collectors.splice(0).map((collector) => collector.close()))
})

describe('stage 0 mock collector', () => {
  it('accepts the documented collect request and stores only a redacted summary', async () => {
    const collector = await createMockCollector()
    collectors.push(collector)

    const response = await fetch(
      `${collector.baseUrl}/v3/projects/data-source-1/collect?stm=1700000000000&compress=0`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify([{ eventType: 'VISIT', deviceId: 'must-not-be-recorded', userId: 'must-not-be-recorded' }]),
      },
    )

    expect(response.status).toBe(200)
    expect(collector.requests).toStrictEqual([
      expect.objectContaining({
        projectId: 'data-source-1',
        eventCount: 1,
        eventTypes: ['VISIT'],
        accepted: true,
        status: 200,
      }),
    ])
    expect(JSON.stringify(collector.requests)).not.toContain('must-not-be-recorded')
  })

  it('accepts 204 as a collector success', async () => {
    const collector = await createMockCollector({ acceptedStatus: 204 })
    collectors.push(collector)

    const response = await fetch(`${collector.baseUrl}/v3/projects/data-source-1/collect?stm=1&compress=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '[]',
    })

    expect(response.status).toBe(204)
    expect(collector.requests[0]).toMatchObject({ accepted: true, status: 204, eventCount: 0 })
  })

  it('rejects malformed request contracts with a diagnosable summary', async () => {
    const collector = await createMockCollector()
    collectors.push(collector)

    const response = await fetch(`${collector.baseUrl}/v3/projects/data-source-1/collect?compress=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '[]',
    })

    expect(response.status).toBe(400)
    expect(collector.requests[0]).toMatchObject({
      accepted: false,
      status: 400,
      rejectReason: 'invalid_collect_query',
    })
  })
})
