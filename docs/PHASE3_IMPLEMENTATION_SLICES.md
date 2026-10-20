# Phase 3 Implementation Slices — Context Selection and Multi-Cluster Routing

**Status:** Accepted plan, October 18, 2026. Slice 0 contracts frozen on October 19, 2026 in [PHASE3_CONTRACTS.md](./PHASE3_CONTRACTS.md). Slice 1 implements rule state, startup, and CLI; Slice 2 implements explicit model routing; Slice 3 implements transactional recovery and inventory notices; Slice 4 implements full scope presentation and status inspection; Slices 4a/4b implement bounded parallel execution and cancellable FIFO admission; Slice 5 remains pending.

**Scheduling amendment (2026-10-20):** Slice 2 uses Pi sequential tool execution. Parallel scheduling, shared capacity admission, and overlapping-call tests move to Slice 4a; the subsequently accepted Slice 4b queue revision is implemented with it below.

**Starting point:** The existing [Phase 2 acceptance](./PHASE2_ACCEPTANCE.md) is complete. Its implementation, tests, contract snapshots, and acceptance records remain the historical baseline. This phase is an explicit forward migration from that working runtime, not a rewrite of what Phase 2 delivered.

**Source of truth:** [DESIGN.md](./DESIGN.md) and the [multi-cluster plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md).

## 1. Goal and exit boundary

Ship a usable read-only application with unified `/clusters`, default live `*`, exact context sets, required model-supplied context for every diagnostic call, and deterministic reconnect reconciliation. Use one Pi agent, one existing managed MCP connection, and the existing six-operation allowlist.

This phase must start from completed Phase 2 and finish **without** `Incident`, `EvidenceStore`, hypotheses, domain-tool registration, or incident lifecycle. [Phase 4 — Investigation Domain](./PHASE4_IMPLEMENTATION_SLICES.md) consumes the resulting scope and execution APIs. Tool parity and controlled operations move to [Phase 5](./PHASE5_IMPLEMENTATION_SLICES.md); Skills, Evals, and TUI Refinement move to Phases 6, 7, and 8.

```text
Completed Phase 2 singleton runtime
    → Session selection rule: default all or explicit exact set
    → Application resolution against validated MCP inventory
    → Model supplies one exact context
    → Bridge validates context/schema and captures an execution snapshot
    → MCP call with cancellation
    → Generation/revision recheck
    → Existing bounded, redacted result with exact origin
```

## 2. Baseline versus target

| Concern   | Completed Phase 2 baseline                                   | Phase 3 target                                                                                     |
| --------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Command   | `/cluster` picker/direct/status                              | `/clusters` picker/direct/all/status; no singular alias                                            |
| Startup   | CLI singleton, configured default, MCP default, then unbound | Explicit CLI rule, explicit configured exact/all rule, then live `*`; MCP default is informational |
| Scope     | One selected exact context                                   | Session-owned exact set or live all-contexts rule                                                  |
| Arguments | Hide/remove model context and inject selection               | Require and preserve model context for every cluster-dependent tool, even singleton                |
| Reconnect | Retain selected exact context                                | Re-resolve unchanged exact/all rule and publish inventory changes with compatible tools            |
| Results   | Exact context and connection/registry provenance             | Exact context plus separated selection/inventory/generation provenance; no evidence IDs yet        |

Keep Phase 2 success/failure handling, read-only MCP/RBAC, redaction, no-shell policy, per-call finite log limits, exact context identity, cancellation, and unchanged kubeconfig. Change tests whose single-selection contract is intentionally superseded; preserve tests for the remaining invariants and add target behavior. Do not keep a parallel legacy routing mode.

## 3. Contracts

### Session selection and resolution

