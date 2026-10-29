# 调查工具的用途与调用时机

本文说明当前 Pi SRE 中 `/incident`、`/evidence` 命令与五个本地调查工具的区别，以及 LLM 在诊断过程中何时使用这些工具。

## 1. Commands 给用户用，Tools 给 LLM 用

两类入口操作同一份 Investigation 数据，但服务于不同的调用者：

| 入口 | 调用者 | 用途 |
| --- | --- | --- |
| `/incident` | 用户 | 查看当前调查的 scope 和状态摘要 |
| `/incident new <question>` | 用户 | 显式开始新调查，替换当前调查 |
| `/evidence`、`/evidence <id>` | 用户 | 查看证据列表或指定证据 |
| 五个本地调查 tools | LLM | 读取调查状态和证据、记录假设、提交结论 |

注册 tools，是为了让 LLM 能通过结构化接口参与调查管理。它们由 Pi SRE 在本地实现，不经过 Kubernetes MCP，也不访问集群。

Kubernetes MCP tools 负责获取集群事实；本地调查 tools 负责围绕这些事实读取和维护调查状态。后者虽然可以更新本地假设和结论，但不会修改 Kubernetes 资源，符合诊断只读边界。

## 2. 五个工具分别什么时候使用

| Tool | 作用 | 典型调用时机 |
| --- | --- | --- |
| `investigation_get` | 读取当前调查的问题、状态、scope 摘要、revision、focus 和结论；也可按 ID 读取一个 hypothesis 或 execution outcome | 多轮对话后继续诊断时确认进度；更新假设前读取其版本；提交结论前取得当前调查 revision |
| `evidence_list` | 分页读取已经保存的证据记录 | 回顾已查到的事实，判断下一步需要查什么，避免重复查询 |
| `evidence_get` | 按 evidence ID 读取一条已保存证据及其来源 | 引用证据前核对内容和来源；重新查看之前采集的观察结果 |
| `hypothesis_upsert` | 创建或更新假设，记录支持证据、反驳证据和推理理由 | 提出待验证原因，或根据新证据将假设更新为 `supported` / `rejected` |
| `investigation_conclude` | 验证并排队提交调查结论 | 已有足够依据解释问题，或信息不足、无法继续而需要以 `inconclusive` 结束调查 |

这些工具不是每轮都必须按顺序调用的固定流程。当前提示词说明了用途和约束，但没有强制 LLM 每轮调用全部工具。

### 读取已有状态和证据

`investigation_get`、`evidence_list` 和 `evidence_get` 都只读取当前应用进程中保留的调查数据。因此，即使 MCP 暂时不可用，LLM 仍可回顾已经收集到的证据。

读取存储证据不会重新查询集群，也不代表集群当前状态仍与采集时一致。需要确认最新状态时，应重新调用可用的 Kubernetes MCP 诊断工具。

### 记录假设

`hypothesis_upsert` 将解释与观察事实分开管理：

- `candidate`：待验证的候选解释。
- `supported`：已有支持证据的解释。
- `rejected`：已有反驳证据的解释。

模型需要提供假设陈述、理由，以及支持和反驳它的 evidence ID。创建时省略 `id` 和 `expectedRevision`；更新时必须同时提供假设 ID 和该假设的预期 revision，防止根据旧版本覆盖状态。`supported` 和 `rejected` 状态需要对应的已存储证据引用。

### 提交结论

`investigation_conclude` 接收当前 Investigation 的 aggregate revision、解释、终态和引用的 hypothesis / evidence ID。这里的 revision 属于整个调查，与更新某个假设时使用的假设 revision 不同。

- `resolved`：问题已经得到解释，必须引用有证据支持的 `supported` 假设；不表示基础设施已修复。
- `inconclusive`：记录无法得出明确结论的不确定性，可以没有证据。

工具返回 `pending` 只表示提案已经通过验证并排队。应用在本轮 agent 工作结束后尝试正式提交；后续状态变化、会话绑定失效、未完成的工作、中断或模型提供方错误等都可能阻止提交。应在后续轮次检查是否真正进入终态。

## 3. 一个完整诊断示例

用户问：“为什么 checkout 的 Pod 一直重启？”以下是可能的调用过程，而非强制步骤。

1. **确认调查状态。** 应用按生命周期规则建立或沿用调查。LLM 如需确认当前问题、scope 或状态，可以调用 `investigation_get`。
2. **采集事实。** LLM 调用 Kubernetes MCP 诊断工具查看 Pod、事件等，并在每个集群相关调用中显式提供允许范围内的精确 `context`。成功的诊断结果由应用自动采集为 evidence，返回结果中包含已保存的 evidence ID；模型不需要额外调用“保存证据”工具。失败或中断的调用不作为 evidence。
3. **记录候选解释。** LLM 用 `hypothesis_upsert` 创建“内存不足导致 Pod 重启”的 `candidate` 假设，记录当前依据和仍待确认的理由。
4. **继续验证。** LLM 通过 MCP 获取更多信息；必要时用 `evidence_list` / `evidence_get` 回看已有证据。假设查到 `OOMKilled`，模型可以引用该证据，结合其他观察判断是否把假设更新为 `supported`。
5. **提交结论。** 解释充分后，LLM 获取最新调查 revision，调用 `investigation_conclude`，提交解释和证据引用。应用在本轮工作结束后检查条件并尝试提交。这个结论说明诊断结果，不执行扩容、重启或其他修复操作。

如果后续证据推翻了 OOM 假设，模型可以将它更新为 `rejected`，记录反驳依据并继续检查其他原因。如果必要信息不可用且无法继续，也可以提交 `inconclusive`，说明限制与不确定性。

## 4. 为什么不只在聊天中描述推理

聊天文字能表达判断，但不足以可靠地驱动应用状态。例如，“可能是 OOM”究竟是候选假设，还是已经得到证据支持；“诊断完成”是否应该结束 Incident，都需要明确的结构化操作。

这些工具让应用可以校验：

- 引用的证据和假设是否属于当前绑定的 Incident。
- 更新是否基于当前版本，避免旧状态覆盖新状态。
- 结论是否满足生命周期和引用要求。
- 结束调查时是否还有未完成的工作。

应用校验引用、版本和生命周期约束；证据在语义上是否足以支持某个推断，仍然主要由模型判断。结构化工具不等于应用自动证明了根因。

## 5. 权限与实现边界

工具的 Incident 身份和权限来自当前绑定会话，模型不能传入另一个 Incident ID，也不能通过这些工具修改 scope rule。用户通过 `/clusters` 选择 scope；活跃调查的 rule 保持不变，新的选择用于下一次调查。

当前公开工具可以读取会话所指向的当前或最近结束的 Investigation，不提供任意历史 Incident 的查询能力。结构化状态保留在应用进程内，不能仅凭聊天记录在进程重启后恢复。

实现与相关说明：

- [工具和命令注册](../src/runtime/investigation-tools.ts)
- [模型系统提示词](../src/runtime/system-prompt.ts)
- [Investigation 生命周期与历史查询](./INVESTIGATION_LIFECYCLE_AND_HISTORY.md)

