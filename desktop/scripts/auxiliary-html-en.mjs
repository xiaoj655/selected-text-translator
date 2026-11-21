// These pages are shared with the extension. Localize only the desktop copy.
const settings = {
  '直接翻译': 'Translate',
  '英文引导 · 逐层提示': 'Guided Reading',
  '朗读音色': 'Voice',
  '自动选择': 'Automatic',
  '语速': 'Playback speed',
  '慢速': 'Slow',
  '舒缓': 'Relaxed',
  '正常': 'Normal',
  '稍快': 'Fast',
  '连接模型': 'Model connection',
  'API 地址': 'API URL',
  'API Key': 'API key',
  '检测连接并获取模型': 'Test connection and load models',
  '翻译模型': 'Translation model',
  '学习模型': 'Learning model',
  '保存设置': 'Save settings',
}

const copyByPage = {
  'popup.html': {
    ...settings,
    'Selected · 阅读助手': 'Selected · Reading Assistant',
    '读懂一个词，也读懂它所在的世界。': 'Understand new words in context.',
    '阅读偏好': 'Reading preferences',
    '划词后的默认模式': 'Default mode for selected text',
    '也可以在阅读卡片中切换，自动记住选择。': 'Switch modes on a reading card and your choice will be remembered.',
    '试听声音': 'Preview voice',
    '仅用于你选择的服务': 'For your chosen provider',
    '音标与英文引导使用': 'For phonetics and Guided Reading',
    '填写可用的通用模型名称': 'Enter a general-purpose model name',
    '与翻译共用 API 地址和密钥。翻译模型为通用模型时可留空。': 'Uses the same API URL and key as translation. Leave blank if your translation model is general-purpose.',
    '当前网页': 'Current page',
    '读取中': 'Loading',
    '在此页停用': 'Disable on this page',
    '此页及子路径停用': 'Disable here and on subpages',
    '重新启用': 'Enable again',
    '我的表达本 · 到期复习': 'Vocabulary &amp; review',
    'Alt + Shift + E 打开选区': 'Alt + Shift + E to open selected text',
    '全部设置': 'All settings',
  },
  'options.html': {
    ...settings,
    'Selected · 设置': 'Selected · Settings',
    '让阅读，按你的节奏。': 'Reading settings',
    '快速读懂，或多想一步。把翻译、声音和英文提示调成你喜欢的样子。': 'Choose how you translate, listen, and get hints as you read.',
    '可用的通用模型名称': 'General-purpose model name',
    '用于音标与英文引导，共用 API 地址和密钥。翻译使用通用模型时可留空；qwen-mt 需要另外填写。': 'Phonetics and Guided Reading use the same API URL and key. Leave blank if your translation model is general-purpose. If you use qwen-mt, enter a separate learning model.',
    '阅读与声音': 'Reading and speech',
    '默认模式': 'Default mode',
    '引导模式先给英文线索，点击后才揭晓答案。': 'Guided Reading gives you English clues before you reveal the answer.',
    '试听': 'Preview voice',
    '声音由系统或已安装的语音引擎提供。网络音色会标注「在线」。': 'Voices come from your system or installed speech engines. Network voices are marked Online.',
    '划词 → 悬停或点击 → 开始阅读': 'Select text, then hover or click to start reading.',
    '调试日志': 'Debug logging',
    '启用调试日志': 'Enable debug logging',
    '关闭日志': 'Turn off logging',
    '默认关闭。开启后只记录请求状态与长度，不记录选区正文。': 'When enabled, logs record only the request status and length. Selected text is excluded.',
    '停用的网站与路径': 'Disabled sites and paths',
    '在这些地址及其子路径下隐藏阅读入口。支持完整的 http / https 地址。': 'Hide reading tools at these addresses and their subpaths. Enter a full HTTP or HTTPS URL.',
    '要停用的地址': 'URL to disable',
    '添加当前网页': 'Add current page',
    '添加': 'Add',
    '我的表达本与复习': 'Vocabulary &amp; review',
  },
  'library.html': {
    'Selected · 我的表达本': 'Selected · Vocabulary',
    'Selected 设置': 'Selected. Settings',
    '导入备份': 'Import backup',
    '导出 Anki': 'Export to Anki',
    '导出备份': 'Export backup',
    '选择表达本备份': 'Choose a vocabulary backup',
    '把遇见，变成记得。': 'Vocabulary',
    '收藏阅读中遇到的词与表达，带着原来的语境，再认识一次。': 'Review the words and expressions you saved while reading, with their original context.',
    '学习进度': 'Study progress',
    '今日待复习': 'Due today',
    '学习中': 'Learning',
    '已掌握': 'Mastered',
    '今天有 <strong id="today-review-count">0</strong> 条表达等待复习': '<strong id="today-review-count">0</strong> to review today',
    '开始复习': 'Start review',
    '表达本视图': 'Vocabulary views',
    '全部收藏': 'All saved expressions',
    '到期复习': 'Due for review',
    '停止朗读': 'Stop audio',
    '撤销': 'Undo',
    '找一个词或一段语境': 'Search vocabulary',
    '搜索收藏的单词、表达或原句…': 'Search words, expressions, or source sentences…',
    '再看一些': 'Load more',
    '先想一想它在原句中的意思，再揭晓。不用输入，按你的真实感觉选择。': 'Think about what the expression means in context, then reveal the answer and rate how well you knew it.',
    '空格揭晓 · 揭晓后按 <kbd>1</kbd> 还不熟 / <kbd>2</kbd> 记住了': 'Space to reveal · Then press <kbd>1</kbd> for Still learning or <kbd>2</kbd> for Got it',
    '留在这台设备，随时可以导出。': 'Stored on this device. Export anytime.',
    '阅读设置': 'Reading settings',
  },
}

export function localizeAuxiliaryHtml(name, source) {
  let html = source.replace('lang="zh-CN"', 'lang="en"')
  // Replace longer phrases first so shared words cannot change a later match.
  const entries = Object.entries(copyByPage[name]).sort(([a], [b]) => b.length - a.length)
  for (const [original, translation] of entries) {
    html = html.replaceAll(original, translation)
  }
  return html
}

export const auxiliaryHtmlPages = Object.keys(copyByPage)
