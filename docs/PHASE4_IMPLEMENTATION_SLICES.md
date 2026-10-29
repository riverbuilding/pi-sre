# Phase 4 Implementation Slices — Investigation Domain

**Status:** Slice 0 contracts and offline lifecycle fixtures completed on 2026-10-20; see [PHASE4_CONTRACTS.md](./PHASE4_CONTRACTS.md). Slice 1 domain models and pure invariants completed on 2026-10-21; Slice 2 bounded EvidenceStore completed on 2026-10-22; Slice 3 investigation service, hypothesis consistency, and dispatch accounting completed on 2026-10-23; Slice 4 application controller, lifecycle hooks, and incident authority completed on 2026-10-23, initially inactive; Slice 5 observation capture and runtime/bridge activation completed on 2026-10-27. Production incidents, evidence capture and per-incident diagnostic budgets are enabled. Slice 6 public inspection/interpretation completed on 2026-10-28. Slice 7 automated acceptance and installed-package/live-cluster smoke passed on 2026-10-29; visual terminal acceptance remains pending; see [PHASE4_ACCEPTANCE.md](./PHASE4_ACCEPTANCE.md). Renumbered on 2026-10-18 after insertion of Phase 3 Context Selection and Multi-Cluster Routing.

**Applies to:** Pi SRE V0.1, Phase 4 — Investigation Domain.

**Prerequisite (met):** [Phase 3 Context Selection and Multi-Cluster Routing](./PHASE3_IMPLEMENTATION_SLICES.md) and its [acceptance gate](./PHASE3_ACCEPTANCE.md) completed on 2026-10-20. Phase 2 remains the unchanged historical baseline.

**Source of truth:** [DESIGN.md](./DESIGN.md), especially Sections 13–16, 28–30, 40–45,
50, 66, and 74. The decisions below make those architectural examples implementable;
they are Phase 4 target contracts, not existing behavior. The accepted [multi-cluster plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md) defines first-delivery scope and later extensions.

**Capacity amendment (2026-10-23):** Reservations are removed from the store and service.
Dispatch spends one attempt immediately; completion checks actual evidence/aggregate count
and bytes before synchronous commit. Earlier dated validation records below describe the
implementation at that time; this amendment supersedes their reservation behavior.

