# Phase 3 Slice 0 — Frozen Migration Contracts

**Status (2026-10-19): Slice 0 complete; runtime implementation starts in Slice 1.** This record specifies the migration from accepted Phase 2. It does not enable multi-cluster routing or claim Phase 3 acceptance.

Read alongside [the implementation slices](./PHASE3_IMPLEMENTATION_SLICES.md), [DESIGN.md](./DESIGN.md), and [the multi-cluster plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md). Historical Phase 2 contracts, captures, and acceptance records remain unchanged. The installed runtime and standalone MCP client inspected for this slice are both **0.99.0**. No new server or live-cluster probe is required for this documentation slice.

**Scheduling amendment (2026-10-20):** Slice 2 uses Pi sequential tool execution. Parallel scheduling, the four-call application limit, capacity refusal, and overlapping-call acceptance move to pending Slice 4a. Direct callers own scheduling; this slice adds no application queue or capacity-admission API.

**Queue implementation amendment (2026-10-20):** Slices 4a/4b supersede the earlier Slice 2 sequential scheduling boundary. All registered tools now use parallel execution with four active slots and a bounded, cancellable FIFO queue. The current call-order contract below incorporates the accepted queue revision; no incident budget is introduced. Installed/live acceptance remains Slice 5.

**Lifecycle amendment (2026-10-19):** At the user’s request, runtime attachment tokens and detach/drain bookkeeping are removed. Pi owns agent cancellation and settlement before conversation replacement; the interactive reload path requires idle work. MCP generations and scope revisions continue to invalidate calls on reconnect or scope changes. Direct callers own their cancellation and settlement; calling the low-level reload API does not cancel direct calls.

**Configuration amendment (2026-10-19):** During Slice 1, the user replaced the singleton-only configured choice with `kubernetes.contexts`, equivalent to CLI exact-set/sole-wildcard values. The contracts below incorporate that amendment; historical Phase 1/2 records are unchanged.

## 1. Migration map

| Phase 2 contract and implementation                                                               | Frozen Phase 3 replacement                                                                                                                | Owner / slice                |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `StartupClusterIntent.cluster`; `--cluster` and `--cluster=` accept one name                      | `--clusters` accepts one nonempty exact set or sole `*`; no legacy flags/alias                                                            | CLI/application, 1           |
| CLI > config > MCP default > unbound in `resolveStartupContext`                                   | CLI rule > configured `kubernetes.contexts` exact/all rule > live all; MCP default is informational                                       | Resolver, 1                  |
| `ClusterContextState.bound` carries one context; `captureScope()` takes no target                 | Selection rule and resolution are separate; execution capture requires the supplied exact context                                         | Manager, 1–2                 |
| `registryRevision` advances for inventory and selection                                           | Separate `inventoryRevision` and `selectionRevision`; connection generation has an independent lifecycle                                  | Manager, 1–3                 |
| `prepareMcpToolSchema` removes context; argument preparation deletes it; bridge injects selection | Context remains required in the model schema and argument copy; validate and forward unchanged                                            | Policy/preparation/bridge, 2 |
| Controller exposes diagnostics compatible with its one selected context                           | Publish a tool when at least one resolved permitted context satisfies its discovered context schema; execution checks the specific target | Controller/policy, 2–3       |
| Captured handlers bind only connection generation and the manager                                 | Retain generation binding; capture immutable per-call authority and recheck before success                                                | Runtime/bridge, 2–3          |
| Reconnect retains one exact selection; resolved unbound never binds later defaults                | Reconnect retains the exact/all rule; exact can become partially available; all follows authoritative inventory                           | Controller/manager, 3        |
| `/cluster` uses one `ui.select` and checks inventory revision after awaiting                      | Only `/clusters`; staged set/all picker with Apply/Cancel and a full selection ticket                                                     | Command, 4                   |
| One context shown in widget/model messages/result scope                                           | Show rule and availability; each result still has exactly one context, now with separate revisions and connection provenance              | Guidance/bridge, 2–4         |
| Pi may schedule independent tools concurrently; direct calls have a work guard                    | Use sequential Pi scheduling and work guards; defer four-call parallel admission to Slice 4a                                              | Controller/bridge, 2–3       |

