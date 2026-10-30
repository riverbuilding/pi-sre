# Phase 4 Slice 0 — Investigation Domain Contracts

**设计更新（2026-10-30，尚未实施）：** 后续实施以 [调查与 Context 简化方案](./INVESTIGATION_CONTEXT_SIMPLIFICATION.md) 和 [命令与操作限制方案](./TUI_COMMAND_VISIBILITY_AND_RESTRICTIONS.md) 为准。下文保留当前/此前实现与阶段记录，不再规定新架构必须保留 Incident 或旧生命周期。文档更新不代表代码已迁移或命令已禁用。

## 最新目标与迁移影响

本文件冻结的是旧 Investigation Domain 的已实施契约，保留供理解现有代码和既有测试。新迁移删除调查对象、EvidenceStore、领域工具、结论提交、不可变 scope/next、session binding 与领域 revisions；预算迁至逐条用户请求，结果归属迁至调用身份和准确 context。新验收按简化方案第 13 节，不以本文件中的旧 API/数据结构作为新实现要求。

## 既有设计与实现记录（保留历史，不作为新方案实施要求）

**Status:** Contracts frozen, 2026-10-20; capacity handling simplified and incident-owned storage/archive adopted on 2026-10-23. Runtime evidence uses installed Pi coding agent,
MCP, and TUI **0.99.0**. Phase 3 is [accepted](./PHASE3_ACCEPTANCE.md).
This slice adds offline lifecycle fixtures and contracts only. Incidents, evidence storage,
incident budgets, local investigation tools, and incident-aware dispatch are not enabled.

The 2026-10-23 amendment removes budget/storage reservations. Dispatch spends an attempt
immediately; writes check actual count/bytes synchronously at commit. The byte budget
counts only evidence content and is owned by EvidenceStore; other investigation state
is excluded as small overhead. Targets and hypotheses have no separate count limits. This supersedes earlier
reservation wording in the architecture and multi-cluster/Phase 3 planning documents.

The subsequent 2026-10-23 storage amendment gives every incident its own EvidenceStore
and independent count/byte limits. The service can explicitly flush a concluded investigation
to JSONL, releasing its memory only after successful publication. This supersedes the
original application-wide evidence quotas and memory-only/no-export contract.

The [Phase 4 plan](./PHASE4_IMPLEMENTATION_SLICES.md) defines delivery order.
[DESIGN.md](./DESIGN.md), especially Sections 13–16, 28–30, 41–45, 50, and 66, defines
the architecture. These contracts resolve its illustrative field names and open storage/
summary choices for the first implementation. Historical Phase 1/2 acceptance stays intact.

## 1. Product boundary and ownership

Keep one agent, one managed MCP connection, the existing six-operation allowlist, discovered
argument validation, explicit model context, read-only configuration, and disabled raw
retention. Do not add Kubernetes operations, diagnostic response schemas, shell access,
remediation, patterns, active-rule amendment, an incident database, archive import/resume,
or transcript restoration. Explicit concluded-investigation JSONL archival is supported
by the offline service; production commands and controller integration remain planned.

| Owner                                | Responsibility                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi                                   | Conversation, model requests, queue delivery, compaction, branch projection, cancellation, session identity and TUI lifecycle                                                        |
| Domain helpers                       | Immutable values, exact identities, reference validity, lifecycle and time invariants; no Pi or MCP imports                                                                          |
| EvidenceStore                        | One incident per store; sole evidence authority, execution idempotency, stable pages, independent capacity and immutable reads                                                       |
| Investigation service                | Atomic incident creation/replacement/conclusion, hypotheses, targets/focus, aggregate revision, operation outcomes, dispatch budget and explicit concluded-investigation JSONL flush |
| Application investigation controller | Process-owned session map, active binding/epoch, effective incident authority, leases, coordination with MCP recovery and publication                                                |
| MCP controller/cluster layer         | Single transport, generation, validated inventory, reconciliation and shared FIFO admission                                                                                          |
| Evidence adapter/bridge              | Validated request provenance, normalized safe excerpt, final validity checks and synchronous observation recording before success                                                    |
| Investigation extension/runtime      | Register hooks, commands/local tools, delegate to controller, publish bounded summaries and widgets                                                                                  |

