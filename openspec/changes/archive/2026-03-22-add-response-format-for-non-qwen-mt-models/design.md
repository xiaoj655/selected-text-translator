## Context

当前翻译流程分两条路径：
- `qwen-mt`：流式输出，使用 `translation_options`，不依赖系统提示词。
- 非 `qwen-mt`：非流式输出，依赖固定系统提示词让模型返回 JSON，再从 `choices[0].message.content` 提取 `translation` 字段；当前未消费单词增强字段。

现状问题是非 `qwen-mt` 路径没有显式使用 `response_format`，只能靠提示词约束 JSON 结构，导致兼容模型在输出一致性上不稳定；当接口要求 `json_object` 时，如果提示词未明确 JSON 输出，还会直接报错。

## Goals / Non-Goals

**Goals:**
- 为非 `qwen-mt` 请求补充 `response_format`，使结构化输出契约由“prompt-only”升级为“参数 + prompt”双重约束。
- 优化非 `qwen-mt` prompt，明确 JSON 输出要求与字段契约（必需与可选字段边界）。
- 在单词场景消费并展示 `phonetic/definitions` 等增强字段，同时保持句子场景简洁展示。
- 保持 `qwen-mt` 现有请求与流式消费逻辑不变，避免引入回归。
- 补齐测试覆盖，验证模型分支、请求体和解析行为。

**Non-Goals:**
- 不新增设置 UI 让用户手工切换 `response_format`。
- 不扩展到任意第三方 Provider 的多套兼容策略。
- 不重做翻译卡片布局，仅在现有成功态增加单词场景字段区域。

## Decisions

### Decision 1: 非 `qwen-mt` 默认启用 `response_format: {\"type\":\"json_object\"}`
- Rationale: 当前非 `qwen-mt` 分支本身就要求返回 JSON 并提取 `translation`，`json_object` 与现有解析目标一致，改动小且收益直接。
- Alternative considered:
- 继续使用默认 `text`：实现最简单，但无法提供结构化输出约束，稳定性提升有限。
- 直接使用 `json_schema`：约束更强，但跨模型兼容性和实现复杂度更高，适合后续增量迭代。

### Decision 2: 将非 `qwen-mt` 系统提示词收敛为“强约束 JSON 合同”
- Rationale: `json_object` 模式要求提示词明确 JSON 输出；同时当前 prompt 过长且包含大量非核心字段，增加模型偏航概率。
- Strategy:
- 明确要求输出合法 JSON 对象。
- 明确必须包含顶层 `translation` 非空字符串字段。
- 明确单词场景可返回 `phonetic`、`definitions`、`contextual_analysis`。
- 明确禁止 markdown 代码块和额外解释文本。
- Alternative considered:
- 保留旧 prompt：无需改动，但“字段过多 + 约束分散”会继续导致非预期输出。

### Decision 3: 建立“字段白名单 + 场景化消费”策略
- Rationale: 用户要求三者联动时明确“哪些字段会返回、哪些字段可用”，需要防止模型返回噪声字段或脏数据直接进入 UI。
- Strategy:
- 始终要求并消费 `translation`（必需字段）。
- 仅当输入被判定为“单词”时才尝试消费 `phonetic`、`definitions`、`contextual_analysis`。
- 对可选字段执行结构与非空校验；不合法则忽略并回退为仅展示 `translation`。
- Alternative considered:
- 无条件消费所有返回字段：实现简单，但会引入展示噪声与字段污染风险。

### Decision 4: 维持“严格失败 + 可诊断日志”，不引入自动降级重试
- Rationale: 项目既有规范强调单一可预期契约，失败时应清晰暴露而不是静默 fallback。
- Strategy:
- 保留当前响应解析主流程（JSON 解析 + `translation` 字段校验），并增加可选字段的安全提取日志。
- 优化错误文案与日志上下文，便于识别 `response_format`/输出格式不匹配问题。
- Alternative considered:
- 请求失败后自动降级到 `response_format: text` 重试：可提高部分端点可用性，但会弱化契约一致性并增加分支复杂度。

### Decision 5: `qwen-mt` 路径保持零行为变化
- Rationale: `qwen-mt` 路径已使用专用翻译协议（`translation_options` + stream），与本变更目标无关。
- Alternative considered:
- 全模型统一注入 `response_format`：会污染 `qwen-mt` 专用协议，存在兼容风险。

## Risks / Trade-offs

- [Risk] 部分非 `qwen-mt` 端点不支持 `response_format`，导致请求失败  
  → Mitigation: 在错误信息中保留状态码和关键上下文；测试中覆盖“结构不匹配”失败路径，确保可快速诊断。

- [Risk] Prompt 收敛后可能丢失旧 prompt 的附加字段（如词性/例句）  
  → Mitigation: 在本变更中把单词增强字段纳入“可选且受校验”的正式契约，避免完全丢失。

- [Risk] 单词判定过于粗糙导致字段误用或漏用  
  → Mitigation: 采用保守判定（空白分词规则）并保持“判定失败即回退 translation-only”。

- [Risk] 新旧模型命名差异导致分支误判  
  → Mitigation: 复用既有 `isQwenMtModel` 判定并补充分支测试。

## Migration Plan

1. 更新请求构建逻辑：仅在非 `qwen-mt` 分支注入 `response_format` 并替换系统提示词。
2. 更新非流式解析：`translation` 必需；单词场景按白名单安全提取 `phonetic/definitions/contextual_analysis`。
3. 更新卡片成功态渲染：单词场景展示可选增强字段，其他场景仅展示译文。
4. 更新错误信息与日志字段，增强格式契约诊断。
5. 增补单元测试并通过本地测试套件。
6. 发布后在调试日志中抽样确认非 `qwen-mt` 请求体、字段提取与展示路径符合预期。

回滚策略：若上线后出现兼容性问题，回滚到旧的非 `qwen-mt` 请求构建逻辑（去掉 `response_format` 并恢复旧 prompt）。

## Open Questions

- 是否需要在后续版本为“明确支持 schema 的模型”升级到 `response_format: {\"type\":\"json_schema\", ...}`？
- 是否需要把非 `qwen-mt` 的 `response_format` 策略暴露为可配置项，而不是代码内固定策略？
