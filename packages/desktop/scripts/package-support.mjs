import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

/** Downloaded builder helpers are CommonJS even inside this ESM workspace. */
export function ensureBuilderCache(cache) {
  mkdirSync(cache, { recursive: true })
  const manifest = join(cache, 'package.json')
  try {
    writeFileSync(manifest, '{"private":true,"type":"commonjs"}\n', { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    // Respect existing metadata in a user-supplied ELECTRON_BUILDER_CACHE.
    if (JSON.parse(readFileSync(manifest, 'utf8')).type === 'module') {
      throw new Error(`Electron builder helpers require CommonJS. Choose a separate ELECTRON_BUILDER_CACHE; ${manifest} declares type: module.`)
    }
  }
}

/** @electron/asar's file lookup uses the host path separator, including Windows. */
export function verifyArchiveFiles(archive, files, extractFile) {
  for (const file of files) {
    if (extractFile(archive, normalize(file)).length === 0) throw new Error(`Empty packaged file: ${file}`)
  }
}
