/**
 * Preload for the remote window: the page bridge on every platform, and the
 * Windows caption outside macOS, as the official DSH
 * desktop draws it (upstream apps/desktop/src/preload-windows.ts and
 * preload-menu.ts).
 *
 *  - `html[data-windows-titlebar]` plus `--dsh-windows-titlebar-height` make the
 *    DSH web client reserve the caption row, mark it as the window drag region,
 *    and seat its sidebar toggle there (see upstream ui-layout / ui-sidebar).
 *  - The "应用 / 编辑" menubar sits at `--dsh-windows-menu-start`, which the
 *    client's sidebar publishes, and pops native menus through the main process.
 *  - The caption overlay is repainted with the page's sidebar colours.
 *
 * The page gets exactly one thing: `window.dshSshDesktop` (protocol 1), the
 * bridge remote plugins such as dsh-desktop-link call. It is a set of
 * `invoke`s; the main process decides whether to answer (caller and
 * arguments, see policy.js), so nothing here is trusted. The caption menubar
 * lives in a closed shadow root, and only trusted (user) input opens a menu.
 * On a page that is not the DSH client (a 401, an error) the preload supplies
 * its own drag strip so the window can still be moved and the menus reached.
 *
 * Sandboxed preloads must be CommonJS and self-contained.
 */
const { contextBridge, ipcRenderer } = require('electron')

// Top frame on the forward's address only; the main process re-checks the
// exact origin on every call. Named apart from the official desktop's
// `window.dshDesktop`, which the same web client reads as its own product API.
if (process.isMainFrame && location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  contextBridge.exposeInMainWorld('dshSshDesktop', {
    protocol: 1,
    capabilities: ['notify', 'setBadge', 'revealInEditor'],
    notify: (input) => ipcRenderer.invoke('dsh-bridge:notify', input).then(() => undefined),
    setBadge: (count) => ipcRenderer.invoke('dsh-bridge:setBadge', count).then(() => undefined),
    revealInEditor: (input) => ipcRenderer.invoke('dsh-bridge:revealInEditor', input).then(() => undefined),
  })
}

const TITLEBAR_HEIGHT = 40
const zh = String(navigator.language || '').toLowerCase().startsWith('zh')
const LABELS = zh
  ? { application: '应用', edit: '编辑', menuBar: '应用菜单' }
  : { application: 'Application', edit: 'Edit', menuBar: 'Application menu' }

function mark() {
  const root = document.documentElement
  if (root === null) return
  root.dataset.windowsTitlebar = ''
  root.style.setProperty('--dsh-windows-titlebar-height', `${String(TITLEBAR_HEIGHT)}px`)
}

// The root may not exist yet when the preload runs; mark it as early as
// possible so the client's first render already sees the caption.
// macOS has a native title bar and global application menu. The remote page
// still gets the validated bridge above, without Windows layout markers.
if (process.platform !== 'darwin') mark()

