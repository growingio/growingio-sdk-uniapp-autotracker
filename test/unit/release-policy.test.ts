import { describe, expect, it } from 'vitest'
import { releasePolicy } from '../../scripts/release-policy.js'

describe('发布版本与渠道', () => {
  it.each(['1.0.0', '0.1.0'])('正式版 %s 使用 latest', (version) => {
    expect(releasePolicy(version)).toEqual({ version, tag: 'latest', prerelease: false })
  })
  it.each(['1.0.0-beta.1', '1.0.0-rc.1'])('预发布 %s 使用 next', (version) => {
    expect(releasePolicy(version)).toEqual({ version, tag: 'next', prerelease: true })
  })
  it.each([['1.0.0', 'v1.0.1'], ['01.0.0', 'v01.0.0'], ['1.0.0+local', 'v1.0.0+local']])('拒绝不匹配或非规范版本 %s / %s', (version, tag) => {
    expect(() => releasePolicy(version, tag)).toThrow()
  })
})
