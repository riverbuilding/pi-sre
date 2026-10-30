# MCP 结果如何转换为工具响应和调查证据

**设计更新（2026-10-30，尚未实施）：** 后续实施以 [调查与 Context 简化方案](./INVESTIGATION_CONTEXT_SIMPLIFICATION.md) 和 [命令与操作限制方案](./TUI_COMMAND_VISIBILITY_AND_RESTRICTIONS.md) 为准。下文保留当前/此前实现与阶段记录，不再规定新架构必须保留 Incident 或旧生命周期。文档更新不代表代码已迁移或命令已禁用。

## 最新目标与迁移影响

统一为 MCP raw → 标准化/脱敏/限长 → 带来源的工具结果 → messages，不再调用 recordObservation、保存 Evidence 或等待领域提交才返回成功。模型可见 content 必须包含准确 context、操作、必要 namespace、适用时间、状态与截断信息；不能只放 details。未派发结果标明未执行；省略 namespace 表示 server/context policy。原始响应不留存，不新增临时文件存储。

## 既有设计与实现记录（保留历史，不作为新方案实施要求）

本文解释 incident 诊断路径中的两步：`presentObservation(...)` 准备返回内容，`controller.recordObservation(...)` 将同一份正文提交为调查证据。

相关实现：

- [incident-diagnostic.ts](../src/mcp/incident-diagnostic.ts)：编排 MCP 调用、结果处理、证据提交和返回。
- [result-normalizer.ts](../src/mcp/result-normalizer.ts)：标准化、脱敏和限制 MCP 结果。
- [observation-adapter.ts](../src/mcp/observation-adapter.ts)：组装来源信息及最终工具响应。
- [investigation-controller.ts](../src/app/investigation-controller.ts)：验证提交权限。
- [investigation-service.ts](../src/investigation/investigation-service.ts)：创建并保存 Evidence，更新操作结果。

## 完整转换示例

以下使用文本型 MCP 结果，假设调用成功、权限仍有效、容量充足且未触发截断。ID、时间和查询内容均为示例；`mapping` 表示当前调用的工具名称映射。

### 1. MCP 返回原始结果 raw

```ts
const raw = await connection.callTool(mapping.mcpName, args, combined);
```

假设返回：

```ts
const raw = {
  content: [
    {
      type: "text",
      text: "Pod payment-api 处于 CrashLoopBackOff",
    },
  ],
  isError: false,
};
```

这是 MCP 工具结果，尚未包含 Pi SRE 的 incident 或 evidence 身份信息。

### 2. normalizeMcpResult 标准化结果

```ts
const normalized = normalizeMcpResult(raw, policy);
```

该函数提取文本、执行脱敏及条目数和长度限制，并统一结果结构。本例得到：

```ts
const normalized = {
  text: "Pod payment-api 处于 CrashLoopBackOff",
  status: "success",
  isError: false,
  truncated: false,
};
```

这里没有调用模型总结或改写正文。本例只是提取了 MCP 返回的文本。若 MCP 提供有效的 `structuredContent`，标准化函数会优先处理该结构化内容，脱敏并序列化为文本；本文使用的是 `content` 文本路径。

### 3. observationProvenance 组装来源信息

```ts
const provenance = observationProvenance(lease.scope, execution, context, namespace, completedAt);
```

假设得到：

```ts
const provenance = {
  incidentId: "incident-1",
  executionId: "exec-1",
  evidenceId: "ev-123",
  completedAt: "2026-10-28T12:00:00.000Z",

  scope: {
    context: "prod",
    namespace: "payments",
    namespacePolicy: "unrestricted",
    readOnly: true,
    scopeRevision: 1,
    selectionRevision: 1,
    inventoryRevision: 1,
    connectionGeneration: 1,
  },
};
```

incident、execution 和 evidence ID 来自本次执行身份；`evidenceId` 已在 dispatch 时生成，但此时证据尚未提交。context 和 namespace 对应本次调用的显式参数，scope 和连接版本来自 lease。

### 4. presentObservation 生成最终展示结果

```ts
const presented = presentObservation(normalized, provenance, mapping, policy.maxTextChars);
```

本例得到：

```ts
const presented = {
  // 最终保留下来的纯正文，供后续保存为证据。
  excerpt: "Pod payment-api 处于 CrashLoopBackOff",

  // 完整工具响应，供后续返回。
  result: {
    content: [
      {
        type: "text",
        text:
          'Evidence: "ev-123"; context="prod"; ' +
          'namespace="payments"; READ ONLY\n' +
          "Pod payment-api 处于 CrashLoopBackOff",
      },
    ],
    details: {
      tool: mapping,
      status: "success",
      truncated: false,
      ...provenance,
    },
    isError: false,
  },
};
```

`excerpt` 与 `result` 的关系是：

```text
result.content[0].text = 来源前缀 + excerpt
result.details        = 工具信息 + 状态 + 截断标记 + 来源元数据
```

单独返回 `excerpt`，让证据库可以直接保存最终正文，无需从展示文本中拆除来源前缀。这一步只构造数据，不写入调查状态。

`presentObservation` 限制的是 `JSON.stringify(result).length`，即完整响应序列化后的字符数。因此，即使 `normalized.text` 已经限长，加上前缀和元数据后仍可能需要进一步截断正文。截断时保留完整身份和来源信息，并在正文末尾添加 `\n[Result truncated]`。如果连必要的展示结构都放不下，则返回 `undefined`，调用方返回 `presentation-refused`，不提交成功证据。

### 5. recordObservation 提交证据

```ts
controller.recordObservation(lease, {
  excerpt: presented.excerpt,
  truncated: presented.result.details.truncated,
  completedAt,
});
```

controller 先验证 lease 仍然有效，且已经执行过 dispatch，再将对应的执行身份交给调查服务。调查服务根据已登记的执行来源补齐其余字段，创建并保存 Evidence。

本例保存的证据如下：

```ts
const evidence = {
  id: "ev-123",
  incidentId: "incident-1",
  executionId: "exec-1",
  source: "kubernetes",

  context: "prod",
  namespace: "payments",
  operation: mapping.mcpName,
  scopeRevision: 1,
  inventoryRevision: 1,
  connectionGeneration: 1,

  excerpt: "Pod payment-api 处于 CrashLoopBackOff",
  truncated: false,
  completedAt: "2026-10-28T12:00:00.000Z",
};
```

该步骤还会更新调查状态和操作结果：正文未截断时，操作结果为 `successful`；已截断时为 `partial`。这里保存的是内存证据，写入归档文件由单独的显式归档流程完成。

### 6. 提交成功后返回 result

```ts
return presented.result;
```

调用方先提交证据，再返回成功工具响应。如果证据提交失败，就不会返回这份成功响应。

## 数据流与顺序保证

```text
MCP raw.content[].text
         │ 提取、脱敏、限长
         ▼
 normalized.text
         │ 加来源信息，按完整响应长度再次限长
         ▼
 presented.excerpt
         ├──→ Evidence.excerpt：保存在调查证据库
         │
         └──→ 来源前缀 + excerpt
                    │
                    ▼
          presented.result.content[0].text
                    │ 证据提交成功后
                    ▼
               返回给模型
```

证据库保存的正文，与返回给模型的响应中来源前缀后面的正文完全相同。原始 MCP 响应不会由这条路径保存为 Evidence。

在最终的权限和取消检查、同步提交、返回之间没有 `await`。这样不会在这些步骤之间让出执行权，避免检查通过后因会话、scope 或连接变化而把过期结果当作新鲜证据提交和返回。
