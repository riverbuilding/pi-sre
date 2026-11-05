# Session Projection 与 TranscriptContext

更新：2026-11-04，生产已切换请求管线。Pi 类型与转换由依赖提供；Pi SRE 不从会话投影恢复权限、预算或领域证据。单一 Session、扩展初始化一次；历史导航与 reload 入口的全面禁用仍是[独立交付缺口](./TUI_COMMAND_VISIBILITY_AND_RESTRICTIONS.md)。

本文基于项目当前使用的 `@earendil-works/pi-coding-agent` **0.99.0**，说明
`session.sessionManager.buildSessionProjection().messages` 与 `TranscriptContext` 的关系。

两者处于同一条数据流的不同阶段：前者是会话记录投影出的有效消息历史，后者是传给模型 provider 的标准化请求上下文。

## 数据流

```text
SessionManager 保存的会话记录
    ↓ 选择当前分支、处理 compaction、应用 context edits
buildSessionProjection().messages：AgentMessage[]
    ↓ 恢复到运行时，随对话继续追加消息
运行时消息
    ↓ transformContext：扩展可调整本次请求的消息
    ↓ convertToLlm：将 Pi 消息转换为模型支持的消息
Message[]
    ↓ normalizeContext({ messages })
TranscriptContext
    ↓ provider 按模型 API 转换请求
模型请求
```

这是概念上的数据流，并不表示每次模型请求都会重新调用 `buildSessionProjection()`。
会话恢复后的运行时还会接收新消息、工具结果和排队的 steering 消息。

## 两者分别表示什么

| 对比项   | `buildSessionProjection().messages`                                | `TranscriptContext`                     |
| -------- | ------------------------------------------------------------------ | --------------------------------------- |
| 所属层   | 会话存储与恢复                                                     | 模型 provider 调用                      |
| 类型     | `AgentMessage[]`                                                   | 包含 `messages: Message[]` 的标准化对象 |
| 消息格式 | 可以包含 `custom`、`compactionSummary`、`branchSummary` 等 Pi 消息 | 已转换为模型层支持的消息类型            |
| 含义     | 当前分支经过压缩、编辑后的有效历史                                 | 本次传给 provider 的标准化上下文        |

### Session projection

`buildSessionProjection()` 沿当前 leaf 所在分支构建投影，处理最近一次 compaction，并应用有效的 context edits。
被摘要覆盖的历史不再直接出现在消息数组中；被编辑的消息使用替换内容，被省略的消息不再贡献内容。
因此，`.messages` 不是完整的原始历史记录。

返回值除了 `messages`，还有 `entries`、`thinkingLevel` 和 `model`。
其中 `entries` 保留每条投影贡献与原始会话 entry 的对应关系，而 `messages` 是这些贡献展平后的数组。

### TranscriptContext

`TranscriptContext` 是 `pi-ai` 的 provider 输入类型。其核心内容为 `messages: Message[]`，并带有一个 TypeScript 类型品牌标记。
该标记用于区分普通请求输入 `Context` 与经过标准化的上下文，不是发给模型的业务字段。

`normalizeContext()` 负责生成该类型。如果普通 `Context` 中包含独立的 `systemPrompt` 或 `tools`，
它会把这些字段合并到新增的开头 system 消息中。`TranscriptContext` 通过 transcript 中的 system 消息携带提示词和工具声明。
当前 agent loop 调用的是 `normalizeContext({ messages: llmMessages })`，相关 system 信息已在消息序列中。

`TranscriptContext` 仍是 provider 无关的格式；provider 随后会把它转换为对应模型 API 的请求格式。

## 当前环境消息

[request-environment-extension.ts](../src/tui/request-environment-extension.ts) 使用 `customType: "pi-sre-environment"` 记录当前环境：all/exact、available targets、unavailable selected、MCP 状态、namespace policy 和 READ ONLY。变更通知来自同一运行事实，不维护第二份事件或调查记录，不输出 endpoint。

Projection 中的消息保留 `role: "custom"`、`customType`、`content`、`display: false` 和时间。`convertToLlm()` 将其正文转换为 provider 可见 user message；`display: false` 只影响 UI，不阻止模型读取。它依然是应用 custom message，不会被请求适配器误认作用户 message_start，因此不会获得新预算。

空闲时 `pi.sendMessage(..., {deliverAs: "steer"})` 直接追加消息，不启动模型；活动期间排队 steering，在后续处理点进入上下文。它不改写已发送的模型请求，也不作为调用授权或取消机制。选择可在活动期间变更，已接收调用保留原 context；之后新调用按当前选择校验。

## 压缩与恢复

每次模型请求前的 `context` hook 检查输入中是否已有最新环境正文；缺失或过期时补充当前快照。它覆盖手动 compaction 后下一轮以及 overflow compaction 后直接重试，不依赖再次触发 before_agent_start。相同快照去重；当前环境来自实际运行状态，不能从历史文本恢复权限。

Pi compaction 是有损摘要。工具结果和模型判断只在 messages 中，没有独立 EvidenceStore、引用完整性、假设 revision、结论对象或 JSONL 调查归档。丢失的历史变化不重建：恢复消息说明同名 context 可能改变目标，旧结果保留原 context/时间，缺少事实或来源时应说明限制并按需重查。

工具结果的实际 context、操作、namespace policy、执行状态、客户端执行区间和截断在 `content` 内。仅存于 `details` 的信息不能当作 provider 可见来源。Pi 前置 schema/abort 拒绝通过 session-owned `message_end` boundary 替换为安全未执行结果，再进入 transcript/provider。模型生成的 assistant 参数不属于服务端结果脱敏范围。

## 检查位置

需要查看有效历史使用 `sessionManager.buildSessionProjection().messages`；检查实际模型输入使用 provider 的 TranscriptContext。两者可能因运行时新增消息、context hook 与转换而不同。读取投影不等于提交会话变更；持久化由 Pi API 负责。

验证见 [真实 Pi 请求边界](../tests/integration/pi-execution-boundaries.test.ts)、[环境测试](../tests/unit/tui/request-environment.test.ts)与[生产组合测试](../tests/integration/application-lifecycle.test.ts)。依赖中的 `session-manager.js`、`messages.js`、agent-loop 和 transcript 转换定义 Pi 自身的投影机制；这些机制的存在不代表 Pi SRE 支持分支恢复产品流程。
