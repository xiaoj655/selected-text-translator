## Context

当前 popup 设置页在 `src/popup.js` 中只监听表单 `submit`，用户必须点击 Save 才会调用 `saveProviderSettings` 写入 `chrome.storage.sync`。popup 交互天然容易被关闭或切走，导致用户输入后未显式提交时改动丢失。现有 `saveProviderSettings` 会统一 trim 并校验三个字段非空，因此自动保存方案需要复用该契约并避免无效写入。

## Goals / Non-Goals

**Goals:**
- 在 popup 中，当任一输入框失焦时，若当前表单值可通过校验且与最近已保存值不同，则自动保存一次。
- 输入值为空或仅空白时不触发保存，保持“必填字段”约束。
- 提供最小状态反馈，让用户知道自动保存成功或失败。
- 保持 `base_url` / `api_key` / `model` 的存储键和读写契约不变。

**Non-Goals:**
- 不调整 provider 设置的数据结构、键名或存储后端。
- 不改造 options 页面行为。
- 不引入实时每次输入变更保存（`input` 事件级别自动保存）。

## Decisions

1. 在 `popup.js` 监听三个输入框的 `blur` 事件触发自动保存。
- Rationale: 与用户预期的“失焦即保存”一致，改动最小。
- Alternative considered: 使用 `change` 事件；其触发时机受浏览器实现和控件类型影响，语义不如 `blur` 明确。

2. 自动保存前先读取并比较“最近一次已保存的规范化值”，仅在值变化时写存储。
- Rationale: 避免重复 `chrome.storage.sync.set` 写入和冗余状态闪烁。
- Alternative considered: 每次失焦都写入；实现更简单但会产生不必要写操作。

3. 自动保存复用 `saveProviderSettings` 进行规范化与校验；校验失败时展示简短提示并跳过写入。
- Rationale: 保持所有入口共享同一校验逻辑，避免 popup 与其他设置入口行为分叉。
- Alternative considered: 在 `popup.js` 单独实现轻量校验；会造成规则重复与未来不一致风险。

4. 保留现有表单提交保存能力作为兼容路径，自动保存作为新增主路径。
- Rationale: 降低回归风险，允许用户继续手动保存。
- Alternative considered: 移除 submit 保存与按钮；需要同时改 HTML 与交互文案，非本次必要范围。

## Risks / Trade-offs

- [Risk] 失焦时的异步保存可能与快速连续操作交叠，产生状态文案被后续请求覆盖。  
  → Mitigation: 在保存流程中串行化请求（或基于进行中的 Promise 阻止并发）并仅让最后一次结果更新状态。

- [Risk] 用户填到一半先离开字段，因其他字段为空导致保存失败，可能看到错误提示。  
  → Mitigation: 使用“Fill all fields to auto-save.” 这类简短可理解提示，并在后续成功保存后覆盖为成功状态。

- [Risk] 保留 submit 与 blur 两条路径会增加事件触发复杂度。  
  → Mitigation: 抽取统一 `persistCurrentForm(reason)`，由 submit/blur 复用同一逻辑。

## Migration Plan

- 仅前端 popup 逻辑与对应测试变更，无数据迁移。
- 回滚策略：恢复到仅 submit 触发保存的 `popup.js` 版本即可。

## Open Questions

- 无阻塞性问题；默认继续保留 Save 按钮作为兼容交互。
