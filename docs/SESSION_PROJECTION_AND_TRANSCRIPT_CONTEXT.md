# Session Projection 与 TranscriptContext

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

## Pi SRE 的 cluster scope 示例

[cluster-extension.ts](../src/tui/cluster-extension.ts) 使用持久化的 custom message 记录当前 cluster scope。
下面示例省略了具体时间和完整 scope 文案。

在 projection 中，它保留 Pi 的消息类型和 UI 元数据：

```ts
const scopeMessage = {
  role: "custom",
  customType: "pi-sre-cluster-scope",
  content: 'Cluster: "alpha"...',
  display: false,
  timestamp: 123,
};
```

经过 `convertToLlm()` 后，它作为 user 消息进入 `TranscriptContext.messages`：

```ts
const modelMessage = {
  role: "user",
  content: [{ type: "text", text: 'Cluster: "alpha"...' }],
  timestamp: 123,
};
```

`display: false` 控制 UI 展示，不会阻止该消息进入模型上下文。
`customType`、`display` 和 `details` 不会作为该转换结果的字段传给 provider。

扩展查询 projection，是为了检查当前有效历史中是否还存在最新的 scope 快照：

- `session_start` 查找已有快照，为订阅状态变化后的去重提供依据。
- `before_agent_start` 再次检查；如果 compaction 或分支导航移除了快照，或者历史中的快照与当前状态不同，就返回当前快照，由 Pi 持久化。
- 状态发生变化时，通过 `pi.sendMessage(..., { deliverAs: "steer" })` 记录更新；活动工作期间由 Pi 排队交付。

scope 消息用于向模型解释应用状态。实际 cluster 选择与调用范围仍由应用状态和 MCP bridge 强制执行。

## Scope updates during and between agent runs

Pi SRE sends scope updates through
`pi.sendMessage(message, { deliverAs: "steer" })`, without setting `triggerTurn`.
Pi's `AgentSession` decides how to deliver each message based on whether the agent is running.
Specifying `deliverAs: "steer"` does not always enqueue a steering message.

| Agent state | Delivery                                                                      | Effect on model requests                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Running     | Queue the update through `agent.steer()`                                      | The loop consumes the update at a turn boundary, after the current response and any associated tool results, appends it to the context, and makes another model request. |
| Idle        | Append the update directly to session history and refresh the runtime context | No model request starts automatically. The next user prompt includes the update in its history.                                                                          |

An update does not rewrite a request that has already been sent. In the connection-loss
integration test, the message sequence is conceptually:

```text
First request:
  [system information, initial alpha scope, user question]

Connection loss during the first request:
  steering queue = [scope unavailable update]

Second request, after the first response and consumption of the queued update:
  [system information, initial alpha scope, user question,
   first assistant response, scope unavailable update]
```

The initial `alpha` snapshot is created before the prompt: the `session_start` handler
subscribes to the cluster manager, and `subscribe()` immediately delivers the current state.
Because the agent is idle, this snapshot goes directly into session history. Only the later
connection-loss update enters the steering queue in this test. Two custom messages in the
final session history do not imply that two messages were queued together.

The mock model function returns a response stream on both calls. After the second response,
the loop ends because there are no tool calls or further queued messages.

### Cluster switching and availability changes

The current implementation blocks explicit cluster switching while agent work is active.
The user must wait for the work to finish or cancel it before switching. Changes observed
during an active loop therefore include scope availability changes, such as an MCP
connection loss; they should not be interpreted as permission to switch clusters mid-run.

The extension compares the generated scope description with the last recorded description.
If they are identical, it sends no update and causes no additional model request.
Scope messages inform the model; application state and the MCP bridge independently enforce
the selected cluster and block cluster-dependent calls when scope is unavailable.

### Why notify the model when scope becomes unavailable?

Notifying the model is useful because connection loss changes the assumptions under which
it can continue the investigation. Without the update, it may keep attempting tool calls
or describe ongoing cluster access based on an outdated scope snapshot. A subsequent model
request gives it an opportunity to explain the interruption, summarize existing evidence,
and identify what remains unverified. For example:

> The Kubernetes MCP connection was lost, so I cannot collect further data. Based on the
> evidence obtained before the disconnection, I can confirm the following observations.
> The remaining hypotheses have not been verified.

Previously collected evidence remains an observation from the time it was obtained.
Connection loss does not erase it, but the model must not present it as a fresh observation
or claim that current access is still available. Selecting a cluster also does not by
itself establish that Kubernetes authentication or authorization has succeeded.

The notification supports explanation and investigation wrap-up. Application state and
the MCP bridge must enforce the loss of access independently: subsequent cluster-dependent
calls must be blocked when scope is unavailable, regardless of the model's response.
The model cannot restore access or switch clusters merely by interpreting a scope message.

This approach costs an additional model request and does not immediately interrupt an
in-flight model request or tool operation. Cancellation and tool failure handling require
separate application mechanisms; enqueueing a steering update does not cancel either one.

For Pi SRE's observe, diagnose, and explain scope, allowing the model to summarize existing
evidence and explain the interruption is a useful reason to retain this behavior. It does
not guarantee that the model will finish in exactly one additional request.
If the product instead requires every investigation to stop immediately on connection
loss, the application would need an explicit cancellation policy and a direct UI notice;
an additional model request solely to report the interruption would then be optional.
That is an alternative policy, not the behavior implemented by the steering message itself.

## 使用时如何选择

需要判断“当前有效会话历史中是否保留某条 Pi 消息”，使用 `buildSessionProjection().messages`。
需要检查“本次传给模型 provider 的标准化上下文”，查看调用处的 `TranscriptContext`。

两者不能直接视为相同数组：运行时新增消息、请求前的 `transformContext` 和 `convertToLlm` 转换都可能造成差异。
读取或修改投影结果也不等于提交会话变更；持久化变更应使用 Pi 提供的会话或扩展 API。

## 对应实现与验证

- Pi 依赖中的 `dist/core/session-manager.js`：`buildContextEntries()`、`buildSessionProjection()`。
- Pi 依赖中的 `dist/core/messages.js`：`convertToLlm()`。
- `pi-agent-core` 依赖中的 `dist/agent-loop.js`：`streamAssistantResponse()`，展示消息转换与标准化顺序。
- `pi-ai` 依赖中的 `dist/types.d.ts` 和 `dist/utils/transcript.js`：`TranscriptContext` 类型与 `normalizeContext()`。
- [cluster scope 集成测试](../tests/integration/cluster-scope-messages.test.ts)：验证去重、compaction 后恢复，以及活动工作期间的 scope 更新。