- Store a discriminated rule: nonempty exact names or all-contexts. With no explicit CLI/config choice, use live all-contexts displayed as `*`.
- `--clusters <exact-name> <exact-name>` builds an exact set; quoted names work identically, for example `--clusters "exact-name" "another-exact-name"`. `--clusters '*'` explicitly selects live all-contexts; `*` must be the sole value and should be quoted to prevent shell expansion. Explicit CLI wins over an explicitly configured `kubernetes.contexts` exact/all rule, then live `*`. Preserve exact names; no patterns or implicit aliasing.
- Invalid explicit names fail selection atomically with no wildcard/default fallback. Empty or failed inventory retains pending selection intent and blocks diagnostics; rule defaulting and infrastructure availability are different states.
- `/clusters` opens a picker for one/many exact names or all; `/clusters <exact-name>` selects one; `/clusters --all` selects all; `/clusters --status` inspects without mutation. Replace `/cluster` without an alias and update CLI help/docs with the implementation.
- Because there is no incident in Phase 3, an idle selection changes the current **session** rule and subsequent calls immediately. Block selection during active agent/direct-tool work; stale pickers cannot commit. Phase 4 later adds separate active-incident rule versus next-incident selection. Do not simulate that distinction before incidents exist.
- Inventory and selection revisions are separate. Exact names remain fixed; missing members are unavailable and unselected additions stay outside permission. Live `*` follows successful application discovery at startup/reconnect. New members are available, not checked or healthy.

### Unified execution

- Keep a required model-facing `context` for every cluster-dependent tool, including exact singleton. Preserve discovered constraints in one argument schema and validate current permission/availability separately against argument values.
- Reject missing, unknown, unavailable, out-of-scope, or tool-incompatible targets before MCP. Never hide, strip, infer, inject, or overwrite context. Context-independent enumeration does not need a target.
- Capture a per-call immutable snapshot of selected rule/revision, exact context, inventory revision, and connection generation. Resolve targets without changing a global current context. Slice 2 registers all MCP tools as sequential; independent target overlap and bounded concurrency are deferred to Slice 4a.
- Publish a tool if at least one permitted target is compatible, and recheck the specific target at execution. Old schemas or direct handlers cannot bypass selection.
- Recheck cancellation, generation, and snapshot validity before returning success. No incident identity, evidence reservation, or evidence commit is required in this phase.

### Reconnect transaction

1. Block dispatch and invalidate the old generation; cancel/settle old calls before replacement.
2. Reconnect and rediscover tools and complete context inventory on that one connection.
3. Validate inventory and resolve the unchanged session rule. Exact `{A, B}` over new `{A, C}` permits A, reports B unavailable, refuses C. Live `*` permits A/C and reports C not checked.
4. Publish matching connection, inventory, resolution, and tools together. Publish bounded added/removed/changed notices to UI/model before dispatch resumes. Failed inventory discovery keeps diagnostics blocked.

Old-generation late success is withheld; prior transcript observations keep their origin/time. Reconnect does not replay interrupted calls. Per-context auth/authorization/tool failures remain scoped; only shared transport loss blocks every target. Model-driven enumeration does not install authoritative inventory.

### UX, results, and future seams

Persist bounded selection/availability messages using existing Pi extension hooks and restore them after compaction. Messages inform the model; runtime checks enforce scope even before steering is consumed. Show rule, membership/count, partial availability, namespace policy, READ ONLY, and each call's exact target. Namespace omission still does not establish all-namespace coverage.

Keep the existing normalizer and raw retention disabled. Result details add typed exact-context and execution provenance, not credentials or raw arguments. Basic failure/partial/not-checked notices use current state and tool outcomes; durable coverage tracking, evidence IDs, per-incident budgets, and hypothesis links belong to Phase 4. The already-configured investigation call limit does not become a fictitious incident budget in Phase 3.

Expose a narrow scope/execution-authority seam so Phase 4 can supply an incident-owned rule and extend snapshots with incident identity/lifecycle and storage reservations. Domain implementation is not a prerequisite for this seam or Phase 3 acceptance.

## 4. Implementation slices

### Slice 0 — Freeze migration contracts

Read the completed Phase 2 implementation and installed Pi APIs. Specify rule/resolution types, selection/inventory revisions, snapshot invalidation, command parsing/selection cancellation, schema publication, and concurrency limits. Create `docs/PHASE3_CONTRACTS.md`. Keep historical Phase 2 records unchanged; identify exact assertions that intentionally change.

**Acceptance:** Explicit mapping from each old contract to its new behavior, with no dependency on future incident/evidence services.

