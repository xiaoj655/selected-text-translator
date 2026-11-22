# Desktop build

桌面版提供**翻译工作台**和**English Coach**，复用仓库根目录 `src/` 的模型连接、翻译、引导理解和表达本逻辑。桌面界面使用英文。

## 翻译工作台

- 启动应用后可以直接粘贴文本。默认粘贴即提交并替换上一次的原文。也可点「Paste and translate」读取剪贴板，或在手动输入后点「Translate」。
- 「Translate」和「Guided Reading」共用原文，可以调整原文和目标语言。复制、朗读和收藏位于结果下方，重新生成等操作在结果的更多菜单。
- 翻译后原文留在输入框，当前结果显示在下方。历史侧栏可搜索、回看记录，重启时恢复最近 20 条。
- 从系统托盘或再次启动应用可打开已有窗口。关闭或按 `Esc` 可隐藏窗口，从托盘菜单退出应用。桌面端本轮暂停全局热键和悬浮取词入口。
- 表达本支持收藏、间隔复习、JSON 备份和 Anki 导出。学习档案可迁移表达本、翻译记忆和工作台历史。

## English Coach

「Article reading」拉取公开订阅源中的近期科技新闻、工程博客和技术思考。选一篇文章可以查看来源、时间和订阅源提供的正文，或打开原文；只有摘要时可点「Import full article」导入网页全文。也可以用「Paste text」阅读自己粘贴的英文，正文没有 12,000 字符截断。对话保留在当前应用会话中。

