# Desktop build

桌面版外壳,复用仓库根目录 `src/` 的全部业务逻辑与 UI,不修改扩展主线代码。

## 结构

- `scripts/sync-src.mjs`:把 `../src/` 与图标复制到 `vendor/`(生成物,不进 git)。`npm start` / `npm run smoke` / `npm run dist` 之前自动执行。
- `src/`:Electron 主进程、消息路由、`chrome` 兼容层、取词、TTS、窗口。
- `app/card.html`:悬浮卡片窗口,直接以普通 `<script>` 加载 `content.js`。
- `.github/workflows/desktop-build.yml`:在 macOS / Windows runner 上产出安装包。

`src/` 下的模块除了 `main.js` / `windows.js` / `preload.cjs` 都不 import Electron,便于在纯 Node 下做冒烟测试。

## 本地运行

```bash
cd desktop
npm ci
npm start
```

首次启动后从托盘菜单打开「设置」,填入 API 地址、API Key 与翻译模型(与扩展相同)。
默认全局快捷键 `Alt+Shift+E`,托盘菜单的「快捷键」子菜单可改。

## 取词行为

热键触发时会先保存剪贴板、模拟一次 `Cmd/Ctrl+C`、读取新内容、再恢复剪贴板:

- macOS 用 `osascript` 的 System Events,需要给运行中的 App 授予「辅助功能」权限;
- Windows 用 PowerShell `SendKeys`;
- 模拟失败(权限未授予、命令不存在、应用不允许复制)时自动回退为「使用当前剪贴板内容」,即先手动复制再按热键也能用。

剪贴板只提供纯文本,没有网页 DOM 上下文,因此义项消歧 / 整句引导能力弱于浏览器扩展。详见 `docs/desktop-plan.md` 第 5 节。

## 构建

```bash
cd desktop
npm run dist:dir     # 只产出解包目录,最快
npm run dist -- --mac
npm run dist -- --win
npm run dist -- --linux
```

产物在 `desktop/dist/`(已 gitignore)。

CI 在 `desktop` 分支 push 或手动 `workflow_dispatch` 时,用 `macos-latest` / `windows-latest` 分别产出安装包并作为 Artifact 上传:

- macOS:`Selected Text Translator-0.8.0.dmg`(Intel / x64)与 `Selected Text Translator-0.8.0-arm64.dmg`(Apple Silicon),以及对应的 zip;
- Windows:`Selected Text Translator Setup 0.8.0.exe`(x64)与 win zip。

在 Actions 运行页的 Artifacts 里下载,实机测试时按机器架构选对应 dmg。

**当前产物未签名**:`mac.identity` 为 `null`,Windows 未提供代码签名证书。macOS 首次打开需在「系统设置 → 隐私与安全性」中允许,Windows 可能出现 SmartScreen 提示。若要签名与公证,在仓库 Secrets 中配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`,并移除 `mac.identity` 配置。

## 验证

```bash
cd desktop
npm run smoke        # 纯 Node:存储、shim、background.js 消息链路
```

实机手动验证步骤见 `docs/desktop-progress.md` 的「手动实机验证清单」。
