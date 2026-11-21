const REPOSITORY = 'xiaoj655/selected-text-translator'
const RELEASE_TAG = /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
const compareVersions = new Intl.Collator('en', { numeric: true }).compare

export async function fetchReleasePage(fetch, page) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`)
  const releases = await response.json()
  if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list.')
  return { releases, hasNext: /;\s*rel="next"/.test(response.headers.get('link') || '') }
}

export async function findDesktopUpdate(fetchPage) {
  let latest = null
  for (let page = 1; ; page += 1) {
    const { releases, hasNext } = await fetchPage(page)
    for (const release of releases) {
      const version = RELEASE_TAG.exec(release?.tag_name)?.[1]
      if (!version || release.draft || release.prerelease) continue
      if (latest && compareVersions(version, latest.version) <= 0) continue
      if (!release.assets?.some((asset) => asset.name === 'latest.yml' && asset.state === 'uploaded')) continue
      latest = { version, url: `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}` }
    }
    if (!hasNext) return latest
  }
}

export function createDesktopUpdater({ updater, findRelease, sendState, logger = () => {} }) {
  let state = { status: 'idle' }

  function transition(next) {
    state = next
    sendState(state)
  }

  function fail(error) {
    logger('update-failed', error)
    transition({ status: 'error' })
  }

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.disableWebInstaller = true
  updater.on('error', (error) => {
    if (state.status === 'installing') fail(error)
  })
  updater.on('download-progress', ({ percent }) => {
    if (state.status !== 'downloading' || !Number.isFinite(percent)) return
    const rounded = Math.max(0, Math.min(100, Math.floor(percent)))
    if (rounded !== state.percent) transition({ ...state, percent: rounded })
  })

  async function check() {
    if (['checking', 'downloading', 'ready', 'installing'].includes(state.status)) return state
    transition({ status: 'checking' })
    try {
      const release = await findRelease()
      if (release) updater.setFeedURL({ provider: 'generic', url: release.url, useMultipleRangeRequest: false })
      const result = release && await updater.checkForUpdates()
      if (!result?.isUpdateAvailable) {
        transition({ status: 'up-to-date' })
        return state
      }
      if (result.updateInfo?.version !== release.version) throw new Error('Update version does not match release tag.')
      transition({ status: 'downloading', version: release.version })
      const files = await updater.downloadUpdate()
      if (!files.length) throw new Error('No update installer was downloaded.')
      transition({ status: 'ready', version: release.version })
    } catch (error) {
      fail(error)
    }
    return state
  }

  function install() {
    if (state.status !== 'ready') return state
    transition({ ...state, status: 'installing' })
    try {
      updater.quitAndInstall(true, true)
    } catch (error) {
      fail(error)
    }
    return state
  }

  return { getState: () => state, check, install }
}