**Completed (2026-10-19):** [Frozen migration contracts](./PHASE3_CONTRACTS.md) map the implemented singleton contracts and affected assertions to exact/all rules, separate revisions, execution snapshots, staged picker cancellation, required model context, gated schema/reconnect publication, and a four-call application concurrency limit. Installed Pi/MCP 0.99.0 APIs were inspected. This is a documentation boundary; no Phase 3 runtime behavior is enabled.

### Slice 1 — Rule state, startup, and CLI

Extend `context-manager.ts`, `context-resolver.ts`, CLI/config boundaries, and pure fixtures. Configuration uses `kubernetes.contexts: [A, B]` or `["*"]`, with the same value validation as CLI; remove `defaultCluster` without a compatibility alias. Implement exact sets/default all, explicit override validation, separated revisions, and current resolution. Keep names opaque and preserve pending intent through failure.

**Acceptance:** Unit tests cover no user choice despite MCP default, explicit CLI/config choices, duplicate/conflicting arguments, invalid selections without fallback, empty discovery, and session isolation. No kubeconfig mutation.

**Implemented (2026-10-19):** Exact/all rules are copied, canonicalized, validated, and frozen before connecting. Startup uses CLI > configured exact/all rule > default live all, independent of MCP default metadata; retries retain the launch-time choice even after initial failure. Selection/inventory revisions are separate. Initial exact validation is atomic; accepted rules retain unavailable members on later inventory changes, and all follows successful discovery. Failed discovery retains intent and the last successful inventory without dispatch authority. CLI/help/package checks use only `--clusters`, with variadic exact names or sole `*` and the single-value equals form.

**Slice boundary:** The existing singleton bridge projection remains until Slice 2. At the user's request, the `/clusters` command and staged exact/all picker portion of Slice 4 have been brought forward. More than one available target exposes no diagnostic tools; no first member is chosen or fan-out performed. Singleton results carry the separated revisions. Basic status describes resolved counts and pending intent, while full scope presentation, publication, snapshot, concurrency, and routing contracts remain in their later slices. Historical Phase 2 records are unchanged; executable composition tests migrate the affected assertions.

**Validation (2026-10-19):** Focused rule/CLI tests passed, followed by scope/recovery and bridge/normalizer checks. `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (397 passed; 7 optional executable-dependent tests skipped), `npm run build`, and `git diff --check` passed. Packaged CLI checks exercise variadic/equals/wildcard help and invalid inputs without configuration or MCP startup. No live-cluster or installed-terminal acceptance was performed; that remains Slice 5.

**Configuration amendment validation (2026-10-19):** Configuration and CLI now share `parseClusterRule`; both normalize to immutable exact/all rules before startup selection. Tests cover configured sets/all, whole-rule CLI override, malformed/empty/duplicate/mixed/oversized lists, exact name preservation, removal of `defaultCluster`, and launch-time intent through initial failure and recovery. Focused tests passed, then formatting, lint, type checks, the full suite (417 passed; 7 optional executable-dependent tests skipped), build, and diff checks passed. Multi-target routing remains Slice 2 work.

### Slice 2 — Model schema and bridge routing

Update `tool-policy.ts`, `tool-call-preparation.ts`, and `tool-bridge.ts` together. Require model context, validate one argument schema and current execution permission, capture session execution snapshots, propagate cancellation, and preserve exact origin in results. Keep the same diagnostic allowlist and limits.

**Acceptance:** Missing context is rejected even for singleton; wrong context is never overwritten; valid A/B calls retain separate targets; direct callers/stale handlers and incompatible schemas cannot bypass authority. Existing empty-success and failure categories remain distinct.

**Implemented (2026-10-19):** Diagnostic schemas require and preserve exact model context for singleton/set/all rules, intersecting discovered constraints with compatible permitted inventory. The bridge rejects missing, excluded, unknown, unavailable, and incompatible targets without substitution. Per-call frozen snapshots carry immutable rule, separated revisions, generation, exact context, namespace policy, and read-only profile. The execution-authority interface is independent of Pi/MCP transport and requires no incident/evidence model. All registered MCP tools use Pi sequential execution. Work guards remain held through normalization; snapshots and work guards are explicitly released on every exit. No capacity counter or admission API is part of this slice. Pi owns abort-and-settle behavior before conversation replacement; interactive reload requires idle work. MCP reconnect cancels outstanding calls and invalidates old-generation handlers and results. Compatible schemas are republished for idle selections; replacement extensions register the current tools without rotating application authority.

**Validation refactor (2026-10-20):** Schema preparation now produces one schema preserving discovered constraints and requiring explicit nonempty context. Execution checks that schema once, then checks argument values against current permission, availability, and retrieval limits. No application scope enum or second transport validation is generated. Current-generation handlers honor idle selection changes immediately; generation/snapshot guards remain unchanged.

**Slice boundary:** Reconnect publication gating, transactional reconciliation, and bounded inventory transition notices remain Slice 3. Full scope widgets, paginated membership/status, and bounded model messages remain Slice 4. Parallel tool execution and shared capacity admission remain Slice 4a. Singleton presentation state is retained for the existing command/widget, but the bridge exclusively routes by supplied exact context; no singleton injection mode remains. Historical Phase 2 records are unchanged; executable assertions migrate to the new model-target contract.

**Validation (2026-10-19):** Focused bridge/schema/production-Pi tests passed, including required singleton targets, set/all A/B routing with distinct resource markers, overlapping targets, four-slot admission including enumeration, failure/cancellation release, per-target failure isolation, immutable/foreign snapshot rejection, stale schema/public mutation refusal, idle reload/new-session continuity, and cancellation/settlement on reconnect. `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (457 passed; 7 optional executable-dependent tests skipped), `npm run build`, and `git diff --check` passed. No installed-terminal or live-cluster acceptance was performed; those remain Slice 5.

