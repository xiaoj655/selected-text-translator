# 桌面版早期移植方案（历史）

> 本文保留早期设计，不代表当前功能。现在的主入口是翻译工作台和 English Coach；全局热键和悬浮取词暂停。请以[桌面版使用说明](../desktop/README.md)、[当前进度](desktop-progress.md)和[迭代路线](desktop-roadmap.md)为准。

早期目标是把本扩展改造成常驻桌面的划词/取词翻译工具:全局快捷键触发 → 取到当前选中文字 → 在置顶悬浮窗里复用现有翻译卡片。

本文件只描述方案,不改动任何现有代码。

## 1. 目标形态

- 菜单栏 / 系统托盘常驻,无主窗口。
- 全局快捷键(默认 `Alt+Shift+E`,可自定义)唤起。
- 在任何应用中选中文字后按快捷键,鼠标附近弹出置顶卡片:翻译 / 引导理解 / 朗读 / 收藏。
- 设置页、表达本、复习流程作为独立窗口复用。
- API Key 由用户自填,数据全部留在本机。

## 2. 关键结论

1. **业务逻辑可以直接搬。** `background.js` 的 `fetch` + `AbortController` + SSE 是标准 Web API;`translation-contracts.js`、`qwen-context.js`、`context-sentence.js`、`reading-support.js`、`result-cache.js`、`vocabulary-store.js` 是纯逻辑。
2. **UI 可以直接搬。** `content.js` 的卡片渲染、Shadow DOM、内联 CSS,以及 `popup/options/library.html` 都是标准网页。
3. **耦合点集中且可 shim。** 全仓库只用到下列 Chrome API(实测统计):

   | API | 次数 | 桌面映射 |
   | --- | --- | --- |
   | `chrome.storage.sync` | 16 | 主进程 `settings.json` |
   | `chrome.storage.local` | 2 | 主进程 `vocabulary.json` |
   | `chrome.storage.onChanged` | 8 | 主进程写后广播 |
   | `chrome.runtime.sendMessage` | 13 | `ipcRenderer.invoke` |
   | `chrome.runtime.onMessage` | 6 | `ipcRenderer.on` |
   | `chrome.runtime.lastError` | 15 | shim 中固定为 `undefined` |
   | `chrome.runtime.getURL` | 3 | 自定义协议 `app://` |
   | `chrome.runtime.openOptionsPage` | 2 | 打开设置窗口 |
   | `chrome.tabs.query` / `sendMessage` / `create` | 3 / 3 / 1 | 窗口 id / 窗口转发 / 打开窗口 |
   | `chrome.tts.speak` / `stop` / `getVoices` | 各 1 | 系统 TTS 适配层 |

   写一个约 200 行的 `window.chrome` 兼容层,比改 20 个源文件风险低得多,且阶段 0 在扩展仓库里就能做,对扩展行为零影响。

4. **推荐 Electron,而非 Tauri(至少第一阶段)。** 一个容易漏掉的点:扩展里 `fetch` 第三方 API 不受 CORS 限制(靠 `host_permissions`/service worker 权限)。Electron 主进程是 Node,`fetch` 同样无 CORS,`background.js` 原样可跑。Tauri 的前端是 WKWebView/WebView2,直接发请求会被 CORS 挡住,必须把请求和 SSE 流式解析整体迁到 Rust 侧(`reqwest`)再转发给前端,等于重写 `background.js` 的一半。Tauri 的体积优势(~10MB vs ~100MB)值得在第二阶段评估。
5. **最大的功能天花板是"取词 + 上下文",不是翻译。** 见第 5 节。

## 3. 架构

```
┌─ 原生层(每平台一份,尽量薄) ─────────────────────────┐
│ 全局热键 │ 取词(AX / UIA / 剪贴板) │ 托盘 │ 自启 │ 系统 TTS │
└───────────────────┬─────────────────────────────────┘
                    │ IPC(Electron main)
┌───────────────────▼─────────────────────────────────┐
│ 主进程                                                │
│  ├─ messageRouter(接管原 background.js 的 listener)  │
│  ├─ 原 background.js(翻译 / 缓存 / 请求,零改动)      │
│  ├─ 原 speech.js / vocabulary-messages.js(换适配层)  │
│  ├─ 存储:settings.json + vocabulary.json             │
│  └─ 窗口管理:card / settings / library               │
└───────────────────┬─────────────────────────────────┘
                    │ IPC + 广播
┌───────────────────▼─────────────────────────────────┐
│ 渲染进程(webview,注入 window.chrome shim)            │
│  ├─ 原 content.js(卡片 UI / 交互,少量改造)           │
│  ├─ 原 popup.js / options.js / library.js            │
│  └─ 原 HTML / CSS(全部保留)                          │
└──────────────────────────────────────────────────────┘
```