Construct the controller/store outside every extension factory and runtime-replacement
factory, under application ownership. Never use a module-global store. Bind a newly created
extension to that owner; reload must not create another store for the same incident.
Process exit loses unarchived structured state. Explicit JSONL archives remain offline records
and cannot restore execution authority or an active investigation. Persisted Pi messages may contain bounded summaries/results, as today;
they are not a database or an authority source.

## 2. Verified Pi lifecycle seam

Inspected installed `dist/core/extensions/types.d.ts`, `agent-session.js`,
`agent-session-runtime.js`, `session-manager.d.ts`, and Pi agent-core's tool/loop types.
The executable [lifecycle probe](../tests/integration/phase4-lifecycle-contracts.test.ts)
uses real Pi service/session creation, the production SRE resource policy and `SreRuntime`,
public prompt/queue/reload/navigation/replacement APIs, and synthetic provider responses.
Its small creation/binding witness is test-only: it is not the future domain implementation.
No provider credentials, model request, MCP process, or Kubernetes cluster is used by it.

| Boundary                                | Observed behavior and implementation consequence                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered command                      | `prompt()` dispatches it before `input`, even during streaming. Commands do not implicitly create an incident. Interactive built-in commands are handled by Pi separately.                                                                                                                                                                                                                          |
| `input`                                 | Exposes `source: interactive \| rpc \| extension`, raw text/images, and `streamingBehavior` while streaming. It precedes credential preflight. Returning `handled` stops the prompt. It is an intent boundary, not a creation/dispatch boundary.                                                                                                                                                    |
| `before_agent_start`                    | Runs after prompt expansion, credential preflight and any pre-prompt compaction. Has expanded prompt/images but no input source. Consume an eligible pending input intent once here, before agent/tool execution.                                                                                                                                                                                   |
| Streaming `prompt`, `steer`, `followUp` | Emit input with streaming delivery mode, enqueue user messages, and drain through the existing run. They do not call `before_agent_start` again for delivery. Do not create incidents from queued delivery.                                                                                                                                                                                         |
| Custom application messages             | `sendCustomMessage`/extension `sendMessage` do not constitute user input. Idle messages persist without a turn; steering preserves tool-result ordering. They never create incidents.                                                                                                                                                                                                               |
| Overflow compaction/retry               | `session_before_compact` and `session_compact` expose `reason: overflow`, `willRetry: true`; the real retry continues without another user input or `before_agent_start`. Preserve the incident.                                                                                                                                                                                                    |
| `agent_end`                             | Can occur around continuation/recovery. It is not an incident conclusion signal.                                                                                                                                                                                                                                                                                                                    |
| Reload                                  | Emits `session_shutdown(reason: reload)`, rebuilds extensions, then emits `session_start(reason: reload)` when UI/command bindings exist. Identity is unchanged; preserve domain state, invalidate old binding/leases and deduplicate summaries. Bare SDK `bindExtensions({})` is insufficient to exercise reload start; fixtures bind a real UI context. Interactive reload must remain idle-only. |
| New/resume/fork                         | Before-switch/fork hooks can veto. On accepted replacement Pi aborts and settles outgoing work, emits shutdown, disposes the old session, creates the new runtime, and invokes the host rebind callback. `bindExtensions` emits the pending start event. Do not invalidate the binding for a vetoed transition.                                                                                     |
| Identity                                | `ctx.sessionManager.getSessionId()` / `session.sessionId` are exact identities. New/fork have distinct IDs even when messages are copied. Resume of the same file keeps its ID. File path, cwd, branch leaf, or incident text are not session identity.                                                                                                                                             |
| Tree navigation                         | `navigateTree` without summarization changes projection and emits `session_tree`, retaining session identity. Do not rewind operational state or conclude incidents.                                                                                                                                                                                                                                |
| Tool cancellation                       | Pi supplies `execute(..., signal, ...)`. Replacement aborts and settles an executing tool before shutdown/start. The fixture asserts that ordering. Existing scoped-stdio tests separately verify cancellation through MCP.                                                                                                                                                                         |