Retain the six-operation allowlist: `configuration_contexts_list`, `pods_list`, `pods_get`, `pods_log`, `events_list`, `namespaces_list`. Enumeration is context-independent; the other five require context. Keep one agent, one managed MCP connection, discovered-schema validation, existing cancellation/timeouts, error categories, redaction, bounded normalization, disabled raw retention, read-only MCP/RBAC, and no shell or kubeconfig mutation. No schema snapshots, annotation requirements, or diagnostic resource validators are added.

## 2. Rule, inventory, and resolution

The following are implementation contracts, not new runtime exports in Slice 0. Reuse `ClusterContext`, `ClusterContextRegistry`, and the MCP discovery adapter. Put selection/resolution types in the cluster layer; keep Pi and MCP transport types out of them.

```ts
type ClusterScopeRule =
  | { readonly kind: "exact"; readonly contexts: readonly [string, ...string[]] }
  | { readonly kind: "all" };

interface ClusterSelection {
  readonly rule: ClusterScopeRule;
  readonly source: "cli" | "config" | "default-all" | "user";
  readonly selectionRevision: number;
}

type ClusterResolution =
  | {
      readonly status: "blocked";
      readonly reason: "inventory-unavailable" | "invalid-selection";
    }
  | {
      readonly status: "resolved";
      readonly available: readonly ClusterContext[];
      readonly unavailable: readonly string[];
    };

interface ClusterExecutionSnapshot {
  readonly rule: ClusterScopeRule;
  readonly selectionRevision: number;
  readonly inventoryRevision: number;
  readonly connectionGeneration: number;
  readonly context: string;
  readonly namespacePolicy: "unrestricted";
  readonly readOnly: true;
}
```

Each published state includes the selection even while connecting, disconnected, empty, or invalid. Discovery status retains the existing distinction between transport unavailable and enumeration failure (`incompatible-tool`, `invalid-response`, `tool-error`). `resolved` with zero available targets blocks diagnostics; it does not mean authentication succeeded. Availability means membership in validated inventory, not query success or health. Tool compatibility remains a separate predicate over available targets.

Exact names are opaque. Preserve spelling, whitespace, case, and identities sharing an endpoint. Reuse selection-name validation and enumeration limits. Canonicalize exact sets by deterministic code-unit ordering, reject duplicates rather than silently deduplicating, and freeze copies including nested arrays. Limit a requested exact set to 1,024 names, matching the inventory-entry limit. Never truncate authority.

Initial exact selection is atomic: with inventory `{A, C}`, a requested `{A, B}` is invalid and dispatches to neither A nor C. Keep the whole pending rule; a later complete inventory containing A/B can validate it. Once the exact rule has been validated, reconnect removal of B produces `available=[A]`, `unavailable=[B]`; A remains usable. This distinction requires retaining whether the current exact selection has ever passed complete validation. A failed user replacement never commits a subset or destroys the previous selection.

All resolves to every current validated context. Its resolution's `unavailable` array is empty; removals from the preceding successful inventory are reported in the bounded transition notice rather than accumulated indefinitely. A failed discovery does not replace the preceding inventory with an empty one. A successful empty discovery does: preserve the rule, show zero availability, and block diagnostics. Newly discovered members are not checked; Phase 3 does not implement a durable coverage store.

### Revision rules

| Value                  | Advances when                                                                     | Does not advance when                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `selectionRevision`    | Initial rule is established (1), or a different validated rule commits            | Inventory/default metadata changes, reconnect, failed/cancelled selection, reordered equivalent exact set, repeated same rule |
| `inventoryRevision`    | A complete valid inventory is installed, including empty or identical rediscovery | User selection, failed discovery, model enumeration, transport transition                                                     |
| `connectionGeneration` | Replacement begins, before cancellation or any await                              | Selection, per-target operation failure, healthy non-forced restart no-op                                                     |

