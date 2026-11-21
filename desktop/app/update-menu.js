const UPDATE_LABELS = {
  idle: '检查更新',
  checking: '正在检查更新…',
  'up-to-date': '检查更新',
  downloading: '正在下载更新…',
  ready: '重启并更新',
  installing: '正在重启…',
  error: '重试更新',
}

const BUSY_STATES = new Set(['checking', 'downloading', 'installing'])

function detailText({ status, version, percent }) {
  if (status === 'up-to-date') return '已是最新版'
  if (status === 'error') return '更新失败'
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
      triggerEl.setAttribute('aria-label', isReady ? '更多操作，有更新可安装' : '更多操作')
      triggerEl.title = isReady ? '更多 · 有更新可安装' : '更多'
    }
    if (status === previous || isBusy) return
    if (shouldAnnounce && isReady) {
      announce(version ? `更新 v${version} 已下载，可以重启安装。` : '更新已下载，可以重启安装。')
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
      const message = '保存草稿或学习记录失败，请重试更新。'
      onSaveError(message)
      announce(message)
      return
    }
    await syncStatus(api.installUpdate, { status: 'error' })
  })
}
