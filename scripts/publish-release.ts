import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { npmRegistry, publishNpmRelease } from './npm-publisher.js'
import { archivesDir, metadata, sdkName } from './release-layout.js'
import { releasePolicy } from './release-policy.js'
import './check-release.js'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF_TYPE !== 'tag') throw new Error('publish_requires_github_tag_workflow')
const policy = releasePolicy(metadata.version, process.env.GITHUB_REF_NAME)
const release = JSON.parse(await readFile(join(archivesDir, 'release.json'), 'utf8')) as { name: string; version: string; tag: string; prerelease: boolean; npmFile: string; npmIntegrity: string }
assert.equal(release.name, sdkName)
assert.equal(release.version, policy.version)
assert.equal(release.tag, policy.tag)
assert.equal(release.prerelease, policy.prerelease)
const archive = join(archivesDir, release.npmFile)
assert.equal(`sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`, release.npmIntegrity)
const result = await publishNpmRelease(sdkName, policy, release.npmIntegrity, {
  /** 使用标准网络接口查询发布包仓库元信息，供幂等发布判断。 */
  fetch: (url) => fetch(url, { signal: AbortSignal.timeout(15_000) }),
  /** 在有限轮询之间等待，避免过密查询包仓库。 */
  delay: () => delay(1_000),
  /** 使用已验证的包和发布渠道执行 npm 发布，不在此重新构建产物。 */
  publish: () => { execFileSync('npm', ['publish', archive, '--registry', npmRegistry, '--tag', policy.tag, '--access', 'public', '--provenance', '--ignore-scripts'], { stdio: 'inherit' }) },
})
console.log(`npm_${result}:${policy.version}:${policy.tag}`)