主进程与渲染进程都跑同一套 ESM 源码,通过 shim 消除运行时差异。

## 4. `chrome` shim 设计

### 4.1 渲染侧(`desktop/preload.js`)

- `storage.{sync,local}.get/set`:`ipcRenderer.invoke('storage:get', area, keys)`,返回 Promise;现有代码同时用了 `await` 和 `.catch()`,Promise 完全兼容。
- `storage.onChanged.addListener`:监听主进程 `storage:changed` 广播,补出 `{ oldValue, newValue }` 与 `areaName`,保持 8 处监听者的语义。
- `runtime.sendMessage(msg, cb)`:转成 `invoke('message', msg)`,成功/失败都必须调用回调;`lastError` 固定为 `undefined`。现有 15 处 `() => { void chrome.runtime.lastError }` 只是 Chrome 里「消费 lastError」的惯用法,shim 保证属性可读、回调必达即可。
- `runtime.onMessage.addListener`:桥接 `ipcRenderer.on('message', ...)`。`TRANSLATION_EVENT` 与 `SPEECH_EVENT` 是流式/异步推送,必须走这条"主进程 → 渲染进程"通道,不能用 `invoke` 的返回值代替。
- `runtime.getURL(path)`:映射到 `app://local/...`;现有 `speech.js` 与 `provider-diagnostics.js` 用它做来源校验,需保持字符串可比较。
- `runtime.openOptionsPage` / `tabs.create`:转成 `invoke('window:open', name)`。
- `tabs.query({active:true})`:返回当前悬浮窗的伪 tab id;`tabs.sendMessage(tabId, notification, {frameId})`:主进程转发给对应 webview。

### 4.2 主进程(`desktop/main.js`)

`background.js` 的 listener 依赖 `sender.tab.id`、`sender.frameId` 作为缓存 key(`key = ${tabId}:${frameId}`,第 59 行)和事件回传目标(`emitEvent(tabId, ...)`)。**这是最关键的一处适配**:router 需伪造

```js
const sender = { tab: { id: windowId }, frameId: 0, url, documentId }
```

其中 `windowId` 用窗口 id 代替 tab id,`emitEvent` 内部改为 `webContents.send('message', ...)`。`speech.js` 的 `matchesSpeech` 用 `tabId + frameId + speechId + clientId + documentId` 做归属匹配,同一套伪造值即可继续工作。

### 4.3 IPC 消息映射

扩展里的消息类型不多(含常量与数组内定义的),桌面端全部保留语义:

| 消息 | 处理方 |
| --- | --- |
| `START_TRANSLATION` / `CANCEL_TRANSLATION` / `TRANSLATION_EVENT` | 主进程,原 `background.js` 不变 |
| `VOCABULARY_*` | 主进程 + 本地 JSON(原 `vocabulary-store.js` 换存储实现) |
| `SPEAK_TEXT` / `SPEAK_LIBRARY_TEXT` / `STOP_SPEECH` / `PREVIEW_SPEECH` / `GET_SPEECH_VOICES` / `SPEECH_EVENT` | 主进程 TTS 适配层 |
| `DISCOVER_PROVIDER_MODELS` | 主进程 `fetch`,无 CORS 限制 |
| `OPEN_SETTINGS` / `OPEN_LIBRARY` | 打开对应窗口 |
| `OPEN_READING_ASSISTANT` | 扩展里是快捷键 → 后台 → content;桌面端改为热键直接触发取词,此消息可废弃 |

## 5. 取词方案(核心难点)

扩展靠 DOM 一次性拿到三样东西:选中文本、**选区矩形**(定位卡片)、**附近段落**(义项消歧、整句引导、重复词定位)。桌面端没有等价 API,只能分层取。

### 5.1 三层策略

