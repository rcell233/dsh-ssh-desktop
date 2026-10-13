/** Platform/architecture and release signing regressions; no macOS host required. */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilderCache, verifyArchiveFiles } from '../scripts/package-support.mjs'
import {
  assertBuildHost, createBuildConfig, localElectronDist, macSigningOptions,
  parseBuildArgs, resourcesDirectory,
} from '../scripts/package-config.mjs'

const macArm = { platform: 'darwin', arch: 'arm64' }
const macIntel = { platform: 'darwin', arch: 'x64' }
const windows = { platform: 'win32', arch: 'x64' }
const linux = { platform: 'linux', arch: 'x64' }

assert.deepEqual(parseBuildArgs([], macArm).architectures, ['arm64'])
assert.deepEqual(parseBuildArgs([], macIntel).architectures, ['x64'])
assert.equal(parseBuildArgs([], windows).platform, 'win32')
assert.deepEqual(parseBuildArgs(['--mac', '--arch', 'all'], macArm).architectures, ['arm64', 'x64'])
assert.equal(parseBuildArgs(['--', '--mac', '--arch=x64', '--dir', '--signed'], linux).dir, true)
assert.equal(parseBuildArgs(['--help'], linux).help, true)
for (const args of [[], ['--linux'], ['--mac', '--win'], ['--mac', '--arch'], ['--mac', '--arch=universal'], ['--win', '--arch=arm64'], ['--win', '--signed']]) {
  assert.throws(() => parseBuildArgs(args, linux))
}
assert.throws(() => assertBuildHost({ platform: 'darwin' }, 'linux'), /on a Mac/)
assert.doesNotThrow(() => assertBuildHost({ platform: 'darwin' }, 'darwin'))
console.log('ok   build arguments select native architectures and reject unsupported combinations')

assert.equal(localElectronDist('darwin', 'arm64', macArm, '/runtime'), '/runtime')
assert.equal(localElectronDist('darwin', 'x64', macArm, '/runtime'), undefined)
assert.equal(localElectronDist('darwin', 'x64', windows, '/runtime'), undefined)
assert.equal(localElectronDist('win32', 'x64', linux, '/runtime'), undefined)
assert.equal(resourcesDirectory('output', 'darwin'), join('output', 'DSH SSH Desktop.app', 'Contents', 'Resources'))
assert.equal(resourcesDirectory('output', 'win32'), join('output', 'resources'))
console.log('ok   cross-architecture builds cannot reuse the host runtime; Mac resources use the bundle')

assert.deepEqual(macSigningOptions(false, {}), { identity: '-', hardenedRuntime: false, notarize: false })
assert.throws(() => macSigningOptions(true, {}), /credentials/)
assert.throws(() => macSigningOptions(true, { APPLE_ID: 'example' }), /credentials/)
assert.throws(() => macSigningOptions(true, { APPLE_ID: 'example', APPLE_KEYCHAIN_PROFILE: 'test' }), /credentials/)
const apple = { APPLE_ID: 'example', APPLE_APP_SPECIFIC_PASSWORD: 'test-only', APPLE_TEAM_ID: 'TEST' }
assert.throws(() => macSigningOptions(true, { ...apple, CSC_NAME: '-' }), /ad-hoc/)
assert.throws(() => macSigningOptions(true, { ...apple, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }), /CSC_NAME/)
for (const env of [apple, { APPLE_API_KEY: '/key.p8', APPLE_API_KEY_ID: 'test', APPLE_API_ISSUER: 'test' }, { APPLE_KEYCHAIN_PROFILE: 'test' }]) {
  assert.deepEqual(macSigningOptions(true, env), { type: 'distribution', hardenedRuntime: true, notarize: true, forceCodeSigning: true })
}
console.log('ok   ad-hoc builds need no Apple credentials; release builds require signing and notarization')

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js')
for (const [platform, signing] of [['darwin', macSigningOptions(false, {})], ['darwin', macSigningOptions(true, apple)], ['win32', undefined]]) {
  const config = createBuildConfig({
    desktop: '/desktop', dist: '/dist', pluginFile: '/dist/plugin.tgz',
    pluginVersion: '0.2.0', electronVersion: '44.4.5', platform,
    signing,
  })
  await validateConfiguration(config)
  assert.equal(config.appId, platform === 'darwin' ? 'io.github.rcell233.dsh-ssh-desktop' : 'dsh-ssh-desktop')
  assert.equal(config.mac.minimumSystemVersion, '13.0.0')
  assert.match(config.mac.artifactName, /\$\{arch\}/)
  assert.match(config.win.artifactName, /\$\{arch\}/)
  assert.ok(config.files.includes('LICENSE') && config.files.includes('NOTICE'))
  assert.equal(config.extraResources[0].to, 'dsh-desktop-link-0.2.0.tgz')
}
console.log('ok   Mac and Windows configs pass the installed electron-builder schema')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-packaging-'))
try {
  writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n')
  const cache = join(scratch, '.cache', 'builder')
  ensureBuilderCache(cache)
  const helper = join(cache, 'icon-tool.js')
  writeFileSync(helper, 'require("node:fs"); process.stdout.write("commonjs works")\n')
  const run = spawnSync(process.execPath, [helper], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, 'commonjs works')
  const customMetadata = '{"type":"commonjs","name":"custom-cache"}\n'
  writeFileSync(join(cache, 'package.json'), customMetadata)
  ensureBuilderCache(cache)
  assert.equal(readFileSync(join(cache, 'package.json'), 'utf8'), customMetadata)
  writeFileSync(join(cache, 'package.json'), '{"type":"module"}\n')
  assert.throws(() => ensureBuilderCache(cache), /Choose a separate ELECTRON_BUILDER_CACHE/)
  console.log('ok   downloaded CommonJS helpers run inside ESM workspaces without overwriting cache metadata')

  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const { createPackage, extractFile } = appBuilderRequire('@electron/asar')
  const source = join(scratch, 'source')
  mkdirSync(join(source, 'src', 'main'), { recursive: true })
  writeFileSync(join(source, 'src', 'main', 'index.js'), 'export const example = true\n')
  writeFileSync(join(source, 'empty'), '')
  const archive = join(scratch, 'app.asar')
  await createPackage(source, archive)
  verifyArchiveFiles(archive, ['src/main/index.js'], extractFile)
  assert.throws(() => verifyArchiveFiles(archive, ['src/main/missing.js'], extractFile), /not found/)
  assert.throws(() => verifyArchiveFiles(archive, ['empty'], extractFile), /Empty packaged file/)
  console.log('ok   packaged file verification reads real ASAR archives with native path separators')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
