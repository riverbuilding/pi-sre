# Multi-Cluster Investigation Plan

**Status:** Design accepted on October 18, 2026; implementation pending. The current Phase 2 runtime still supports one selected context. Phase 3 independently upgrades that runtime's context selection; Phase 4 adds Investigation Domain and Phase 5 adds tool parity. This document describes the cross-phase target; documentation changes enable no runtime capabilities.

## 1. Accepted first delivery

Use one Pi agent, one managed Kubernetes MCP server, and the existing approved read-only diagnostic tools. Support exact context sets and a live all-contexts selection, displayed as `*`, with live `*` as the default unless the user explicitly chooses another rule. Patterns and changes to an active incident's selection rule are later extensions.

> The user controls the scope rule. The application maintains its current resolution. The model explores within it. Every Kubernetes operation targets exactly one validated context.

| Scope rule     | Meaning                                         | After inventory changes from `{A, B}` to `{A, C}`                |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Exact `{A}`    | One named context                               | A remains permitted                                              |
| Exact `{A, B}` | Only those named contexts                       | A remains usable; B is unavailable; C is outside scope           |
| Live `*`       | All contexts in the current validated inventory | A and C are permitted; B is unavailable; C starts as not checked |

In Phase 3 the session rule is explicitly changeable while idle, without any incident object. In Phase 4 the incident captures an immutable **rule**, not fixed resolved membership of `*`. C joining `*` follows existing user intent; it is not an amendment. Changing an active incident's exact set or replacing it with `*` is an amendment and is deferred. In that phase, select a new rule and start another incident instead.

“Live” follows successful application-controlled discovery, initially at startup and every MCP replacement. It does not imply continuous kubeconfig watching or immediate detection of server changes. Model-driven enumeration alone cannot update execution authority.

## 2. State and selection

Phase 3 keeps these values separate:

1. **Inventory:** validated MCP context identities and sanitized metadata.
2. **Session selection:** the user's exact/all rule and selection revision.
3. **Resolution:** current permitted/available contexts and unavailable previously known members.
4. **Execution snapshot:** one call's session binding, exact context, selection revision, inventory revision, and connection generation.

Phase 4 adds next selection for another incident, the active incident's captured rule/scope revision, incident identity/lifecycle, and aggregate evidence revisions. Its execution lease extends the Phase 3 snapshot; it does not replace the routing implementation. The initial Phase 4 delivery has no active-incident rule amendment API. Ordinary evidence updates and next-selection changes do not invalidate incident leases. Incident/session replacement, conclusion, connection replacement, and cancellation do.

The planned CLI accepts `--clusters <exact-name> <exact-name>` for an exact set and `--clusters '*'` for live `*`; wildcard must be the sole value and should be quoted to prevent shell expansion. [Phase 3 Slice 0](./PHASE3_CONTRACTS.md) freezes parsing and validation and supersedes the earlier repeated-`--cluster`/`--all-clusters` proposal. These extensions are not implemented yet.

Startup precedence is explicit CLI selection, then an explicitly configured `kubernetes.defaultCluster` as the user's exact singleton choice, then live `*`. With no explicit choice, use `*` even when MCP reports a default context; MCP default metadata never narrows the rule. Unknown explicit names reject initial selection atomically without fallback to `*`. Phase 3 requires validated inventory and at least one available target for diagnostic dispatch; Phase 4 also requires this to create an incident; empty/failed discovery leaves the selected rule pending, not silently changed.

Use only `/clusters` for scope selection and inspection. With no arguments it opens a picker supporting one exact name, multiple exact names, or live `*`; `/clusters <exact-name>` selects one context directly, `/clusters --all` selects live `*`, and `/clusters --status` inspects state. Replace the current singular command rather than keeping it as an alias. In Phase 3 idle selection changes the current session rule and subsequent calls. Once Phase 4 introduces incidents, it changes next selection while an incident retains its captured rule; show both when different. Selecting `*` again is unnecessary when its resolution changes.

Avoid “scope refresh”: distinguish inventory refresh, next selection, and future active-rule amendment. Do not add unsupported fields to runnable configuration templates.

