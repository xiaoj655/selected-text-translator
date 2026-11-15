# 桌面版长期任务进度

本文件是桌面版移植的**唯一进度来源**。每次新会话先读本文件与 `docs/desktop-plan.md`,再说「继续」即可接着做,不依赖对话记忆。完成一项就勾选、记下验证结果。

## 协作分工

- **我(agent)**:写代码、单测、构建脚本、验证脚本、文档;更新本文件;把大任务拆成可独立验收的小步。
- **你**:在 macOS / Windows 实机上按下方清单手动验证,回传现象、日志、截图;阶段 4 提供 Apple Developer 账号与代码签名证书。
- **安装包获取**:push 到 `desktop` 分支后,`.github/workflows/desktop-build.yml` 自动构建;在 Actions 运行页的 **Artifacts** 里下载 `selected-text-translator-macOS` / `selected-text-translator-Windows`。macOS 有两个 dmg:`Selected Text Translator-0.8.0.dmg` 是 Intel (x64),`Selected Text Translator-0.8.0-arm64.dmg` 是 Apple Silicon。
- **凭据**:API Key、证书、账号一律走环境变量或仓库外私有配置;不要发给我,不要出现在截图、日志、测试报告、提交里(沿用 AGENTS.md 约定)。

## 环境约束(固定事实,不要反复确认)

- 本地环境:Ubuntu / Node 22.22.1 / npm 9.2.0,npm registry 可访问;已装 Xvfb,可无头启动 Electron 应用做启动验证。
- **没有 macOS / Windows 环境可提供**,但 CI 用 GitHub 托管的 `macos-latest` / `windows-latest` runner 产出安装包,已跑通。
- 阶段 0–2 的代码与单测在本地 Linux 完成;阶段 3–4 的平台相关代码只能写、不能自测,正确性依赖你的实机验证。
- 我没有 GUI 交互能力:看不到悬浮窗、点不了系统授权弹窗、没法在应用里选中文字按快捷键。凡涉及交互的验证都必须由你执行。

## 里程碑

本轮目标:**成功构建出 Windows / macOS 安装包**(已达成,见变更记录)。阶段 3 的原生取词与阶段 4 的签名公证留待后续。

### 阶段 0 — 地基(无需额外环境)
- [x] 定义 `chrome` shim 接口(storage / runtime / tabs / tts)
- [x] shim 单元测试(含 `lastError`、回调必达、`onChanged` 广播语义)
- [x] 验收:现有 `npm test` 全绿(229 项),扩展行为不变,`src/` 无功能性改动

### 阶段 1 — Electron MVP
- [x] 主进程壳 + 窗口(card / settings / options / library)
- [x] 全局热键(托盘菜单可切换预设、冲突回退)
- [x] 剪贴板取词(备份 → 模拟复制 → 读取 → 恢复,失败回退现有剪贴板)
- [x] 悬浮窗复用 `content.js` 卡片 UI + `background.js` 翻译链路
- [x] 验收:Linux 下 `npm run smoke` 通过、`electron-builder --dir` 成功、Xvfb 下主进程启动成功
- [ ] **功能表现由你在实机按清单 1 验证**

### 阶段 2 — 完整功能
- [x] 系统 TTS 适配(macOS `say` / Windows `System.Speech` / Linux `spd-say`)
- [x] 本地存储 + `safeStorage` 加密 API Key
- [x] 设置页、表达本、收藏、复习、导入导出(全部复用 `src/`)
- [x] 托盘、窗口生命周期
- [ ] 开机自启(未实现)
- [ ] 验收:自动化测存储/导入导出;**按清单 2 手动验证**

### 阶段 3 — 原生取词增强(平台特异,风险最高)
- [ ] macOS:AX 取词 + 选区矩形 + 辅助功能权限引导
- [ ] Windows:UIA `TextPattern` 取词 + 矩形
- [ ] 统一 A → B → C 降级调度,按应用黑名单停用
- [ ] 验收:**全部行为由你按清单 3 手动验证**,据回传日志迭代

### 阶段 4 — 分发
- [x] electron-builder 配置(dmg / nsis / AppImage)、双架构 macOS
- [x] GitHub Actions 自动产出 macOS + Windows 安装包并上传 Artifact
- [ ] 签名 + 公证(需你的 Apple 账号与证书)
- [ ] 自动更新
- [ ] 验收:**按清单 4 手动验证**干净机器安装与更新

## 手动实机验证清单(由你执行)

回传时请附:平台 + 系统版本 + 代码版本(commit)、操作步骤、预期 vs 实际、日志、截图。截图注意避开 API Key 输入框。

