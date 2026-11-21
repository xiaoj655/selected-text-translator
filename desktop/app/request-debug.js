const kinds = {
  translation: 'Translation',
  guidance: 'Guided Reading',
  tutor: 'English Coach',
  'provider-models': 'Connection test',
  'cloud-speech': 'Cloud speech',
}
const outcomes = {
  pending: 'Awaiting response',
  error: 'Request failed',
  aborted: 'Canceled',
}
const clock = new Intl.DateTimeFormat('en', { timeStyle: 'medium' })

function resultLabel(entry) {
  return entry.status == null ? (outcomes[entry.outcome] || 'Responded') : `HTTP ${entry.status}`
}

function copyableRequest(entry) {
  if (entry.body == null || entry.truncated) return entry
  try {
    return { ...entry, body: JSON.parse(entry.body) }
  } catch {
    return entry
  }
}

export function bindRequestDebug({ api, copyText, prepareOpen }) {
  const $ = (id) => document.getElementById(id)
  const dialog = $('request-debug')
  const toggle = $('debug-enabled')
  const clear = $('debug-clear')
  const copy = $('debug-copy')
  const list = $('debug-list')
  const empty = $('debug-empty')
  const feedback = $('debug-feedback')
  const more = $('btn-more')
  const rows = new Map()
  let snapshot = null
  let selectedId = null
  let revision = 0
  let changing = false

  function applySnapshot(result) {
    snapshot = result
    more.toggleAttribute('data-recording-requests', result.enabled)
    if (result.enabled) more.setAttribute('aria-description', 'Recording requests')
    else more.removeAttribute('aria-description')
  }

  function select(entry) {
    $('debug-meta').textContent = [
      kinds[entry.kind] || entry.kind,
      resultLabel(entry),
      entry.durationMs == null ? '' : `${entry.durationMs} ms`,
      clock.format(entry.timestamp),
    ].filter(Boolean).join(' · ')
    $('debug-url').textContent = `${entry.method} ${entry.url}`
    $('debug-headers').textContent = Object.entries(entry.headers)
      .map(([name, value]) => `${name}: ${value}`).join('\n') || 'No headers'
    const body = copyableRequest(entry).body
    const bodyText = body == null ? 'No request body' : typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    if ($('debug-body').textContent !== bodyText) $('debug-body').textContent = bodyText
    $('debug-truncated').hidden = !entry.truncated
  }

  function render() {
    const entries = snapshot?.entries || []
    const selected = entries.find(({ id }) => id === selectedId) || entries[0]
    selectedId = selected?.id ?? null
    if (!changing) toggle.checked = Boolean(snapshot?.enabled)
    toggle.disabled = !snapshot || changing
    clear.disabled = !entries.length || changing
    copy.disabled = !selected || changing
    $('debug-content').hidden = !selected
    empty.hidden = Boolean(selected)
    empty.textContent = snapshot?.enabled
      ? 'No requests yet. Close this panel and translate, practice, or test a connection.'
      : 'Turn on request recording to see calls to your model provider.'

    const present = new Set(entries.map(({ id }) => id))
    for (const [id, row] of rows) {
      if (present.has(id)) continue
      row.remove()
      rows.delete(id)
    }
    entries.forEach((entry, index) => {
      let row = rows.get(entry.id)
      if (!row) {
        row = document.createElement('button')
        row.type = 'button'
        row.className = 'debug-row'
        const name = document.createElement('span')
        name.textContent = `${kinds[entry.kind] || entry.kind} · ${entry.method}`
        row.append(name, document.createElement('small'))
        row.addEventListener('click', () => {
          selectedId = entry.id
          feedback.textContent = ''
          render()
        })
        rows.set(entry.id, row)
      }
      row.setAttribute('aria-pressed', String(entry.id === selectedId))
      const meta = `${clock.format(entry.timestamp)} · ${resultLabel(entry)}`
      if (row.lastElementChild.textContent !== meta) row.lastElementChild.textContent = meta
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null)
    })
    if (selected) select(selected)
    else {
      for (const id of ['debug-meta', 'debug-url', 'debug-headers', 'debug-body']) $(id).textContent = ''
    }
  }

  async function refresh() {
    if (!dialog.open || changing) return
    const current = ++revision
    try {
      const result = await api.getState()
      if (current !== revision || !dialog.open) return
      applySnapshot(result)
      render()
    } catch {
      if (current !== revision || !dialog.open) return
      feedback.textContent = 'Could not read the request log.'
    }
  }

  async function change(operation, message) {
    if (changing) return
    changing = true
    ++revision
    render()
    try {
      applySnapshot(await operation())
      if (dialog.open) feedback.textContent = message
    } catch {
      if (dialog.open) feedback.textContent = 'Could not update the request log. Try again.'
    } finally {
      changing = false
      if (dialog.open) {
        render()
        void refresh()
      } else snapshot = null
    }
  }

  $('open-debug').addEventListener('click', () => {
    prepareOpen()
    empty.textContent = 'Loading requests…'
    dialog.showModal()
    void refresh()
  })
  dialog.addEventListener('close', () => {
    snapshot = null
    selectedId = null
    ++revision
    feedback.textContent = ''
    $('debug-headers').closest('details').open = false
    render()
  })
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked
    void change(() => api.setEnabled(enabled), enabled ? 'Recording requests.' : 'Recording is off. The request log was cleared.')
  })
  clear.addEventListener('click', () => void change(() => api.clear(), 'Request log cleared.'))
  copy.addEventListener('click', async () => {
    const entry = snapshot?.entries.find(({ id }) => id === selectedId)
    if (!entry) return
    try {
      const copied = await copyText(JSON.stringify(copyableRequest(entry), null, 2))
      if (dialog.open) feedback.textContent = copied === false ? 'Could not copy the request.' : 'Request copied.'
    } catch {
      if (dialog.open) feedback.textContent = 'Could not copy the request.'
    }
  })
  api.onChanged(() => void refresh())
}
