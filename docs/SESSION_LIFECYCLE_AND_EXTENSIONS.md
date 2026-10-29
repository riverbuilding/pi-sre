# Session 生命周期、Investigation Binding 与 SRE 扩展

本文记录当前 Phase 4 实现中 session 操作、investigation 绑定和内置扩展的关系。
Session 是 Pi 的对话与运行时抽象；Incident 是 SRE 的调查领域对象，两者分别管理。

## Session 操作

| 操作                      | Session ID                        | Investigation 行为                                     |
| ------------------------- | --------------------------------- | ------------------------------------------------------ |
| `/reload`                 | 不变                              | 保留关联 incident，重新绑定                            |
| `/new`                    | 创建新 ID                         | 不继承旧 incident；后续符合条件的输入可创建新 incident |
| `/fork`                   | 创建新 ID，复制所选分支的对话历史 | 不继承旧 incident 的执行权限、证据和预算               |
| resume / 切换已有 session | 使用目标 session 原有 ID          | 如果当前进程仍保留其关联，则恢复该 incident            |
| 对话树导航                | 不变                              | 保留 incident                                          |

表中描述操作成功后的行为。被生命周期钩子否决的 new/fork 等操作不会替换当前绑定。
启动应用当前总是创建新 session；跨进程恢复 investigation 不能从 Pi 对话持久化推导出来。
Controller 的 session → incident 映射及调查状态由当前进程持有，flush 后也会移除对应映射。

Fork 复制的历史可能包含旧 scope 消息，但历史消息不授予诊断权限。
实际调用仍由当前绑定、incident scope 和 MCP bridge 校验；scope 扩展负责同步当前状态。

## 为什么同一个 session 会重新 bind

`registerInvestigationLifecycle()` 在每次 `session_start` 时调用
`controller.bind(ctx.sessionManager.getSessionId())`，在 `session_shutdown` 时解绑。

Pi reload 的主要顺序是：

```text
旧扩展收到 session_shutdown（reason: reload）
    ↓
旧扩展解绑并释放订阅、工作守卫等局部状态
    ↓
Pi 使旧 runner 失效，重新加载资源并重建扩展
    ↓
新扩展收到 session_start（reason: reload）
    ↓
使用相同 session ID 创建新的 binding
```

因此 session 身份不变，扩展实例及其持有的绑定发生变化。
进程持有的 `McpController`、`InvestigationController` 和 incident 数据继续存在；
reload 本身不会重置 incident 的预算、已有证据，也不等于 MCP reconnect。
解绑会使旧执行权限失效并结算未完成的诊断，迟到结果不能作为新绑定下的证据提交。

另一个例子是 A → B → A：返回 A 会恢复原有关联的 incident，但必须取得新的 binding，
第一次进入 A 时留下的旧引用不能重新获得权限。

## bindingEpoch 的含义与当前冗余

```ts
export interface InvestigationBinding {
  readonly sessionId: string;
  readonly bindingEpoch: number;
}
```

`sessionId` 标识会话；`bindingEpoch` 显式记录该 controller 的绑定代次。
每次调用 `bind()` 都递增，不是每个 session 分别计数，也不是 incident revision。

```text
bind A       → { sessionId: A, bindingEpoch: 1 }
reload A     → { sessionId: A, bindingEpoch: 2 }
切换到 B     → { sessionId: B, bindingEpoch: 3 }
返回 A       → { sessionId: A, bindingEpoch: 4 }
```

需要区分绑定代次，不代表当前实现必须依赖这个数字字段。当前 `isBound()` 实际检查：

```ts
return !this.#disposed && binding === this.#binding;
```

每次 `bind()` 都创建新的冻结对象，所以旧 binding 或其对象拷贝都会被拒绝。
`unbind(expected)` 同样比较对象引用，避免旧扩展的清理逻辑解绑较新的绑定。
因此不能把防止旧 binding 生效的能力单独归因于 `bindingEpoch`。