### 清单 1 — 阶段 1(两平台通用)
1. 从 Actions 的 Artifacts 下载安装包。**macOS 注意选对架构**:Intel 用 `Selected Text Translator-0.8.0.dmg`,Apple Silicon 用 `Selected Text Translator-0.8.0-arm64.dmg`。当前产物未签名,macOS 首次打开需在「系统设置 → 隐私与安全性」允许,Windows 可能出现 SmartScreen 提示。
2. 启动 App,托盘/菜单栏图标出现,不弹主窗口。
3. 在设置里填入 API 地址、API Key、翻译模型(与扩展相同)。
4. 在浏览器或文本编辑器里选中一段英文,按 `Alt+Shift+E`。
5. 预期:鼠标附近弹出置顶卡片,流式显示译文;按 `Esc` 关闭。
6. 再测:中文选中(应译英)、整句、空选区(应有提示且不崩溃)、超长文本。
7. 剪贴板:先复制一段自有内容 → 触发取词 → 结束后检查原剪贴板内容是否被恢复。
8. 热键冲突:托盘菜单换成另一个快捷键组合,重测。
9. 回传:卡片是否弹出、位置是否合理、控制台/调试日志有无报错、取词是否成功。

> 若 macOS 上取词失败,多半是「辅助功能」权限未授予(模拟 `Cmd+C` 需要它)。此时先手动 `Cmd+C` 再按热键,应能走剪贴板回退。

### 清单 2 — 阶段 2
1. 朗读选区与包含选区的原句,试听音色、语速调整、试听、停止。
2. 收藏一条 → 退出并重启 App → 数据仍在 → 导出 JSON → 清空后导入 → 条数与复习进度一致。
3. 设置项重启后保持;API Key 在 `userData/sync.json` 中应为 `enc:v1:` 开头的密文而非明文。
4. 托盘退出/重开。
5. 回传:音色列表是否为空、有无 TTS 报错、数据是否持久。

### 清单 3 — 阶段 3(最关键)
**macOS**
1. 首次启动是否弹出辅助功能授权;到「系统设置 → 隐私与安全性 → 辅助功能」授权后重启 App。
2. 分别在 Safari、Word、VS Code、预览(PDF)中选中文字并按热键,确认是否取到(不依赖剪贴板)。
3. 卡片是否贴着选区位置(rect),而非只在鼠标旁。
4. 全屏应用、多 Spaces / 外接显示器下卡片是否可见。
5. 对取不到文字的应用,是否自动回退到剪贴板且不破坏剪贴板。

**Windows**
1. Chrome / Edge / Word / 记事本 中选中文字按热键,记录哪些走 UIA、哪些走剪贴板兜底。
2. 多显示器 + 125% / 150% 缩放下卡片位置与清晰度。
3. 在密码管理器等敏感应用中,按应用黑名单停用是否生效。
4. 回传:每款应用的取词结果(成功 / 走兜底 / 失败),以及调试日志里的取词路径。

### 清单 4 — 阶段 4
1. 干净机器上双击 dmg / exe,是否无 Gatekeeper / SmartScreen 拦截(当前未签名,预期会有提示)。
2. 触发一次自动更新,确认能升级到新版本(自动更新尚未实现)。
3. 回传:安装截图(避开敏感信息)、更新日志。

## 变更记录

| 日期 | 阶段 | 内容 | 验证 |
| --- | --- | --- | --- |
| 2026-11-15 | 方案 | 新增 `docs/desktop-plan.md` | 未涉及运行 |
| 2026-11-15 | 协作 | 新增本文件,确立长期任务追踪与手动验证方式 | — |
| 2026-11-15 | 0–2 | 新建 `desktop/` Electron 壳、双层 `chrome` shim、剪贴板取词、TTS、窗口与托盘;`src/` 零改动 | `npm test` 229 全绿;`npm run smoke` 通过;`electron-builder --dir` 成功;Xvfb 下主进程 `background module loaded` → `ready linux` |
| 2026-11-15 | 4 | 新增 `desktop-build.yml`,macOS / Windows 双平台 CI | run `43746432557` 成功,产出 arm64 dmg + x64 exe;既有 "Verify and package extension" 同样 success |
| 2026-11-15 | 4 | 尝试补 x64 架构、CI 加 smoke、修弃用警告 | run `43747068833` 失败:`mac.arch` 不是合法字段,Windows job 也因全局配置校验失败 |
| 2026-11-15 | 4 | 回退非法配置,改为 CI 分两步 `--mac --x64` / `--mac --arm64`;env 提到 job 级 | run `43747411549` **全绿**(macOS 3m51s / Windows 3m48s),产出 x64 dmg(119M)、arm64 dmg(115M)、x64 exe(116M)及对应 zip,两个 Artifact 已上传 |
