import { describe, expect, it } from 'vitest'
import { createMockCollector } from '../support/mock-collector.js'
import { miniHost, miniTargets } from '../support/miniprogram-host.js'
import { buildMiniProgramEvent } from '../../src/core/dataStore/protocol.js'

describe.each(miniTargets)('%s real HTTP collector', target => {
  it.each([200, 204] as const)('sends mini events through uni transport and accepts HTTP %s', async status => {
    const received: Readonly<Record<string, unknown>>[] = []
    const collector = await createMockCollector({ acceptedStatus: status, onAcceptedEvents: events => received.push(...events) })
    const f = miniHost(target)
    const requests: Promise<void>[] = []
    f.host.request.mockImplementation(options => {
      const abort = new AbortController()
      requests.push(fetch(options.url, { method: options.method, headers: options.header, body: options.data, signal: abort.signal })
        .then(response => { options.success({ statusCode: response.status }); options.complete() })
        .catch(error => { options.fail({ errMsg: String(error) }); options.complete() }))
      return { abort: () => abort.abort() }
    })
    try {
      expect(f.init({ serverUrl: collector.baseUrl })).toBe(true)
      expect(await f.tracker.whenReady()).toBe(true)
      f.show()
      f.tracker.setLocation(0, 0)
      f.tracker.track('http_fixture', { amount: 0, member: false })
      f.tracker.setUserAttributes({ role: 'fixture' })
      f.tracker.onAppHide()
      await Promise.all(requests)
      expect(collector.requests).toHaveLength(1)
      expect(collector.requests[0]).toMatchObject({ accepted: true, status, projectId: 'account', eventCount: 5 })
      expect(received.map(event => event.eventType)).toEqual(['VISIT', 'PAGE', 'CUSTOM', 'LOGIN_USER_ATTRIBUTES', 'APP_CLOSED'])
      for (const event of received) {
        expect(buildMiniProgramEvent(String(event.eventType), event, true)).toEqual({ ok: true, event })
        expect(event.platform).toBe(target === 'mp-weixin' ? 'MinP' : 'alip')
        expect(event.domain).toBe(f.appId)
      }
      expect(received[2]).toMatchObject({ attributes: { amount: '0', member: 'false' }, latitude: 0, longitude: 0, title: '首页' })
      expect(f.tracker.queuedEvents()).toEqual([])
    } finally {
      await Promise.all(requests)
      await collector.close()
    }
  })
})
