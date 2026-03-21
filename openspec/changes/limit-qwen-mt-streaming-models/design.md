## Context

当前翻译路径把所有 `qwen-mt` 前缀模型都当作流式模型处理，请求体固定 `stream: true`，后台也默认通过 SSE 逐段消费响应。这个假设与实际模型能力不一致：只有 `qwen-mt-flash` 与 `qwen-mt-lite` 支持稳定流式，其它 `qwen-mt*` 可能仅返回非流式结果，进而触发“无 stream body”或流读取失败。

该问题横跨请求构建（`src/translation-contracts.js`）与响应消费（`src/background.js`），并影响内容脚本的事件预期（是否会收到 `stream` 事件）。

## Goals / Non-Goals

**Goals:**
- 将 `qwen-mt` 路径的流式行为收敛为显式白名单，仅允许 `qwen-mt-flash` 与 `qwen-mt-lite` 使用 stream。
- 对非白名单 `qwen-mt*` 保留 `translation_options` + 无 system prompt 协议，但改用非流式响应消费。
- 保持前端卡片行为稳定：有流则增量渲染，无流则直接在成功事件显示最终译文。
- 补齐模型分支与请求/响应路径测试，防止回归。

**Non-Goals:**
- 不新增用户可配置的“是否流式”开关。
- 不改变非 `qwen-mt` 的结构化输出契约（`response_format=json_object`）。
- 不扩展额外 provider 适配逻辑。

## Decisions

### Decision 1: 使用显式白名单判定 `qwen-mt` 是否允许流式
- Rationale: 需求已明确仅两个模型支持流式，显式白名单最可控、可测试。
- Strategy:
- 新增模型能力判定函数（基于规范化模型名）。
- `qwen-mt-flash` / `qwen-mt-lite` -> `stream: true`；其他 `qwen-mt*` -> `stream: false`。
- Alternative considered:
- 继续按前缀启用流式：实现简单但与真实能力不匹配，持续产生失败。
- 运行时探测流能力：更智能，但复杂度高且会引入额外试探请求。

### Decision 2: 保持 `qwen-mt` 专用请求协议，只切换传输模式
- Rationale: 业务契约核心是 `translation_options` 与无 system prompt，不应因流式能力差异而改变。
- Strategy:
- 白名单内外都走 `qwen-mt` 协议。
- 仅变更 `stream` 标记与响应消费路径。
- Alternative considered:
- 非白名单 `qwen-mt` 回退到通用 prompt + JSON：会偏离既有 `qwen-mt` 协议，增加语义风险。

### Decision 3: 后台按“请求模式”分派响应消费器
- Rationale: 当前 `usesStructuredOutputForModel` 只能区分 `qwen-mt` 与非 `qwen-mt`，不足以覆盖“`qwen-mt` 内部流式/非流式分叉”。
- Strategy:
- 引入更明确的请求模式（例如 stream vs non-stream）并据此选择 `consumeStream` 或 `consumeNonStreamResponse`/`consumeQwenMtNonStreamResponse`。
- 保持事件语义：流式才发 `TRANSLATION_EVENT_STATUS.STREAM`，非流式仅发 `STARTED` + `SUCCESS/ERROR`。
- Alternative considered:
- 非白名单 `qwen-mt` 也复用 SSE 消费并容错：会隐藏真正协议错误，难定位。

### Decision 4: 更新规范与测试，锁定行为边界
- Rationale: 这是行为契约变化，不仅是实现细节。
- Strategy:
- 修改 `translation-provider-settings` 与 `selected-text-translation` 相关 requirement。
- 增加白名单匹配、请求体 `stream` 值、以及非流式 `qwen-mt` 成功路径测试。

## Risks / Trade-offs

- [Risk] 白名单遗漏合法变体（如版本后缀）导致误判  
  → Mitigation: 在判定函数中采用规范化匹配并增加测试样例（大小写、空白、后缀）。

- [Risk] 非白名单 `qwen-mt` 返回结构与预期不一致  
  → Mitigation: 保持错误可诊断（含模型名与响应摘要），并在 spec 中定义失败为清晰错误而非静默降级。

- [Risk] 前端依赖 `STREAM` 事件的体验变化  
  → Mitigation: 明确仅流式模型发送 `STREAM`；非流式通过 `SUCCESS` 一次性更新，不影响最终展示。

## Migration Plan

1. 在 `translation-contracts` 中新增/调整 `qwen-mt` 流式能力判定与请求构建。
2. 在 `background` 中按请求模式分派响应消费逻辑，补齐非流式 `qwen-mt` 解析。
3. 保持 content 侧事件处理兼容，仅在有 `STREAM` 事件时做增量渲染。
4. 更新 tests 覆盖白名单模型、非白名单模型与最终事件序列。
5. 若出现线上兼容问题，回滚到变更前请求/消费逻辑（恢复全 `qwen-mt` 流式策略）。

## Open Questions

- 白名单是否需要支持更宽匹配（如 `qwen-mt-flash-v2`）？本次先按精确模型名实现。
- 是否需要在设置页给非白名单模型显示“已自动禁用流式”的提示？本次不做 UI 改动。
