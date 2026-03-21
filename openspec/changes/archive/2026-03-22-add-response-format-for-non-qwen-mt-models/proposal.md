## Why

当前非 `qwen-mt` 模型路径依赖“提示词要求模型输出 JSON”，但请求体没有显式传递 `response_format`。这会导致兼容 OpenAI/兼容 API 的模型在结构化输出场景下稳定性不足，且在未明确 JSON 输出时可能直接报错。另一个缺口是：单词场景下即使模型返回 `phonetic/definitions`，前端也未消费，造成可用信息丢失。现在需要统一“请求参数 + prompt + 字段消费”三者契约。

## What Changes

- 为非 `qwen-mt` 模型请求增加 `response_format` 参数，使用结构化输出模式（`{ "type": "json_object" }`）。
- 对 `qwen-mt` 系列保持现有请求结构，不注入 `response_format`。
- 优化非 `qwen-mt` 的系统提示词，明确字段契约：
- 必填可用字段：`translation`（非空字符串）。
- 单词场景可选字段：`phonetic`、`definitions`、`contextual_analysis`。
- 调整解析与错误处理路径，使 `response_format` 与提示词约束一致，并在不兼容响应时返回可诊断错误。
- 更新卡片渲染逻辑：单词场景在字段合法时展示音标与释义；句子/短语场景仅使用 `translation`。
- 补充/更新单元测试，覆盖请求构建、字段校验、单词场景展示与回退行为。

## Capabilities

### New Capabilities
- `structured-response-format-for-generic-models`: 为非 `qwen-mt` 翻译请求定义并应用 `response_format` 契约，保障结构化输出一致性。

### Modified Capabilities
- `translation-provider-settings`: 非 `qwen-mt` 请求从“仅靠 prompt 约束 JSON”升级为“请求参数 + prompt 双重约束”。
- `selected-text-translation`: 成功态卡片从“仅展示译文”扩展为“单词场景可展示已校验的音标与释义字段”。

## Impact

- Affected code:
- `src/translation-contracts.js`（请求体构建、prompt 常量、字段提取与校验）
- `src/background.js`（非流式响应解析、成功事件 payload、错误信息）
- `src/content.js`（单词场景扩展字段渲染）
- `tests/translation-contracts.test.js` 及内容脚本相关测试（新增 `response_format`、字段契约与展示行为断言）
- API/contract impact:
- 非 `qwen-mt` `chat/completions` 请求体新增 `response_format` 字段（本变更使用 `json_object`）。
- 非 `qwen-mt` 成功响应字段契约更新为：
- 必需：`translation`。
- 可选：`phonetic`、`definitions`、`contextual_analysis`（仅在单词场景且字段合法时使用）。
- `qwen-mt` 请求路径无 breaking change。
