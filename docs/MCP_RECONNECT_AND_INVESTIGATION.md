# MCP Reconnect During an Investigation

**Status (2026-10-21):** This note explains implemented Phase 3 connection/session behavior and the planned Phase 4 investigation semantics. Incident, Evidence, Hypothesis, and durable query-attempt records are not implemented. The proposed query-attempt representation below is a design recommendation, not an existing domain contract.

Reconnect preserves the investigation's intent and accepted observations while replacing execution authority. It restores permission to issue fresh calls; interrupted calls do not resume or replay.

## Connection replacement

An actual replacement follows this sequence:

1. Close the dispatch gate, withdraw tools, and mark MCP as connecting.
2. Increment `connectionGeneration`, invalidating old handlers, queued work, and execution snapshots.
3. Request cancellation of old calls, settle tracked transport work, and close the old connection. Cancellation does not prove that the server stopped executing; late invalidated payloads cannot become fresh successful results.
4. Reload configuration and establish the replacement connection, preserving the session's selected rule. Edited configuration does not silently replace that rule.
5. Rediscover tools, apply the read-only allowlist and discovered-schema checks, and discover complete context inventory through `configuration_contexts_list`.
6. Accept validated inventory, increment `inventoryRevision`, and resolve the unchanged scope rule. Successful discovery increments the revision even when inventory is identical. `selectionRevision` does not change merely because of reconnect.
7. Calculate added, removed, and changed context metadata; publish compatible tools and scope/UI/model notices while dispatch remains blocked.
8. Reopen dispatch. Every new diagnostic call still requires an exact model-supplied context and a fresh execution snapshot.

A healthy non-forced `/mcp_restart` can retain the existing connection; it does not perform this replacement sequence. Unexpected transport loss blocks access immediately; the current application directs the user to `/mcp_restart` for recovery rather than automatically reconnecting.

If inventory discovery fails, retain the last successful inventory for inspection, withdraw tools, and block diagnostic calls. Discovery proves inventory availability, not Kubernetes authentication, authorization, or health. An empty usable resolution also blocks diagnostics without changing scope intent. Cluster-specific operation failures remain scoped to the affected call; shared transport loss affects all targets.

## What survives within investigation scope

Phase 3 currently owns a session rule and conversation history. Phase 4 will capture the active incident's immutable rule and add evidence, hypotheses, coverage, and budgets on the same execution boundary.

| State                                                  | Reconnect behavior                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Session rule; Phase 4 incident identity and scope rule | Preserve                                                                                                                 |
| Conversation history                                   | Preserve accepted prior tool outcomes and reasoning                                                                      |
| Phase 4 committed evidence and hypotheses              | Preserve; observations retain origin, observation time, and original provenance                                          |
| Inventory and available scope resolution               | Rediscover and recompute                                                                                                 |
| Connection generation and per-call execution authority | Replace; old authority cannot authorize new work                                                                         |
| Active or queued calls                                 | Invalidate and settle; never transfer to the new connection                                                              |
| Phase 4 coverage                                       | Preserve historical outcomes; interruption establishes no successful coverage; new wildcard members start as not checked |
| Phase 4 incident budgets                               | Preserve; reconnect does not reset them                                                                                  |

For inventory changing from `{A, B}` to `{A, C}`:

| Rule           | Available after reconnect | Other contexts                                    |
| -------------- | ------------------------- | ------------------------------------------------- |
| Exact `{A, B}` | A                         | B is unavailable; C remains outside scope         |
| Live `*`       | A, C                      | B is no longer available; C starts as not checked |

A committed observation from B remains historical evidence even if B disappears. An interrupted query against B supplies no accepted observation. A new query against C requires explicit context C and current execution authority. Prior observations from A are retained with their original time; reconnect does not make them current again.

## How interrupted calls settle

