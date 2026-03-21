## Why

当前实现会对所有 `qwen-mt` 前缀模型统一使用流式请求；但实际上只有 `qwen-mt-flash` 和 `qwen-mt-lite` 支持流式，其他 `qwen-mt` 模型可能返回非流式响应，导致请求失败或读取流异常。需要将流式能力收敛到明确白名单，避免误用 stream 传输。

## What Changes

- 将 `qwen-mt` 家族请求从“前缀即流式”调整为“仅白名单模型流式”。
- 仅 `qwen-mt-flash`、`qwen-mt-lite` 使用 `stream: true` 与流式消费路径。
- 其他 `qwen-mt*` 模型改为非流式请求与非流式响应解析，但继续使用 `translation_options` 且不发送 system prompt。
- 更新翻译渲染行为：仅在流式响应可用时执行增量更新；非流式路径展示最终翻译结果。
- 增补单元测试与行为覆盖，确保白名单与非白名单路径不回归。

## Capabilities

### New Capabilities
- _None_

### Modified Capabilities
- `translation-provider-settings`: 将 `qwen-mt` 路径的 stream 行为改为“仅白名单模型启用”，并为其他 `qwen-mt*` 模型定义非流式请求/响应契约。
- `selected-text-translation`: 将“流式增量显示”调整为“按请求模式处理”；在非流式路径下仍需正确展示最终译文并处理并发选择切换。

## Impact

- Affected code:
  - `src/translation-contracts.js`
  - `src/background.js`
  - `src/content.js`（仅事件/状态兼容性）
- Affected tests:
  - `tests/translation-contracts.test.js`
  - 可能新增/调整背景翻译流程测试
- API behavior:
  - `qwen-mt-flash`、`qwen-mt-lite` 继续走 stream
  - 其他 `qwen-mt*` 强制不使用 stream