### Slice 3 — Tool publication and MCP recovery

Update `mcp-controller.ts` and state publication to reconcile schemas, inventory, rule resolution, and connection generations as one usable boundary. Build replacement tools only against the corresponding inventory and current rule.

**Acceptance:** Added/removed/reappearing contexts distinguish exact/all behavior; failed enumeration blocks calls; zero resolution retains intent; old generation calls cannot return fresh success; per-context failures leave other targets usable.

**Implemented (2026-10-20):** Reconnect blocks every bridged handler before generation invalidation and keeps the gate closed through synchronous tool publication and downstream scope/UI/model notifications. Replacement discovery completes before registry installation; the controller's first scope listener publishes tools filtered against that inventory and the unchanged rule before other scope listeners run. Reentrant publication listeners cannot dispatch diagnostics or enumeration, or change selection. Enumeration failure retains the last successful inventory for inspection, publishes no tools, and blocks diagnostics. Empty resolution retains intent and exposes no diagnostic tools. Unexpected publication failure withdraws tools and authority.

Successful reconciliation records immutable added/removed/changed name sets relative to the last successful inventory. The widget, command feedback, and persistent model scope snapshot show bounded names/counts without endpoint metadata. Live `*` additions are explicitly not checked; exact additions remain outside permission, missing selected members become unavailable, and reappearing selected members become usable without amending selection. Metadata changes do not establish health. Existing cancellation, late-result withholding, and per-target failure categories remain intact; interrupted calls are not replayed.

**Validation (2026-10-20):** Production Pi/stdio recovery tests cover `{alpha, beta}` → `{alpha, gamma}` and reappearance for exact/all rules, unchanged selection despite config reload, metadata/default changes, reentrant dispatch/selection refusal, UI/model notice ordering, target-compatible replacement schemas, failed/malformed/empty enumeration and recovery, old-handler refusal, and per-context authorization isolation. Existing delayed-result/cancellation tests continue to pass. Notice bounds are unit-tested at 1,024 contexts. Formatting, lint, type checks, the full suite (474 passed; 7 optional executable-dependent tests skipped), build, and diff checks passed. No installed-terminal or live-cluster acceptance was performed.

**Slice boundary:** Full rule/member presentation and pagination remain Slice 4. Pi tool execution remains sequential; shared capacity admission and overlapping-call acceptance remain Slice 4a. Installed-terminal and disposable-cluster acceptance remain Slice 5. No incident, evidence, coverage store, new diagnostic operation, or mutation workflow is added.