Revisions start at zero before initialization and never decrease within the manager lifetime. Same-rule selection is an acknowledged no-op and retains its source. The startup rule is computed from the initial validated application configuration and CLI before connecting. MCP recovery reloads transport configuration but does not reinterpret `contexts` as new selection intent, including after initial connection failure. A changed configuration choice requires a new application launch or explicit `/clusters` selection.

## 3. CLI and command parsing

Freeze the Phase 3 slice plan's CLI form. It supersedes the earlier repeated-`--cluster`/`--all-clusters` proposal; the target examples in DESIGN and the cross-phase plan are aligned in this slice. Current README/help remain Phase 2 until the executable changes in Slice 1.

```bash
pi-sre
pi-sre --clusters prod-us
pi-sre --clusters "prod-us" "prod-eu"
pi-sre --clusters '*'
```

`--clusters` occurs once and consumes one or more argv values up to the next option. A sole `*` means live all; it cannot appear alongside another value. Other values are exact names, never patterns. `prod-*` is an exact name and must exist. Shell quoting is removed by the shell, and the application does no shell parsing. A separate value starting with `-` is treated as an option; allow `--clusters=<exact-name>` as a single-value form for such names. Values after that equals form are not extra members. Literal `*` is reserved for all in the CLI; a context actually named `*` remains selectable as an exact identity through the picker. `kubernetes.contexts` uses the same list values and wildcard semantics: `[A, B]` is an exact set, `["*"]` is live all, and omission defaults to live all. A scalar, empty list, duplicate names, more than 1,024 names, or mixed wildcard/exact values is invalid configuration. The singleton `defaultCluster` field is removed without an alias. CLI overrides the entire configured rule; malformed configuration still fails loading. Both boundaries normalize into `ClusterScopeRule` before manager construction.

Reject empty values, duplicate names/flags, mixed wildcard/exact values, unknown options, extra positionals, and legacy `--cluster`/`--all-clusters`. Keep `--help`/`-h` free of config/MCP startup while still validating other arguments. An explicit CLI rule overrides even an invalid configured default; an invalid CLI rule never falls back. The no-choice rule is all even with a valid MCP default or only one context.

| Command                  | Parsing and effect                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `/clusters`              | Empty argument string opens a staged picker                                                 |
| `/clusters <exact-name>` | Entire nonempty argument string is one opaque name; do not split, trim, or shell-unquote it |
| `/clusters --all`        | Exact reserved argument selects all                                                         |
| `/clusters --status`     | Inspect without mutation or a model turn, including during work/outages                     |

Reserve those exact flag strings; reject other arguments beginning `--` with usage guidance. Names colliding with flags or needing terminal-input whitespace preservation remain reachable through the picker. `/clusters *` directly selects the exact name `*`; only `--all` means all here. No multi-name slash parser is introduced: use the picker. Do not register `/cluster` as an alias.

Use public `ctx.ui.select` in a staged loop: show exact names as toggle rows, plus distinct All, Apply, and Cancel rows. Map rows to identities internally so context names cannot collide with action labels. Apply commits the entire draft once; All sets the draft all rule; toggling an exact row from all starts an exact draft. Empty exact drafts cannot apply. Escape/undefined, Cancel, UI failure, or lifecycle invalidation discards the draft. Merely toggling rows makes no authoritative change.

Capture a selection ticket containing extension lifecycle revision, selection revision, inventory revision, connection generation, and a manager-owned work epoch. Increment the work epoch whenever agent/direct-tool work starts so a picker cannot commit after work started and ended while it was open. Recheck ticket equality, current validated inventory, `ctx.isIdle()`, and the manager work guard after every await and synchronously at commit. Selection requires current nonempty inventory, including for all; outage/empty startup keeps its existing pending rule. Status needs no ticket or idle guard. Preserve numbered command receipt/progress/outcome feedback and honest already-selected/cancelled/refused outcomes.

## 4. Session lifecycle and execution authority

The operational session is the application-owned manager lifetime, independent of Pi conversation history. Preserve its explicit rule across `/new`, resume, fork, and reload, as the existing composition does. Never restore permission from stored messages or a session file. Separate application instances have separate managers, rule copies, and work guards.

