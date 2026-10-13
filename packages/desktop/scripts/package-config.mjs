import { join } from 'node:path'

export const PRODUCT_NAME = 'DSH SSH Desktop'
export const MAC_APP_ID = 'io.github.rcell233.dsh-ssh-desktop'
export const MINIMUM_MACOS = '13.0.0'

export const HELP = `Build DSH SSH Desktop (run through pnpm).

  pnpm package:mac                         Native Mac architecture, DMG + ZIP
  pnpm package:mac --arch all              Apple Silicon + Intel, separate files
  pnpm package:mac --arch arm64 --signed   Developer ID signing + notarization
  pnpm package:win                         Windows x64 NSIS installer

Options: --mac | --win, --arch arm64 | x64 | all, --dir, --signed, --help
macOS builds require a Mac. Default Mac builds use ad-hoc signing, without
Apple notarization. --signed requires a Developer ID Application certificate
in the keychain (or CSC_LINK/CSC_KEY_PASSWORD) and Apple notarization credentials.
Choose one complete notarization credential group:
  APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
  APPLE_KEYCHAIN_PROFILE (optionally APPLE_KEYCHAIN)
Use CSC_NAME to select a specific Developer ID Application identity.
Output: dist/installer/
`

/** Pure argument parsing, also exercised on hosts that cannot build macOS. */
export function parseBuildArgs(args, host = { platform: process.platform, arch: process.arch }) {
  let platform
  let architecture
  let dir = false
  let signed = false
  let help = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') continue
    if (arg === '--mac' || arg === '--win') {
      const next = arg === '--mac' ? 'darwin' : 'win32'
      if (platform && platform !== next) throw new Error('Choose either --mac or --win per build.')
      platform = next
    } else if (arg === '--arch' || arg.startsWith('--arch=')) {
      const next = arg === '--arch' ? args[++i] : arg.slice(7)
      if (!['arm64', 'x64', 'all'].includes(next)) throw new Error('--arch must be arm64, x64, or all.')
      if (architecture && architecture !== next) throw new Error('Specify --arch only once.')
      architecture = next
    } else if (arg === '--dir') dir = true
    else if (arg === '--signed') signed = true
    else if (arg === '--help' || arg === '-h') help = true
    else throw new Error(`Unknown build option: ${arg}`)
  }
  if (help) return { help: true }
  platform ??= host.platform
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Choose --mac or --win; Linux installers are not supported.')
  architecture ??= platform === 'darwin' ? (host.platform === 'darwin' ? host.arch : 'arm64') : 'x64'
  if (platform === 'win32' && architecture !== 'x64') throw new Error('Windows packaging currently supports --arch x64 only.')
  if (platform !== 'darwin' && signed) throw new Error('--signed configures macOS Developer ID signing only.')
  const architectures = architecture === 'all' ? ['arm64', 'x64'] : [architecture]
  if (architectures.some((arch) => !['arm64', 'x64'].includes(arch))) throw new Error('Only arm64 and x64 architectures are supported.')
  return { help: false, platform, architectures, dir, signed }
}

export function assertBuildHost(options, hostPlatform = process.platform) {
  if (options.platform === 'darwin' && hostPlatform !== 'darwin') {
    throw new Error('Build macOS packages on a Mac or the macOS GitHub Actions runners; Linux/Windows cannot sign and validate them.')
  }
}

/** Fail before packaging instead of silently producing an unnotarized release. */
export function macSigningOptions(signed, env = process.env) {
  if (!signed) return { identity: '-', hardenedRuntime: false, notarize: false }
  // Match electron-builder's credential precedence so a partial higher-priority
  // group cannot defer the error until the end of a long packaging run.
  const groups = [
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    ['APPLE_KEYCHAIN_PROFILE'],
  ]
  const configured = groups.find((names) => names.some((name) => name !== 'APPLE_TEAM_ID' && env[name]))
  if (!configured || !configured.every((name) => typeof env[name] === 'string' && env[name].trim())) throw new Error('--signed needs complete Apple notarization credentials: APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE (optionally APPLE_KEYCHAIN).')
  if (env.CSC_NAME?.trim() === '-') throw new Error('--signed needs a Developer ID Application certificate, not the ad-hoc identity "-".')
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' && !env.CSC_NAME?.trim()) {
    throw new Error('--signed needs CSC_NAME when CSC_IDENTITY_AUTO_DISCOVERY is false.')
  }
  return { type: 'distribution', hardenedRuntime: true, notarize: true, forceCodeSigning: true }
}

/** Never reuse the host binary for a different target platform or architecture. */
export function localElectronDist(platform, arch, host, localDist) {
  return platform === host.platform && arch === host.arch ? localDist : undefined
}

export function resourcesDirectory(appOutDir, platform, productFilename = PRODUCT_NAME) {
  return platform === 'darwin'
    ? join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : join(appOutDir, 'resources')
}

export function createBuildConfig({ desktop, dist, pluginFile, pluginVersion, electronVersion, platform, signing }) {
  return {
    appId: platform === 'darwin' ? MAC_APP_ID : 'dsh-ssh-desktop',
    productName: PRODUCT_NAME,
    executableName: PRODUCT_NAME,
    copyright: PRODUCT_NAME,
    electronVersion,
    directories: { output: join(dist, 'installer'), buildResources: 'assets' },
    files: ['src/**/*', 'assets/**/*', '!assets/installer.nsh', 'node_modules/**/*', 'package.json', 'LICENSE', 'NOTICE'],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    extraResources: [
      { from: pluginFile, to: `dsh-desktop-link-${String(pluginVersion)}.tgz` },
      { from: join(desktop, 'assets', 'icon-256.png'), to: 'icon-256.png' },
    ],
    publish: null,
    mac: {
      icon: 'assets/icon.png',
      category: 'public.app-category.developer-tools',
      minimumSystemVersion: MINIMUM_MACOS,
      artifactName: 'DSH-SSH-Desktop-${version}-mac-${arch}.${ext}',
      darkModeSupport: true,
      ...signing,
    },
    win: {
      icon: 'assets/icon.ico',
      artifactName: 'DSH-SSH-Desktop-Setup-${version}-${arch}.${ext}',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      installerIcon: 'assets/icon.ico',
      uninstallerIcon: 'assets/icon.ico',
      include: 'assets/installer.nsh',
      installerLanguages: ['zh_CN'],
      language: '2052',
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
    },
  }
}