function install() {
  mark()
  const root = document.documentElement

  // ---------------------------------------------------------------- menubar
  const host = document.createElement('div')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; position: fixed; top: 0; left: var(--dsh-windows-menu-start, 48px); z-index: 2147483000;
      height: ${String(TITLEBAR_HEIGHT)}px; display: flex; align-items: center; -webkit-app-region: no-drag;
      font-family: var(--dsw-font-family, "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif); }
    :host([data-standalone]) { left: 12px; }
    [role=menubar] { display: flex; gap: 2px; -webkit-app-region: no-drag; }
    button { -webkit-app-region: no-drag; height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
      color: var(--dsw-alias-label-secondary, #61666b); font: inherit; font-size: 14px; cursor: default; }
    button:hover, button[aria-expanded=true] { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
      color: var(--dsw-alias-label-primary, #0f1115); }
    button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3b6cf6); outline-offset: -2px; }
  `
  const bar = document.createElement('div')
  bar.setAttribute('role', 'menubar')
  bar.setAttribute('aria-label', LABELS.menuBar)

  /** Re-focus the editor the user was in, so a menu command lands there. */
  let restoreEditor = () => {}
  const rememberEditor = (event) => {
    const target = event.composedPath()[0]
    if (!(target instanceof HTMLElement) || target === host) return
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)
      && !target.matches('[contenteditable="true"]')) return
    const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : undefined
    const start = input?.selectionStart
    const end = input?.selectionEnd
    const selection = document.getSelection()
    const ranges = selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    restoreEditor = () => {
      if (!target.isConnected) return
      target.focus({ preventScroll: true })
      if (input !== undefined && start != null && end != null) input.setSelectionRange(start, end)
      else if (selection !== null && ranges.length > 0) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    }
  }
  document.addEventListener('focusout', rememberEditor, true)

  const buttons = []
  const createButton = (name, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = LABELS[name]
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.tabIndex = index === 0 ? 0 : -1
    // Keep focus (and the selection) in the page's editor.
    button.addEventListener('pointerdown', (event) => { event.preventDefault() })
    button.addEventListener('mousedown', (event) => { event.preventDefault() })
    const open = async () => {
      if (button.getAttribute('aria-expanded') === 'true') return
      const rect = button.getBoundingClientRect()
      button.setAttribute('aria-expanded', 'true')
      restoreEditor()
      try { await ipcRenderer.invoke('dsh-remote:menu', name, rect.left, rect.bottom) }
      catch { /* the main process refused or the window is closing */ }
      finally { button.setAttribute('aria-expanded', 'false') }
    }
    button.addEventListener('click', (event) => { if (event.isTrusted) void open() })
    button.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const next = buttons[index === 0 ? 1 : 0]
        button.tabIndex = -1
        next.tabIndex = 0
        next.focus()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        void open()
      }
    })
    bar.append(button)
    buttons.push(button)
  }
  createButton('application', 0)
  createButton('edit', 1)
  shadow.append(style, bar)

  // ------------------------------------------------- standalone caption strip
  // A page without the DSH shell (a 401 or error page) has no drag region and
  // no room under the native caption buttons; supply both until the shell shows.
  const strip = document.createElement('div')
  strip.style.cssText = `position:fixed;top:0;left:0;right:0;height:${String(TITLEBAR_HEIGHT)}px;` +
    '-webkit-app-region:drag;z-index:2147482999;background:transparent;pointer-events:none'
  let standalone = false
  const setStandalone = (value) => {
    if (value === standalone) return
    standalone = value
    host.toggleAttribute('data-standalone', value)
    if (value) {
      document.body.prepend(strip)
      document.body.style.paddingTop = `${String(TITLEBAR_HEIGHT)}px`
    } else {
      strip.remove()
      document.body.style.removeProperty('padding-top')
    }
  }

  document.body.append(host)
  const hasShell = () => document.querySelector('[data-shell-overlay]') !== null
  // The client renders asynchronously; give it a moment before deciding the
  // page is not the DSH shell.
  const shellTimer = setTimeout(() => { if (!hasShell()) setStandalone(true) }, 1500)
  const shellObserver = new MutationObserver(() => {
    if (hasShell()) {
      clearTimeout(shellTimer)
      setStandalone(false)
    }
  })
  shellObserver.observe(document.body, { childList: true, subtree: true })

  // ------------------------------------------------------ caption appearance
  const probe = document.createElement('span')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
    'background-color:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)'
  document.body.append(probe)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  /** Resolve any CSS colour to `rgba(r, g, b, a)` by painting one pixel. */
  const nativeColor = (color) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = 'rgba(0,0,0,0)'
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(Math.round((a / 255) * 100) / 100)})`
  }
  let previous = ''
  const transparent = (rgba) => rgba.endsWith(', 0)')
  const sendAppearance = () => {
    if (context === null) return
    const computed = getComputedStyle(probe)
    let color = nativeColor(computed.backgroundColor)
    let symbolColor = nativeColor(computed.color)
    if (transparent(color)) {
      // No DSH palette (a plain page): match the page itself, which Chromium
      // paints white when it declares no background.
      const page = getComputedStyle(document.body)
      const background = nativeColor(page.backgroundColor)
      color = transparent(background) ? 'rgba(255, 255, 255, 1)' : background
      symbolColor = nativeColor(page.color)
    }
    const current = `${color}|${symbolColor}`
    if (current === previous) return
    previous = current
    ipcRenderer.send('dsh-remote:appearance', color, symbolColor)
  }
  const appearanceObserver = new MutationObserver(sendAppearance)
  appearanceObserver.observe(root, { attributes: true, attributeFilter: ['lang', 'class', 'style', 'data-ds-theme-source'] })
  appearanceObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style', 'class'] })
  appearanceObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
  document.head.addEventListener('load', sendAppearance, true)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sendAppearance)
  sendAppearance()

  window.addEventListener('pagehide', () => {
    clearTimeout(shellTimer)
    shellObserver.disconnect()
    appearanceObserver.disconnect()
    document.removeEventListener('focusout', rememberEditor, true)
    document.head.removeEventListener('load', sendAppearance, true)
    host.remove()
    strip.remove()
    probe.remove()
  }, { once: true })
}

if (process.platform !== 'darwin') {
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}
