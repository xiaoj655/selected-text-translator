## Why

Popup 设置页当前依赖用户显式触发保存，输入后直接关闭 popup 时容易丢失未保存改动。为降低配置流失和重复输入成本，需要在更自然的交互时机自动持久化有效输入。

## What Changes

- 将 popup 设置页的保存触发方式从“仅手动保存”扩展为“输入框失焦后自动保存”。
- 规定仅在输入值非空（去除首尾空白后）且与当前已保存值不同的情况下触发写入，避免无效写入。
- 为自动保存补充最小化状态反馈（成功/失败），帮助用户确认改动是否已落盘。
- 保持现有 provider 存储契约（`base_url`、`api_key`、`model`）不变，确保翻译流程兼容。

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `action-popup-provider-settings`: 修改 popup 设置行为要求，新增输入框失焦自动保存及对应校验、反馈语义。

## Impact

- Affected specs: `action-popup-provider-settings`（新增/更新 requirement 与场景）。
- Affected code: popup UI 表单事件处理、storage 写入触发时机、状态提示渲染。
- API/dependencies: 无新增外部依赖；继续使用 `chrome.storage.sync` 与既有键名。
