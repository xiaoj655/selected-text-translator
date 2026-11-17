process.env.STT_LIVE_SOURCE_LANG = 'zh'
process.env.STT_LIVE_SOURCE_TEXT = '早上好，我的朋友。你今天过得怎么样？我很高兴见到你。'
await import('./verify-live-languages.mjs')
