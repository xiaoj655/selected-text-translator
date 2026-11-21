# AGENTS.md

## 交付

- 桌面端直接提交并推送到 `desktop`，浏览器插件直接提交并推送到 `main`。
- 所有提交的作者和提交者均为 `Codex <codex@openai.com>`，使用仓库级 Git 配置。
- 桌面端每轮有用户可感知的代码改动时，同步版本和变更日志，随 `desktop` 推送 `desktop-v<version>`。插件发版用与 `manifest.json` 一致的 `v<version>`。
- 推送成功后报告提交和发布标签（如有），CI 异步运行。

## 验证

- 每轮用现有入口做必要的针对性验证。纯文档检查 diff 和链接。涉及共用代码、多个主流程或高风险改动时，按影响范围扩大验证。同一项检查只在相关改动后重跑。
- 插件使用 `node --test tests/<file>.test.js` 或 `npm run test:browser`。CI 负责全量回归和打包。需要本地打包时用 `npm run package:extension`。
- 桌面端使用 `npm run smoke --prefix desktop` 或 `npm run test:e2e --prefix desktop`，输入和布局可分别用 `-- --input`、`-- --layout` 单独检查。`npm run verify --prefix desktop` 已包含 smoke 和 Electron E2E，留给需要完整回归的改动。
- 有视觉改动时检查一张代表性截图，按需补充受影响的状态。真实 API 测试须先获得授权，凭据只从环境变量或仓库外配置读取。提交、日志和截图须脱敏。

## 界面

- 参考 OpenAI 产品的整体风格。突出正文和主操作，统一字号、间距和组件，使用中性色和少量强调色。省去装饰性渐变、徽章、嵌套卡片和重复文案。
- 复用已有逻辑和组件。桌面端的产品路径见 `desktop` 分支的 `docs/desktop-roadmap.md`。
