# Selected Text Translator 桌面版

从 [GitHub Releases](https://github.com/xiaoj655/selected-text-translator/releases) 下载 `Selected Text Translator` 安装包。macOS Apple Silicon 选择带 `arm64` 的 DMG，Intel 选择另一份 DMG。Windows 使用 Setup EXE，Linux 使用 AppImage。

打开后焦点直接落在原文框。粘贴或输入文字，点击「翻译」，也可以按 `⌘ Enter`（Windows / Linux 为 `Ctrl Enter`）。译文在旁边显示，点击「复制译文」即可使用。窄窗口内原文和译文上下排列。顶部可选择原文和译文语言。

点击「模型设置」填写 API 地址、API Key 和模型。升级时沿用原桌面版的模型配置和数据目录。API Key 由系统安全存储加密后写入，系统无法加密时，新配置只在本次运行中有效。旧版历史和收藏保留在原数据目录，可通过旧版查看。0.9.59 的独立 Preview 使用另一个数据目录，仅在 Preview 填过的模型配置可在新版中重新填写。

## 本地运行

```bash
npm ci
npm ci --prefix desktop
npm start --prefix desktop
```

在仓库根目录运行 `npm run verify --prefix desktop`，检查语法、共享翻译逻辑和桌面端使用流程。桌面端测试需要图形会话，使用本地模拟 API 和临时目录。原桌面界面可用 `npm run test:e2e:legacy --prefix desktop` 验证。

## 构建

```bash
cd desktop
npm run dist:dir
npm run dist -- --mac
npm run dist -- --win
npm run dist -- --linux
```

安装包写入 `desktop/dist/`。推送 `desktop-v*` 标签时，流水线按标签对应的 `desktop/package.json` 版本打包，并从 `desktop/CHANGELOG.md` 读取发布说明。现有 macOS 安装包未配置 Developer ID 签名。

新界面位于 `desktop/translator/`，翻译协议与模型请求复用仓库根目录的 `src/`，打包时同步到 `desktop/vendor/`。
