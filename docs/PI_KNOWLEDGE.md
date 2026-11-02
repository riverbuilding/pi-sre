# Pi Knowledge

本文记录 Pi 运行时的接口与执行语义，供阅读代码、编写扩展和测试时参考。接口说明基于项目安装的 `@earendil-works/pi-coding-agent` **0.99.0**，核对日期为 2026-11-02；升级后应重新检查类型声明与实现。这里描述 Pi 能力，不代表 Pi SRE 已启用全部能力。

## 事件监听与执行拦截

### `pi.on()` 与 `session.subscribe()`

两者都能观察事件，但职责不同：`pi.on()` 在扩展中注册生命周期处理器，部分事件允许修改数据或控制执行；`session.subscribe()` 向持有 `AgentSession` 的应用或测试代码提供会话运行通知。

| 对比     | 扩展中的 `pi.on()`                           | `session.subscribe()`                         |
| -------- | -------------------------------------------- | --------------------------------------------- |
| 注册位置 | 扩展 factory，通过 `ExtensionAPI` 注册       | 持有 `AgentSession` 的应用或测试代码          |
| 订阅方式 | 按事件名注册处理器                           | 接收会话事件，再判断 `event.type`             |
| 典型用途 | 输入处理、上下文转换、工具策略、生命周期逻辑 | UI 更新、执行状态跟踪、日志、测试断言         |
| 返回值   | 按事件契约，部分可修改、阻止或继续执行       | 不作为流程决策结果                            |
| 异步行为 | 支持异步处理器，运行时等待对应处理           | 回调类型为 `void`，分发时不等待返回的 Promise |
| 取消订阅 | 返回取消函数                                 | 返回取消函数                                  |

`pi.on()` 也包含纯通知事件。不能因为注册了处理器，就假设任意返回值都能影响流程；必须查看该事件的返回类型。

```ts
pi.on("input", (event) => (event.text === "consumed" ? { action: "handled" } : undefined));
```

这里的 `{ action: "handled" }` 表示输入已由扩展消费，不再因此启动正常的模型运行。`undefined` 则继续后续处理。

```ts
const unsubscribe = session.subscribe((event) => {
  if (event.type === "agent_start") {
    events.push(event.type);
  }
});
```

这里记录会话通知。回调返回 `{ action: "handled" }` 不会消费输入或阻止 Agent。需要异步工作时，应由应用显式管理完成、取消和错误，不能依赖此订阅器等待。

两套事件有交集，但不是同一份事件列表：

- 两边都有 `agent_start`、`agent_end`、`agent_settled`、消息事件和工具执行事件等。
- 扩展侧提供 `input`、`before_agent_start`、`context`、`tool_call` 等处理入口。
- 会话订阅额外提供 `auto_retry_start/end`、`queue_update`、`compaction_start/end` 等通知。
- 同名事件的载荷也可能不同。例如会话侧 `agent_end` 额外包含 `willRetry`。

### 常用扩展事件

| 环节           | 事件                                                                                            | 能力                                                        |
| -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 输入           | `input`                                                                                         | 放行、转换或消费输入                                        |
| 运行前         | `before_agent_start`                                                                            | 添加自定义消息、调整系统提示                                |
| 模型上下文     | `context`                                                                                       | 转换会话消息；不包含提示与工具系统消息，Pi 随后恢复这些状态 |
| 完整模型上下文 | `context_with_system`                                                                           | 转换包含系统消息的完整请求消息，需保留首条系统消息          |
| Provider 请求  | `before_provider_request`                                                                       | 调整 Provider 请求载荷                                      |
| Provider 响应  | `after_provider_response`、`provider_stream_event`                                              | 观察响应和解析后的 Provider 流事件                          |
| 工具执行前     | `tool_call`                                                                                     | 原地修改输入参数，或通过返回值阻止执行                      |
| 工具执行后     | `tool_result`                                                                                   | 调整结果内容、结构化结果、错误状态等                        |
| 消息完成       | `message_end`                                                                                   | 替换完成后的消息，必须保持原角色                            |
| 每轮结束       | `turn_end`                                                                                      | 添加会话条目、请求继续                                      |
| 最终结束前     | `agent_before_settle`                                                                           | 添加会话条目、请求一次继续                                  |
| 最终结束       | `agent_settled`                                                                                 | 通知运行已完全结束，无流程控制返回值                        |
| 会话操作前     | `session_before_switch`、`session_before_fork`、`session_before_compact`、`session_before_tree` | 按各自契约取消或定制对应操作                                |

