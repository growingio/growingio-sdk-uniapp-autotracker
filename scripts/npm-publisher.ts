import assert from 'node:assert/strict'
import semver from 'semver'
import type { releasePolicy } from './release-policy.js'

type Policy = ReturnType<typeof releasePolicy>
export const npmRegistry = 'https://registry.npmjs.org/'

/** 只发布一次；失败重跑先核对不可覆盖的版本内容，再检查渠道是否已前进。 */
export async function publishNpmRelease(name: string, policy: Policy, integrity: string, io: {
  /** 读取包仓库元信息，返回包含 HTTP 状态的标准响应。 */
  fetch: (url: string) => Promise<Response>
  /** 执行一次已验证产物的发布，重试检查不能再次触发此方法。 */
  publish: () => void
  /** 在有限包仓库复检之间等待。 */
  delay: () => Promise<void>
}): Promise<'published' | 'already-published'> {
  const versionUrl = `${npmRegistry}${name}/${policy.version}`
  const tagsUrl = `${npmRegistry}-/package/${name}/dist-tags`
  const response = await io.fetch(versionUrl)
  const exists = response.ok
  if (exists) {
    const published = await response.json() as { dist: { integrity: string } }
    assert.equal(published.dist.integrity, integrity, '已发布版本与本次产物不一致')
  } else if (response.status !== 404) throw new Error(`registry_read_failed:${response.status}`)
  const tagsResponse = await io.fetch(tagsUrl)
  if (tagsResponse.ok) {
    const tags = await tagsResponse.json() as Record<string, string>
    const current = tags[policy.tag]
    if (!exists && current && semver.valid(current) && semver.gt(current, policy.version)) throw new Error(`release_would_regress_${policy.tag}:${current}`)
  } else if (tagsResponse.status !== 404) throw new Error(`registry_tags_failed:${tagsResponse.status}`)
  if (!exists) io.publish()

  // 包仓库/CDN 可短暂延迟；只重试读校验，不能因此重复执行发布。
  for (let attempt = 0; attempt < 4; attempt++) {
    const verification = await io.fetch(versionUrl)
    const tagsCheck = await io.fetch(tagsUrl)
    if (verification.ok && tagsCheck.ok) {
      const published = await verification.json() as { dist: { integrity: string } }
      assert.equal(published.dist.integrity, integrity, '发布后内容校验失败')
      const tags = await tagsCheck.json() as Record<string, string>
      const current = tags[policy.tag]
      if (current === policy.version || (exists && current && semver.valid(current) && semver.gt(current, policy.version))) return exists ? 'already-published' : 'published'
    }
    if (attempt < 3) await io.delay()
  }
  throw new Error(`registry_verification_failed:${policy.version}:${policy.tag}`)
}
