export function shouldShowMainWindow(payload, floatingCardDisabled) {
  return Boolean(floatingCardDisabled) || !String(payload?.text || '').trim()
}