其他通知包括 `session_start`、`session_shutdown`、`model_select`、`thinking_level_select`、`message_start/update`、`tool_execution_start/update/end` 等。此表列出常用入口，完整列表以 `ExtensionAPI.on()` 的重载声明为准。

需要区分的执行边界：

- `tool_call` 是执行前的策略钩子；`tool_execution_start` 是执行状态通知。
- `agent_end` 表示一个 Agent 循环结束，之后仍可能自动重试、压缩恢复或继续工作。
- `agent_settled` 表示本次运行已完全收尾，不会再自动继续。
- `provider_stream_event` 提供 Pi 解析后的 Provider 事件，不保证是原始 HTTP 字节或 SSE 帧；它是通知接口，应按只读数据处理。

### `context` 的触发时机与请求级作用域

`pi.on("context", ...)` 在 Agent 准备每次模型调用的上下文时触发，发生在 `streamFunction` 之前，不是每次用户输入只触发一次。

当前版本的关键顺序如下；图中省略其他请求准备步骤：

```text
准备本次会话消息
    ↓
context：等待扩展处理会话消息，恢复系统消息
    ↓
context_with_system：处理包含系统消息的完整上下文
    ↓
转换为模型支持的消息格式（convertToLlm）
    ↓
调用 streamFunction
```

以下情况只要继续进入正常 Agent 模型调用路径，就会重新触发 `context`：

- 用户提交初始问题，准备首次调用模型。
- 工具执行完成，再次调用模型分析结果。
- steering 或 follow-up 被消费，需要继续调用模型。
- Pi 自动重试，或压缩恢复后重新调用模型。

这里的重试指 Pi 重新进入 Agent 模型调用路径。Provider 内部的 HTTP 重试不一定重新触发此事件；独立的压缩摘要请求也不能直接按此规则推断。输入若被 `input` 处理器消费且未启动模型调用，则不会因此触发 `context`。

执行边界测试中的四次调用可表示为：

```text
initial  → context → model:1
steering → context → model:2
follow-1 → context → model:3
follow-2 → context → model:4
```

因此，以下处理器会为四次调用分别补入环境信息：

```ts
pi.on("context", (event) => ({
  messages: [
    ...event.messages,
    {
      role: "custom",
      customType: "environment",
      content: "CURRENT_ENVIRONMENT",
      display: false,
      timestamp: Date.now(),
    },
  ],
}));
```

`context` 转换作用于本次请求使用的消息副本。通过返回的 `messages` 加入环境消息，不会自动追加到 Agent 的持久会话历史；调用四次不会因此在历史中累积四条环境消息。若需要每次请求获得最新环境状态，应在处理器中读取当前状态并构造消息；固定返回同一文本不会自动刷新其内容。处理器另外调用持久化 API 的副作用不属于这里的请求级转换。

与之相比，此测试的 `before_agent_start` 只触发一次：初始请求启动后，steering 和 follow-up 都在同一个 Agent 循环中被消费。不能用 `before_agent_start` 的次数推断模型调用次数，也不能用一次 prompt 的次数推断 `context` 的次数。

实现核对入口是 SDK 的 `transformContext` 接线、扩展 runner 的 `emitContext()` 和核心 Agent loop 的 `streamAssistantResponse()`。

### 其他入口

#### 底层 `session.agent.subscribe()`

```ts
const unsubscribe = session.agent.subscribe((event, signal) => {
  // 观察核心 Agent 循环；signal 可用于关联取消。
});
```