| 层 | macOS | Windows | 能拿到什么 |
| --- | --- | --- | --- |
| A. 原生辅助功能(优先) | `AXUIElementCreateSystemWide` → 取 `kAXFocusedUIElementAttribute` → `kAXSelectedTextAttribute`;`kAXSelectedTextRangeAttribute` + `kAXBoundsForRangeAttribute` 取矩形;向上遍历 `kAXValueAttribute` 取上下文 | UIA `TextPattern.GetSelection().GetText(-1)`、`GetBoundingRectangles()` | text + rect + 上下文(部分应用) |
| B. 剪贴板(兜底) | 备份 `NSPasteboard` → `CGEvent` 发 `Cmd+C` → 轮询读取(≤300ms)→ 恢复 | 备份剪贴板 → `SendInput` 发 `Ctrl+C` → 读取 → 恢复 | 仅 text |
| C. 降级 | 都失败时提示"未取到选中文字,请手动复制后按快捷键",并允许直接粘贴查询 | 同左 | — |

A 层需要权限:macOS 需 `AXIsProcessTrusted()` 且引导用户开启「辅助功能」,**Electron 无内置能力,要配一个原生模块(Swift + N-API)或走 Tauri 的 Rust**;Chromium/Electron/Java 应用常暴露不全,所以 B 层不是可选项而是必需品。Windows 上浏览器类应用的 UIA 文本模式经常拿不到,B 层同样是主力。可参考开源的 Easydict / Bob 的取词实现。

不要做"全局监听剪贴板变化自动弹窗",误触发率高;只在热键路径里用 B 层。

### 5.2 数据流与协议复用

热键 → `captureSelection()` → 产出

```js
{ text, context, contextStart, contextEnd, rect, appName }
```

→ IPC 送入悬浮窗 → 注入 `state.activeSelection`。

**这里有个很有利的设计巧合**:`content.js` 的 `getSelectionContext(range)`(第 1623 行)本来就返回 `{ context, contextStart, contextEnd }`,而 `content.js` 第 361 行把它们作为 `START_TRANSLATION` 的 payload 上送,`background.js` 第 94–95 行交给 `getContextSentence()`。也就是说**桌面端只要构造出同形状的对象,整条翻译/引导/缓存链路一行都不用改**。上下文长度沿用 `MAX_TRANSLATION_CONTEXT_LENGTH = 2400`。

拿不到上下文时,`context: ''`,`contextStart/contextEnd: null`,后台已有"仅使用选中文字"的分支,行为是安全的,只是义项判断和整句引导会变弱。可产品化引导用户"多选一句"来补足。

### 5.3 无法完全抹平的降级

| 扩展能力 | 桌面版 |
| --- | --- |
| 结合附近段落判断义项、重复词定位 | 依赖 A 层上下文,多数应用只能退化为纯文本翻译 |
| 整句引导(主干/转折/指代) | 有上下文时可用,否则质量下降 |
| 卡片跟随选区定位 | A 层给 rect 时可精确定位;B 层退化为跟随鼠标指针 |
| 悬停 `Aa` 触发 | 改为热键触发 |
| 按 URL 停用(`DISABLED_URL_PATTERNS`) | 改为按 `bundleId` / 进程名停用(如密码管理器) |
| 收藏来源 `window.location.origin`(第 854 行) | 改为应用名 + 窗口标题 + 时间戳 |
| Chrome 内部页面限制 | 消失,任何应用可用 |

## 6. `content.js` 改造清单

改动集中,其余 1,700 行(卡片渲染、键盘、焦点、流式更新、宽度拖拽、CSS)保留:

- `refreshSelection()`(106–176):抽出 `setActiveSelection(payload)`,由 IPC 注入替代 DOM 扫描;`selectionchange` 等 5 个文档监听器在桌面窗口里不再需要(或仅保留窗口内复制/选择)。
- `isSupportedSelectionRange()` / `getTriggerAnchorRect()` / `positionTrigger()`:桌面端无 `Aa` 按钮,热键即触发,可整段跳过。
- `getSelectionContext(range)`(1623)与 `buildSelectionFingerprint()`:改为直接采用主进程给的字段。
- `positionCard()` 里的 `window.innerWidth/innerHeight`(1327、1477 等):换为主进程传入的屏幕工作区矩形,处理多显示器与 DPI 缩放。
- `chrome.storage.sync.get(DISABLED_URL_PATTERNS_KEY)`(1750):换成应用黑名单。
- Shadow DOM + 内联 CSS:在独立窗口里可直接保留;`:host { position: fixed; inset: 0; pointer-events: none }` 需按窗口尺寸调整。

## 7. 其余适配层

