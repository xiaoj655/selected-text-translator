export const MASTERY_INTERVAL_DAYS = 7

export function getStudyProgress(entries, now = Date.now()) {
  const progress = { due: 0, learning: 0, mastered: 0, total: 0 }
  if (!Array.isArray(entries)) return progress
  const timestamp = Number.isFinite(now) ? now : Date.now()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    progress.total++
    if (Number.isFinite(entry.dueAt) && entry.dueAt <= timestamp) progress.due++
    else if (Number.isFinite(entry.intervalDays) && entry.intervalDays >= MASTERY_INTERVAL_DAYS) progress.mastered++
    else progress.learning++
  }
  return progress
}

export function formatStudyProgress(progress) {
  const value = progress || getStudyProgress([])
  return `今日待复习 ${value.due} · 学习中 ${value.learning} · 已掌握 ${value.mastered}`
}

export function buildReviewReminder(progress) {
  const due = Number(progress?.due) || 0
  if (due <= 0) return null
  return { due, text: `今天有 ${due} 条表达等待复习 · 趁热打铁记得更牢` }
}

export function getDayKey(now = Date.now()) {
  const date = Number.isFinite(now) ? new Date(now) : new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function shouldShowReviewReminder(lastDate, now = Date.now()) {
  return getDayKey(now) !== lastDate
}