### Slice 4 — Unified command, prompt, and TUI

Replace singular registration with `/clusters` and picker/direct/all/status variants. Update help, system policy, scope messages, and widget for model routing and default all. Use existing feedback and lifecycle mechanisms; preserve work guards and compaction/reload behavior.

**Acceptance:** Current session selection changes only while idle; no singular alias; status works during outages/active work; exact rule and available members remain clear; READ ONLY is visible at narrow widths. No incident UI or next-incident fiction.

**Command portion implemented early (2026-10-19):** Production registers only `/clusters`, with direct exact-name, `--all`, `--status`, and staged multi-selection picker forms. Toggle rows stage full exact sets; All selects the live rule; Apply commits once; Cancel/Escape/UI failure preserve authority. Reserved option parsing never splits or trims exact names. Feedback renders a bounded preview of selected names or All, independent of the singleton execution projection. Pickers check manager state (including inventory/selection/generation), a work-start epoch, and extension lifecycle revision after every await and before commit. Full rule/availability widgets, bounded model transition notices, and pagination remain outstanding Slice 4 work; bridge/model routing remains Slice 2.

**Command validation (2026-10-19):** Picker and production Pi/MCP tests cover exact sets, live All, atomic Apply, cancellation, empty drafts, action/name collisions, unavailable-member removal, no singular alias, unknown options, UI failure redaction, and invalidation by restart, another selection, work that starts/ends, and extension reload. Formatting, lint, type checks, the full suite (431 passed; 7 optional executable-dependent tests skipped), build, and diff checks passed. No installed-terminal or live-cluster acceptance was performed.

**Implemented (2026-10-20):** The continuous widget and persistent model snapshots now show exact/live rule and source, available and unavailable selected members/counts, partial or blocked availability, namespace policy, selection/inventory revisions, connection generation, and MCP/inventory state. READ ONLY remains on its own widget line. Exact rule intent remains visible when only one member is available or discovery is unavailable. Automatic snapshots use bounded identity previews (at most eight complete names per category), omitted counts, and bounded safe diagnostics, keeping the entire message below 8,000 characters without truncating context identities. Existing persisted steering, semantic deduplication, compaction restoration, and extension cleanup remain in use.

`/clusters --status` reports the summary before opening read-only `ui.select` membership pages of 20 names. It includes exact selected names missing from inventory and labels unselected inventory names outside permission. Full names can be inspected individually; navigation and Escape never change selection or model history. Status remains usable during active work and outages, labels last successful inventory as historical, and closes stale views after scope/lifecycle changes. UI failures report safe feedback while preserving the summary. System policy now explicitly explains default live `*`, unchecked additions, exact sets, and complete status inspection. README documents the current behavior.

