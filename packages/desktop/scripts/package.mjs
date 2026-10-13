/** Stage the pnpm workspace as plain files, then build native desktop packages. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HELP, PRODUCT_NAME, assertBuildHost, createBuildConfig, localElectronDist,
  macSigningOptions, parseBuildArgs, resourcesDirectory,
} from './package-config.mjs'
import { ensureBuilderCache, verifyArchiveFiles } from './package-support.mjs'

const require = createRequire(import.meta.url)
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..', '..')
const dist = join(repo, 'dist')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

async function main() {
  const options = parseBuildArgs(process.argv.slice(2))
  if (options.help) return console.log(HELP)
  assertBuildHost(options)
  const signing = options.platform === 'darwin' ? macSigningOptions(options.signed) : undefined
  const manifest = readJson(join(desktop, 'package.json'))
  const core = join(repo, 'packages', 'core')
  const plugin = readJson(join(repo, 'packages', 'server-plugin', 'package.json'))
  process.env.ELECTRON_BUILDER_CACHE ??= join(repo, '.cache', 'electron-builder')
  ensureBuilderCache(process.env.ELECTRON_BUILDER_CACHE)
  // Work around Windows Low integrity workspaces, without changing Mac TMPDIR.
  if (process.platform === 'win32') {
    const temp = join(repo, '.cache', 'tmp')
    mkdirSync(temp, { recursive: true })
    process.env.TEMP = temp
    process.env.TMP = temp
  }

  const pnpm = process.env.npm_execpath
  if (!pnpm) throw new Error('Run packaging through pnpm: pnpm package:mac or pnpm package:win.')
  mkdirSync(dist, { recursive: true })
  const pluginFile = join(dist, `dsh-desktop-link-${String(plugin.version)}.tgz`)
  // Rebuild every time: the source can change without a plugin version bump.
  rmSync(pluginFile, { force: true })
  const packed = spawnSync(process.execPath, [pnpm, 'pack', '--pack-destination', dist], {
    cwd: join(repo, 'packages', 'server-plugin'), stdio: 'inherit',
  })
  if (packed.error || packed.status !== 0 || !existsSync(pluginFile)) throw new Error('Packing the server plugin failed.', { cause: packed.error })

  const electronPackage = dirname(require.resolve('electron/package.json'))
  const electronVersion = readJson(join(electronPackage, 'package.json')).version
  const runtime = join(electronPackage, 'dist')
  const localDist = existsSync(runtime) ? realpathSync(runtime) : undefined
  const { build, Platform, Arch } = require('electron-builder')
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const { extractFile } = appBuilderRequire('@electron/asar')
  const targetPlatform = options.platform === 'darwin' ? Platform.MAC : Platform.WINDOWS
  const targetTypes = options.dir ? ['dir'] : options.platform === 'darwin' ? ['dmg', 'zip'] : ['nsis']
  const results = []

  for (const arch of options.architectures) {
    const stage = join(desktop, '.stage', `${options.platform}-${arch}`)
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    cpSync(join(desktop, 'src'), join(stage, 'src'), { recursive: true })
    mkdirSync(join(stage, 'assets'))
    for (const file of ['icon.ico', 'icon.png', 'icon-256.png', 'installer.nsh', 'trayTemplate.png', 'trayTemplate@2x.png']) {
      cpSync(join(desktop, 'assets', file), join(stage, 'assets', file))
    }
    for (const file of ['LICENSE', 'NOTICE']) cpSync(join(repo, file), join(stage, file))
    const coreTarget = join(stage, 'node_modules', '@dsh-ssh', 'core')
    mkdirSync(coreTarget, { recursive: true })
    cpSync(join(core, 'lib'), join(coreTarget, 'lib'), { recursive: true })
    cpSync(join(core, 'package.json'), join(coreTarget, 'package.json'))
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
      name: manifest.name, productName: PRODUCT_NAME, version: manifest.version,
      description: manifest.description, type: 'module', main: manifest.main,
      license: manifest.license, author: PRODUCT_NAME,
      dependencies: { '@dsh-ssh/core': readJson(join(core, 'package.json')).version },
      // The stage has real files, not pnpm symlinks: do not ask pnpm to list it.
      packageManager: 'traversal@1.0.0',
    }, null, 2)}\n`)

    const config = createBuildConfig({
      desktop, dist, pluginFile, pluginVersion: plugin.version,
      electronVersion, platform: options.platform, signing,
    })
    const electronDist = localElectronDist(options.platform, arch, process, localDist)
    if (electronDist) config.electronDist = electronDist
    config.afterPack = async (context) => {
      const resources = resourcesDirectory(context.appOutDir, context.electronPlatformName, context.packager.appInfo.productFilename)
      rmSync(join(resources, 'default_app.asar'), { force: true })
      // Check the actual archive, including the manually staged core dependency.
      verifyArchiveFiles(join(resources, 'app.asar'), [
        manifest.main, 'node_modules/@dsh-ssh/core/lib/index.js',
        'assets/trayTemplate.png', 'assets/trayTemplate@2x.png', 'LICENSE', 'NOTICE',
      ], extractFile)
      if (!readFileSync(join(resources, `dsh-desktop-link-${String(plugin.version)}.tgz`)).equals(readFileSync(pluginFile))) {
        throw new Error('Packaged server plugin does not match the freshly built tarball.')
      }
    }
    results.push(...await build({ targets: targetPlatform.createTarget(targetTypes, Arch[arch]), projectDir: stage, config, publish: 'never' }))
  }
  console.log('\nbuilt:')
  for (const file of results) console.log(`  ${file}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
