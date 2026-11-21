export function isDesktopUI() {
  return Boolean(globalThis.sttDesktop || globalThis.chrome?.desktopUI)
}

export function uiText(chinese, english) {
  return isDesktopUI() ? english : chinese
}