**Validation (2026-10-20):** Focused TUI/scope/recovery tests passed (81 tests), followed by `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (483 passed; 7 optional executable-dependent tests skipped), `npm run build`, and `git diff --check`. Added tests cover paginated complete identity inspection, action/name collisions, backward navigation, Escape, partial exact permission, retained outage inventory, active-work status, stale views, safe UI failures, eight-name previews, and whole-message bounds with long/escaped names. Existing production Pi recovery, message deduplication, compaction restoration, selection guards, and shutdown checks continue to pass. No installed-terminal or live-cluster acceptance was performed.

**Slice boundary:** Pi tool execution remains sequential. Parallel scheduling/capacity admission remains Slice 4a. Installed-terminal and disposable-cluster acceptance remains Slice 5; no incident UI, evidence store, or mutation workflow is introduced.

### Slice 4a — Bounded parallel tool execution

Enable parallel execution for independent diagnostic targets with one application-wide limit of four active MCP calls across tools and contexts, including model-driven enumeration. Keep exact context validation, per-call snapshots, cancellation, and stale-result withholding. Slice 4b supersedes the original immediate fifth-call refusal policy with bounded waiting.

**Implemented (2026-10-20):** Registered tools declare Pi parallel execution; the session-owned authority shares admission across tools and replacement handlers. Slots remain held through normalization and release on every exit. Real Pi tests dispatch four independent calls while a fifth waits and later completes with its exact resource origin. Per-context failures remain isolated.

### Slice 4b — Bounded, cancellable admission queue

**Implemented (2026-10-20):** The accepted queue revision replaces capacity refusal for ordinary saturation. One session-owned scheduler admits four active calls and up to 32 FIFO waiters across diagnostics, model-driven enumeration, direct callers, and replacement handlers. Only a full queue returns `capacity-exceeded`. Queue residence has a monotonic 30-second deadline and returns `timeout` with an admission-wait message; the MCP timeout starts separately at dispatch. Bounds are application constants without new configuration.

Validate schema/scope before admission. Waiters retain private arguments and original authority revisions/generation, and hold work guards; they hold no execution snapshot or active slot. Cancellation promptly removes waiters. Handoff and pre-dispatch checks revalidate cancellation, connection/generation, publication gate, revisions, current scope and target compatibility. Changed authority invalidates rather than rebinds queued work. Fresh snapshots are captured only immediately before dispatch. Slots/snapshots/guards release on every exit; cancellation/expiry/handoff cleanup settles once.

Publication blocking, transport loss, generation invalidation, and shutdown settle affected waiters without waiting for active transport settlement. Recovery publishes matching tools/inventory/notices before new calls dispatch. Old queued calls never run on the replacement connection. Phase 4 dispatch budget/storage reservations remain future work after queue admission.

**Acceptance:** Deterministic tests cover FIFO A/B origins, four-active/32-waiting shared bounds including enumeration, invalid preflight without capacity use, separate application isolation, head/middle/tail cancellation, wait expiry, handoff cancellation/generation/revision/availability races, duplicate release, application cancellation before controller teardown, and slot recovery after transport/normalization failures. Real Pi/stdio tests cover a five-call model batch and four active calls plus queued diagnostics/enumeration across forced replacement, process loss, and shutdown, including no replay and per-context authorization isolation after recovery. Installed/disposable-cluster acceptance remains Slice 5.

**Validation (2026-10-20):** Focused queue/bridge/Pi/reconnect tests passed, followed by `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (506 passed; 7 optional executable-dependent tests skipped), `npm run build`, and `git diff --check`. No installed-terminal or live-cluster acceptance was performed.

### Slice 5 — Full-path and installed acceptance

After Slices 4a/4b, add `tests/integration/phase3-acceptance.test.ts` using production composition, real Pi, deterministic model streams, and recording MCP fixtures. Extend package CLI acceptance for new flags and migrated defaults. Record results in `docs/PHASE3_ACCEPTANCE.md`.

Cover singleton/set/all routing, missing-context refusal, invalid overrides, model choices outside selection, identical resource names with different cluster markers, independent overlapping calls, FIFO wait/overflow/expiry/cancellation, queued reconnect cleanup, selection races, reconnect `{A, B}` to `{A, C}`, failed/empty enumeration, changed defaults, stale handlers/results, cancellation, per-target failures, compaction/reload, and shutdown.

Run affected tests first, then `npm run format:check`, `npm run lint`, `npm run check`, `npm test`, and `npm run build`. An explicit disposable-cluster/installed-package smoke test verifies `/clusters`, default all, exact routing, changed availability, unchanged kubeconfig, terminal display, and cleanup; deterministic fixtures cover added-context cases without requiring a third live cluster. Offline checks do not claim live access.

## 5. Exit criteria and handoff

- The completed Phase 2 application can be upgraded directly to this phase, with the new selection/routing behavior usable through the TUI and packaged CLI.
- Default live `*`, exact sets, unified `/clusters`, and required model context work through the existing read-only MCP boundary.
- Reconnect publication and stale-result rejection are deterministic, with explicit per-target provenance and availability notices.
- Canonical checks and the recorded installed/disposable-cluster acceptance pass; no domain/evidence implementation is required.
- Phase 4 adds incident-owned rules, next-selection semantics, evidence/hypotheses, lifecycle epochs, and per-incident capacity/call budgets on the accepted Phase 3 execution seam. It does not reimplement commands, default selection, schema routing, or reconnect discovery.
