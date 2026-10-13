/**
 * Getting the user's attention: system notifications and the taskbar badge.
 *
 * Two sources feed it:
 *  - finished tasks from the server plugin's feed (see @dsh-ssh/core session
 *    `task` events), which notify only when the user is not already looking
 *    at that connection, and count as unseen until the window is focused;
 *  - the page bridge (`notify`, `setBadge`), for remote plugins.
 *
 * Windows has no numeric app badge (`app.setBadgeCount` is macOS/Linux), so
 * the count is drawn as a taskbar overlay icon: a red disc with a digit, or
 * "+" past nine. The window also flashes its taskbar button until focused.
 *
 * @module dsh-ssh-desktop/attention
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Notification, app, nativeImage } from 'electron'

import { taskNotification } from './policy.js'

/**
 * The app icon at a size toasts show well (scripts/make-icon.mjs). Windows
 * reads it from disk itself, so a packaged build points at the copy in
 * resources rather than into app.asar.
 */
const NOTIFICATION_ICON = typeof process.resourcesPath === 'string' && existsSync(join(process.resourcesPath, 'icon-256.png'))
  ? join(process.resourcesPath, 'icon-256.png')
  : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'icon-256.png')

/** 3×5 pixel digits, row-major, for the badge. */
const GLYPHS = {
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
}

/**
 * A 16×16 overlay: a red disc with the count in white.
 * @param {number} count 1..∞
 */
export function badgeBitmap(count) {
  const size = 16
  const scale = 2
  const glyph = GLYPHS[count > 9 ? '+' : count]
  const buffer = Buffer.alloc(size * size * 4)
  const left = (size - 3 * scale) / 2
  const top = (size - 5 * scale) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - size / 2
      const dy = y + 0.5 - size / 2
      const distance = Math.sqrt(dx * dx + dy * dy)
      // A soft edge: full inside radius 7, fading over the last pixel.
      const alpha = Math.max(0, Math.min(1, 8 - distance))
      if (alpha === 0) continue
      const gx = Math.floor((x - left) / scale)
      const gy = Math.floor((y - top) / scale)
      const ink = gx >= 0 && gx < 3 && gy >= 0 && gy < 5 && glyph[gy][gx] === '1'
      const offset = (y * size + x) * 4
      // BGRA, premultiplied.
      const [r, g, b] = ink ? [255, 255, 255] : [220, 38, 38]
      buffer[offset] = Math.round(b * alpha)
      buffer[offset + 1] = Math.round(g * alpha)
      buffer[offset + 2] = Math.round(r * alpha)
      buffer[offset + 3] = Math.round(255 * alpha)
    }
  }
  return buffer
}

export class Attention {
  /**
   * @param {object} options
   * @param {() => import('electron').BrowserWindow | undefined} options.window
   * @param {(connectionId: string) => boolean} options.isShowing  the user is looking at this connection now.
   * @param {(connectionId: string) => void} options.activate  bring this connection's view forward.
   * @param {(line: string) => void} [options.trace]
   * @param {(count: number) => void} [options.onCount]  the badge number changed (the tray shows it too).
   */
  constructor(options) {
    this.onCount = options.onCount
    this.window = options.window
    this.isShowing = options.isShowing
    this.activate = options.activate
    this.trace = options.trace ?? (() => {})
    /** Finished tasks the user has not seen, per connection. */
    /** @type {Map<string, number>} */
    this.unseen = new Map()
    /** What pages asked the badge to show, per connection. */
    /** @type {Map<string, number>} */
    this.pageBadges = new Map()
    /** Live notifications: without a reference their click handler can be collected. */
    /** @type {Set<Notification>} */
    this.shown = new Set()
    this.lastBadge = 0
  }

  /**
   * A task finished on a connection.
   * @param {string} connectionId
   * @param {string} connectionName
   * @param {{ title: string, outcome: 'completed' | 'error' | 'blocked' }} task
   */
  task(connectionId, connectionName, task) {
    this.trace(`task ${connectionId} ${task.outcome}`)
    if (this.isShowing(connectionId)) return
    this.unseen.set(connectionId, (this.unseen.get(connectionId) ?? 0) + 1)
    this.#show(connectionId, taskNotification(task, connectionName))
    this.#render()
    const win = this.window()
    if (win !== undefined && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
  }

  /**
   * A page asked for a notification (already validated and rate limited).
   * @param {string} connectionId
   * @param {string} connectionName
   * @param {{ title: string, body: string }} content
   */
  pageNotify(connectionId, connectionName, content) {
    this.#show(connectionId, { title: content.title, body: content.body === '' ? connectionName : `${content.body}\n${connectionName}` })
  }

  /**
   * A page set its badge (already validated).
   * @param {string} connectionId
   * @param {number} count
   */
  setPageBadge(connectionId, count) {
    if (count === 0) this.pageBadges.delete(connectionId)
    else this.pageBadges.set(connectionId, count)
    this.#render()
  }

  /** The user is looking at a connection: its finished tasks are seen. */
  seen(connectionId) {
    const win = this.window()
    if (win !== undefined && !win.isDestroyed()) win.flashFrame(false)
    if (this.unseen.delete(connectionId)) this.#render()
  }

  /** A connection went away: forget what it asked for. */
  forget(connectionId) {
    this.unseen.delete(connectionId)
    this.pageBadges.delete(connectionId)
    this.#render()
  }

  /** The number on the badge. */
  count() {
    let total = 0
    for (const n of this.unseen.values()) total += n
    for (const n of this.pageBadges.values()) total += n
    return total
  }

  /**
   * A sample notification, from the menu. Windows reports a refusal
   * asynchronously, through `onFailed`.
   * @param {string} connectionId
   * @param {string} connectionName
   * @param {(reason: string) => void} onFailed
   * @returns {'shown' | 'unsupported'}
   */
  test(connectionId, connectionName, onFailed) {
    if (!Notification.isSupported()) return 'unsupported'
    this.#show(connectionId, { title: `测试通知 · ${connectionName}`, body: '任务完成时，通知会像这样出现。' }, onFailed)
    return 'shown'
  }

  /**
   * @param {string} connectionId
   * @param {{ title: string, body: string }} content
   * @param {(reason: string) => void} [onFailed]
   */
  #show(connectionId, content, onFailed) {
    if (!Notification.isSupported()) {
      this.trace('notifications are not supported here')
      return
    }
    const notification = new Notification({ title: content.title, body: content.body, silent: false, ...(process.platform === 'darwin' ? {} : { icon: NOTIFICATION_ICON }) })
    this.shown.add(notification)
    const release = () => { this.shown.delete(notification) }
    notification.on('click', () => {
      release()
      this.activate(connectionId)
    })
    notification.on('close', release)
    notification.on('failed', (_event, error) => {
      release()
      this.trace(`notification failed: ${String(error)}`)
      process.stderr.write(`warning: a notification failed: ${String(error)}\n`)
      onFailed?.(String(error))
    })
    notification.show()
  }

  #render() {
    const win = this.window()
    const total = this.count()
    if (total === this.lastBadge) return
    this.lastBadge = total
    this.onCount?.(total)
    if (process.platform !== 'win32') {
      app.setBadgeCount(total)
      if (total === 0 && win !== undefined && !win.isDestroyed()) win.flashFrame(false)
      return
    }
    if (win === undefined || win.isDestroyed()) return
    if (total === 0) {
      win.setOverlayIcon(null, '')
      win.flashFrame(false)
      return
    }
    const image = nativeImage.createFromBitmap(badgeBitmap(total), { width: 16, height: 16 })
    win.setOverlayIcon(image, `${String(total)} 条未读`)
  }
}
