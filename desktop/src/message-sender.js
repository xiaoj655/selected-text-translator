const READING_TRANSLATION_TYPES = new Set(['START_TRANSLATION', 'CANCEL_TRANSLATION'])

export function routeDesktopMessageSender(message, sender, isMainWindow = false) {
  if (message?.payload?.requestScope !== 'reading' || !READING_TRANSLATION_TYPES.has(message?.type)) {
    return sender
  }
  if (!isMainWindow || sender?.documentId !== 'main') {
    throw new Error('Open the main window to translate an article.')
  }
  // The shared background keeps one translation per window/frame. Reserve one
  // fixed slot for article lookups without exposing arbitrary frame routing.
  return { ...sender, frameId: 1 }
}