它接收核心 `AgentEvent`，不包含 `AgentSession` 自己添加的自动重试、压缩等会话通知。与 `session.subscribe()` 不同，其回调支持 `Promise<void>`，Agent 会等待异步处理器。应用层观察通常优先使用 `session.subscribe()`。

#### Agent 直接执行钩子

这些是可设置的函数，不是事件订阅：

| 钩子               | 作用                                     |
| ------------------ | ---------------------------------------- |
| `transformContext` | 在转换成模型消息前处理上下文             |
| `beforeToolCall`   | 工具执行前检查或阻止                     |
| `afterToolCall`    | 调整工具执行结果                         |
| `finishTurn`       | 在轮次边界决定继续或结束                 |
| `streamFunction`   | 接管模型流式调用，测试可借此提供离线响应 |

`AgentSession` 自身也使用底层钩子连接扩展机制。直接赋值会替换已有函数，必须先理解现有接线；需要保留逻辑时，保存并调用原函数。测试中包装 `finishTurn` 的做法属于这一类。

业务策略优先通过扩展钩子实现，避免覆盖运行时接线。

#### 扩展间自定义事件总线 `pi.events`

```ts
const unsubscribe = pi.events.on("sre:scope_changed", (data) => {
  // 接收应用自行发布的数据；data 为 unknown，使用前按需要校验。
});

pi.events.emit("sre:scope_changed", { contexts: ["dev"] });
```

此总线用于扩展间通信，需要主动 `emit()`，不会自动转发 `input` 或 `agent_start` 等内置事件。`emit()` 也不提供可等待的异步处理或执行否决契约。

## 执行边界测试中的事件记录

`tests/integration/pi-execution-boundaries.test.ts` 中的 `events` 是测试自行维护的字符串数组，不是 Pi 的事件对象集合。多个入口向同一个数组追加记录：

```ts
// 扩展钩子
pi.on("before_agent_start", () => {
  events.push("before_agent_start");
});

// 会话通知
session.subscribe((event) => {
  if (event.type === "agent_start") events.push(event.type);
});

// 模拟模型调用内部
events.push(`model:${++calls}`);
```

因此数组可以同时包含 `"before_agent_start"`、`"agent_start"` 和 `"model:1"` 等记录。

```ts
expect(events.filter((e) => e === "before_agent_start")).toHaveLength(1);
```

这个断言只计数 `"before_agent_start"`，不计入 `"model:N"`。对应测试验证：一次 `session.prompt("initial")` 接受初始输入后，steering 与逐条 follow-up 可在同一个 Agent 循环中引发四次模型调用，而 `before_agent_start` 只出现一次。`context` 则为每次模型调用补入 `CURRENT_ENVIRONMENT`。

测试还包装 `session.agent.steer/followUp`，用 `WeakMap` 为消息对象标记来源，在 `message_start` 时按对象身份识别初始消息、steering 和 follow-up。该检查依赖当前公共队列路径在交付时保持对象引用；文本可能相同，不能可靠标识来源。这里的 `origins.get(message) ?? "initial"` 是测试约定，不是 Pi 事件自带的来源字段。

## 阅读与核对入口

- [Pi v0.99.0 扩展文档](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/extensions.md)：生命周期与事件契约。
- [扩展类型](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/src/core/extensions/types.ts)：`ExtensionAPI.on()`、事件载荷与返回值。
- [AgentSession](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/src/core/agent-session.ts)：`AgentSessionEvent`、订阅分发与扩展转发。
- [核心 Agent](https://github.com/earendil-works/pi/blob/v0.99.0/packages/agent/src/agent.ts) 与 [核心类型](https://github.com/earendil-works/pi/blob/v0.99.0/packages/agent/src/types.ts)：底层订阅与执行钩子。
- 本地安装包 `node_modules/@earendil-works/pi-coding-agent/dist/core/` 下的 `agent-session.d.ts/js`、`extensions/types.d.ts`、`event-bus.d.ts`：当前项目实际消费的声明与实现。
- [Session 生命周期与 SRE 扩展](./SESSION_LIFECYCLE_AND_EXTENSIONS.md)：项目扩展接线及其历史设计记录。