- **TTS**:`speech.js` 的接口(音色列表 `{voiceName, lang, remote}`、`speak(text, {lang, voiceName, rate, enqueue, onEvent})`、`stop()`)保持,主进程实现换成 macOS `AVSpeechSynthesizer`(Swift 侧)/ Windows SAPI 或 WinRT `SpeechSynthesizer`;`onEvent` 需发出 `start/end/error/interrupted/cancelled` 五类事件以匹配 `FINAL_SPEECH_EVENTS`。
- **存储**:`provider-settings.js` / `vocabulary-store.js` / `reading-support.js` 只调 `chrome.storage.*`,shim 接管即可;路径用 `app.getPath('userData')`。现有 JSON 导入导出、v1/v2 备份兼容、2,000 条 / 4 MiB 上限逻辑照搬。
- **凭据**:API Key 用 `safeStorage.encryptString` 加密落盘(macOS Keychain / Windows DPAPI),不要沿用 `storage.sync` 的明文(扩展里还可能同步到 Google 账号)。
- **窗口**:卡片窗口 `frame: false`、`transparent`、`alwaysOnTop`、`skipTaskbar`;macOS 需 `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` 才能在全屏应用/Spaces 上显示。
- **自启**:`app.setLoginItemSettings({ openAtLogin: true })`。

## 8. 目录结构建议

```
src/                 # 保持不动,扩展与桌面共用
desktop/
  main.js            # 主进程、窗口、router、热键
  preload.js         # window.chrome shim
  message-router.js  # sender 伪造 + 事件转发
  storage.js         # settings.json / vocabulary.json + onChanged 广播
  capture/
    index.js         # 取词调度(A → B → C)
    darwin/          # Swift / N-API:AX + 剪贴板
    win32/           # UIA + 剪贴板
  tts/
    index.js         # 统一接口 → 平台实现
  windows/           # card / settings / library 窗口配置
  package.json       # electron / electron-builder
docs/desktop-plan.md
```

共用 `src/` 是重点:不要 fork 一份出来改,否则扩展的 bug 修复要合并两次。

## 9. 分阶段计划与验收

| 阶段 | 任务 | 验收标准 |
| --- | --- | --- |
| 0 | 抽象 `chrome` shim 接口定义(仅接口 + 单测,扩展侧不启用) | 现有 `npm test` 全绿,扩展行为不变 |
| 1 | Electron 壳 + 全局热键 + 剪贴板取词(B 层)+ 悬浮窗 + 主进程 router | 在浏览器中选中文字按热键,卡片显示译文;流式可用 |
| 2 | TTS、本地存储、设置页、表达本/复习、托盘/自启 | 收藏 → 复习 → 导出导入闭环可跑;重启后数据保留 |
| 3 | A 层原生取词(macOS AX / Windows UIA)+ rect 定位 + 上下文 + Key 加密 | 在 Safari/Word/VS Code 中不污染剪贴板也能取词;卡片贴着选区 |
| 4 | 签名、公证、安装包、自动更新 | 干净机器上双击 dmg/exe 可安装,无 Gatekeeper/SmartScreen 拦截 |

粗估:阶段 1 约 1–2 周出可用 MVP;完整到阶段 4 约 2–3 人月,阶段 3 与 4 是主要不确定性。

## 10. 风险清单

| 风险 | 缓解 |
| --- | --- |
| 上下文缺失导致翻译/引导质量下降 | 允许用户多选一句;B 层把剪贴板全文当 context;做有无上下文的对照验证 |
| macOS 辅助功能权限被拒或授权后失效 | 首次启动引导 + `AXIsProcessTrusted()` 检测 + 设置页重新引导 |
| 全屏应用 / 多 Spaces 下悬浮窗不显示 | 窗口层级与 `visibleOnAllWorkspaces` 配置,真机逐场景验证 |
| 剪贴板法与用户复制操作竞争、恢复失败 | 只在热键路径使用、完整保存所有剪贴板格式、超时回滚 |
| 全局热键与系统/其他 App 冲突 | 设置页自定义 + `register` 失败时给出明确提示 |
| Electron 体积/内存偏高,常驻不划算 | 阶段 1 先验证;若不可接受,阶段 3 再评估 Tauri(需重写请求层) |
| Windows 旧版缺 WebView2(Tauri 方案时) | 引导安装,或坚持 Electron 自带 Chromium |
| 签名公证流程耗时、易被低估 | 提前申请 Apple Developer 账号与证书,CI 内做 notarize;现有 `v*` 标签发布流水线可复用思路 |
| 共用 `src/` 导致一处改动影响两端 | 阶段 0 的 shim 单测 + 保留现有 `npm test` / `test:browser` 作为回归 |