`bindingEpoch` 还被复制进 effective scope，参与序列化缓存键；不过解绑时已有
`lifecycleEpoch` 递增。因此从当前实现看，这个字段在失效判定上存在冗余，主要显式表达绑定代次。
本文记录现状，不改变字段或校验逻辑。

相关版本字段的职责不同：

| 字段                   | 表达的变化                                                |
| ---------------------- | --------------------------------------------------------- |
| `bindingEpoch`         | 绑定代次                                                  |
| `lifecycleEpoch`       | 调查执行生命周期失效，例如解绑、取消、创建或结束 incident |
| `connectionGeneration` | MCP 连接代次                                              |
| `inventoryRevision`    | Context inventory 版本                                    |
| `scopeRevision`        | Incident scope 版本                                       |

## 当前注册的 SRE 扩展

[pi-runtime.ts](../src/runtime/pi-runtime.ts) 显式注册两个 inline extension factory。
正常应用路径传入 `McpController` 时注册第一个；shell guard 始终注册。
这些是 SRE 自有注册逻辑，不要求用户额外安装第三方扩展。

### pi-sre-mcp-recovery

名称保留了早期 MCP recovery 的含义，目前实际聚合四组功能：

| 注册模块                         | 职责                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `registerMcpRecovery`            | 订阅 MCP 工具变化并更新工具注册，隐藏失效工具；提供 `/mcp_restart`；关闭时取消订阅                              |
| `registerInvestigationLifecycle` | 启动时 bind、关闭时 unbind；符合条件的用户输入自动创建或继续 incident；管理 agent 工作守卫                      |
| `registerClusterScope`           | 提供 `/clusters`；显示有效 scope、next selection 和只读状态；向模型上下文同步 scope；维护订阅和工作守卫         |
| `registerInvestigationTools`     | 注册本地调查工具及 `/incident`、`/evidence`；在 agent turn 结束时尝试提交仍有效的结论提案；关闭时清除待提交提案 |

本地调查工具为 `investigation_get`、`evidence_list`、`evidence_get`、
`hypothesis_upsert` 和 `investigation_conclude`。它们操作 SRE 调查状态，不直接调用 Kubernetes。
Kubernetes 诊断仍通过注册的 MCP 工具和 bridge 执行。

### pi-sre-read-only-shell-guard

拦截 Pi 的 `user_bash` 事件，拒绝用户 shell 输入通道的命令执行。
模型内置工具的禁用由 runtime 创建参数另外完成：使用 `noTools: "builtin"`，
并显式排除 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`。

[resource-loader.ts](../src/runtime/resource-loader.ts) 设置 `noExtensions: true`，
关闭项目目录及 agent-home 的扩展自动发现，同时允许上述显式注册的 inline factories。
它也关闭自动发现 skills、prompt templates、themes 和 context files。

## 实现与验证入口

- [InvestigationController](../src/app/investigation-controller.ts)：绑定、session 映射、scope 和诊断执行权限。
- [Investigation lifecycle](../src/runtime/investigation-lifecycle.ts)：session 与 agent 事件接线。
- [MCP recovery](../src/tui/mcp-restart-command.ts)、[cluster scope](../src/tui/cluster-extension.ts)、[investigation tools](../src/runtime/investigation-tools.ts)：扩展职责实现。
- [Controller 单元测试](../tests/unit/app/investigation-controller.test.ts)：旧绑定清理、会话隔离和旧执行失效。
- [Controller lifecycle 集成测试](../tests/integration/phase4-controller-lifecycle.test.ts)：reload、导航、resume、fork、new 与否决行为。
- [Lifecycle contracts 集成测试](../tests/integration/phase4-lifecycle-contracts.test.ts)：真实 Pi 生命周期契约。
- 当前安装的 Pi 依赖 `dist/core/agent-session.js`、`agent-session-runtime.js`、`session-manager.js`：reload 事件顺序及 session ID 创建行为。
- [Session projection 与 TranscriptContext](./SESSION_PROJECTION_AND_TRANSCRIPT_CONTEXT.md)：对话投影与 scope 消息进入模型上下文的方式。
