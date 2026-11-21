import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createDesktopUpdater, fetchReleasePage, findDesktopUpdate } from '../desktop/src/update.js'

const RELEASE_URL = 'https://github.com/xiaoj655/selected-text-translator/releases/download/desktop-v0.9.64'
const RELEASE = { version: '0.9.64', url: RELEASE_URL }

function release(tag, fields = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [{ name: 'latest.yml', state: 'uploaded' }],
    ...fields,
  }
}

test('requests the public GitHub release list and follows a next-page link', async () => {
  const releases = [release('desktop-v0.9.64')]
  const result = await fetchReleasePage(async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/xiaoj655/selected-text-translator/releases?per_page=100&page=2')
    assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json' })
    assert.ok(options.signal instanceof AbortSignal)
    return Response.json(releases, {
      headers: {
        link: '<https://api.github.com/releases?page=1>; rel="prev", <https://api.github.com/releases?page=3>; rel="next"',
      },
    })
  }, 2)

  assert.deepEqual(result, { releases, hasNext: true })
})

test('reports GitHub HTTP errors instead of treating them as no available release', async () => {
  await assert.rejects(
    fetchReleasePage(async () => new Response(null, { status: 429 }), 1),
    /GitHub release lookup failed \(429\)/,
  )
})

test('finds the highest published desktop version with a Windows update manifest across pages', async () => {
  const pages = [
    [
      release('v99.0.0'),
      release('desktop-v9.1.0', { draft: true }),
      release('desktop-v9.0.0', { prerelease: true }),
      release('desktop-v9.0.0-rc.1'),
      release('desktop-v09.0.0'),
      release('desktop-v8.0.0', { assets: [{ name: 'latest-mac.yml', state: 'uploaded' }] }),
      release('desktop-v7.0.0', { assets: [{ name: 'latest.yml', state: 'open' }] }),
      release('desktop-v0.9.9'),
    ],
    [
      release('desktop-v0.9.10', {
        assets: [{
          name: 'latest.yml',
          state: 'uploaded',
          browser_download_url: 'https://example.test/latest.yml',
        }],
      }),
      release('desktop-v0.8.99'),
    ],
  ]
  const pageRequests = []
  const update = await findDesktopUpdate(async (page) => {
    pageRequests.push(page)
    return { releases: pages[page - 1], hasNext: page < pages.length }
  })

  assert.deepEqual(pageRequests, [1, 2])
  assert.deepEqual(update, {
    version: '0.9.10',
    url: 'https://github.com/xiaoj655/selected-text-translator/releases/download/desktop-v0.9.10',
  })
})

test('returns no update source when published releases contain no Windows manifest', async () => {
  const update = await findDesktopUpdate(async () => ({
    releases: [release('desktop-v0.9.62', { assets: [{ name: 'Setup.exe', state: 'uploaded' }] })],
    hasNext: false,
  }))

  assert.equal(update, null)
})

function setupUpdater({ findRelease = async () => RELEASE } = {}) {
  const states = []
  const calls = []
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: (options) => calls.push(['feed', options]),
    async checkForUpdates() {
      calls.push(['check'])
      return { isUpdateAvailable: true, updateInfo: { version: RELEASE.version } }
    },
    async downloadUpdate() {
      calls.push(['download'])
      updater.emit('download-progress', { percent: 42 })
      return ['setup.exe']
    },
    quitAndInstall: (...args) => calls.push(['install', ...args]),
  })
  const controller = createDesktopUpdater({
    updater,
    findRelease,
    sendState: (state) => states.push(state),
    logger: () => {},
  })
  return { updater, controller, states, calls }
}

test('downloads an available release and installs only on explicit request', async () => {
  const { updater, controller, states, calls } = setupUpdater()

  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.disableWebInstaller, true)
  assert.equal(controller.getState().status, 'idle')

  controller.install()
  await controller.check()

  assert.deepEqual(calls, [
    ['feed', { provider: 'generic', url: RELEASE_URL, useMultipleRangeRequest: false }],
    ['check'],
    ['download'],
  ])
  assert.ok(states.some(({ status }) => status === 'checking'))
  assert.ok(states.some(({ status, percent }) => status === 'downloading' && percent === 42))
  assert.equal(controller.getState().status, 'ready')
  assert.equal(controller.getState().version, RELEASE.version)

  controller.install()
  controller.install()
  assert.equal(controller.getState().status, 'installing')
  assert.deepEqual(calls.filter(([action]) => action === 'install'), [['install', true, true]])
})

test('checks a candidate once while the update download is in progress', async () => {
  const started = Promise.withResolvers()
  const completed = Promise.withResolvers()
  const { updater, controller, calls } = setupUpdater()
  updater.downloadUpdate = () => {
    calls.push(['download'])
    started.resolve()
    return completed.promise
  }

  const firstCheck = controller.check()
  await started.promise
  const duplicateCheck = controller.check()
  controller.install()
  assert.equal(controller.getState().status, 'downloading')

  completed.resolve(['setup.exe'])
  await Promise.all([firstCheck, duplicateCheck])
  assert.equal(controller.getState().status, 'ready')
  assert.deepEqual(calls.map(([action]) => action), ['feed', 'check', 'download'])
})

test('does not download when the running app is up to date', async () => {
  const { updater, controller, calls } = setupUpdater()
  updater.checkForUpdates = async () => ({ isUpdateAvailable: false })
  await controller.check()

  assert.equal(controller.getState().status, 'up-to-date')
  assert.equal(calls.some(([action]) => action === 'download'), false)
})

test('rejects update metadata for a version different from the selected release', async () => {
  const { updater, controller, calls } = setupUpdater()
  updater.checkForUpdates = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.9.65' },
  })

  await controller.check()
  controller.install()
  assert.equal(controller.getState().status, 'error')
  assert.equal(calls.some(([action]) => action === 'download' || action === 'install'), false)
})

test('allows a retry after the feed request fails', async () => {
  let attempts = 0
  const { controller } = setupUpdater({
    async findRelease() {
      attempts += 1
      if (attempts === 1) throw new Error('GitHub unavailable')
      return RELEASE
    },
  })

  await controller.check()
  assert.equal(controller.getState().status, 'error')
  await controller.check()
  assert.equal(controller.getState().status, 'ready')
})

test('reports an installer launch failure and allows a new update check', async () => {
  const { updater, controller } = setupUpdater()
  updater.quitAndInstall = () => updater.emit('error', new Error('Installer failed to start'))

  await controller.check()
  controller.install()
  assert.equal(controller.getState().status, 'error')

  await controller.check()
  assert.equal(controller.getState().status, 'ready')
})