Context names remain exact MCP identities. Do not trim, case-fold, or deduplicate by endpoint: different contexts may use different credentials. Names do not prove immutable physical-cluster identity. Surface changed safe endpoint metadata after discovery and preserve generation provenance without claiming to detect every server-side remapping.

## 3. Per-call routing

Use one routing contract for every rule: every cluster-dependent tool requires one exact model-supplied `context`, including an exact singleton and a wildcard resolution containing one member. Preserve the context in the model schema and validate it against discovered constraints and current permitted targets. Do not hide, infer, inject, or overwrite the target. A missing or out-of-scope target is rejected, including when there is only one permitted choice. Context-independent discovery and local investigation tools do not need a cluster selector.

Derive model choices from current rule resolution and discovered tool compatibility. Preserve server constraints. Missing, unknown, unavailable, or out-of-scope targets fail before dispatch. Publish a tool if at least one permitted target is compatible; recheck compatibility at execution. Stale schemas and direct handlers cannot grant access.

```text
Validate arguments
    → Resolve one context under the effective session/incident rule and current inventory
    → Check connection, tool compatibility, cancellation, and limits
    → Capture a Phase 3 session execution snapshot; Phase 4 adds incident/capacity reservation
    → Preserve supplied context and validate final MCP arguments
    → Execute with cancellation
    → Revalidate snapshot before success publication; Phase 4 also commits evidence
```

Do not route by changing a global active context or implicitly fan out one Kubernetes call. Independent A/B calls have independent leases. The model can explore other permitted targets when relevant; wildcard permission does not require an exhaustive fleet scan.

## 4. Reconnect and reconciliation

Recovery is an application transaction independent of model cooperation:

1. Block new Kubernetes dispatches, invalidate the old generation, and cancel/settle old calls. Withhold invalidated late success; preserve committed evidence.
2. Reconnect and rediscover tools and complete context inventory on the replacement connection.
3. Validate inventory and resolve the unchanged session rule in Phase 3, or active incident rule in Phase 4. Preserve exact requested identities; recompute live `*`. An invalid next selection must not disable an otherwise usable active incident.
4. Publish connection, inventory, resolution, and compatible tools together. Failed inventory validation leaves diagnostics blocked; tool discovery alone is insufficient.
5. Publish bounded added/removed/changed/unavailable notices to TUI and model before reopening dispatch. Pi steering may reach the model later; execution checks already enforce the current state.

Expose complete resolved membership through bounded/paginated application inspection. Summaries may show counts and limited change lists; omitted names are not missing contexts. Removed wildcard targets remain represented in bounded outcome/evidence history as unavailable. Added targets are available, not investigated or verified healthy.

A shared transport failure blocks all targets. Cluster-specific authentication, authorization, timeout, and operation failures remain per-target outcomes, never false empty results or global failures. Do not automatically replay interrupted operations during reconnect.

## 5. Phase 3 provenance and Phase 4 evidence/budgets

Phase 3 returns bounded result provenance with exact context, known namespace, session selection/inventory revisions, connection generation, and truncation. Phase 4 adds incident/execution IDs, evidence storage, resource targets, observation time, and domain consistency. Same-named resources in different contexts remain distinct. Hypotheses may connect evidence across contexts in one incident; observations and interpretations remain separate.

Track bounded query outcomes and distinguish successful, failed, interrupted, partial/truncated, and not checked. Namespace omission means server/context policy, not all-namespace coverage. Empty success is not proof of global absence; availability is not coverage. Old evidence keeps its origin and observation time through reconnect.

Count every dispatched attempt, including failures/retries, against one incident-wide call budget. Reserve budget and storage atomically, bound concurrency, retain per-result limits, and apply Phase 4 aggregate evidence limits. These per-incident/storage guarantees activate in Phase 4; Phase 3 retains existing finite per-tool limits and adds bounded concurrency without inventing an incident budget. Reconnect and wildcard additions never reset budgets.

Show the rule, resolved membership/count, availability, namespace policy, and READ ONLY. Phase 4 adds next selection when different. Tool renderings show exact context. Bounded application state messages communicate resolution/revision changes and recover after compaction. Transcript text cannot authorize execution.