Pi owns cancellation and settlement of agent work before conversation replacement. Application shutdown also aborts the session before disposal, and interactive reload refuses active responses. On `session_shutdown`, extensions release subscriptions, invalidate pickers through their local lifecycle revision, and release their agent-work guards. Replacement extensions register the controller's current tools. No runtime attachment token or separate detach/drain protocol is needed. Direct callers own their cancellation and settlement, including when using low-level reload APIs. Disposing the manager closes all authority; reconnect cancels tracked transport calls and invalidates the old generation.

Expose a narrow cluster execution-authority interface: read current selection/resolution, acquire a snapshot for `(generation, exactContext)`, check snapshot currency, and hold/release direct-work guards. The manager issues snapshots only under current published authority. The bridge separately owns operation admission, schema checks, and result normalization; the controller owns the connection. Pi schedules independent model calls in parallel; the manager owns scope, shared admission, and work guards. Phase 4 can supply an incident-owned rule through this boundary and extend snapshots with lifecycle/storage reservations. Do not import or stub an incident/evidence service now.

Capture a fresh frozen snapshot per admitted diagnostic call. Currency requires matching owner, selection revision/rule, inventory revision, generation, dispatch-enabled state, and continued availability/compatibility of that exact target. Snapshot object identity is not the global selected context. A result or unrelated concurrent call never changes these values. Selection is blocked by both agent work and direct calls; teardown/reconnect may invalidate them regardless of the idle guard.

### Call order and scheduling

1. Check cancellation, allowlist, captured generation, ready transport, and dispatch gate. Privately copy and validate discovered-schema/model arguments and retrieval limits; preserve exact context unchanged. Validate current scope, availability, and discovered context compatibility before admission. Invalid calls consume no active slot or queue entry.
2. Acquire a work guard and admission from one application-owned scheduler shared across tools, contexts, direct/model callers, enumeration, and replacement handlers. Permit **four active calls plus 32 FIFO waiters**. New calls cannot overtake existing waiters. A fifth call waits without model retry; only a full waiting queue returns bounded `capacity-exceeded`, with zero MCP dispatches.
3. A queue entry retains private arguments, original handler generation, selection/inventory revisions, cancellation hooks, and settlement state. It grants no execution authority and holds no execution snapshot or active slot while waiting. Work guards block idle selection and invalidate stale picker tickets. Never publish/log queued raw arguments.
4. Bound queue residence to **30 seconds** using a monotonic deadline. Expiry returns `timeout` with a safe admission-wait message and zero dispatches. The MCP request timeout starts separately at dispatch. Caller cancellation promptly removes the waiter and preserves existing abort behavior. Remove its timer/listener and reclaim waiting capacity immediately.
5. At slot handoff and again before dispatch, recheck cancellation, connection generation/readiness, publication gate, selection/inventory revisions, current scope resolution, exact target availability, and tool compatibility. Enumeration checks connection/publication/revisions without a target snapshot. Changed authority invalidates waiting work rather than rebinding it to a new revision or connection. Existing scope/transport/stale failure categories apply.
6. After admission passes, capture a fresh diagnostic execution snapshot immediately before dispatch with no intervening await. Preserve exact context and call the managed connection with cancellation. Hold the slot through normalization and final cancellation/snapshot checks. Release slot, snapshot, and work guard on every exit, including synchronous transport throws, capture refusal, malformed results, cancellation, and staleness. Cleanup and settlement are idempotent, including cancellation/expiry racing with handoff.
7. Transport loss, publication blocking, generation invalidation, and disposal promptly settle affected waiters without waiting for an active slot or uncooperative transport call. Reconnect cancels/settles old work before replacement publication; old waiters never cross generations or replay. Calls during blocked publication fail preflight. Shutdown leaves no queued promises, timers, cancellation listeners, or work guards behind; active slots release when their cancelled operations settle.
8. Recheck cancellation and snapshot validity after MCP and immediately before publishing normalized success. Withhold invalidated payloads even after server success. Never retry interrupted calls automatically.

