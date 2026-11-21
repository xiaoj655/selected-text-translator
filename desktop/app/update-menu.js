const UPDATE_LABELS = {
  idle: 'Check for updates',
  checking: 'Checking for updates…',
  'up-to-date': 'Check for updates',
  downloading: 'Downloading update…',
  ready: 'Restart and update',
  installing: 'Restarting…',
  error: 'Retry update',
}

const BUSY_STATES = new Set(['checking', 'downloading', 'installing'])

function detailText({ status, version, percent }) {
  if (status === 'up-to-date') return 'Up to date'
  if (status === 'error') return 'Update failed'
  if (status === 'ready' && version) return `v${version}`
  if (status === 'downloading' && Number.isFinite(percent)) {
    return `${Math.floor(Math.min(100, Math.max(0, percent)))}%`
  }
  return ''
}

export function bindUpdateMenu({ api, announce, beforeInstall, onSaveError }) {
  const triggerEl = document.getElementById('btn-more')
  const buttonEl = document.getElementById('btn-update')
  const labelEl = document.getElementById('update-action')
  const detailEl = document.getElementById('update-detail')
  let state = { status: 'unsupported' }
  let updateRevision = 0
  let isUserAction = false

  function render(next, shouldAnnounce = true) {
    if (!next?.status) return
    const previous = state.status
    state = next
    const { status, version } = state
    const isReady = status === 'ready'
    const isBusy = BUSY_STATES.has(status)
    const label = UPDATE_LABELS[status]
    const hasFocus = document.activeElement === buttonEl
    buttonEl.hidden = !label
    if (buttonEl.hidden && hasFocus) triggerEl.focus()
    if (labelEl.textContent !== label) labelEl.textContent = label || ''
    const detail = detailText(state)
    if (detailEl.textContent !== detail) detailEl.textContent = detail
    buttonEl.setAttribute('aria-disabled', String(isBusy))
    if (isReady !== (previous === 'ready')) {
      triggerEl.classList.toggle('has-update', isReady)
      triggerEl.setAttribute('aria-label', isReady ? 'More actions, update available' : 'More actions')
      triggerEl.title = isReady ? 'More actions · Update available' : 'More actions'
    }
    if (status === previous || isBusy) return
    if (shouldAnnounce && isReady) {
      announce(version ? `Update v${version} is ready. Restart to install it.` : 'Update ready. Restart to install it.')
    }
    if (shouldAnnounce && isUserAction && detail && !isReady) announce(detail)
    isUserAction = false
  }

  async function syncStatus(command, fallback) {
    const revision = updateRevision
    try {
      const next = await command()
      if (revision === updateRevision) render(next)
    } catch {
      if (revision === updateRevision && fallback) render(fallback)
    }
  }

  api.onUpdateState((next) => {
    updateRevision += 1
    render(next)
  })
  void syncStatus(api.getUpdateStatus)
  buttonEl.addEventListener('click', async () => {
    if (buttonEl.hidden || BUSY_STATES.has(state.status)) return
    isUserAction = true
    if (state.status !== 'ready') {
      render({ status: 'checking' })
      await syncStatus(api.checkForUpdates, { status: 'error' })
      return
    }

    const ready = state
    render({ status: 'installing' })
    try {
      await beforeInstall()
    } catch {
      render(ready, false)
      const message = 'Could not save your draft or study history. Try updating again.'
      onSaveError(message)
      announce(message)
      return
    }
    await syncStatus(api.installUpdate, { status: 'error' })
  })
}
