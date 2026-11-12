export function matchesUrlPattern(url, pattern) {
  if (pattern.startsWith('=')) return url === pattern.slice(1)
  try {
    const current = new URL(url)
    const rule = new URL(pattern)
    if (current.origin !== rule.origin) return false
    if (rule.search && current.search !== rule.search) return false
    if (rule.hash && current.hash !== rule.hash) return false
    const path = rule.pathname.replace(/\/$/, '')
    return current.pathname === path || current.pathname.startsWith(`${path}/`)
  } catch {
    return false
  }
}