All registered MCP tools use `executionMode: "parallel"`, including enumeration. Four active, 32 waiting, and the 30-second queue deadline are initial application constants; no configuration keys are added. Existing request timeouts/result limits remain. Phase 3 introduces no incident budget; Phase 4 reserves incident dispatch budget and evidence storage after queued work passes dispatch checks. Cancelled, expired, invalidated, and overflowed waiters consume no dispatched-attempt budget.

Keep existing failure categories: missing/non-string/unknown/out-of-scope context is `invalid-arguments`; unavailable resolution or a removed permitted member is `scope-unavailable`; transport loss is `transport-unavailable`; old generation/snapshot is `stale-scope`. Discovered-schema violations are `invalid-arguments`; incompatible descriptors are rejected at discovery with `incompatible-schema`. No capacity-refusal category is added in Slice 2. Scope/argument refusals are bounded tool errors with zero MCP calls, not empty success. Retain Kubernetes authentication/authorization, timeout, and tool-execution categories. Caller cancellation keeps the existing abort behavior. Generation invalidation must never return old diagnostic payload as fresh success. Per-context failures do not withdraw unrelated targets or mark the transport down.

## 5. Schema and reconnect publication

For each allowlisted diagnostic descriptor, retain its object schema, other properties, required fields, openness, and context constraints. Require a declared context property as today. Prepare one private argument schema by making context a required nonempty string while preserving all discovered constraints. Do not generate a session-scope enum or separate transport validator. If no permitted available names pass context compatibility, hide the tool. If a constraint cannot be evaluated, fail closed as today.

The schema and descriptor must not share mutable authority with public registered objects. Execution validates arguments once against the private schema, then validates their values against retrieval limits and current permission/availability through `validateMcpToolExecution`. Current-generation handlers honor idle selection changes immediately. Republish tools on semantic selection/resolution changes to update visibility; schemas contain no captured permission. Old-generation handlers always fail. Enumeration retains its discovered input schema and needs no context; its model-visible result is presentation only and cannot install inventory.

Distinguish the publication gate (all model/direct MCP dispatch blocked during replacement/publication) from diagnostic readiness (requires usable resolution). After successful discovery, context-independent enumeration can remain published/callable even with empty inventory or invalid selection. It still checks generation, ready transport, publication gate, cancellation, schema before dispatch, but takes no diagnostic target snapshot. Failed authoritative enumeration retains the current behavior of withdrawing the model tool surface until recovery.

Reconnect is a controller transaction:

1. Close dispatch, withdraw diagnostic tools, increment generation, cancel/settle old calls, and retire the old process. A shared transport drop closes dispatch immediately even before a retry starts.
2. Load transport configuration, connect once, discover descriptors, and enumerate complete inventory. Keep pending state private; no listener may observe a usable new inventory with old schemas.
3. Validate inventory, advance inventory revision, re-resolve the unchanged rule, compute added/removed/changed sanitized metadata, and build compatible tools against that state. Discovery failure leaves diagnostics blocked and preserves rule intent; empty success installs an empty resolution.
4. Install matching connection, inventory, resolution, and tools while dispatch remains closed. Synchronously notify UI/tool subscribers and enqueue the bounded persistent model notice. Only then reopen dispatch if there are usable diagnostic targets. If publication fails, keep dispatch closed and report failure.

Use the same closed-gate publication sequence for idle selection changes. Pi `registerTool` refreshes one tool at a time, so it is not itself an atomic batch API. The controller gate and one consistent application snapshot provide the atomic boundary; hiding a tool alone is not authorization. All subscriber callbacks during transition must observe dispatch blocked. A successful no-op `/mcp_restart` changes neither generation nor inventory. Shared concurrent retries retain one replacement promise.

Reconciliation examples after accepted `{A, B}` inventory becomes `{A, C}`:

| Rule           | New permitted/available | Notice / refused target                               |
| -------------- | ----------------------- | ----------------------------------------------------- |
| Exact `{A}`    | A                       | C remains outside selection                           |
| Exact `{A, B}` | A                       | B unavailable; C outside selection                    |
| All `*`        | A, C                    | B removed/unavailable; C newly available, not checked |

