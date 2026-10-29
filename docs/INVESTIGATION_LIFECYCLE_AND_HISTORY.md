# Investigation 生命周期与历史查询

本文记录截至 2026-10-29 的当前实现，说明 `InvestigationController`、`InvestigationService` 如何管理 Incident，以及结束后的 Investigation 保存在哪里、如何查询。本文描述现有行为，不代表历史管理功能已完整实现。

## 1. 是否同时只维护一个活跃 Incident？

当前执行入口一次只绑定一个 Incident，但 Service 可以同时保存多个 Investigation。需要区分以下三个层次：

| 层次 | 当前实现 |
| --- | --- |
| 当前绑定 | Controller 只有一个 `#binding`，同一时刻只有当前绑定会话的开放 Incident 可以获得诊断执行权限；仍需通过 scope、连接和工具等检查 |
| 每个会话 | `#sessions` 保存 `sessionId → incidentId`，每个会话只指向当前或最近结束的一个 Incident |
| Service 存储 | `#investigations` 按 Incident ID 保存多个 Investigation，默认最多驻留 20 个，包括未结束和已结束的 |

因此：

- 如果“活跃”指当前具有诊断执行权限，则只有当前绑定会话所指向的一个 Incident。
- 如果“活跃”指状态仍为 `new` 或 `investigating`，则可以有多个。例如切换会话后，原会话的 Incident 不会自动结束，只是失去当前执行权限。
- `InvestigationService` 没有“全局唯一活跃 Incident”的约束，其操作显式接收 Incident ID。

`Incident` 表示问题、不可变 scope、生命周期状态和结论；`InvestigationState` 聚合 Incident、targets、evidence、hypotheses、outcomes、已消耗的诊断次数、时间和 revision。二者不等同于 Pi 的 AgentSession。

实现参考：

- [InvestigationController](../src/app/investigation-controller.ts)：`#binding`、`#sessions`、`bind`、`inspect`、`currentScope`。
- [InvestigationService](../src/investigation/investigation-service.ts)：`#investigations`、`DEFAULT_INCIDENT_LIMIT`、`start`。
- [InvestigationState](../src/domain/investigation-state.ts) 和 [Incident](../src/domain/incident.ts)。

## 2. 结束、替换与会话切换的行为

| 操作 | 旧 Investigation 的去向 | 会话指针 |
| --- | --- | --- |
| `investigation_conclude` 成功提交 | Incident 变为 `resolved` 或 `inconclusive`，完整 Investigation 仍驻留内存 | 继续指向这个已结束的 Incident |
| `/incident new <question>` 替换未结束的 Incident | 旧 Incident 自动以 `inconclusive` 结束，保留原有 evidence、hypotheses 等状态；创建新的 Investigation | 切到新 Incident |
| 已结束后输入下一条符合生命周期条件的问题 | 创建新的 Investigation，旧 Investigation 继续保留 | 切到新 Incident |
| 未结束时输入下一条符合生命周期条件的问题 | 继续原 Investigation，不会仅凭问题内容自动识别为新 Incident | 保持不变 |
| 切换会话、reload、取消工作 | 不会结束或归档 Incident；旧执行权限失效，已派发但未完成的工作记录中断结果 | 切换会话会更换当前 binding；原会话映射保留 |
| 显式归档成功 | 将已结束的 Investigation 写入 JSONL，然后从 Service 内存删除 | Controller 清理指向该 Incident 的会话映射 |
| 应用进程退出 | 未归档的结构化 Investigation 状态丢失 | 内存映射丢失 |

这里“替换时自动结束”发生在显式 `/incident new` 引发的 `replace` 中。普通轮次结束、取消诊断和切换会话都不等于结束 Incident。

`investigation_conclude` 在工具执行时只验证并排队结论，随后在 `agent_end`、活动工作结束后尝试提交；中断、binding 或 revision 变化等情况可能导致提交失败。工具返回 `pending` 时不能视为已经结束。

终态 Incident 不允许继续修改，需要创建新的 Incident。`resolved` 表示问题已得到解释，不表示基础设施已修复。

实现参考：[Controller 的 start/conclude](../src/app/investigation-controller.ts)、[Service 的 replace/conclude](../src/investigation/investigation-service.ts)、[生命周期 hooks](../src/runtime/investigation-lifecycle.ts)、[结论工具](../src/runtime/investigation-tools.ts)。