**Storage amendment (2026-10-23):** Each incident owns one EvidenceStore and independent
evidence count/byte limits. Service-level explicit JSONL flush archives a concluded
investigation before releasing its metadata, store and resident-incident slot. This replaces
the original application-wide evidence limits and memory-only/no-export choice.
See [the exact archive contract](./PHASE4_CONTRACTS.md#51-incident-owned-storage-and-explicit-jsonl-flush).

## 1. Goal

Operational investigation state must exist independently from the Pi transcript.
Deliver all seven requested components:

```text
Incident
InvestigationScope
Target
Evidence
Hypothesis
InvestigationState
EvidenceStore
```

The completed path is:

```text
user question + explicit selection or default live-* rule
    → create incident with immutable scope rule and initial resolution
    → capture incident identity and current execution authority
    → validate arguments, resolve one permitted target, and bind its exact context
    → call an approved read-only MCP tool
    → normalize, redact, and bound the result
    → commit successful observation to EvidenceStore
    → return compact content with evidence ID and originating scope
    → record hypotheses referencing that evidence
    → explain findings or conclude inconclusive
```

Pi continues to own conversation, agent execution, compaction, and the TUI. Pi SRE owns
the investigation and its consistency. A completed investigation never means that Pi SRE
repaired infrastructure.

## 2. Starting Point

This is the accepted Phase 3 baseline used by Slice 0:

| Component                                       | Phase 4 use                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Phase 3 session rule/resolution                 | Capture the selected exact/all rule at incident creation; separate incident authority from next selection                   |
| Phase 3 model routing and snapshots             | Reuse required model context and per-target validation; extend execution authority with incident/session/lifecycle identity |
| Existing MCP controller, registry, and recovery | Reuse discovery/reconciliation; evaluate the active incident rule as well as the session's next choice                      |
| Existing normalizer and provenance              | Add evidence capture after safe presentation and before successful Pi publication                                           |
| Domain/investigation placeholders               | Implement incident, evidence, hypothesis, lifecycle, storage, and budgets here                                              |
| Pi lifecycle and state messages                 | Add incident identity/summaries without rebuilding Phase 3 command and recovery behavior                                    |

Phase 3 allows idle `/clusters` selection to change the session rule immediately because no incident exists. Phase 4 adds the distinct rule captured by an active incident. After this integration, `/clusters` changes next selection while that incident continues under its own rule. Visibility and dispatch must switch to the same effective incident authority together.

## 3. Scope Boundary

### In scope

- Pi-independent domain models, validation, and lifecycle rules;
- immutable exact-set/live-`*` incident rules, current resolution, and explicit per-call targets;
- integration of inherited one-agent/one-MCP exploratory routing and reconnect reconciliation with incident authority, evidence, and shared budgets;
- bounded per-incident in-memory evidence storage with stable IDs and provenance;
- explicit service-level JSONL archival and memory release for concluded investigations;
- hypothesis creation, revision, and evidence links;
- a session-owned investigation controller and immutable state snapshots;
- automatic capture of successful diagnostic results before publication to Pi;
- bounded per-context query outcomes distinguishing successful, failed, interrupted, partial/truncated, and not checked;
- incident-aware dispatch, tool availability, recovery, and stale-result protection;
- bounded model summaries and minimal `/incident` and `/evidence` commands;
- deterministic acceptance and an explicit installed-application smoke runbook.

### Deferred

- an incident database, archive import/resume, automatic archival, production archive UI,
  or restoration from transcripts;
- raw MCP artifacts, artifact browsing, or enabling `results.rawRetention`;
- active-rule amendment, pattern selectors, rich fleet workflows/comparison views;
- multiple MCP servers, per-user authentication, and remote workers;
- a namespace picker or application-level namespace/workload access restrictions;
- diagnostic skills, automatic hypothesis generation, RCA scoring, and kind fault suites;
- a comprehensive incident dashboard or timeline UI;
- additional Kubernetes operations, generic resource access, shell access, and remediation.

The new [Phase 5](./PHASE5_IMPLEMENTATION_SLICES.md) owns the 22-tool Kubernetes MCP
config/core parity milestone, including its explicit controlled-operations design expansion.
Phase 6 owns diagnostic knowledge, Phase 7 owns automated kind diagnosis evaluation, and
Phase 8 owns broader TUI refinement. Phase 4 remains read-only and includes enough
interaction to use and verify the domain without depending on those phases.

## 4. Proposed Behavioral Contracts

### 4.1 Incident creation and lifecycle

- Maintain at most one active incident per Pi session. Retain concluded incidents for
  inspection within the bounded application lifetime until explicitly flushed to JSONL.
  Other sessions may retain their own open incidents; there is no global active incident.
- The first top-level user prompt without an active incident creates one when the selected
  rule resolves against validated inventory to at least one available target. Subsequent
  prompts continue it until explicitly concluded or replaced. Do not use an LLM classifier
  to guess incident boundaries.
- Commands, application scope messages, steering delivery, compaction retries, and extension
  reloads must not create duplicate incidents. Verify Pi hook ordering in Slice 0.
- With no usable scope resolution, leave the investigation absent, explain the inventory
  or availability requirement, and keep cluster-dependent calls blocked. Do not create an incident
  and fill its rule later from model text. Preserve pending selection intent for recovery.
- Diagnostic dispatch requires an open incident bound to the current session. A captured
  handler or model tool call cannot lazily create one, reopen a concluded incident, or fall
  back to the next-investigation selection. Local state inspection remains available.
- `/incident new <question>` explicitly starts another incident while idle. Validate all
  inputs and capacity first; if one is active, conclude it as `inconclusive` with a safe
  replacement reason and create the new incident atomically. Preserve the earlier state.
- Preserve the design's statuses: `new`, `investigating`, `resolved`, `inconclusive`.
  Dispatching a diagnostic call or recording a hypothesis moves `new` to `investigating`.
  An explicit conclusion moves an open incident to a terminal status; agent-loop completion,
  cancellation, MCP loss, and a fluent assistant answer do not do so automatically.
- `resolved` means the diagnostic question has an evidence-backed explanation. Require a
  nonblank conclusion and at least one `supported` hypothesis with supporting evidence.
  It does not assert recovery or remediation. `inconclusive` records a reason and remaining
  uncertainty and may have no evidence. Terminal incidents are immutable; follow-up work
  starts another incident.

### 4.2 Incident rule, live resolution, and next selection

| Value              | Authority and lifetime                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Next selection     | Explicit CLI/config choice or default live `*`, then unified `/clusters`; used for the next incident                                      |
| Incident rule      | Immutable exact set or live all-contexts (`*`), initial scope revision, and selection provenance                                          |
| Current resolution | Application evaluates that rule against validated inventory and tool compatibility                                                        |
| Execution lease    | One call's exact permitted context plus current incident/session/lifecycle, scope revision, inventory revision, and connection generation |

If I1 has exact rule {A} and the user selects B while idle, I1 still uses A and I2 starts on B. Show **investigation exact {A}; next exact {B}**. Existing active-work selection guards remain. No next-selection command amends I1.

For exact {A, B}, new inventory context C is outside scope; if B disappears it is unavailable, while A may remain usable. For live `*`, C joins permission after validated inventory refresh without reselection, but starts as not checked. Removed members become unavailable. This changes resolution, not the incident rule. The first delivery supports neither patterns nor active-rule amendment; selecting a changed rule requires another incident.

Execution contracts:

- Every cluster-dependent call requires one model-supplied exact context for singleton, exact-set, and live-`*` rules. Keep it visible and required in every model schema; never inject or overwrite it. Reject missing, unknown, unavailable, out-of-scope, or tool-incompatible values before dispatch.
- The bridge resolves and captures one immutable lease per call. Never route parallel A/B calls by switching a global current context. Tool visibility and execution use the same incident resolution; a tool usable on one target is not automatically usable on every member.
- Keep inventory and selection revisions separate from scope-rule revision, aggregate evidence revision, lifecycle epoch, and connection generation. Ordinary evidence changes and next selection do not invalidate valid concurrent leases. Incident/session replacement, conclusion, cancellation, and connection replacement do.
- Reconnect blocks dispatch and invalidates/settles old work, discovers replacement tools and complete context inventory, validates and re-resolves the unchanged rule, then atomically publishes state/tools and bounded change notices before dispatch resumes. Failed inventory discovery blocks diagnostics; no defaults or model text rescue it.
- Preserve exact names through recovery; recompute live `*`. Empty resolution blocks calls without rewriting the rule. A partially available incident can continue on usable members even if next selection is invalid. Never replay interrupted operations automatically.
- Recheck lease validity immediately before synchronous evidence commit/publication. Keep committed old observations; withhold old-generation late success. Publish added/removed/changed/unavailable notices and current resolution to model/TUI. Queued steering is explanatory, not the enforcement boundary.

“Live” means current successful application discovery, initially startup/reconnect, not continuous kubeconfig watching. Model context enumeration does not itself refresh authority. Keep the current registry and transport in the existing cluster/MCP layers; use an injected scope/lease seam rather than `captureScope()` / `isCurrent()` as sole incident authority.

### 4.3 Namespace, targets, and time

Phase 4 retains the current unrestricted application namespace policy. Model arguments can
choose a namespace where the discovered tool supports it. An omitted namespace means
server/context policy, never proof of all-namespace coverage. Do not turn an incident
question, target namespace, or time range into an unenforced access restriction.

Use `Target` as the public domain name, rather than adding a competing `KubernetesTarget`.
A target is an identified resource, not a query or selector. Record exact cluster context,
kind, name, and known namespace, with optional API version and UID. Never invent a default
namespace, UID, workload relationship, or list-result target. Unknown namespace stays unknown;
different contexts, kinds, or namespaces produce distinct identities. A later UID can
distinguish a replacement object with the same name.

Resolve `defaultTimeRange` once at incident creation into an absolute investigation window
using an injected clock. It provides diagnostic focus. Only claim a tool applied a time
filter when the validated call actually did. Model broader namespace/workload restrictions
only when a later design also supplies enforcement for them.

### 4.4 Evidence and operation outcomes

Evidence is a successful MCP observation, not an assistant claim or inferred root cause.
Store the deterministic, redacted, bounded presentation from the normalizer. A free-form
Kubernetes response does not require a Pi SRE resource schema to become evidence.

| Result                                                             | Required handling                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Successful diagnostic result                                       | Store exactly one evidence record for that execution and return its ID.                |
| Successful empty content or empty resource collection              | Store the successful observation; do not infer that the cluster contains no resources. |
| Truncated result                                                   | Store the retained excerpt with `truncated: true`; disclose partial presentation.      |
| Unsupported/malformed result                                       | Safe failure outcome; no successful evidence.                                          |
| Authentication, authorization, timeout, transport, or tool failure | Preserve a safe, distinct operation outcome; no resource fact or false empty result.   |
| Cancellation, stale generation, or stale incident/session          | No evidence commit or late successful publication.                                     |
| Context enumeration                                                | Remains operational discovery; does not become incident diagnostic evidence.           |

Record originating context, applicable namespace, operation name, execution ID, observation
completion time, scope revision, inventory revision, connection generation, and truncation. The completion
time is when Pi SRE obtained the observation, not necessarily the resource event time.
New wildcard members are not retroactively covered by earlier queries. Absence/health claims must name actual query scope and disclose failed, partial, and unqueried targets. Inventory availability is not coverage.
Use small typed provenance fields. Never attach raw arguments, arbitrary metadata, full
responses, credentials, or serialized exceptions to evidence or Pi details.

Where useful, an adapter may derive a resource reference from validated request fields or
parse only the response fields needed to identify a target. Accept extra server fields.
Failure to identify a target must not invalidate otherwise usable diagnostic content.

Do not deduplicate by identical text: observations at different times are distinct evidence.
Use an execution identity to make repeated delivery/commit idempotent. A real retry has a
new execution identity. Hypothesis statements cannot edit an evidence record.

### 4.5 Hypotheses and conclusions

- Retain `candidate`, `supported`, and `rejected` statuses. The model or user explicitly
  proposes interpretation; the service validates consistency rather than diagnosing from text.
- Supporting and contradicting evidence IDs must exist in the same incident. Reject unknown
  IDs, cross-incident links, duplicates, or an ID on both sides in one hypothesis.
- `supported` requires supporting evidence. `rejected` requires contradicting evidence.
  These constraints establish traceability, not proof that the interpretation is correct.
- Keep IDs stable, validate bounded statements and rationales, and expose revision checks
  so stale updates cannot overwrite newer interpretation. Preserve both support and
  contradiction when legitimately present.
- Concluding an incident stores its explanation and cited hypothesis/evidence IDs. An
  inconclusive conclusion must remain distinguishable from a supported diagnosis.

### 4.6 Storage, limits, and sensitive data

**Phase 4 choice:** One in-memory EvidenceStore per incident, plus explicit service-level
JSONL archival of concluded investigations. Keep `results.rawRetention: disabled`.
EvidenceStore retains safe observation excerpts, not raw MCP responses; no `artifactRef`
is populated. Process exit loses unarchived state. Archives preserve offline history but
cannot restore active investigations or execution authority. Pi messages are not a database.

Named, injectable limits are 20 resident investigations across the application, and **per
incident** 1,000 evidence records and 8 MiB of retained evidence UTF-8 string content;
at most 100 targets and 50 hypotheses per incident. Each EvidenceStore owns its byte ledger.
Other investigation state is excluded from evidence byte accounting; its count and
field-length limits remain. Existing per-result text/item limits still apply.

Reject capacity-exceeding mutations atomically and visibly. Never silently evict cited
evidence or truncate IDs into collisions. Check actual evidence capacity and collection
limits at completion before synchronous commit. Storage refusal creates no evidence or
successful publication; the dispatched attempt stays spent. Pending work can still settle
and record safe failure outcomes. A full incident can conclude; its history never consumes
the next incident's evidence quota.

`flush(incidentId, absoluteFilePath)` requires a concluded, idle incident. Write the complete
investigation metadata and ordered evidence as versioned JSONL, publish the complete file
without overwriting an existing destination, then release the service-owned state and its
resident slot. Failures preserve memory and allow retry; overlapping same-incident flushes
are refused. Reads remain available until release. After release, in-memory inspection
refuses the missing incident; automatic archive loading/import is not provided. A session
switch never flushes an open incident. See the detailed format, publication, permissions
and failure rules in [Section 5.1 of the contracts](./PHASE4_CONTRACTS.md#51-incident-owned-storage-and-explicit-jsonl-flush).

All retained free text receives shared redaction and bounded presentation, including
questions and hypothesis rationales. Terminal display must escape control sequences.
Pattern redaction retains its documented limits for arbitrary sensitive application data;
do not claim universal anonymization. Only explicit flush persists these domain records;
no raw payload or serialized transport exception is written.

Activate `investigation.maxToolCalls` as the per-incident diagnostic dispatch budget.
Successful and failed dispatched attempts count; rejected preflight calls, local domain
tools, and startup/context discovery do not. Check and increment synchronously immediately
before transport so parallel calls cannot exceed it. Exhaustion blocks further diagnostics and allows explanation or
an inconclusive conclusion; it does not fabricate evidence or automatically resolve the incident.

### 4.7 Pi session lifecycle and model context

- Own stores and services outside extension factory closures so `/reload` does not reset them.
  Route all tools through the currently bound Pi session identity; avoid module-global state.
- Compaction and tree navigation do not delete or rewind operational observations. A branch
  can refer to evidence collected elsewhere in the same Pi session; the state summary must
  identify it as application state rather than evidence implied by the visible branch.
- A new or forked Pi session starts with no active incident. Resuming a session in the same
  process may reconnect to its existing in-memory state by exact Pi session identity.
  Switching away invalidates pending leases for that session binding.
- Resuming after process restart starts without structured investigation state. Never rebuild
  authority by parsing old messages or assistant prose. Explain this limit and start a new
  incident from the current explicit selection when requested.
- Stable policy belongs in the system prompt. Publish bounded state messages on meaningful
  incident changes, deduplicate unchanged state, and restore the latest summary if compaction
  removed it. Do not append the entire store or change the system prompt on every request.
- A summary includes incident ID/status, scope rule/revision, resolved contexts/availability, inventory revision, changes, next selection when
  different, current focus, counts, and a bounded set of hypotheses/evidence references.
  Provide paginated local reads for additional evidence. Messages describe state; services
  and the bridge independently enforce it.

## 5. Domain Contracts and Ownership

All domain contracts use readonly fields, stable opaque IDs, and explicit timestamp values
that cannot be mutated through returned snapshots. Prefer UTC ISO strings over mutable
`Date` objects at public snapshot boundaries; validate and compare them through shared
domain helpers. Inject clocks and ID factories into services for deterministic tests.

| Component            | Minimum contract                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Incident`           | ID, bounded question, creation time, immutable scope rule, status, optional terminal conclusion. No Pi session object.                                                                           |
| `InvestigationScope` | Exact-set/live-all rule, initial scope revision and selection provenance; unrestricted namespace policy and absolute time window. Current resolution and live connection authority are separate. |
| `Target`             | Cluster context, resource kind/name, known namespace, optional API version/UID. Container selection belongs to observation provenance where relevant.                                            |
| `Evidence`           | ID, incident ID, source `kubernetes`, collected-at time, context, optional target reference, safe summary, context/scope/inventory/generation provenance, truncation flag.                       |
| `Hypothesis`         | ID, incident ID, statement, status, supporting/contradicting evidence IDs, rationale, revision and update time.                                                                                  |
| `InvestigationState` | Incident, targets, evidence, hypotheses, optional current focus, operation counts/outcomes, started/updated time, monotonic revision. Immutable aggregate snapshot.                              |
| `EvidenceStore`      | Bind one incident at construction; append idempotently; get by ID; list stable ordered pages; report independent capacity. Never expose mutable backing collections or raw MCP objects.          |

EvidenceStore is the single evidence authority. `InvestigationState.evidence` is its readonly
snapshot, not another writable collection. The investigation service coordinates evidence,
targets, hypotheses, lifecycle, and aggregate revisions. An unsuccessful mutation changes
none of them. Public APIs return discriminated outcomes with safe actionable context.

```text
src/
├── domain/
│   ├── incident.ts
│   ├── investigation-scope.ts
│   ├── target.ts
│   ├── evidence.ts
│   ├── hypothesis.ts
│   └── investigation-state.ts
├── investigation/
│   ├── evidence-store.ts              # contract and bounded in-memory implementation
│   ├── investigation-archive.ts       # explicit JSONL publication
│   └── investigation-service.ts       # consistency, lifecycle and flush
├── app/
│   └── investigation-controller.ts    # session binding, scope leases, composition
├── mcp/
│   ├── evidence-adapter.ts            # normalized observation → domain input
│   └── tool-bridge.ts                 # thin dispatch/capture wiring
├── runtime/
│   ├── investigation-tools.ts         # local domain-tool definitions
│   └── investigation-context.ts       # bounded model summary
└── tui/
    └── investigation-extension.ts     # lifecycle and minimal commands
```

Names are proposed; do not create unused abstractions or placeholder modules. Domain and
investigation services import neither Pi APIs nor MCP transport types. The application
injects the recording/scope interface into the bridge. Extensions register and delegate;
they do not implement state transitions or Kubernetes diagnosis.

## 6. Slice 0 — Freeze Domain and Runtime Contracts

**Outcome:** Implementation has explicit decisions and verified public integration seams.

### Work

- Confirm Sections 4–5 against DESIGN.md and record any necessary design clarification.
- Inspect installed Pi types and behavior for prompt hooks, input sources, session identity,
  new/resume/fork/reload/tree events, custom messages, and tool cancellation. Existing types
  expose these events; verify ordering and lifecycle through executable fixtures.
- Freeze creation rules, conclusion semantics, immutable scope rules and live resolution, storage limits, pagination,
  execution identity, lease invalidation, and budget accounting.
- Specify the effective-scope interface used by both tool visibility and execution, plus
  the successful-observation recording interface. Identify Phase 2 assertions that must
  evolve from the accepted Phase 3 session rule to incident-owned authority without weakening routing/recovery coverage. Reuse its `/clusters`, default live `*`, exact sets, and required model context; these are prerequisites, not Phase 4 implementation tasks.
- Create `docs/PHASE4_CONTRACTS.md` with verified decisions and small sanitized examples.

### Acceptance

- Fixture tests prove one incident per intended creation, correct session binding, and hook
  behavior under queued input, compaction retry, reload, and switch/fork.
- No new Kubernetes operation, exact diagnostic output schema, or second connection is needed.
- Every proposed domain field and limit has an owner; live state remains in memory; explicit terminal JSONL archival follows the storage amendment.

**Completed (2026-10-20):** [PHASE4_CONTRACTS.md](./PHASE4_CONTRACTS.md) freezes creation and conclusion semantics, session binding, immutable incident scope versus next selection, effective-scope/lease and synchronous recording interfaces, capacity reservations, dispatch accounting, pagination, summary limits and the migration of existing routing/recovery assertions. Installed Pi 0.99.0 was inspected directly. Eight real-Pi offline fixture cases verify prompt sources and preflight, queued delivery, actual overflow compaction/retry, reload/tree navigation, new/fork/resume and fresh-owner isolation, vetoed replacement, and executing-tool cancellation before shutdown. The fixture's creation witness is test-only; no production domain behavior is implemented in this slice.

**Validation (2026-10-20):** Focused lifecycle, existing public Pi contracts, scoped stdio bridge and persistent scope-message suites passed (25 tests). `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (527 passed; 7 optional executable-dependent contract tests skipped), `npm run build`, and `git diff --check` passed. No live provider, installed-terminal or real-cluster validation was performed; full Phase 4 acceptance remains Slice 7.

## 7. Slice 1 — Domain Models and Pure Invariants

**Outcome:** All six domain models are usable without Pi, MCP, or a live cluster.

### Work

- Implement `Incident`, `InvestigationScope`, `Target`, `Evidence`, `Hypothesis`, and
  `InvestigationState` contracts with creation/validation helpers where behavior needs them.
- Implement exact-set/live-all rules, nonempty exact membership validation, resolution, identity, time-window validation, lifecycle transitions, and immutable snapshots. Keep inventory/session/transport authority outside permanent incident scope; patterns and active-rule mutation are absent.
- Define safe discriminated errors for invalid state, scope mismatch, missing references,
  stale revision, and capacity/budget refusal. Keep transport error categories outside the domain.

### Acceptance

- Unit tests cover valid/invalid creation, exact context identity, target identity and unknown
  namespace, exact membership versus live-all resolution changes, invalid time ranges, terminal transitions, and nested mutation attempts.
- Changing a caller-owned selection, target array, or timestamp cannot mutate an incident.
- Domain files have no Pi or MCP imports and no Kubernetes API implementation.

**Completed (2026-10-21):** `src/domain/` defines all six models, privately frozen snapshots, exact target identity, captured exact/live-all scope and separate inventory resolution, canonical UTC windows with injected-clock duration resolution, bounded/redacted text, typed failures, evidence-reference validation, and explicit diagnostic lifecycle transitions. Snapshot collection limits are named and injectable. The shared redactor now lives in `src/shared/`, with the existing MCP import path preserved. No runtime incident creation, evidence storage, dispatch accounting, or incident authority is enabled; these remain later slices.

**Validation (2026-10-21):** Domain unit tests cover caller-owned/nested mutation, exact identity and unknown namespace, live versus exact inventory changes, invalid creation/time windows, evidence/hypothesis links, terminal transitions, aggregate consistency and injected collection limits. `npm run check`, `npm run lint`, `npm run format:check`, `npm test` (536 passed; 7 optional executable-dependent contract tests skipped), `npm run build`, and `git diff --check` passed. No provider or live-cluster validation was needed for this pure-domain slice.

## 8. Slice 2 — Bounded EvidenceStore

**Outcome:** Safe observations have a stable, queryable home independent of conversation.

### Work

- Bind each store to one incident; implement append/get/list, stable collection order, bounded page
  sizes, execution idempotency, and byte/count accounting.
- Check actual count/bytes synchronously at append and commit atomically.
- Retain only safe domain content; expose immutable snapshots and capacity state.

### Acceptance

- Unit tests cover independent observations with identical text, duplicate execution delivery,
  unknown incident/ID, stable pages, immutable reads, count/UTF-8 byte limits, and failed-write atomicity.
- Concurrent writes cannot overshoot limits or expose half-written records. Failed writes
  consume no storage. Different incidents and application instances have independent capacity.
- No file is written, no artifact reference is invented, and no raw payload is retained.

**Completed (2026-10-22):** `src/investigation/evidence-store.ts` provides incident-registered append/get/list, stable evidence IDs, execution-idempotent delivery, immutable safe excerpts, application-wide count limits and synchronous capacity reservations/commits. Authenticated, store/incident-bound high-water cursors preserve insertion order without retaining cursor histories. Pages include only whole records within their serialized UTF-8 response budget; a record that cannot fit produces an explicit refusal. `ContentCapacity` originally supplied a shared 8 MiB UTF-8 string-content ledger. The 2026-10-23 simplification makes that ledger EvidenceStore-owned and counts only evidence content; incident registration remains a bounded identity index. Default pages contain 20 records (maximum 50) within 64 KiB; callers can supply a smaller presentation budget. No runtime composition, incident lifecycle, transport capture, raw retention, file artifacts or persistence is enabled.

**Validation (2026-10-22):** Storage and domain tests cover identical-text observations, duplicate/conflicting delivery, incident/ID isolation, high-water pages, cursor tampering/isolation, whole-record presentation budgets, immutable reads, exact UTF-8 boundaries, shared accounting, out-of-order completions, reservation cleanup, forged tokens and independent application instances. `npm run check`, `npm run lint`, `npm run format:check`, `npm test` (552 passed; 7 optional executable-dependent contract tests skipped), `npm run build`, and `git diff --check` passed. No provider, installed-terminal or live-cluster validation was needed for this storage-only slice.

## 9. Slice 3 — Investigation Service and Hypothesis Consistency

**Status:** Completed on 2026-10-23. Slice 4 now composes the service under the application-owned MCP controller; runtime/bridge activation remains deferred until Slice 5.

**Outcome:** One service owns coherent investigation snapshots and explicit interpretation.

### Work

- Implement start, replace, inspect, focus/target updates, hypothesis upsert, conclude, and
  explicit asynchronous flush of concluded investigations to JSONL.
- Coordinate EvidenceStore with aggregate revision/timestamps and target references.
- Enforce evidence-link rules, conclusion requirements, terminal immutability, limits, and
  per-incident diagnostic dispatch accounting.
- Keep session identity/routing in the application controller, outside the domain aggregate.

### Acceptance

- Unit tests cover supported/rejected hypotheses, contradictory links, cross-incident IDs,
  stale revisions, atomic replacement, terminal updates, and clock/ID determinism.
- Concluding `resolved` without supporting evidence fails; `inconclusive` needs an explanation.
- A failed mutation changes no state or budget; parallel dispatches respect maxToolCalls.
- Agent-loop completion has no domain transition by itself.

### Implementation and handoff

- `src/investigation/investigation-service.ts` owns bounded process-lifetime investigations, explicit start/replace/conclude, immutable inspection, focus/targets, hypothesis revisions, and diagnostic accounting. Callers supply incident identity; the service has no global current incident or Pi session map. The future controller owns one-active-incident-per-session binding, usable inventory/tool compatibility, active-agent guards, cancellation and authority checks.
- Start captures the selection and resolves the absolute time window once through injected clock/ID factories. Replacement validates the new question, scope, time, IDs and incident count before atomically retaining a new incident and concluding the previous open one as inconclusive. Concluded incidents remain inspectable and consume a resident incident slot until explicitly flushed.
- Each incident owns its EvidenceStore and independent evidence count/byte limits. Store registration is removed; `capacity(incidentId)` reports only that incident. EvidenceStore remains the only observation owner. Internal aggregate snapshots read its immutable records; public evidence inspection delegates to its bounded get/list APIs. EvidenceStore exclusively owns the byte ledger and charges evidence content once. Other aggregate state and read snapshots do not consume the evidence byte budget.
- Hypothesis upserts validate same-incident evidence links, support/contradiction requirements, bounded redacted prose and per-hypothesis expected revisions. Aggregate revisions advance for mutations; ordinary updates do not invalidate independent diagnostic executions. Resolved conclusions require a cited supported hypothesis with supporting evidence.
- `dispatchDiagnostic` checks and spends one attempt immediately before transport, including synchronous transport throws. It returns an execution identity and holds no storage capacity. Successful recording checks actual evidence capacity and target validity, then synchronously commits matching evidence/outcome/state. Failure or interruption retains a safe category explanation independently of the evidence byte budget; capacity refusal remains explicit and pending work still settles. Settled/copy/foreign execution tokens cannot mutate state. Identical successful delivery with the original token is idempotent; conflicting delivery fails.
- Outcomes retain exact context, operation, known namespace/target, execution ID, completion time, scope/inventory revisions and connection generation. Empty success is evidence; truncated success is partial. No raw arguments, responses, exceptions, raw artifacts or transcript restoration are introduced. Explicit JSONL archives contain safe canonical domain state only.
- Slices 4–5 must dispatch only after shared-queue admission, enforce session/lifecycle/inventory/connection authority before dispatch and immediately before recording, and settle invalidated work through `releaseDiagnostic` before conclusion/replacement. Service execution tokens alone grant no Kubernetes execution authority. The bridge must budget the complete result envelope and publish exactly the committed excerpt/provenance.

**Validation (2026-10-23):** Domain/storage/service tests cover supported/rejected hypotheses, conflicting/duplicate/cross-incident evidence links, stale revisions, terminal guards, atomic replacement/refusal, deterministic clock/IDs, out-of-order observations, exact provenance, empty/partial observations, safe failure categories, cancellation, forged tokens, concurrent attempts and target reservations, shared application limits, partial-reservation cleanup, full-capacity prepaid commits and exact UTF-8 accounting. `npm run check`, `npm run lint`, `npm run format:check`, `npm test` (578 passed; 7 optional executable-dependent contract tests skipped), `npm run build`, and `git diff --check` passed. No provider, installed-terminal or live-cluster validation was needed for this service-only slice.

### Incident storage/archive amendment (2026-10-23)

The storage and service implementation now follows incident-owned stores rather than the
application-wide storage described in the historical Slice 2/3 records above. One retained
entry holds metadata and its own EvidenceStore. Explicit service `flush` archives terminal
state and ordered evidence through `investigation-archive.ts`, then releases the entry.
No production command invokes archival. Slice 4 adds controller delegation and session-reference cleanup; runtime activation remains deferred until Slice 5.
Targets and hypotheses have no separate count limits; the earlier injectable snapshot
collection limits have been removed because their storage overhead is negligible.

Validation covers independent incident count/UTF-8 byte limits, immutable reads, stable
pagination, atomic refusal, complete/redacted JSONL with evidence links, empty archives,
private file permissions, open/pending/unknown refusals, existing-file/symlink protection,
I/O failure/retry, temporary-file cleanup, same-incident concurrent flush refusal, unrelated
active investigation progress and released incident slots. Historical test counts above
remain records of their respective implementation dates.

**Amendment validation:** Focused domain/storage/service tests passed (54 tests).
`npm run format:check`, `npm run lint`, `npm run check`, `npm test` (581 passed;
7 optional tests skipped), `npm run build`, and `git diff --check` passed. Filesystem
archive tests use disposable local directories; no provider or Kubernetes cluster is used.

## 10. Slice 4 — Application Controller and Incident Execution Scope

**Status:** Completed on 2026-10-23 as inactive application infrastructure. The production runtime and diagnostic bridge continue to use accepted Phase 3 behavior until Slice 5 observation capture is implemented and verified.

**Outcome:** Incident rule/resolution is authoritative and distinct from next selection.

### Work

- Compose the service/controller and bind it to Pi session identity; implement incident creation triggers and per-call leases.
- Reuse Phase 3 CLI, `/clusters`, default selection, and schema routing. Add next-selection semantics while an incident is active: idle selection does not retarget that incident; a new incident captures the next rule.
- Reuse required model-target validation and transport checks from Phase 3. Extend the authority seam to resolve the active incident rule and add lifecycle/session identity and dispatch accounting; preserve context without injection/overwrite.
- Adapt inherited effective-scope resolution, capability publication, reconnect reconciliation, and messages to incident authority together. Preserve Phase 3 concurrency and single-connection behavior.
- Publish rule, resolution, inventory changes, and next selection honestly. Mark added wildcard contexts not checked; preserve unavailable exact targets and historical provenance.

### Acceptance

- Exact {A} → next selection B → follow-up still uses A; I2 uses B.
- Exact {A, B} routes calls independently; unselected C is refused. Missing B does not disable A, and missing next selection does not disable the incident.
- Inventory {A, B} → {A, C}: exact rule refuses C and reports B unavailable; live `*` admits C without reselection, reports B unavailable, and labels C not checked.
- Zero targets, malformed/failed enumeration, per-tool incompatibility, changing defaults, stale model choices, active-work selection, and session/connection replacement cannot bypass authority.
- Connection/tools/resolution publication is consistent. No old-generation success commits evidence; no reconnect resets budgets or mutates kubeconfig.

Land the Phase 4 incident wiring and Slice 5 evidence capture together, or keep that new wiring inactive until both pass. The already-accepted Phase 3 context-selection application remains usable independently; no extra Kubernetes tool or Phase 5 parity is required.

### Implementation and Slice 5 handoff

- `src/app/investigation-controller.ts` owns exact Pi session bindings, monotonic binding/lifecycle epochs, one current incident reference per retained session, immutable effective-scope views, explicit start/replacement/conclusion, cancellation and terminal archive delegation. Empty sessions are not retained. Reload/resume rebinds existing process-owned state; new/fork identities start empty. Archive success releases matching session references.
- The application-owned `McpController` constructs one service/controller outside runtime/extension factories, supplies generation-bound diagnostic descriptors inside the existing reconnect publication gate, and disposes the controller during shutdown. There is no extra manager, queue, connection, Kubernetes operation, or storage configuration.
- `currentScope()`, `clusterState()`, and `availableTools()` resolve the captured incident rule independently of next selection. A blocked resolution remains visible for outage presentation and grants no dispatch permission. Exact missing members stay unavailable; live `*` follows validated inventory. Tool compatibility is checked for both visibility and each exact call target. Ordinary aggregate updates and idle next selection preserve good incident authority.
- Admission uses the existing shared FIFO queue and owns idempotent queue/work/signal cleanup. Admission alone spends nothing. After awaiting admission, call synchronous `dispatchExecution(lease)` immediately before transport: it checks registered lease identity, current binding/lifecycle/inventory/generation, publication gate and tool compatibility, then spends one attempt. Copied/released/stale leases cannot dispatch. Reconnect, cancellation and outgoing session binding invalidation settle dispatched work with safe interruption outcomes; queued work is refused without spending. Budget refusal remains the service's typed `budget-refused` error.
- `src/runtime/investigation-lifecycle.ts` implements eligible idle interactive/RPC intent consumption at `before_agent_start`, using the expanded question after credential preflight. It excludes commands, handled/extension/custom input and queued delivery; agent end does not conclude an incident. It owns per-extension work guards and stale-safe shutdown. Register after SRE-owned input handlers; later handled-input hooks must clear pending intent through its returned callback.
- `src/runtime/investigation-guidance.ts` reuses bounded Phase 3 rule/membership/reconciliation presentation and adds incident identity and distinct next selection/availability. Added wildcard members are explicitly not checked. Full investigation summaries, deduplication/restoration, public commands and local tools remain Slice 6.
- **Activation remains deferred:** production factories do not register the new lifecycle hooks, and `McpController.publishReady()` / `createMcpToolBridge()` still share Phase 3 authority. Slice 5 must switch both consumers to the controller's same effective view together, use the admitted incident lease for dispatch, recheck it immediately before synchronous observation commit, and publish exactly the stored bounded excerpt/ID/provenance. Release the lease in `finally` on every path. The controller's execution token alone does not authorize recording without that final check. No successful incident diagnostic path may be enabled without capture.

**Validation (2026-10-23):** 21 focused tests cover exact-A/next-B continuation and replacement, independent parallel targets, usable incident scope with unavailable next selection, live additions/removals, tool compatibility, absent/empty/failed inventory, publication gating, dispatch-only accounting, cancellation before/after admission, shared-queue invalidation, stale/copied leases, old-token refusal, archive session-reference cleanup, and real-Pi prompt/preflight/queue/reload/navigation/new/fork/resume/veto behavior. The affected controller, lifecycle, investigation service/storage and MCP recovery suites passed. `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (606 passed; 7 optional executable-dependent contract tests skipped), `npm run build`, and `git diff --check` passed. No live provider, installed-terminal or real-cluster behavior is claimed; full-path activation and acceptance remain later slices.

## 11. Slice 5 — Capture MCP Observations Before Pi Publication

**Status:** Completed on 2026-10-27. Slice 4 incident authority and lifecycle hooks are now active in production alongside capture.

**Outcome:** Every successful incident diagnostic result is traceable to stored evidence.

### Work

- Add the narrow observation adapter and injected recorder to the existing bridge.
- Capture dispatch identity, spend one attempt, call MCP, normalize/redact/bound, recheck the
  lease and cancellation, commit evidence, and return compact content plus its ID.
- Keep errors distinct from observations. Retain only bounded safe operation outcomes;
  never serialize raw errors, arguments, or responses into domain state or tool details.
- Apply the existing presentation budget to the complete result envelope, including evidence
  ID and exact target/scope/inventory provenance. Reflect any additional truncation in the returned metadata and stored excerpt.
- Define the synchronous commit as the publication boundary; check cancellation immediately
  before it, with no asynchronous gap between commit and constructing the successful result.

### Acceptance

- Deterministic MCP integration covers valid, empty, malformed, truncated, and extended-field
  results; authentication/authorization/tool/transport failures; timeout and cancellation.
- Store and tool result agree on evidence ID, excerpt, context, namespace, scope/inventory revisions, generation, and
  truncation. Failure results carry no successful evidence ID.
- Restart, replacement, shutdown, and out-of-order completion cannot misattribute evidence.
  Budget refusal makes no MCP call. Storage refusal at completion creates no evidence or
  successful publication; the attempt remains spent and pending work settles.
- Existing read-only allowlist, discovered-schema validation, redaction, and no-shell tests pass.

### Implementation

- `src/mcp/incident-diagnostic.ts` admits the controller's incident lease through the existing shared queue, spends one attempt immediately before MCP transport, normalizes safely, and checks cancellation and lease authority immediately before synchronous recording. Every exit releases the lease; failed, interrupted and storage-refused work settles with bounded safe outcomes.
- `src/mcp/observation-adapter.ts` budgets the complete serialized successful envelope, preserves typed identity/provenance, and reduces only the observation excerpt. The retained excerpt and returned excerpt/truncation agree. A required envelope that cannot fit is refused before dispatch. No raw response, raw arguments, serialized errors or artifact is retained.
- The bridge receives the application controller as its recorder/authority. `recordObservation(lease, observation)` validates the registered, dispatched current lease; an execution token alone is insufficient. Empty successes commit evidence; enumeration remains operational discovery outside evidence and incident budgets.
- `McpController` publishes tools from the same incident resolution used by admission. Production Pi factories register eligible-input lifecycle hooks, and the widget, `/clusters --status`, selection feedback and recovery feedback distinguish current incident scope from next selection. Reload/same-process resume rebinds retained state; a new session grants no diagnostic authority until an eligible prompt creates an incident.
- Existing low-level Phase 3 scope/queue fixtures remain. Production integration fixtures now create incidents through eligible lifecycle hooks before directly invoking diagnostic tools. The inherited Phase 2 switching assertion now verifies that next selection cannot retarget an active incident. Historical acceptance documents are unchanged.
- Public investigation/evidence/hypothesis tools and incident replacement/conclusion commands remain Slice 6. Full Phase 4 acceptance and installed-terminal/live-cluster smoke remain Slice 7; no live run is claimed here.

**Validation (2026-10-27):** 35 new tests cover retained/returned excerpt and provenance agreement, empty/extended/truncated results, safe authentication/authorization/tool/transport/malformed/timeout failures, cancellation after normalization, stale session/connection/shutdown results, out-of-order completions, atomic concurrent storage refusal, budget/presentation refusals before transport, usable incident scope with unavailable next selection, and changed presentation limits after reconnect. Managed stdio fixtures and real-Pi production composition verify stored observation IDs before successful results reach the transcript. Inherited authority, lifecycle, queue and read-only policy coverage remains green.

`npm run format:check`, `npm run lint`, `npm run check`, `npm test` (641 passed; 7 optional executable-dependent contract tests skipped), `npm run build`, and `git diff --check` passed. No provider, installed-terminal or live Kubernetes test was run. Slice 6 public inspection/interpretation and Slice 7 full Phase 4 acceptance remain pending.

## 12. Slice 6 — Minimal Investigation Tools and Inspection

**Status:** Implemented on 2026-10-28; full-path/installed-terminal/live-cluster acceptance remains Slice 7.

**Outcome:** Users and the model can inspect state and record interpretation through public APIs.

### Work

- Add local tools `investigation_get`, `evidence_list`, `evidence_get`, `hypothesis_upsert`,
  and `investigation_conclude`, with small explicit input schemas and bounded responses.
  They access application state only; they grant no Kubernetes write capability.
- The controller supplies incident identity and scope for local domain tools. Their inputs cannot amend the rule, access another incident, or change Pi session binding. Every cluster-dependent diagnostic MCP tool separately requires a validated model target, including singleton rules. Hypothesis updates use expected revisions.
- Add `/incident` for a current summary, `/incident new <question>` for explicit replacement,
  and `/evidence` for bounded inspection of the current or just-concluded incident. Local
  read tools can inspect the most recent concluded incident until a new one starts.
- Reuse timestamped command feedback; refuse lifecycle mutations during active work through
  both the application boundary and UI. Read-only inspection remains available.
- Publish bounded, deduplicated state summaries and restore them after compaction/navigation.
  Update stable prompt guidance to explain evidence IDs, conclusions, and in-memory lifetime, per-incident quotas and explicit archive limitations.

### Acceptance

- Real-Pi tests validate model arguments, evidence references, local-tool errors, and conclusion
  semantics without a provider or cluster. Unknown IDs never fall back to another incident.
- Inspection makes no Kubernetes call and works during MCP loss. Commands acknowledge
  repeated invocations; long context names do not hide READ ONLY or the actual execution scope.
- Compaction/reload preserves operational state; new/forked sessions are isolated; resuming
  without in-memory state cannot manufacture evidence from transcript content.
- Unchanged state adds no repeated snapshots; model summaries stay within their frozen budget.

### Implementation and handoff

- `src/runtime/investigation-tools.ts` registers five local tools with explicit TypeBox argument validation and safe domain errors. Controller-bound identity prevents foreign incident/scope inputs. Evidence pages reuse authenticated high-water cursors (20 default, 50 maximum); results are bounded to 64 KiB. Single evidence inspection preserves exact provenance and visibly truncates only the excerpt when needed. `investigation_get` supplies a bounded summary/current revision and optional full hypothesis inspection by ID.
- `/incident`, `/incident new <question>` and `/evidence [<id> | --cursor <cursor>]` reuse timestamped invocation feedback. Reads work during outages and active work; replacement validates through both UI and controller idle guards. No archive command, raw retention or Kubernetes writes are added.
- Conclusion proposals validate same-incident links, supported-resolution semantics and aggregate revision during a turn, then return `pending`. Registration follows lifecycle/scope work guards; `agent_end` releases those guards before committing through the existing idle-only controller API. Revision/binding changes, outstanding diagnostic work, aborted/error completion and shutdown refuse/discard proposals. No terminal lifecycle mutation occurs during active work. The model must inspect a later turn to confirm commit.
- Investigation summaries extend the existing persisted scope message, deduplicate unchanged state, and restore through `before_agent_start`. Reload suppresses the transient unbound shutdown snapshot. Turn completion publishes dispatch/observation/outcome changes without introducing listeners inside atomic diagnostic dispatch/commit; hypothesis changes publish updated state; terminal summaries remain inspectable. Stable prompt guidance explains evidence links, interpretation, deferred conclusion, quotas and in-memory/archive limits.
- `tests/integration/investigation-tools.test.ts` uses installed Pi with a deterministic provider stream and no cluster/provider. Existing MCP-focused regression assertions exclude the five local tools, which stay available independently. Persisted steering timestamps can be reprojected by Pi; prefix assertions retain message content and ordering while ignoring those timestamps.

**Validation (2026-10-28):** `npm run check`, `npm run lint`, `npm run format:check`, `npm test` (649 passed; 7 optional executable-dependent contract tests skipped), `npm run build`, and `git diff --check` passed. Eight new real-Pi tests cover argument/refusal paths, interpretation revision conflicts, evidence-backed resolution, deferred/stale/aborted conclusions, replacement isolation including foreign cursors, outage/active inspection, reload/compaction deduplication, and bounded large evidence/long-identity summaries. No provider, installed-terminal or live-cluster run is claimed; those remain Slice 7.

## 13. Slice 7 — Full-Path Acceptance and Phase Gate

**Status (2026-10-29):** Automated acceptance and canonical checks passed (670 tests; 7 optional contract tests skipped). Installed-package smoke passed against two disposable read-only kind clusters. Visual terminal acceptance is pending because Computer Use denied Terminal access. Slice 7 and Phase 4 remain open until that result is recorded in [PHASE4_ACCEPTANCE.md](./PHASE4_ACCEPTANCE.md).

**Outcome:** Phase 4 is demonstrated through the application rather than only domain unit tests.

### Automated acceptance

Add `tests/integration/phase4-acceptance.test.ts` using production composition, real Pi,
a deterministic model stream, and the recording fake MCP server. Prove:

1. With no user selection, a question creates I1 under live `*` despite any MCP default context. Explicit CLI/config selections override it; invalid explicit selections never fall back. E1 is stored before Pi receives its ID.
2. A hypothesis cites E1; supported conclusions remain inspectable outside the transcript.
3. Compaction preserves domain state without making old evidence fresh or granting scope from prose.
4. Next `/clusters B` does not retarget an exact-A incident; a new incident uses B.
5. Every rule, including singleton, rejects a missing or disallowed model context without injection/overwrite; exact sets/live `*` route parallel calls to different contexts with distinct evidence identities for same-named resources. Hypotheses can link their evidence only within the same incident.
6. The accepted Phase 3 reconnect behavior also applies to active incident rules: exact names persist, live `*` admits C, unavailable B is reported, old-generation commits are withheld, and incident evidence/budgets remain intact.
7. Failed/empty enumeration, per-context auth/tool failures, stale arguments/schemas, limits, cancellation, and shutdown remain distinct and cannot produce false evidence or leaked children.
8. New/forked/resumed/reloaded sessions follow lifecycle rules. Previous transcript summaries cannot reconstruct scope authority after process restart. Invalid next selection does not disable a usable current incident.

Extend packaged CLI acceptance only for the new documented surface and packaging requirements.
Keep CI independent of live clusters and provider credentials.

Run affected Vitest tests first using the existing repository test script, for example:

```bash
npm test -- tests/unit/domain tests/unit/investigation
npm test -- tests/integration/phase4-acceptance.test.ts
```

Then run the canonical gate, stopping on failure:

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run build
```

### Installed-application smoke test

Create `docs/PHASE4_ACCEPTANCE.md` with automated results and a short live runbook. Reuse
Phase 2's two disposable contexts and non-sensitive marker resources; no fault injection
or RCA grading framework is required here.

Verify the packaged application outside the checkout: create an incident on A, collect and
inspect an evidence ID, record a supported or inconclusive explanation, compact/reload,
select B while an exact-A incident is open, verify the incident/next display and fresh A call, then
start a new incident and prove fresh B evidence. Also start exact-set and live-`*` incidents; exercise context removal/reappearance and inventory change notices, prove correct per-call routing and not-checked reporting, and use deterministic fixtures for added-context cases without a third live cluster. Exercise MCP interruption and recovery,
minimal commands at narrow widths, and shutdown cleanup. Check unchanged kubeconfig and
absence of new raw artifacts. Record revision/archive identity, versions, model, terminal,
safe context labels, outcomes, and limitations. Live results must be explicitly recorded;
offline tests alone do not establish terminal behavior or real-cluster access.

## 14. Delivery Order and Review Boundaries

| PR  | Slices | Review focus                                                                                 |
| --- | ------ | -------------------------------------------------------------------------------------------- |
| 1   | 0      | Runtime evidence and fixed Phase 4 contracts.                                                |
| 2   | 1      | Domain names, immutability, identities, and lifecycle.                                       |
| 3   | 2      | Evidence isolation, commit-time limits, and stable reads.                                    |
| 4   | 3      | Aggregate consistency, hypothesis links, and conclusions.                                    |
| 5   | 4–5    | Rule-bound dispatch, live resolution, recovery, and evidence capture as one usable boundary. |
| 6   | 6      | Model tools, minimal commands, and Pi lifecycle/context integration.                         |
| 7   | 7      | Full-path acceptance, package smoke, and completion record.                                  |

Proceed in dependency order. Keep a working read-only application at every boundary.
Update this document's slice status only after the corresponding implementation and checks
pass. No Phase 5 parity or Phase 6 skill work is required to complete this plan.

## 15. Phase 4 Exit Criteria

- All seven deliverables exist with documented public behavior and proportionate tests.
- Incident rules and historical evidence origin remain stable across next-selection changes and recovery. Exact identities stay fixed; live `*` resolution follows validated inventory with visible change notices.
- Successful diagnostic observations are committed once, bounded, and traceable by evidence ID;
  failures, cancellation, and stale work cannot masquerade as facts.
- Hypotheses and conclusions reference valid evidence within their own incident and remain
  explicitly interpretive.
- Operational state survives transcript compaction and extension reload independently; session
  isolation and the lack of cross-process restoration are visible and tested.
- The incident rule, resolved availability, namespace policy, and READ ONLY remain continuously visible; each call shows its exact context, and next selection is separate.
- The single MCP boundary, allowlist, explicit targeting, discovered-schema validation, and
  disabled raw retention remain intact; no remediation or shell path is introduced.
- Canonical checks and the recorded installed-application smoke test pass.

Phase 5 consumes the domain scope and evidence APIs when expanding MCP capabilities.
Phase 6 then uses those APIs and evidence IDs to teach diagnostic reasoning. Neither
phase should need to recover investigation state from prose or add Kubernetes access paths
outside MCP.
