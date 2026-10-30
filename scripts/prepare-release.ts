import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { archivesDir, dist, metadata, npmDir, sdkName } from './release-layout.js'
import { releasePolicy } from './release-policy.js'
import './check-release.js'

const policy = releasePolicy(metadata.version, process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined)
await rm(archivesDir, { recursive: true, force: true })
await mkdir(archivesDir, { recursive: true })
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', archivesDir, '--cache', join(dist, 'npm-cache')], { cwd: npmDir, encoding: 'utf8' })) as Array<{ filename: string; integrity: string }>
const npmPackage = packed[0]
if (npmPackage === undefined) throw new Error('npm_pack_missing_output')
const uniFile = `${sdkName}-${metadata.version}-uni_modules.tgz`
execFileSync('tar', ['-czf', join(archivesDir, uniFile), '-C', dist, 'uni_modules'])
const uniSha256 = createHash('sha256').update(await readFile(join(archivesDir, uniFile))).digest('hex')
await writeFile(join(archivesDir, 'release.json'), JSON.stringify({ ...policy, name: sdkName, npmFile: npmPackage.filename, npmIntegrity: npmPackage.integrity, uniFile, uniSha256 }, null, 2))
console.log(`release_prepared:${metadata.version}:${policy.tag}`)
