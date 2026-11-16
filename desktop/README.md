# Desktop build

桌面版是一个**独立窗口应用**,复用仓库根目录 `src/` 的翻译协议与业务逻辑(provider 设置、流式解析、缓存、表达本、复习、朗读消息),但交互按桌面软件重新设计,不是把浏览器注入浮层照搬过来。

## 交互

- 全局热键呼出**悬浮翻译卡片**:取到选中文字时,在鼠标附近弹出置顶小卡片显示译文(流式),不打断当前工作;复制结果 / 原文、朗读、重新生成、收藏、在主窗口打开。点其他窗口或按 `Esc` 关闭。
- 取不到选中文字时热键改为呼出主窗口,停在输入框等你粘贴。
- 输入框可粘贴或输入任何文字——图片、PDF、视频、应用内无法选区的文字都适用。默认粘贴后自动翻译,可关闭。
- 消息流展示每次查询:译文(流式)、音标 / 释义 / 例句 / 语境分析、引导理解的分层提示与答案;每条结果可复制、朗读、收藏、重新生成、取消、删除、回填输入框。悬浮卡片的查询完成后自动同步进消息流。
- 「翻译 / 引导理解」模式切换,历史记录保存在本机,重启后仍在。
- 关闭按钮与 `Esc` 隐藏到托盘,不退出应用;从托盘菜单退出。

## 设置

点右上角「设置」打开内嵌面板(不用跳到扩展的设置页):

- API 地址、API Key、翻译模型、学习模型;「检测连接」会读取服务实际提供的模型并填充下拉。
- 首次未配置时自动展开。
- 窗口置顶、开机自启、仅剪贴板取词、自定义全局快捷键、主题 / 字号 / 减少动效。
- 右上角「日志」或托盘「打开日志」可查看运行日志(不记录 API Key)。

快捷键:

| 位置 | 操作 |
| --- | --- |
| 任意应用 | `Alt+Shift+E`(默认,托盘菜单可换预设,设置面板可自定义任意组合):取到文字→悬浮卡片;没取到→主窗口 |
| 悬浮卡片 | `Esc` 或点击其他窗口关闭 |
| 输入框 | `Ctrl+Enter` 发送(可切换为 `Enter` 发送、`Shift+Enter` 换行) |
| 窗口内 | `Esc` 隐藏窗口 |

## 取词

默认「自动」:热键触发时保存剪贴板 → 模拟一次 `Cmd/Ctrl+C` → 读取新内容 → 恢复剪贴板。macOS 用 `osascript`(需要给 App 授予「辅助功能」权限),Windows 用 PowerShell `SendKeys`。

如果权限没给、模拟复制被目标应用拒绝,或不想让程序动剪贴板,在设置里勾选**仅用剪贴板取词**:先复制文字,再按热键即可,零权限依赖。取词失败时窗口仍会打开,并提示手动粘贴。

剪贴板只提供纯文本,没有网页 DOM 上下文,因此义项消歧 / 整句引导能力弱于浏览器扩展。详见 `docs/desktop-plan.md` 第 5 节。

## 结构

- `scripts/sync-src.mjs`:把 `../src/` 与图标复制到 `vendor/`(生成物,不进 git)。`npm start` / `npm run verify` / `npm run dist` 之前自动执行。
- `scripts/verify.mjs`:语法检查 + `smoke` + 关键不变量断言,每轮迭代的本地验收入口。
- `scripts/smoke.mjs`:纯 Node 验证存储、双层 `chrome` shim、`background.js` 消息链、取词回退。
- `src/`:Electron 主进程、消息路由、`chrome` 兼容层、取词、TTS、窗口、历史、日志。
- `app/`:主窗口(`index.html` + `app.js` + `app.css`)与悬浮翻译卡片(`card.html` + `card.js` + `card.css`),直接以消息协议驱动后台。
- `.github/workflows/desktop-build.yml`:在 macOS / Windows runner 上产出安装包。

`src/` 下除 `main.js` / `windows.js` / `preload.cjs` 外都不 import Electron,便于在纯 Node 下测试。

## 本地运行与验证

```bash
cd desktop
npm ci
npm run verify    # 语法 + smoke + 不变量
npm start
```

数据都在 `app.getPath('userData')`:`sync.json`(API Key 用 `safeStorage` 加密)、`local.json`、`history.json`、`window-bounds.json`、`desktop.log`。

## 构建

```bash
cd desktop
npm run dist:dir        # 只产出解包目录,最快
npm run dist -- --mac
npm run dist -- --win
npm run dist -- --linux
```

产物在 `desktop/dist/`(已 gitignore)。CI 在 `desktop` 分支 push 或手动 `workflow_dispatch` 时,用 `macos-latest` / `windows-latest` 分别产出安装包并上传 Artifact:

- macOS:`Selected Text Translator-<版本>.dmg`(Intel / x64)与 `...-arm64.dmg`(Apple Silicon),以及对应的 zip;
- Windows:`Selected Text Translator Setup <版本>.exe`(x64)与 win zip。

在 Actions 运行页的 Artifacts 里下载,实机测试时按机器架构选对应 dmg。

**当前产物未签名**:`mac.identity` 为 `null`,Windows 未提供代码签名证书。macOS 首次打开需在「系统设置 → 隐私与安全性」中允许,Windows 可能出现 SmartScreen 提示。若要签名与公证,在仓库 Secrets 中配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`,并移除 `mac.identity` 配置。

实机手动验证步骤见 `docs/desktop-progress.md`。
