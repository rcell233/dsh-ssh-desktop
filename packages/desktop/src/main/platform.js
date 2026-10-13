/** Native window choices shared with platform regression tests. */
export function windowChrome(platform, dark) {
  if (platform === 'darwin') {
    // The OS owns the title bar and traffic lights, outside the web contents.
    return { titleBarStyle: 'default', backgroundColor: dark ? '#1b1b1c' : '#f9fafb' }
  }
  return {
    backgroundColor: '#00000000',
    ...(platform === 'win32' ? { backgroundMaterial: 'acrylic' } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#f9fafb' : '#0f1115', height: 40 },
  }
}

/** Mac can always reopen through its Dock, even if the menu-bar icon failed. */
export function hideOnClose(platform, { quitting, smoke, hasTray }) {
  return !quitting && !smoke && (platform === 'darwin' || hasTray)
}

export function notificationHelp(platform, dev) {
  if (platform === 'darwin') {
    return '请在「系统设置 → 通知」中允许本应用通知，并检查专注模式。macOS 通知事件需要应用签名；请使用已签名的应用包验证。'
  }
  if (platform === 'win32') {
    return `请在「设置 → 系统 → 通知」里确认通知已打开、没有开启勿扰，并允许「DSH SSH Desktop${dev ? ' (dev)' : ''}」发送通知。`
  }
  return '请检查桌面环境的通知服务、应用通知权限和勿扰设置。'
}
