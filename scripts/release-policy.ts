import semver from 'semver'

/** 校验规范版本及可选 Git 标签，决定正式或预发布渠道。 */
export function releasePolicy(version: string, gitTag = `v${version}`): { version: string; tag: 'latest' | 'next'; prerelease: boolean } {
  if (semver.valid(version) !== version || version.includes('+') || gitTag !== `v${version}`) throw new Error('release_version_tag_mismatch')
  const prerelease = semver.prerelease(version) !== null
  return { version, tag: prerelease ? 'next' : 'latest', prerelease }
}