Changed safe endpoint metadata is a notice and a new inventory revision, not proof of a new physical cluster or verified authentication. Retain prior transcript observations with their original provenance; do not relabel them under new authority.

## 6. Display, messages, and result provenance

Continuously show READ ONLY on its own widget line, the rule/source, resolved membership/count and partial/unavailable state, namespace policy, and MCP/inventory state. Each diagnostic call rendering and result shows the exact supplied context. Namespace omission means server/context policy, never an all-namespace coverage assertion. There is no incident ID, next selection, evidence ID, or inferred fleet health in Phase 3.

Use existing `pi-sre-cluster-scope` persisted custom messages through `sendMessage(..., {deliverAs: "steer"})`; no new turn or per-request scope append. Restore current state through `before_agent_start` when compaction/navigation removed it. Keep policy in the system prompt and deduplicate unchanged semantic state. Publish notices before reopening dispatch; steering consumption can occur later and never grants authority.

Bound each automatic model scope/change message to 8,000 characters, with counts and at most eight complete exact names per change category; omit whole names when the character budget is reached and state the omitted count. Never truncate a name into a different identity. Keep full current membership inspectable in the command UI through paginated `ui.select` status views (20 names per page), with no mutation; plain status also reports counts/revisions during work or outages. Retain only the latest inventory transition notice, not an unbounded removal ledger. No endpoints/credentials/raw arguments enter these messages.

Result details retain mapping, status, failure category, truncation, and optional namespace, plus exact context, selection revision, inventory revision, connection generation, namespace policy, and read-only profile from the captured snapshot. Provenance stays attributed on failure/stale results after a target was admitted. Missing-context rejection cannot invent a target. Raw MCP results and raw arguments remain absent from details/storage; existing redaction/presentation limits still apply. Durable query coverage and evidence attribution are Phase 4 work.

## 7. Installed Pi API evidence

Inspected installed declarations and implementation under `node_modules`, not guessed APIs:

| Need                          | Verified public API / installed source                                                                                                                                      | Consequence                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Slash parsing and idle status | `core/agent-session.js` dispatches command name and remaining argument string; `ExtensionContext.isIdle()` in `core/extensions/types.d.ts`                                  | Preserve direct-name string; commands can run during work, so enforce guards explicitly                           |
| Picker                        | `ExtensionUIContext.select(title, string[])` returns one string or undefined; `custom<T>` is also public                                                                    | No native multi-select signature; use the staged select loop above                                                |
| Dynamic tools                 | `ExtensionAPI.registerTool`; `core/extensions/loader.js` replaces the tool map entry and calls `refreshTools()`                                                             | Re-register definitions, hide removed names with `exposure: "hidden"`, enforce controller gate during publication |
| Argument boundary             | `ToolDefinition.prepareArguments`, `parameters`, `execute(..., signal, ...)`                                                                                                | Preparation preserves target; execute independently validates direct calls                                        |
| Parallel execution            | `ToolDefinition.executionMode`; nested `pi-agent-core/dist/types.d.ts` defaults `toolExecution` to parallel; `agent-loop.js` uses `Promise.all` for prepared parallel calls | Declare sequential execution now; application capacity admission is deferred to Slice 4a                          |
| Scope presentation            | `setWidget`, `sendMessage`, `before_agent_start`, `sessionManager.buildSessionProjection()`                                                                                 | Reuse persisted scope strategy and standalone READ ONLY widget line                                               |
| Session lifecycle             | `session_start`/`session_shutdown` include startup/reload/new/resume/fork reasons; `AgentSessionRuntime` aborts before teardown on replacement                              | Rely on Pi agent settlement; interactive reload requires idle work; release extension subscriptions               |
| MCP cancellation              | `@earendil-works/pi-mcp/dist/client.d.ts`: `callTool`, `listTools`, `McpRequestOptions.signal/timeoutMs`, `onClose`, `close`                                                | Reuse managed lifecycle and cancellation; no protocol/client replacement                                          |