### Creation decision

Create at most one open incident per Pi session. Eligible automatic creation requires:

1. A nonblank top-level idle input from `interactive` or `rpc`, not `extension`, a command,
   a custom message, or streaming steering/follow-up delivery.
2. Successful prompt preflight reaching `before_agent_start`, still bound to that session.
3. No open incident, and the selected rule resolved against current validated inventory
   with at least one usable diagnostic target (including tool compatibility).
4. Valid question/time window and available application capacity.

Capture only short-lived input intent at `input`; consume and clear it at
`before_agent_start`. Use the hook's final expanded prompt for the stored question, after
shared redaction/limits. An intent carries the binding identity/epoch; it never grants
scope. Clear it on shutdown, handled input and replacement input. Failed preflight may
leave only an unconsumed intent: subsequent input replaces it and it cannot create through
a command, queued delivery, recovery or tool handler. Keep the SRE-owned hook ordering
explicit; later input transformers must not bypass this decision.

With an open incident, later prompts continue it regardless of fluent assistant answers.
Without usable inventory/scope, leave the incident absent, preserve next-selection intent,
explain the requirement and keep diagnostics blocked. Recovery alone does not manufacture
an incident; a subsequent eligible question or `/incident new <question>` can create one.
Queued input without an incident remains non-authoritative; request a new idle question.
No LLM classifier and no lazy creation in a diagnostic handler.

`/incident new <question>` is an explicit, idle-only creation path. Validate question,
scope, time and capacity before changing anything. If replacing an open incident, atomically
conclude it `inconclusive` with a bounded replacement reason and create the new incident.
If any validation/capacity check fails, preserve the old incident unchanged.

### Binding and memory lifetime

Maintain `Map<PiSessionId, SessionInvestigationState>` in the application controller.
Bind on `session_start`, using a fresh monotonic binding epoch even for a reload or return
to a previous identity. New/fork starts without an incident; do not inherit domain state
from its parent. Same-process resume may rebind retained state by exact ID. A fresh owner
opening the same transcript has no state and explains that limit before new investigation.

Shutdown invalidates the outgoing binding and its leases; reload preserves stored state.
Vetoed transitions preserve binding/epoch. Release subscriptions/guards exactly once.
Do not depend on the optional host UI invalidation callback as the sole safety boundary.
Compaction/navigation preserve committed observations and hypotheses; summaries identify
them as application state, potentially collected outside the visible branch.

## 3. Domain values and lifecycle

The service owns a private mutable aggregate and updates it synchronously after validating
all affected fields, references, capacity and revision metadata. Updates do not reconstruct
or revalidate unchanged collections. EvidenceStore remains the sole evidence authority.
Every service method returning `InvestigationState` returns a detached deep copy, including
nested arrays, targets, rules, references, evidence and conclusions. The public TypeScript
contract stays readonly; copies need not be frozen at runtime. Caller edits cannot change
backing state, and later service updates cannot change earlier copies. Domain creation
helpers and EvidenceStore's separate read APIs continue to return frozen values. Use validated UTC ISO timestamps,
not mutable `Date` values. Inject a clock and opaque ID factory. Validate factory IDs as
nonblank, display-safe, at most 128 UTF-8 bytes, and unique within their ID kind; refuse
collisions atomically. IDs are not truncated or derived from content.