点击「Open link」可以导入公开网页，支持直接粘贴 URL 或 Markdown 链接。在「Settings → Reading → Web import」保存 IQS API Key 后，导入使用阿里云网页解析增强版，设置中可直接打开 Key 获取页。未配置 Key 时在本机提取，导入失败会显示原因并提供重试和粘贴入口。正文保留标题、段落、列表、引用、表格、代码、图片和图注的结构及顺序，字号、宽度和配色使用应用的阅读设置。公开直连视频可用原生播放器播放；嵌入、格式或资源不支持时提供原文入口。请求超时和响应体积保护独立于正文长度，超限会明确报错。[IQS Key 获取页面](https://aisearch.aliyun.com/web-parsing?tab=docs&apiTab=scrape)

成功导入和粘贴的文章自动保存到「History」，按最近访问排序，重启后直接读取本地正文并恢复阅读位置。相同网址更新已有记录，正文变化时重置位置；支持单篇删除和清空。历史最多保存最近 100 篇、总计约 50 MB。导入期间离开表单，完成后仍会写入历史并提示打开。

在文章正文中单击单词可原地查询；拖选短语或句子后，选择「Translate」或「Guided Reading」。查询带上选中内容所在的完整句子或多句、前后各一句及准确位置，并记住上次使用的模式。查询结果可逐条展开提示、查看答案、复制、朗读和收藏；收藏包含原句及可用的来源链接。滚动正文时结果继续保留，可收起面板或按 `Esc` 关闭。文章查询与翻译工作台各自管理请求。

单词查询先显示词义，点击「Sentence structure」后分析所在完整句子；短语、半句和跨句选区自动分析覆盖的完整句子，译文仍只对应选中部分。主干同时标在正文和侧栏的完整原句上，从句细节可展开「Explore sentence」。分析等待和失败重试独立于译文；同句查询复用临时分析缓存。右侧分隔线可以拖动调宽，双击恢复默认，宽度偏好在本机保存。

点击「Read with Coach」了解文章的背景和主要观点，然后追问论据、技术细节或英文表达。AI 上下文与阅读正文分开：预算内发送全文，长文章使用覆盖全篇或与问题、当前阅读位置相关的选段，并显示选段提示；正文预算为 12,000 字符，对话历史总预算为 8,000 字符。图片和视频不会自动发送给学习模型，打开文章和滚动不会调用学习模型。

「Review」继续使用查过的英文短语和句子生成练习，每组围绕一个阅读难点。练习结果和下次复练时间保存在本机。

English Coach使用已配置的通用学习模型。翻译模型为通用模型时也能沿用该模型。发起带读、追问或生成练习时，当前的英文材料及必要的对话上下文会发送给已配置的模型服务。

## 设置与版本

右上角「Settings」按用途分为四组，每次只显示一组。Models 配置翻译和学习模型，Reading 配置网页导入、朗读和文章排版，Preferences 管理语言、输入、窗口和外观，Data 管理术语表和学习档案。模型和朗读配置均提供 [百炼北京 API Key 获取链接](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)。新安装默认由粘贴或手动提交触发翻译。

在「Settings → Reading → Speech」勾选「Read English aloud with Alibaba Cloud」，保存后点「Preview voice」。百炼北京的翻译密钥可以直接复用，其他翻译服务请填单独的百炼北京 API Key。点击朗读时，英文文本会发给百炼，按输入字符计费。其他语言、超过 600 字符的内容和云服务不可用时使用系统语音。[百炼音色试听](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list) · [计费说明](https://help.aliyun.com/zh/model-studio/model-pricing)

在右上角「More actions」可以看当前软件版本并打开 GitHub 发布页，也可打开表达本或日志。

需要查看控制台或网络请求时，在应用窗口按 `F12` 或 `Ctrl+Shift+I`（macOS 为 `⌘⌥I`）打开独立的开发者工具，再选「Console」或「Network」；在应用窗口再次按快捷键可关闭。也可从系统托盘菜单选择「Open Developer Tools」打开主窗口的开发者工具。

从 0.9.64 起，Windows `.exe` 安装版会在后台检查和下载更新，也可以在「More actions」里手动检查。下载完成后在同一菜单点「Restart and update」。0.9.62 及更早版本需要手动覆盖安装一次，Windows 便携 ZIP 可在发布页下载新版。

| 位置 | 操作 |
| --- | --- |
| 翻译输入框 | `Ctrl/⌘+V` 粘贴并翻译 |
| 翻译输入框 | `Ctrl/⌘+Enter` 手动提交，可在设置中启用 `Enter` 提交 |
| 主窗口 | `Ctrl/⌘+K` 聚焦翻译输入框、`Ctrl/⌘+H` 历史侧栏、`Ctrl/⌘+E` 导出、`Ctrl/⌘+/` 帮助 |
| 主窗口 | `Ctrl/⌘` 加 `+`（或 `=`）放大、加 `-` 缩小、加 `0` 恢复 100% |
| 主窗口 | `Esc` 优先收起打开的工具条、菜单或面板，再隐藏窗口 |
| 桌面窗口 | `F12` 或 `Ctrl+Shift+I`（macOS 为 `⌘⌥I`）打开、关闭开发者工具 |

## 结构

- `scripts/sync-src.mjs` 把 `../src/` 复制到 `vendor/`，在 `npm start`、`npm run verify` 和 `npm run dist` 之前自动执行。
- `assets/` 存放桌面图标的 SVG 源文件和图像资源。窗口与托盘运行时读取 PNG，Windows 程序和安装包使用多尺寸 ICO。应用 PNG 为 512 × 512，macOS 菜单栏模板分别为 18 × 18 和 36 × 36。
- `scripts/verify.mjs`:语法检查 + `smoke` + 关键不变量断言;`npm run verify` 还会接着运行 Electron E2E,作为集成验收入口。
- `scripts/smoke.mjs`:纯 Node 验证存储、双层 `chrome` shim 和 `background.js` 消息链。
- `src/`:Electron 主进程、消息路由、`chrome` 兼容层、TTS、窗口、历史和 English Coach。
- `app/`:主窗口工作台和 English Coach界面。
- `.github/workflows/desktop-build.yml` 负责构建 macOS arm64 和 Windows x64 安装包。推送与 `package.json` 版本一致的 `desktop-v*` 标签时，流水线从 `desktop/CHANGELOG.md` 提取发布说明，创建带安装包和 SHA256 校验和的 GitHub Release。

`src/` 下除 `main.js` / `windows.js` / `preload.cjs` 外都不 import Electron,便于在纯 Node 下测试。

## 本地运行与验证

```bash
cd desktop
npm ci
npm run verify    # 语法 + smoke + 不变量 + 本地模拟 API 的 Electron E2E
npm run test:e2e -- --input    # 仅检查输入法与发送快捷键
npm run test:icons           # 用真实 Electron 检查源目录及 ASAR 内的图标
STT_LIVE_CONFIG=/absolute/path/outside-repo/live-config.json npm run test:e2e:live:reading
npm start
```

Electron E2E 使用现有 Playwright 与 Xvfb,可验证窗口内交互、模拟输入、请求、结果与持久化;浏览器扩展的集成检查仍在仓库根目录运行 `npm test` 与 `npm run test:browser`。这些普通检查使用本地模拟 API。带 `live` 的入口才访问真实服务,需要单独配置仓库外凭据并可能产生费用。

网页阅读真实测试的外部 JSON 配置使用 `baseUrl`、`apiKey`，可选 `iqsApiKey`；也可使用 `STT_BASE_URL`、`STT_API_KEY` 环境变量。`STT_TRANSLATION_MODEL` 和 `STT_LEARNING_MODEL` 可覆盖默认模型。测试使用临时用户目录，覆盖实际网页导入、词义与整句分析、跨段划选、侧栏拖宽及应用重启恢复，结束后删除临时配置数据。

macOS 和 Windows 的安装、原生输入法和系统朗读需实机验收。Windows 下还应检查主窗口、设置和表达本没有出现默认菜单栏。

数据都在 `app.getPath('userData')`:`sync.json`、`local.json`、`history.json`、`reading-history.json`、`reading-positions.json`、`window-bounds.json`、`desktop.log`。正文快照与阅读进度分开保存，滚动时只更新进度文件。API Key 在系统加密探针通过时用 `safeStorage` 加密,写成 `enc:v1:` 前缀的密文;当前探针失败时会跳过加密,不能将所有环境都视为已经加密。

## 构建

```bash
cd desktop
npm run dist:dir        # 只产出解包目录,最快
npm run dist -- --mac
npm run dist -- --win
npm run dist -- --win zip '-c.directories.output=dist/portable'  # Windows 便携版
npm run dist -- --linux
```

本地构建产物位于 `desktop/dist/`。推送 `desktop` 分支相关代码、推送 `desktop-v*` 标签或手动触发后，可在 Actions 运行页的 Artifacts 下载以下文件：

- macOS Apple Silicon（arm64）的 DMG 和 ZIP。
- Windows x64 的 `Selected.Text.Translator.Setup.<版本>.exe` 安装包和便携 ZIP。

**当前产物未签名**:`mac.identity` 为 `null`,Windows 未提供代码签名证书。macOS 首次打开需在「系统设置 → 隐私与安全性」中允许,Windows 可能出现 SmartScreen 提示。若要签名与公证,在仓库 Secrets 中配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`,并移除 `mac.identity` 配置。

当前基线、后续迭代方向与实机手动验证步骤见 [`docs/desktop-progress.md`](../docs/desktop-progress.md),逐版变更见 [`CHANGELOG.md`](./CHANGELOG.md)。