The existing [public Pi contract test](../tests/integration/phase2-contracts.test.ts) remains an offline capability probe. Its `/context` and `/cluster` registrations are isolated historical test commands, not production aliases. No new live server behavior is inferred. The historical 0.0.67 limitation still applies: a server omitting enumeration or declared explicit context is incompatible; one permitted target never justifies implicit routing.

## 8. Assertions to migrate and verification

Keep Phase 2 documents/captures historical. Update executable tests as their implementation slices land; do not keep a second legacy routing mode just to satisfy them.

| Existing test assertion                                                                                                            | Intentional change / retained invariant                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/cluster/context-resolver.test.ts`: source `mcp-default`; no-default inventories unbound                                | Default all with/without MCP default, including singleton; retain exact identity and invalid explicit no-fallback checks                                                                                                  |
| `tests/unit/cluster/context-manager.test.ts`: combined revision, no-argument capture, resolved unbound preserved                   | Separate revisions, target capture, pending rule and exact/all reconciliation; retain isolation, immutable state, work guard, stale discovery checks                                                                      |
| `tests/unit/app/cli.test.ts`, `tests/e2e/package.test.ts`: both singular CLI forms and singleton precedence help                   | New variadic/equals syntax, conflicts/duplicates, sole wildcard, default-all help; retain help validation, package isolation and failure-before-startup checks                                                            |
| `tests/unit/mcp/tool-policy.test.ts`: context hidden and context-free model arguments accepted                                     | Required/intersected context, including singleton, while retaining every discovered non-context constraint and openness                                                                                                   |
| `tests/unit/mcp/tool-call-preparation.test.ts`: model context deleted                                                              | Preserve unchanged context; retain private copies, idempotence and log defaults/limits                                                                                                                                    |
| `tests/unit/mcp/scoped-tool-bridge.test.ts`: empty/wrong/object context overwritten; subsequent empty call follows idle selection  | Missing/wrong/object context refused; A/B explicitly supplied and preserved; retain cancellation, stale payload withholding, redaction and schema compatibility                                                           |
| `tests/integration/cluster-startup.test.ts`, `phase2-acceptance.test.ts`: MCP default binding/no-default unbound; injected context | Migrate production-composition cases to exact/all and model routing; add `phase3-acceptance.test.ts`; retain marked result origins/history/child cleanup                                                                  |
| `tests/integration/mcp-restart.test.ts`: resolved unbound stays unbound; one removed selection blocks all; singular command/picker | Rule unchanged, exact partial availability versus live-all additions, split revisions, staged picker tickets and new command; retain restart sharing, immediate withdrawal, late-result rejection and per-target failures |
| `tests/integration/cluster-scope-messages.test.ts`, `tests/unit/tui/cluster-status.test.ts`: one cluster or NOT SELECTED           | Rule/resolution display and bounded change notices; retain compaction restoration, deduplication, history ordering, READ ONLY visibility and sanitization                                                                 |

Slices 4a/4b test overlapping A/B origins, FIFO waiting, full-queue overflow, cancellation removal, queue expiry, dispatch-time authority checks, idempotent slot release, and active/queued reconnect/drop/shutdown settlement without replay. Slices 1–5 additionally test sequential target execution; current versus old-generation handlers; work that starts/ends during a picker; invalid exact initial atomicity versus accepted exact partial reconnect; failed/empty discovery; changed tool enums/patterns; and publication-listener attempts before dispatch reopens. Offline tests cannot establish installed terminal behavior or real Kubernetes routing. Those remain the explicit Slice 5 installed/disposable-cluster gate.

Slice 0 changes documentation only. Verify formatting of changed Markdown and rerun the existing offline Pi contract probe, then canonical format/lint/type/test/build checks. Record actual outcomes below; no new tests are needed to mirror prose contracts.

**Validation (2026-10-19):** The existing offline public Pi contract probe passed (2 tests). `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (390 passed; 7 optional executable-dependent tests skipped), and `npm run build` passed. No runtime source/tests or historical Phase 2 records were changed. Installed/disposable-cluster acceptance remains Slice 5 work.