| Value                | Frozen minimum fields and invariants                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Incident`           | ID, question, createdAt, immutable scope, status, optional terminal conclusion. No Pi session object.                                                                                                                                                                                                       |
| `InvestigationScope` | Exact/all rule; `revision` initially 1 and immutable for this delivery; captured selection source and selection revision; namespace policy `unrestricted`; absolute start/end time window. Inventory and connection remain separate.                                                                        |
| `Target`             | Exact context, kind, name, optional known namespace/API version/UID. Identity is the full tuple, with absent values explicit. No guessed default namespace or inferred list-result object. A new UID distinguishes replacement; unknown UID does not prove equivalence to a known UID.                      |
| `Evidence`           | ID, incident ID, source `kubernetes`, execution ID, operation, completion time, exact context, known namespace/container, optional target reference, safe retained excerpt, scope/inventory revisions and generation, truncation flag. No arbitrary metadata, raw args/payload, exceptions, or artifactRef. |
| `Hypothesis`         | ID, incident ID, statement, candidate/supported/rejected status, supporting and contradicting evidence IDs, rationale, revision, updatedAt.                                                                                                                                                                 |
| `InvestigationState` | Incident, targets, EvidenceStore's readonly evidence snapshot, hypotheses, optional focus, safe operation outcomes/counts, startedAt/updatedAt, monotonic aggregate revision. No second writable evidence collection.                                                                                       |
| `EvidenceStore`      | Constructor-bound incident identity; append/get/list, execution idempotency, stable order, independent count/byte capacity checked at append.                                                                                                                                                               |

`new` becomes `investigating` on a diagnostic dispatch or hypothesis mutation.
Only explicit conclusion moves an open incident to `resolved` or `inconclusive`.
Resolved requires a nonblank explanation and at least one cited supported hypothesis
with supporting evidence. Inconclusive requires a reason describing uncertainty and can
have no evidence. Conclusion stores referenced hypothesis/evidence IDs from the same
incident. Resolved means explained, not repaired. Terminal incidents are immutable.

**Slice 6 delivery clarification (2026-10-28):** The public model conclusion tool validates
and queues a proposal during its turn, returning `pending`. It commits through the existing
idle-only controller conclusion boundary after lifecycle/scope work guards release at
`agent_end`. Binding and aggregate revision must still match, no diagnostic work may remain,
and aborted/error completion discards the proposal. A later state change refuses commit;
no terminal lifecycle mutation occurs during active work. The next inspection confirms the
actual terminal state. Local inspection stays available during MCP loss and after conclusion
until another incident starts; transcript messages never supply missing domain state.

Supporting/contradicting links must exist in the same incident, without duplicates or an
ID on both sides. Supported requires support; rejected requires contradiction; candidate
can have neither. Legitimate support and contradiction can coexist. Hypothesis updates
require expected revision; stale updates change nothing. Reference validation establishes
traceability, not automatic correctness of reasoning. The service never invents diagnoses.

Resolve configured `defaultTimeRange` once at creation using an injected clock and a
strictly positive, safe millisecond duration; reject zero, overflow, invalid or out-of-range
timestamps when the setting becomes active. The existing config regex alone is insufficient.
The absolute window guides investigation; only validated tool arguments prove an applied
time filter. Namespace omission means server/context policy, not all-namespace coverage.

## 4. Effective scope, leases and recording seam

Next selection remains the Phase 3 exact/all choice. An incident privately captures that
rule/provenance; subsequent idle `/clusters` changes only next selection. Current incident
resolution is recomputed from its rule and validated inventory, independently from next
selection. A bad/unavailable next selection must not disable a usable incident.

The application must expose one immutable effective-scope view to both tool publication
and dispatch. The following are semantic interface contracts for Slices 4–5, not unused
TypeScript modules to add now:

```ts
// Field types belong to their owning layer; domain code imports no Pi/MCP types.
interface EffectiveInvestigationScope {
  readonly sessionId: string;
  readonly bindingEpoch: number;
  readonly incidentId: string;
  readonly lifecycleEpoch: number;
  readonly scopeRevision: number;
  readonly rule: ClusterScopeRule;
  readonly resolution: ClusterResolution;
  readonly inventoryRevision: number;
  readonly connectionGeneration: number;
  readonly namespacePolicy: "unrestricted";
  readonly readOnly: true;
}
```

`currentScope()` returns either that view or a discriminated absence/refusal (no open
incident, unavailable scope or stale binding). No view is permission to execute without
checking the publication gate, current transport and discovered tool compatibility.
`subscribe` publishes semantic changes to tool/UI consumers. A handler always consults
the current view; visibility never serves as authorization.

`dispatchExecution(expectedAuthority, operation, exactContext, safeProvenance, signal)`
spends one diagnostic attempt and returns a lease or a discriminated refusal immediately
before transport. It does not hold storage capacity for the result. `isCurrent(lease)`
checks registered lease identity, binding/lifecycle epochs, incident openness, immutable
scope revision, inventory revision/generation, publication gate and exact target/tool
availability. A foreign/copied/released lease fails. `release` is idempotent.

The lease carries a unique application execution ID, the view's authority fields and the
exact context; known namespace/container/target references come only from validated
request fields or a narrowly parsed response adapter. Never attach raw argument objects.
Pi tool-call IDs are transport correlation only, not globally unique observation IDs.

Use existing required context schemas and `prepareMcpToolArguments`; never hide, inject,
infer or overwrite model context, even for singleton rules. Reject missing/outside/unknown
context, unavailable target and incompatible discovered schema before dispatch.

### Ordered dispatch and atomic publication

1. Validate model arguments and current incident permission, compatibility, generation,
   cancellation and publication gate. Enumeration remains context-independent discovery.
2. Join the existing application-wide four-active/32-waiting FIFO queue (30-second wait).
   Waiters retain expected incident/binding/lifecycle/scope/inventory/generation authority,
   no lease or spent diagnostic attempt. They still hold the existing work guard.
3. At handoff revalidate authority, acquire the active slot, spend one diagnostic attempt,
   capture one lease and dispatch unchanged validated args, with no intervening await.
4. Normalize/redact/bound the response and build the final compact evidence envelope.
   Hold admission and the lease through presentation and publication.
5. Immediately before successful publication, check cancellation and lease validity again.
   `recordObservation(lease, safeObservation)` synchronously commits exactly one evidence
   record, outcome and aggregate update, returning its evidence ID/excerpt/provenance.
   Construct the matching successful result synchronously, with no await between the check,
   commit and result construction. No late success after invalidation.
6. On failure/cancellation settle work and release lease/slot/guard exactly once. Safe operation
   failure is not evidence. A dispatched attempt remains counted; a pre-dispatch refusal does not.

The recording interface accepts only a successful normalized observation: safe excerpt,
truncation and completion timestamp plus typed provenance/optional target. It cannot amend
scope, create/reopen incidents or accept assistant prose as observations. Return a
discriminated committed/already-committed/refused outcome. Duplicate delivery of the same
execution returns the original immutable evidence; differing content under the same
execution is refused. A real retry allocates a new execution ID, even for identical text.

Record empty successful responses. Malformed/unsupported results, MCP `isError`, auth,
authorization, timeout, transport failure, cancellation and staleness create no evidence.
Failures retain bounded category/operation/context/time information without raw error
strings. Preserve existing transport categories; add domain refusals for no-open-incident,
invalid-state, missing-reference, scope-mismatch, stale-revision, capacity-exceeded and
budget-exhausted. Do not report refusal as an empty success or mark all contexts unhealthy.

Evidence and returned result must agree on ID, excerpt, exact origin and truncation.
The configured text budget includes the whole result envelope (ID, scope and notice).
If envelope overhead leaves less room, truncate the excerpt before commit, mark it partial,
and store exactly that retained excerpt. Never truncate an ID/context into another identity;
if even the required envelope cannot fit, refuse before dispatch.

### Revisions, recovery and invalidation

| Change                          | Effect                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New evidence/hypothesis/focus   | Advance aggregate revision; do not invalidate other concurrent good leases                                                                                       |
| Idle next selection             | Advance next-selection revision; do not change incident rule, its scope revision or valid incident authority                                                     |
| Incident conclusion/replacement | Invalidate incident lifecycle epoch; conclude/replace only while idle after settlement                                                                           |
| Agent cancellation              | Invalidate and settle the affected work; keep the incident open, allow later new work with fresh authority                                                       |
| Session switch/reload/shutdown  | Invalidate outgoing binding/leases; preserve committed process-owned state for reload/same-process resume                                                        |
| MCP loss/reconnect              | Block dispatch and invalidate old work, settle waiters, rediscover tools/inventory, re-resolve both rules, publish matching tools/scope/notices before reopening |

Reconnect preserves exact incident names and budgets. Exact `{alpha, beta}` with refreshed
inventory `{alpha, gamma}` permits alpha, reports beta unavailable and excludes gamma.
Live `*` admits gamma with no rule amendment and labels it not checked. Empty/failed
inventory blocks diagnostics; no default or model-text fallback. Model enumeration does
not install authority. Historical evidence stays attributed to its original generation.
Never replay interrupted calls. Record interruption through the owning controller during
invalidation/settlement; stale callback payloads cannot mutate a terminal/replaced incident.

Phase 3's `ClusterExecutionAuthority` is the integration starting point, not sufficient
incident authority by itself: its state and queue checks currently key off session
selection revision. Slices 4–5 must make effective incident resolution drive both
`McpController.publishReady()` and bridge validation/admission together. Preserve the shared
queue and reconnect publication gate; do not instantiate another manager/queue/connection
for each incident or adapt next selection into incident authority accidentally.

## 5. Capacity, pages, summaries and coverage

Application constants are named and injectable in tests, not new YAML keys in this slice.
All mutations validate capacity atomically; no silent eviction or truncated identifiers.

| Limit                                        | Frozen value / owner                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Incidents                                    | 20 resident investigations across the application; successfully flushed records release a slot; service                                         |
| Evidence                                     | 1,000 committed records per incident; its EvidenceStore                                                                                         |
| Retained evidence content                    | 8 MiB of retained evidence UTF-8 string content per incident; its EvidenceStore                                                                 |
| Question / conclusion / hypothesis rationale | 4,000 characters each; domain/service boundary                                                                                                  |
| Hypothesis statement / focus                 | 2,000 / 1,000 characters; domain/service boundary                                                                                               |
| Safe operation failure explanation           | 512 characters, generated from safe categories; service                                                                                         |
| Evidence excerpt                             | Existing configured `results.maxTextChars`, reduced for the full result envelope; bridge/adapter                                                |
| Local list pages                             | Default 20, maximum 50 records; reject nonpositive/oversized sizes; store/service                                                               |
| Automatic model summary                      | 8,000 characters total; up to eight complete names per availability/change category and eight hypothesis/evidence references; runtime presenter |
| Dispatch budget                              | Configured `investigation.maxToolCalls` per incident; service, active only when incident wiring lands                                           |

Human prose inputs must be nonblank where required, redacted and visibly bounded; reject
oversized mutation input instead of silently changing its question/interpretation. Evidence
presentation can truncate with an explicit flag. Typed identity fields are validated
separately, preserved exactly and never normalized as prose. Use existing context validation
(1,024 UTF-8 bytes per name, up to 1,024 names per exact set); other resource identity
components must be nonblank/display-safe and at most 1,024 UTF-8 bytes each. No resource
output schema is required.

Count UTF-8 string content in each retained evidence record, including IDs and typed
provenance, once; read snapshots are not additional retained records. Other investigation
state (incidents, hypotheses, targets, outcomes and focus) is temporarily excluded from byte
accounting as small overhead. Its existing count and field-length limits still apply. Use
explicit byte calculations, not JS string length. The content limit is not a promise of an
8 MiB JavaScript heap. Outcome count cannot exceed counted diagnostic attempts. Do not
retain unbounded per-query coverage histories or per-session empty-state objects; retained
session state must be backed by an incident or only the currently active empty binding.

After admission and immediately before transport, check and increment the incident's
spent diagnostic attempts synchronously, including calls whose transport throws immediately.
Queued/rejected/cancelled-before-dispatch work spends none. No evidence slots, target slots,
worst-case excerpt bytes, or failure-outcome bytes are held for in-flight calls.
At completion, validate actual record count, targets and evidence byte growth before the
synchronous commit. Concurrent completions cannot oversubscribe storage.
A capacity refusal creates no evidence or successful result; the dispatched attempt stays
spent. Failure outcomes do not consume the evidence byte budget; settle pending work
and retain its safe outcome even when evidence storage is full.
An incident at its evidence limit can still settle work, update interpretation and conclude.
A new incident receives independent evidence capacity; historical incidents never reduce it.
When resident incident slots fill, explicitly flush a concluded investigation to release a
slot. An open incident, including one in a different session, is never evicted or flushed.

Page requests are incident-isolated, ordered by monotonically increasing insertion sequence,
using an opaque cursor bound to incident/collection and a captured high-water sequence.
New appends do not duplicate/reorder an existing traversal; a new traversal sees them.
Reject unknown/foreign cursors and IDs; do not fall back to another incident. If a full
requested page cannot fit the configured response budget, return fewer whole records plus
a continuation cursor. Single evidence inspection remains bounded; never serialize the
entire aggregate/store into a model tool result.

Coverage is observation history, not permission or cluster health. Maintain bounded query
outcomes with exact context, operation, known namespace/target, execution identity, timestamp
and successful/partial/failed/interrupted status. Derive not-checked for permitted contexts
without observations, including new wildcard members. Reappearance retains historical
observations with their timestamps/generation; it does not prove a fresh check. A Pod query
does not establish complete namespace/fleet coverage. Missing namespace is not all namespaces.

Summary messages include incident ID/status, rule/source/scope revision, resolution counts/
available/unavailable names, inventory/generation, changes, distinct next selection, focus,
counts and bounded evidence/hypothesis references. Omit whole names/references with omitted
counts instead of clipping identities. Persist/deduplicate meaningful changes; restore the
current summary through `before_agent_start` after compaction/navigation. Keep policy in
the stable system prompt. Widgets always show READ ONLY and effective scope; full membership
uses the existing 20-name status pages. New inspection commands/tools stay available during
MCP outages; lifecycle mutations retain active-work guards.

Use shared redaction for all retained/displayed free text, and escape terminal control
sequences. Never log credentials, kubeconfig, raw arguments/resources or serialized errors.
Pattern redaction has its existing limits; no claim of universal anonymization. Do not enable
`results.rawRetention`, write raw MCP artifacts, or reconstruct observations from transcript
messages. Only the explicit JSONL flush below writes safe domain records.

### 5.1 Incident-owned storage and explicit JSONL flush

The controller owns at most one open incident **per Pi session**, not a process-global
active incident. The process-owned service keeps each retained investigation's metadata
and EvidenceStore together. Every store binds one validated incident ID at construction;
`append` rejects a different incident. Store `get(id)`, `list(options)` and `snapshot()`
operate only on that collection. Registration and shared evidence accounting are removed.
The service still takes explicit incident IDs for inspection, evidence reads and
`capacity(incidentId)`; reads never infer the currently selected session or incident.

`await service.flush(incidentId, absoluteFilePath)` archives and releases one concluded
investigation. This API is not a model tool or a new production command. Its contract is:

- Require terminal `resolved`/`inconclusive` state and no pending diagnostic work. A session
  switch does not conclude an incident or authorize flushing an open one. Conclusion and
  replacement do not implicitly perform disk I/O.
- Require an explicit absolute destination in an existing directory supplied by the caller;
  never derive operational storage from cwd. Future application wiring should use an
  application-owned archive directory. No archive directory is silently created.
- Write UTF-8 JSONL with a trailing newline. The first line has type `investigation`,
  version `1`, `state` and `evidenceCount`. The state is the complete InvestigationState
  without `evidence`.
  It includes incident/scope/conclusion, hypotheses, targets, focus, outcomes, attempt count,
  timestamps and revision. Following lines: `{type: "evidence", evidence}` in insertion order.
  IDs, provenance and links remain unchanged; JSON encoding preserves embedded newlines.
- Serialize only canonical bounded/redacted domain data. Raw MCP content, transport arguments,
  errors, credentials and kubeconfig are never added. Raw retention remains disabled.
- Create a same-directory private temporary file (mode `0600`), write and sync its contents,
  close it, then publish with a hard link that refuses an existing destination (including a
  symlink). Remove the temporary file on success or failure after creation. The destination
  is never published partially or overwritten. This is not a power-loss durability guarantee
  for the directory entry or a cross-process transactional database.
- Reject overlapping flushes for the same incident; other investigations can continue.
  Reads remain available while flushing. Any I/O failure retains the entire in-memory
  investigation and capacity, preserves the error cause, and permits retry. If publication
  succeeded but cleanup failed, the file can exist while state is retained; retry with a
  different destination. Successful flush removes the service's metadata, Store and execution-idempotency index together
  and returns `{incidentId, path, evidenceCount}`.
- After success, service inspection, evidence reads and recording with old execution tokens
  refuse the now-missing incident. No implicit disk loading, cursor resurrection, import,
  reopen, or reconstruction from Pi messages is provided. Callers may retain the returned
  archive receipt; the service keeps no unbounded archive index. Existing snapshots held
  by callers remain detached values and are outside service-owned retention.

This is explicit archival, not a way to reset an open incident's evidence or dispatch budget.
Resident incident count bounds process retention separately from each incident's evidence
limits. Archive file retention/deletion policy and production UI integration are deferred.

## 6. Assertions to migrate when incident wiring lands

Do not change accepted Phase 3 production behavior in Slice 0. Add explicit incident-backed
cases later; retain low-level session-scope fixtures where they test the reusable primitives.

| Existing coverage                                                                                                      | Phase 4 migration / invariant retained                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scoped-tool-bridge.test.ts`, `phase3-acceptance.test.ts`: idle selection immediately retargets subsequent diagnostics | With an incident, A remains A after next selection B; explicitly start I2 to use B. Preserve exact context, transcript origin and per-target isolation.                                                                                  |
| `cluster-scope-messages.test.ts`, cluster status/picker tests                                                          | Show incident authority and distinct next choice together; retain pagination, bounded names, READ ONLY, stale picker guards, deduplication and compaction restoration.                                                                   |
| `mcp-restart.test.ts`, `multi-context-routing.test.ts`                                                                 | Reconcile the active rule even if next choice is invalid; preserve exact/all transitions, publication-listener dispatch refusal, stale generations and compatibility checks.                                                             |
| `queued-admission.test.ts`, parallel agent-loop tests                                                                  | Waiters check incident/binding/lifecycle authority; next choice and ordinary evidence updates do not invalidate good incident work. Preserve FIFO capacity/cancellation, count only dispatched attempts, check actual storage at commit. |
| `phase2-acceptance.test.ts`, application/runtime lifecycle tests                                                       | Prompts create only through eligible lifecycle hooks; new/fork isolates, reload/resume preserves in-memory state, fresh owner has no restoration. Historical Phase 2 documents remain unchanged.                                         |
| Bridge/normalizer policy tests                                                                                         | Successful observations get matching stored IDs before publication; empty success is evidence, failure/staleness never is. Preserve allowlist, discovered schemas, redaction, limits, no shell and disabled raw retention.               |

Slice 1 implements domain values/invariants; Slice 2 storage; Slice 3 lifecycle/hypotheses/
budgets; Slices 4–5 land incident authority and evidence capture together (or remain inactive
until both pass); Slice 6 adds public tools/commands; Slice 7 performs full-path acceptance.

## 7. Verification

The lifecycle suite covers eight offline cases: eligible creation/continuation; commands,
handled/extension/custom input and credential/scope refusal; streaming user/application
queues; actual overflow compaction/retry; reload/tree identity; new/fork/resume and fresh-owner
isolation; vetoed replacement; and tool-abort-before-replacement ordering. It verifies the
integration strategy, not production incidents, capacity accounting, lease enforcement or
evidence capture, which require the later slices' tests.

Validation results are recorded in the [Slice 0 status](./PHASE4_IMPLEMENTATION_SLICES.md#6-slice-0--freeze-domain-and-runtime-contracts).
No live provider, installed-terminal, or real-cluster behavior is claimed by this slice.