Cluster rule `*` and status `Namespace: *` have different meanings: the latter retains the existing unrestricted application namespace policy and does not assert that every query covers every namespace.

## 6. Staged delivery from completed Phase 2

| Phase | Delivery                                          | Dependency and exit                                                                                                                                               |
| ----- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2   | Existing singleton runtime/MCP/context management | Complete; keep plans and acceptance records historical                                                                                                            |
| 3     | Context Selection and Multi-Cluster Routing       | Start from existing code; ship `/clusters`, default live `*`, exact sets, required model context, snapshots, reconnect, and acceptance without incidents/evidence |
| 4     | Investigation Domain                              | Consume accepted Phase 3 authority; add incidents, evidence, hypotheses, lifecycle, next-selection semantics, and per-incident budgets                            |
| 5     | Config/core tool parity and controlled profile    | Consume Phase 4 evidence/approval identity; cover all 22 reference definitions                                                                                    |
| 6–8   | Skills, Evals, TUI Refinement                     | Follow the updated roadmap                                                                                                                                        |

The [new Phase 3 plan](./PHASE3_IMPLEMENTATION_SLICES.md) defines migration slices and `PHASE3_CONTRACTS`/`PHASE3_ACCEPTANCE` records. The [Phase 4 plan](./PHASE4_IMPLEMENTATION_SLICES.md) contains the former Investigation Domain work, and the [Phase 5 plan](./PHASE5_IMPLEMENTATION_SLICES.md) contains former Phase 4 parity work. Later phases must reuse, not gate or reimplement, the accepted context-selection foundation.

The current `registryRevision` combines inventory/selection changes; Phase 3 separates them. Reuse the existing registry, connection, cancellation, normalizer, limits, and public Pi hooks. Before incidents exist, use session snapshots and direct result provenance. Phase 4 extends the seam with incident leases and capture; it never reconstructs authority from transcript prose.

Phase 3 tests exact/all defaults and routing, rejected missing/out-of-scope contexts, selection races, `{A, B}` → `{A, C}` reconnect, stale generations/schemas, per-target failures, same-named resources, compaction/reload, and unchanged kubeconfig. Phase 4 adds evidence commits, lifecycle/session epochs, and budget/storage races. Each phase runs affected tests then the canonical format/lint/type/test/build gate, plus its explicit installed/disposable-cluster acceptance.

## 7. Later extensions, in order

1. **Explicit active scope amendment:** record a new rule revision and change reason, define pending-call handling, refresh schemas/UX, preserve provenance. Next-selection commands are not this API.
2. **Pattern selection:** e.g. `prod-*`, after specifying matching/escaping for opaque names; reuse live reconciliation. Patterns are not supported in the first delivery.
3. **Fleet workflows and comparison views:** richer planning, progress, and coverage beyond basic first-delivery limits/outcomes.
4. **Multiple MCP servers, per-user authentication, and remote workers:** add when deployment needs justify them; none is required for multi-context Kubernetes access. Remote execution does not mandate multiple reasoning agents.

Phase 5 controlled operations remain separate. Live `*` grants diagnostic scope, not blanket mutation approval. Every controlled call requires an exact context and approval bound to final arguments, incident/rule revision, inventory revision, and connection generation. Changes invalidate approval.

## 8. HolmesGPT comparison

HolmesGPT's Kubernetes MCP setup supports multi-context kubeconfig and model-selected `context` per call, without Robusta remote-agent routing. Its multi-cluster example instructs first-step enumeration, searching other contexts for missing resources, and origin labeling.

At the inspected revision, its generic adapter initializes a session per invocation and forwards model arguments. Server-mode refresh re-fetches tool definitions; that is distinct from Kubernetes context enumeration. No deterministic reconnect-to-context reconciliation or incident rule revision mechanism was found in that path. These are source observations, not runtime reproductions.

Pi SRE adopts exploratory routing with application-owned rule resolution, recovery, and admission.

Sources: [MCP setup](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/docs/data-sources/builtin-toolsets/kubernetes-mcp.md), [adapter](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/plugins/toolsets/mcp/toolset_mcp.py), [server refresh](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/server.py), [executor refresh](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/config.py).