| Call state when reconnect begins           | Outcome                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Completed and accepted before invalidation | Keep the historical result; Phase 4 keeps committed evidence                                      |
| Dispatched and unfinished                  | Request cancellation, reject invalidated late success, and settle the call with a failure outcome |
| Waiting for admission                      | Remove and settle the waiter without dispatching it                                               |
| New call during replacement/publication    | Reject preflight while the dispatch gate is closed                                                |

Reconnect-induced invalidation normally produces a bounded tool error such as `stale-scope`; transport and readiness failures may use transport/scope failure categories. Caller cancellation retains Pi's abort behavior. These are distinct from an empty successful Kubernetes response and must never imply resource absence or healthy coverage.

Active slots, execution snapshots, and work guards are released as calls settle; queue entries release waiting capacity promptly. No interrupted operation is automatically retried. Any retry is a new call with current argument validation, availability checks, authority, and, in Phase 4, budget accounting. Every dispatched attempt counts against the incident call budget; a waiter that never dispatched is not a dispatched attempt.

## Agent and LLM continuation

During a still-running agent turn, Pi receives interrupted tool outcomes through the normal tool-result path. Scope state changes are persisted as application messages and queued as steering after tool results. The LLM can use those outcomes and the delivered scope information to decide whether to retry, inspect another permitted context, or explain that progress is blocked.

The next LLM request is **not guaranteed to wait for reconnect completion**. It may first see connecting/unavailable state; the replacement inventory and resolution may arrive in a later steering update. Publishing the notice before reopening dispatch does not mean the LLM has already consumed it. Application validation enforces current authority regardless of what the model has seen.

Reconnect cancels MCP work without itself cancelling the entire agent turn. An active turn can continue under Pi's normal loop, but recovery does not guarantee that the model will wait or retry. If the turn has ended or the agent is idle, reconnect does not start a new LLM turn. There is no application checkpoint scheduler or automatic replay of the investigation plan.

Thus, dispatch capability resumes after successful recovery. Individual operations require fresh calls, and reasoning continues only through an active or subsequently started agent turn.

## Domain ownership in Phase 4

An interrupted tool call is an execution outcome associated with an incident. It does not itself establish a diagnostic observation or interpretation:

- **Incident:** retains the investigation identity, captured scope rule, lifecycle, and budgets through reconnect.
- **Evidence:** contains accepted observations. Interrupted or stale payloads cannot be committed as fresh evidence; previously committed observations remain available with their provenance.
- **Hypothesis:** represents interpretation supported by evidence. A transport interruption is not a Kubernetes diagnosis and does not create or invalidate a hypothesis automatically. It can leave a proposed check incomplete.
- **Query/execution attempt (proposed):** records that a query was attempted, dispatched or only queued, and interrupted. Coverage can distinguish this from not checked, failed, and successfully checked.

The proposed bounded attempt record should associate incident/attempt identity, exact context for diagnostic calls, operation, scope/inventory revisions, connection generation, timing, dispatch status, and a safe outcome/reason. It should not retain raw sensitive arguments or results. A fresh retry creates another attempt rather than rewriting the interrupted one.

The accepted plan already requires bounded query outcomes and per-context coverage. Whether these are a dedicated entity or records owned by an investigation service remains a Phase 4 design decision. Phase 3 currently exposes tool outcomes and provenance in the conversation; it has no durable incident attempt ledger.

## Source references

- [MCP controller](../src/app/mcp-controller.ts): replacement, cancellation, discovery, and publication.
- [Context manager](../src/cluster/context-manager.ts): revisions, rule resolution, inventory transitions, and execution currency.
- [Tool bridge](../src/mcp/tool-bridge.ts): admission, failure outcomes, stale-result rejection, and cleanup.
- [Scope extension](../src/tui/cluster-extension.ts): persistent scope snapshots and steering delivery.
- [Phase 3 contracts](./PHASE3_CONTRACTS.md): implemented execution and reconnect boundaries.
- [Multi-cluster investigation plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md): cross-phase scope, evidence, coverage, and budget contracts.
- [Design](./DESIGN.md): authoritative architecture and planned Phase 4 incident/evidence semantics.