## 3. 如何获取历史 Investigation？

### 3.1 当前会话仍指向它

当前公开入口可以查询当前会话指向的 Investigation，包括最近结束但尚未被新 Incident 替换的那个：

| 入口 | 查询内容 |
| --- | --- |
| `investigation_get` | Investigation 摘要、状态、问题、revision、focus、结论，或指定的 hypothesis / execution outcome |
| `evidence_list` / `evidence_get` | 当前 Investigation 中保留的 evidence |
| `/incident` | 当前 Investigation 的 scope 和状态摘要 |
| `/evidence` | Evidence 分页或指定 ID 的记录 |

这些入口绑定当前会话，不接受任意历史 Incident ID。结束后诊断执行被阻止，但本地 inspection 仍然可用。

### 3.2 会话已经转向新的 Incident

旧 Investigation 仍在 `InvestigationService.#investigations` 内存 Map 中。应用内部持有该 Service 实例并知道旧 Incident ID 时，可以调用：

```ts
service.inspect(oldIncidentId);
service.evidenceList(oldIncidentId);
service.evidenceGet(oldIncidentId, evidenceId);
```

`inspect` 返回完整 Investigation 的独立深拷贝。

但当前存在以下限制：

- 没有公开的历史 Investigation 列表工具或命令。
- 没有接受历史 Incident ID 的公开查询工具。
- Controller 只保存每个会话的一个 Incident 指针，没有保存该会话的完整历史 ID 列表。
- Service 没有列出全部驻留 Incident 的公开 API。

因此，旧 Investigation 虽然还在内存中，但用户无法通过现有公开入口完整地发现和查询被替换的历史记录。内部按 ID 查询的能力不等于已提供用户可用的历史管理功能。

### 3.3 同一进程中返回其他会话

如果原会话的映射和 Investigation 尚未被归档清理，在同一应用进程中重新绑定相同 session ID，可以重新访问该会话当前指向的 Investigation。

这只能恢复该会话的当前指针，不能列出它曾经创建的全部 Incident。新会话或 fork 使用新的身份，不会自动继承原会话的 Investigation。

## 4. 显式 JSONL 归档

归档目前是内部 API：

```ts
await controller.flush(incidentId, absoluteFilePath);
```

Controller 委托 `service.flush` 写出归档，并在成功后清理匹配的会话引用。直接调用 Service 时，仅由 Service 删除自己的驻留记录。

归档行为如下：

- 只允许归档已结束且没有待完成诊断工作的 Investigation。
- 使用调用者提供的绝对文件路径，不会自动创建归档目录。
- JSONL 首条记录包含版本、除 evidence 外的 InvestigationState 和 evidence 数量；后续逐条保存 evidence。
- 保存的是保留的领域状态和 evidence 摘要，不保存原始 MCP 响应。
- 拒绝覆盖已有目标文件；写入失败时保留内存状态。
- 成功后删除内存中的 Investigation，释放一个驻留容量名额。
- 没有生产归档 UI / 命令、归档索引、导入、恢复或 resume 功能；归档文件目前是离线历史记录。

Service 默认最多驻留 20 个 Investigation，结束本身不会释放名额。达到容量后，新建或替换会被拒绝，需要先归档已结束的 Investigation。不会自动淘汰历史记录；替换失败也不会先结束旧 Incident。

实现参考：[flush](../src/investigation/investigation-service.ts)、[JSONL 写入](../src/investigation/investigation-archive.ts)。契约参考：[Phase 4 Contracts](./PHASE4_CONTRACTS.md#51-incident-owned-storage-and-explicit-jsonl-flush)。

## 5. 与 Pi 会话持久化的关系

Pi 的会话 transcript 可以保留对话、工具消息和 Investigation 摘要，但它不是 Investigation Domain 的持久化存储。

- reload / resume 只有在同一应用进程仍持有 Service 状态时，才能重新绑定原有结构化 Investigation。
- 进程退出后，不能从 transcript 重建 EvidenceStore、hypotheses、outcomes 或诊断预算。
- 显式 JSONL 归档可以保留离线历史，但当前不能导入应用恢复执行。

相关说明：[Session Projection and Transcript Context](./SESSION_PROJECTION_AND_TRANSCRIPT_CONTEXT.md)、[Phase 4 Contracts](./PHASE4_CONTRACTS.md)。
