import { describe, expect, it, vi } from 'vitest'
import { publishNpmRelease } from '../../scripts/npm-publisher.js'
import { releasePolicy } from '../../scripts/release-policy.js'

/** 创建带状态码的包仓库 JSON 响应。 */
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
/** 构造与待发布内容一致的版本完整性响应。 */
const version = () => json({ dist: { integrity: 'same' } })
/** 构造可调的正式渠道标签，用于防止渠道版本倒退。 */
const tags = (latest = '1.0.0') => json({ latest })
/** 按顺序消费预设包仓库响应并记录发布和等待调用。 */
function fixture(responses: Response[]) {
  return { fetch: vi.fn(async () => { const response = responses.shift(); if (!response) throw new Error('unexpected_registry_read'); return response }), publish: vi.fn(), delay: vi.fn(async () => undefined) }
}

describe('npm 发布和失败重跑', () => {
  it('首次发布遇到 registry 延迟只重试校验，不重复发布', async () => {
    const io = fixture([json({}, 404), json({}, 404), json({}, 404), json({}, 404), version(), tags()])
    await expect(publishNpmRelease('sdk', releasePolicy('1.0.0'), 'same', io)).resolves.toBe('published')
    expect(io.publish).toHaveBeenCalledOnce()
    expect(io.delay).toHaveBeenCalledOnce()
  })
  it('附件失败重跑时允许 npm 已完成并且渠道已有更新版本，不回退渠道', async () => {
    const io = fixture([version(), tags('2.0.0'), version(), tags('2.0.0')])
    await expect(publishNpmRelease('sdk', releasePolicy('1.0.0'), 'same', io)).resolves.toBe('already-published')
    expect(io.publish).not.toHaveBeenCalled()
  })
  it('同版本内容不同必须停止，不能当作已发布成功', async () => {
    const io = fixture([version()])
    await expect(publishNpmRelease('sdk', releasePolicy('1.0.0'), 'different', io)).rejects.toThrow('已发布版本与本次产物不一致')
    expect(io.publish).not.toHaveBeenCalled()
  })
  it('旧版本首次发布不能把 latest 倒退', async () => {
    const io = fixture([json({}, 404), tags('2.0.0')])
    await expect(publishNpmRelease('sdk', releasePolicy('1.0.0'), 'same', io)).rejects.toThrow('release_would_regress_latest')
    expect(io.publish).not.toHaveBeenCalled()
  })
  it('registry 权限错误不能被当作不存在并继续发布', async () => {
    const io = fixture([json({}, 403)])
    await expect(publishNpmRelease('sdk', releasePolicy('1.0.0'), 'same', io)).rejects.toThrow('registry_read_failed:403')
    expect(io.publish).not.toHaveBeenCalled()
  })
  it('预发布校验 next，不能只检查包已存在', async () => {
    const io = fixture([json({}, 404), tags(), version(), json({ latest: '1.0.0', next: '1.1.0-rc.1' })])
    await expect(publishNpmRelease('sdk', releasePolicy('1.1.0-rc.1'), 'same', io)).resolves.toBe('published')
  })
})
