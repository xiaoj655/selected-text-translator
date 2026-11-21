# Desktop build

桌面版提供**翻译工作台**和**AI 老师**，复用仓库根目录 `src/` 的模型连接、翻译、引导理解和表达本逻辑。

## 翻译工作台

- 启动应用后可以直接粘贴文本。默认粘贴即提交并替换上一次的原文。也可点「粘贴并翻译」读取剪贴板，或在手动输入后点「翻译」。
- 「直接翻译」和「引导理解」共用原文，可以调整原文和目标语言。复制、朗读和收藏位于结果下方，重新生成等操作在结果的更多菜单。
- 翻译后原文留在输入框，当前结果显示在下方。历史侧栏可搜索、回看记录，重启时恢复最近 20 条。
- 从系统托盘或再次启动应用可打开已有窗口。关闭或按 `Esc` 可隐藏窗口，从托盘菜单退出应用。桌面端本轮暂停全局热键和悬浮取词入口。
- 表达本支持收藏、间隔复习、JSON 备份和 Anki 导出。学习档案可迁移表达本、翻译记忆和工作台历史。

## AI 老师

完成的英文短语和句子查询会成为训练材料，初次使用时会纳入近期可用历史。每组练习围绕一个阅读难点，可以练短语在句中的意思，或练整句主干、转折、因果等关系。点击开始后，学习模型用该材料生成新句题目。练习结果和下次复练时间保存在本机。

AI 老师使用已配置的通用学习模型。翻译模型为通用模型时也能沿用该模型。生成练习时会发送当次选中的英文材料到配置的服务。

## 设置与版本

在右上角「设置」可以修改模型连接、原文和目标语言、术语表、朗读、输入后自动翻译、窗口和外观偏好。已经开启自动翻译的设置会保留，新安装默认由粘贴或手动提交触发。

在「设置 → 朗读」勾选「使用阿里云朗读英文」，保存后点「试听英文」。百炼北京的翻译密钥可以直接复用，其他翻译服务请填单独的百炼北京 API Key。点击朗读时，英文文本会发给百炼，按输入字符计费。其他语言、超过 600 字符的内容和云服务不可用时使用系统语音。[百炼音色试听](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list) · [计费说明](https://help.aliyun.com/zh/model-studio/model-pricing)

在右上角「更多」可以看当前软件版本并打开 GitHub 发布页，也可打开表达本或日志。

从 0.9.63 起，Windows `.exe` 安装版会在后台检查和下载更新，也可以在「更多」里手动检查。下载完成后在同一菜单点「重启并更新」。0.9.62 及更早版本需要手动覆盖安装一次，Windows 便携 ZIP 可在发布页下载新版。

| 位置 | 操作 |
| --- | --- |
| 翻译输入框 | `Ctrl/⌘+V` 粘贴并翻译 |
| 翻译输入框 | `Ctrl/⌘+Enter` 手动提交，可在设置中启用 `Enter` 提交 |
| 主窗口 | `Ctrl/⌘+K` 聚焦翻译输入框、`Ctrl/⌘+H` 历史侧栏、`Ctrl/⌘+E` 导出、`Ctrl/⌘+/` 帮助 |
| 主窗口 | `Esc` 优先收起打开的工具条、菜单或面板，再隐藏窗口 |

## 结构

- `scripts/sync-src.mjs`:把 `../src/` 与图标复制到 `vendor/`(生成物,不进 git)。`npm start` / `npm run verify` / `npm run dist` 之前自动执行。
- `scripts/verify.mjs`:语法检查 + `smoke` + 关键不变量断言;`npm run verify` 还会接着运行 Electron E2E,作为集成验收入口。
- `scripts/smoke.mjs`:纯 Node 验证存储、双层 `chrome` shim 和 `background.js` 消息链。
- `src/`:Electron 主进程、消息路由、`chrome` 兼容层、TTS、窗口、历史和 AI 老师。
- `app/`:主窗口工作台和 AI 老师界面。
- `.github/workflows/desktop-build.yml`:在 macOS(x64 + arm64)/ Windows / Linux runner 上产出安装包;推送 `desktop-v*` 标签(须与 `package.json` 版本一致)时自动以 `desktop/CHANGELOG.md` 对应版本的说明创建 GitHub Release,附全部安装包与 SHA256 校验和。

`src/` 下除 `main.js` / `windows.js` / `preload.cjs` 外都不 import Electron,便于在纯 Node 下测试。

## 本地运行与验证

```bash
cd desktop
npm ci
npm run verify    # 语法 + smoke + 不变量 + 本地模拟 API 的 Electron E2E
npm run test:e2e -- --input    # 仅检查输入法与发送快捷键
npm start
```

Electron E2E 使用现有 Playwright 与 Xvfb,可验证窗口内交互、模拟输入、请求、结果与持久化;浏览器扩展的集成检查仍在仓库根目录运行 `npm test` 与 `npm run test:browser`。这些普通检查使用本地模拟 API。带 `live` 的入口才访问真实服务,需要单独配置仓库外凭据并可能产生费用。

macOS 和 Windows 的安装、原生输入法和系统朗读需实机验收。Windows 下还应检查主窗口、设置和表达本没有出现默认菜单栏。

数据都在 `app.getPath('userData')`:`sync.json`、`local.json`、`history.json`、`window-bounds.json`、`desktop.log`。API Key 在系统加密探针通过时用 `safeStorage` 加密,写成 `enc:v1:` 前缀的密文;当前探针失败时会跳过加密,不能将所有环境都视为已经加密。

## 构建

```bash
cd desktop
npm run dist:dir        # 只产出解包目录,最快
npm run dist -- --mac
npm run dist -- --win
npm run dist -- --win zip -c.directories.output=dist/portable  # Windows 便携版
npm run dist -- --linux
```

产物在 `desktop/dist/`(已 gitignore)。CI 在 `desktop` 分支相关代码 push、`desktop-v*` 标签或手动 `workflow_dispatch` 时,用 `macos-latest` / `windows-latest` / `ubuntu-latest` 分别产出安装包并上传 Artifact:

- macOS:`Selected Text Translator-<版本>.dmg`(Intel / x64)与 `...-arm64.dmg`(Apple Silicon),以及对应的 zip;
- Windows:`Selected Text Translator Setup <版本>.exe`(x64)与 win zip。
- Linux:AppImage。

在 Actions 运行页的 Artifacts 里下载,实机测试时按机器架构选对应 dmg。

**当前产物未签名**:`mac.identity` 为 `null`,Windows 未提供代码签名证书。macOS 首次打开需在「系统设置 → 隐私与安全性」中允许,Windows 可能出现 SmartScreen 提示。若要签名与公证,在仓库 Secrets 中配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`,并移除 `mac.identity` 配置。

当前基线、后续迭代方向与实机手动验证步骤见 [`docs/desktop-progress.md`](../docs/desktop-progress.md),逐版变更见 [`CHANGELOG.md`](./CHANGELOG.md)。
