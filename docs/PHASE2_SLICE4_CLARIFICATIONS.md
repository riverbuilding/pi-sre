# Slice 4 — Tool Schemas, Execution Policy, and Scope

This note records the clarification requested before implementing Phase 2 Slice 4, updated with the completed bridge terminology. It explains the [implementation plan](./PHASE2_IMPLEMENTATION_SLICES.md#10-slice-4--enforce-scope-in-the-tool-bridge) and [verified server contracts](./PHASE2_CONTRACTS.md). Production diagnostic tools remain deferred until the later slices.

**Current design update (2026-10-16):** Pi SRE trusts the configured MCP server and consumes discovered schemas. Exact input/output matching and mandatory read-only/destructive annotation checks are removed. The allowlist, model-argument validation, explicit context injection, application limits, and scope/lifecycle guards remain. Application-state adapters parse only data they consume. See [the current policy](./MCP_TOOL_SCHEMAS.md). The sections below retain historical Slice 4 terminology.

## 1. What is the original server schema?

The **original server schema** is the tool's input schema supplied by Kubernetes MCP Server through MCP tool discovery. It defines the arguments the server accepts, including `context`, `namespace` where supported, required fields, and constraints such as enums and patterns.

The server input schema is the authoritative **transport contract**. Retaining it means keeping that contract intact for final validation after Pi SRE injects the application-selected context.

Slice 4 derives a separate model-facing schema by removing the `context` property and its entry in `required`, while preserving the other constraints. The bridge validates model arguments against that derived schema, injects context, then validates the complete arguments against the retained server schema before calling MCP.

This refers to the tool's input schema, not its optional output schema or the validators that check whether a schema document is supported by Pi SRE.

## 2. What are the two schemas called in this project?

| Purpose                                     | Documentation term                       | Current code                                                                         |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Arguments accepted by Kubernetes MCP Server | Server input schema / transport contract | `McpToolDescriptor.inputSchema`, typed as `McpInputSchema`                           |
| Arguments exposed through Pi to the LLM     | Model-facing schema                      | `ToolDefinition.parameters`, currently the local variable `parameters` in the bridge |

The definitions live in [tool-discovery.ts](../src/mcp/tool-discovery.ts), [tool-policy.ts](../src/runtime/tool-policy.ts), and [tool-bridge.ts](../src/mcp/tool-bridge.ts).

Before Slice 4, the bridge adapts the server input schema directly with `adaptMcpInputSchema(descriptor.inputSchema)` and uses the result as Pi's `parameters`. There is no separate project-specific model-schema type yet. Slice 4 introduces the separation needed to hide application-owned context from the model while retaining the complete transport contract.

In the completed Slice 4 bridge, `serverParameters` is the retained executable server schema, `modelSchema` is the derived schema document, and `parameters` is the executable model-facing schema registered with Pi. Both argument validators use the supported TypeBox schema representation.

## 3. Is tool-policy the execution-time policy?

[tool-policy.ts](../src/runtime/tool-policy.ts) supplies the tool approval rules. **Execution-time** describes when those rules are enforced.

`evaluateToolPolicy()` checks the exact allowlist and read-only/destructive annotations during discovery and still defers recognized cluster-dependent tools. Before Slice 4, it also ran during bridge creation, without an execution-time recheck.

Slice 4 adds `evaluateToolExecutionPolicy()`, used during bridge creation and rechecked inside every `execute()` call. It shares the approval rules and allows the scoped `pods_list` bridge capability for test-owned registration while discovery keeps production diagnostics deferred. Approval during discovery or registration alone is insufficient because a captured handler may outlive the state in which it was registered.

The plan says “execution-time policy, binding, schema, and generation checks.” These are related but separate checks:

| Check                             | Question it answers                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Tool policy                       | Is this tool still approved for execution?                                                    |
| Model argument validation         | Do the untrusted model arguments satisfy the model-facing schema?                             |
| Scope binding                     | Is a valid application-owned context available for this cluster-dependent call?               |
| Connection generation             | Does this handler still belong to the current connection generation?                          |
| Final server argument validation  | Do the complete arguments satisfy the original server schema after context injection?         |
| Cancellation and result freshness | Can the operation continue and can its result still be published under its originating scope? |

The implemented execution flow is:

1. Recheck tool approval and the current connection generation.
2. Remove any model-supplied `context` and validate the remaining model arguments.
3. Require and capture a valid application-owned scope snapshot.
4. Inject that snapshot's exact context.
5. Validate the final arguments against the original server schema.
6. Call MCP with cancellation and timeout support, then check cancellation and generation before publishing the result.

The tool policy is part of execution enforcement; it does not by itself perform scope binding, argument validation, or lifecycle checks.

## 4. Are context and namespace separate?

Yes. Phase 2 separates **application-owned context** from **per-call namespace arguments**.

| Value     | Ownership and behavior                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context   | Selected by the user/application through startup resolution and, once implemented, `/cluster`. The LLM cannot select or switch it. The bridge injects the exact selected context. |
| Namespace | The LLM can supply it for tools whose schemas support it. It selects the namespace for that query and does not change application/session scope.                                  |

For example, once `pods_log` is reviewed and enabled, with application context `alpha`:

```text
LLM arguments: { name: "api-pod", namespace: "payments" }
MCP arguments: { name: "api-pod", namespace: "payments", context: "alpha" }
```

An attempted model argument `context: "beta"` must be removed and replaced with `alpha` before final server-schema validation. Namespace and model-supplied server names never determine cluster identity.

Phase 2 has no application-level namespace restriction, no `/namespace` command, and no new namespace selection policy. The planned status value `Namespace: *` means no application-level namespace restriction. It does not mean every call queries all namespaces. Applicable namespace information must accompany results so observations remain attributable.

Namespace choice depends on the verified tool contract:

- `pods_list` has no namespace argument in the captured server descriptor.
- `pods_log` and `events_list` expose optional namespace arguments.
- Omitting namespace uses server/context behavior and does not guarantee all-namespace coverage.

The verified `pods_list` routing probe reached `/api/v1/namespaces/default/pods` despite the descriptor's all-namespaces description. Slice 7 must review actual namespace behavior before production exposure; see [the candidate tool contracts](./PHASE2_CONTRACTS.md).
