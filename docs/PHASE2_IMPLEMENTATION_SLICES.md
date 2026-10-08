# Phase 2 Implementation Slices

**Status:** Slice 0 complete (2026-10-07); Slices 1–9 planned

**Applies to:** Pi SRE V0.1, Phase 2 — Cluster Context Management

**Prerequisite:** [Phase 1 acceptance](./PHASE1_ACCEPTANCE.md) is complete, including user-reported live acceptance on 2026-10-07.

**Source of truth:** [DESIGN.md](./DESIGN.md), especially Sections 16–34, 42, 52–54, 59, and 64.

## 1. Goal

Every cluster-dependent Kubernetes operation must use a cluster context that is explicit, visible, and deterministic.

The completed path is:

```text
start one managed Kubernetes MCP connection
    → discover and validate tool contracts
    → enumerate and validate MCP contexts
    → resolve --cluster > config default > MCP default > unbound
    → display operational scope
    → validate model arguments
    → inject application-owned context
    → validate final MCP arguments
    → invoke an approved read-only tool on the same connection
    → return a bounded result with its originating scope
```

The user selects scope. The model investigates within it. Pi SRE never changes kubeconfig or uses shell access to reach Kubernetes.

## 2. Starting Point

Phase 1 already provides the runtime, transport, and safety foundations. Extend these modules rather than building a second integration path.

| Existing component                                           | Phase 2 extension                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/app/cli.ts`                                             | Parse and document `--cluster`; currently accepts only help or no arguments.                          |
| `src/config/schema.ts` and `config.ts`                       | Activate the already validated optional `kubernetes.defaultCluster`.                                  |
| `src/app/mcp-controller.ts`                                  | Coordinate context enumeration and binding with connection generations, tool inventory, and recovery. |
| `src/mcp/connection.ts`                                      | Reuse its one managed Pi MCP connection, timeouts, cancellation, and cleanup.                         |
| `src/mcp/tool-discovery.ts` and `src/runtime/tool-policy.ts` | Validate explicit-context compatibility before exposing selected diagnostic tools.                    |
| `src/mcp/tool-bridge.ts`                                     | Separate model arguments from transport arguments; enforce and inject scope at execution.             |
| `src/runtime/pi-runtime.ts` and `resource-loader.ts`         | Register only SRE-owned extensions and supply current scope to the model.                             |
| `src/tui/mcp-restart-command.ts`                             | Preserve recovery and add coordinated scope/status updates.                                           |
| `tests/fixtures/fake-mcp-server.ts`                          | Add realistic context responses, scoped tools, and deterministic call recording.                      |

Only `configuration_contexts_list` is currently exposed. `pods_list`, `pods_log`, and `events_list` are recognized but deferred. The cluster, domain, investigation, skills, and eval directories currently contain placeholders.

The installed Pi runtime and MCP client are both 0.99.0, upgraded during Phase 1.

## 3. Scope Boundary

### In scope

- MCP-backed context enumeration and a validated context registry;
- application-owned active-cluster state and selection provenance;
- deterministic startup resolution and recoverable selection errors;
- `--cluster`, `/cluster`, and operational `/context`;
- a continuously visible cluster, namespace, read-only, and MCP status;
- explicit context injection into a small approved diagnostic tool surface;
- protection against model-controlled context and cross-cluster call races;
- scope reconciliation after MCP restart or connection loss;
- deterministic unit, MCP integration, Pi agent-loop, and packaged CLI checks;
- explicit live acceptance proving calls reach the selected cluster.

### Out of scope

- incidents, evidence stores, hypotheses, or investigation persistence;
- diagnostic skills and automated root-cause grading;
- automatic cross-cluster discovery or model-driven cluster selection;
- a `/namespace` command or a new namespace selection policy;
- persisted active-cluster selection across application restarts;
- HTTP MCP transport, additional MCP providers, or a second MCP connection;
- generic resource access that can expose Secrets without a reviewed resource policy;
- shell, `kubectl`, mutation tools, or remediation.

The namespace status is `*` in this phase, meaning no application-level namespace restriction. Individual tools may query a namespace and must identify it in their result details. This display does not assert that every call queries all namespaces.

## 4. Behavioral Contract

These are proposed Phase 2 implementation decisions within the existing design. Slice 0 verifies the server and Pi API contracts before implementation.

### Startup selection

| Input or condition                                          | Required behavior                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Valid `--cluster <name>`                                    | Bind that exact MCP context; ignore lower-priority defaults.               |
| Unknown CLI context                                         | Open the TUI unbound with an actionable selection error; never fall back.  |
| No CLI selection; valid configured default                  | Bind the configured context.                                               |
| Unknown configured default                                  | Open unbound with a configuration warning; never fall back to MCP default. |
| Neither CLI nor configured default; valid MCP default       | Adopt it once as explicit application state.                               |
| Valid nonempty registry with no default                     | Stay unbound, including when there is only one context.                    |
| Valid empty registry                                        | Show `NOT CONFIGURED`; block cluster-dependent calls.                      |
| Missing tool, malformed enumeration, or enumeration failure | Report the actual failure; do not interpret it as an empty registry.       |
| MCP unavailable                                             | Keep the TUI and recovery command available; claim no Kubernetes access.   |

Syntactically invalid CLI arguments fail before application startup. A context name that is well-formed but unavailable is a recoverable operational problem. Context names are opaque, exact identifiers, not server aliases, namespaces, or fuzzy matches.

### Selection and concurrency

- `/cluster <name>` changes active application state only after exact registry validation.
- `/cluster` without arguments opens Pi's selector; cancellation changes nothing.
- Selection requires a current registry from a ready connection. Cached names during disconnection are informational only.
- Reject a cluster change while the agent is generating, executing tools, or otherwise running an agent loop. Guide the user to wait or cancel, then retry. Recheck after any awaited selector interaction.
- Application enforcement also protects programmatic callers; a UI-only idle check is insufficient.
- Capture context and connection generation at tool dispatch. A later selection or restart cannot reroute the call.
- Scope changes and connection replacement invalidate stale work. Late results must not become observations under a different cluster.
- Selecting the already active context is a no-op. Invalid selections preserve the existing valid selection.

Phase 3 will capture this scope in `Incident.scope`. At that point `/cluster` establishes the default for the next investigation and must not mutate an existing incident. Phase 2 provides an immutable scope snapshot seam without implementing incident objects.

### Model and transport arguments

The server input schema remains the authoritative transport contract. Derive a separate model-facing schema that omits the application-owned `context` property and its required entry, preserving all other constraints.

For cluster-dependent tools, at execution:

1. Recheck the approved tool policy and current connection generation.
2. Remove any supplied `context` from untrusted model arguments and validate the remaining arguments against the model-facing schema.
3. Require a valid application-owned scope snapshot for cluster-dependent tools.
4. Inject its exact context, overwriting any model-supplied value.
5. Validate the complete arguments against the original MCP schema before transport.
6. Forward cancellation and timeout; check cancellation/generation again before publishing the result.

A declared compatible `context` parameter is required for every exposed cluster-dependent tool. A tool without one remains unavailable, even if the schema permits arbitrary additional properties. Pi SRE never depends on the server's implicit current context. `configuration_contexts_list` remains a non-cluster-dependent operation and does not change active selection when the model calls it.

### Recovery

- During replacement or transport loss, disable cluster-dependent execution immediately and mark the scope unavailable.
- Re-enumerate contexts on the replacement connection before re-enabling diagnostic tools.
- Retain the previous exact selected name as selection intent. Rebind it only if the new validated registry still contains it and its tool contracts support explicit context.
- If the selected name disappears, remain unbound with a warning; never substitute a new MCP or configured default.
- Preserve an explicit `/cluster` choice across recovery. Configuration reload must not override it.
- If no selection was established because initial MCP startup failed, apply the pending CLI/config/MCP startup resolution on the first successful enumeration, using the refreshed configuration.
- Once enumeration has completed, an intentionally unbound session remains unbound across retries; a newly appearing default must not silently select a cluster.
- Existing forced-restart cancellation, stale-handler isolation, conversation preservation, and application-home validation remain in force.

## 5. Target Module Shape and Ownership

```text
src/
├── app/
│   ├── application.ts                 # composition and lifecycle
│   ├── cli.ts                         # --cluster input
│   └── mcp-controller.ts              # connection generations and atomic publication
├── cluster/
│   ├── cluster-context.ts             # Pi-independent context/scope/state types
│   ├── context-registry.ts            # validated inventory and exact lookup
│   ├── context-resolver.ts            # pure startup precedence
│   └── context-manager.ts             # selection, snapshots, subscriptions
├── mcp/
│   ├── context-discovery.ts           # MCP response validation → cluster types
│   ├── tool-discovery.ts              # descriptor and capability validation
│   └── tool-bridge.ts                 # argument validation and scope injection
├── runtime/
│   ├── tool-policy.ts                 # exact diagnostic allowlist
│   ├── system-prompt.ts               # operational scope guidance
│   └── pi-runtime.ts                  # SRE extension registration
└── tui/
    ├── cluster-command.ts             # thin selector/command wiring
    ├── context-command.ts             # operational status rendering
    ├── status-widget.ts               # continuously visible scope
    └── mcp-restart-command.ts          # existing recovery command
```

Names are proposed, not a requirement to create every file in advance. Keep pure resolution and registry logic free of Pi and MCP transport types. The MCP adapter validates external responses and returns cluster domain types. The application owns coordination; extension entrypoints only register hooks, commands, and status subscriptions.

Use a discriminated state model that distinguishes connecting, unavailable, enumeration failure, no contexts, unbound/selection error, and bound. Do not overload one optional string or a transport `ready` flag to represent all operational states. A bound context means scope is selected; it does not prove Kubernetes authentication or authorization succeeds.

Keep selected context, selection source (`cli`, `config`, `mcp-default`, or `user`), registry revision, and connection generation explicit. These are session-scoped objects, with no module-global selection and no authority derived from conversation history.

## 6. Slice 0 — Verify and Freeze the Phase 2 Contracts

**Completed:** See [PHASE2_CONTRACTS.md](./PHASE2_CONTRACTS.md) for observed server 0.0.67 behavior, sanitized captures, supported response forms and limits, Pi 0.99.0 API verification, and the frozen application behavior. Single-context and disabled-provider setups lack the required capabilities and must fail closed; the verified two-context setup supports explicit routing.

**Outcome:** Real server behavior and public Pi APIs have documented, deterministic fixtures before scope enforcement is designed around them.

### Work

- Inspect the supported Kubernetes MCP executable/version and capture sanitized descriptors and context-list responses. Phase 1 live acceptance records server 0.0.67; verify the actual version used for Phase 2.
- Verify the exact context response shape, including default metadata, empty results, single-context behavior, and available namespace/server fields. Design examples and current fake responses are not authoritative wire contracts.
- Verify how the server exposes explicit `context` for candidate diagnostic tools, including any required server configuration. If the supported setup cannot enumerate contexts or honor explicit context, report that compatibility blocker instead of falling back to implicit scope.
- Define the narrow supported response forms: prefer validated structured content; parse text only when it matches an explicitly supported, fixture-backed format. Never infer contexts from prose or parse kubeconfig in Pi SRE.
- Set application-side limits for context response bytes, entries, and field lengths. Exceeding a limit fails enumeration visibly; do not create an authoritative registry from truncated data.
- Verify Pi 0.99 public APIs for selection, status, agent-idle checks, model-context hooks, and command dispatch. Check `/context` against built-in commands and prove the requested operational command is reachable.
- Freeze the startup, switching, recovery, and model-context contracts in Section 4.

### Acceptance criteria and tests

- Fixtures cover valid/default, non-default, empty, malformed, duplicate, and failed context enumeration.
- The documented core-tool descriptors demonstrate whether explicit context is supported.
- Absent default metadata produces unbound scope when no explicit selection exists; contradictory metadata fails validation.
- Fixtures contain no credentials, kubeconfig content, real sensitive endpoints, or raw application data.
- Public Pi APIs support the proposed UX without private-field mutation or method reassignment.

## 7. Slice 1 — Validate Context Enumeration and Build the Registry

**Outcome:** Pi SRE can obtain a complete, validated context inventory without a model turn or live-cluster unit tests.

### Work

- Add the MCP context adapter using the same managed connection as diagnostic calls.
- Validate the context-list descriptor against the exact allowlist, read-only metadata, and schema contract before invoking it application-side.
- Validate the raw response before adapting it into domain contexts. Keep this path separate from model-facing truncation/redaction: a shortened presentation must never determine registry membership.
- Build an immutable registry with exact-name lookup and deterministic display ordering.
- Reject invalid entries, duplicate names, contradictory defaults, and a default referring to an absent context. Do not silently drop bad entries and select from a partial registry.
- Preserve only necessary metadata. Treat names and endpoint strings as untrusted display data; remove terminal control characters and never render embedded credentials.
- Propagate cancellation and classified MCP/tool failures. Empty success is a distinct state.

### Acceptance criteria and tests

- Valid supported wire responses produce the expected registry and default.
- Structured/text compatibility, empty success, `isError`, malformed response, duplicates, inconsistent defaults, limits, timeout, and caller cancellation are covered.
- Registry lookup is exact and immutable; names sharing a prefix or server endpoint remain distinct contexts.
- No direct kubeconfig read or additional MCP process is introduced.

## 8. Slice 2 — Resolve Startup Scope and Add `--cluster`

**Outcome:** Every startup has a deterministic bound or explicitly unbound result.

### Work

- Extend CLI parsing for `--cluster <name>` and `--cluster=<name>`. Reject blank/missing values, duplicate selections, and unknown flags; document help behavior.
- Pass parsed selection intent through `main.ts` into application composition without environment-global state.
- Implement a pure resolver for CLI > configured default > MCP default > unbound.
- Preserve provenance and the requested name for actionable recovery guidance.
- Implement the invalid-selection behavior in Section 4; no unknown CLI/config name falls through to another source.
- Remove or comment out the example YAML's `defaultCluster: staging` so copying it does not immediately produce an invalid selection. Show an opt-in example with a warning to use an actual MCP context.

### Acceptance criteria and tests

- A table-driven resolver test covers precedence, invalid high-priority selection, MCP default, one context without a default, and no contexts.
- CLI tests cover both supported forms, help, missing/blank values, duplicates, and unknown flags.
- Config tests cover optional/default handling and copied example validity.
- Help remains usable without loading application configuration or starting MCP.

## 9. Slice 3 — Own Cluster State and Integrate Startup

**Outcome:** The running application has one authoritative scope manager coordinated with the MCP lifecycle.

### Work

- Introduce session-scoped selection state, immutable scope snapshots, and state subscriptions.
- In startup, discover/validate descriptors, enumerate contexts, resolve scope, and only then publish the final usable tool inventory.
- Descriptor discovery may precede enumeration to validate the context-list contract. No cluster-dependent tool is exposed or called during this preliminary discovery.
- Keep connection readiness separate from registry validity and scope readiness. Context enumeration failure must not become a generic command-not-found error or an empty inventory.
- Allow the TUI to open unbound or degraded with precise diagnostics and recovery guidance.
- Provide application-level coordination for selection, active agent work, and connection generations; preserve Phase 1 cancellation and shutdown ownership.
- Conversation resume/fork/reload must use the current application-owned scope. Historical transcript text never restores cluster authority. A new application launch always resolves its startup inputs anew.

### Acceptance criteria and tests

- Startup performs one application-side enumeration on the owned connection; the model is not needed.
- Bound, unbound, empty, invalid-selection, failed-enumeration, and unavailable states are observable distinctly.
- Runtime creation and shutdown failures still close all acquired resources.
- Two independent applications/managers cannot leak selection to one another.

## 10. Slice 4 — Enforce Scope in the Tool Bridge

**Outcome:** One scoped read-only tool works end to end in deterministic integration tests, and attempted model scope overrides cannot alter its target. Production exposure waits for the visible scope UX in Slice 6 and the per-tool review in Slice 7.

### Work

- Start with `pods_list` if its verified descriptor supports explicit context. Keep other cluster-dependent tools deferred until reviewed in Slice 7.
- Derive the model-facing schema without `context`; retain the original server schema for final validation.
- Implement execution-time policy, binding, schema, and generation checks described in Section 4.
- Inject context independently of namespace. Never use namespace or a model-supplied server name as cluster identity.
- Return safe failure details for unbound scope, unavailable context, incompatible schema, and transport failure; do not send a request when local validation fails.
- Include the originating context and applicable namespace in bounded tool details/result presentation so historical observations stay attributable after a later switch.
- Reuse Phase 1 normalization, redaction, size budgets, cancellation, and disabled raw retention.

### Acceptance criteria and tests

- A deterministic Pi agent-loop call reaches fake MCP with the exact selected `context` and expected non-context arguments.
- Omitted context works, and an attempted foreign/model-supplied context is overwritten with the selected context.
- Original server constraints are validated after injection, including required fields and enum restrictions.
- A missing/incompatible context property, unbound scope, stale handler, or invalid argument produces zero cluster-dependent requests.
- Cancellation and delayed results cannot publish data under a replacement scope or connection generation.
- Empty Kubernetes results remain successful observations.

## 11. Slice 5 — Add `/cluster` and Safe Runtime Switching

**Outcome:** The user can select a context through the TUI while the application enforces stable scope during active work.

### Work

- Register `/cluster <exact-name>` and the no-argument selector using public Pi APIs.
- Show selection and provenance clearly; preserve state on selector cancellation or invalid input.
- Reject switching during an active agent loop or MCP transition. Revalidate readiness, registry revision, and idle state after the selector returns.
- Commit the new selection synchronously through the application manager before publishing status or accepting new diagnostic work.
- Update scope-dependent tool exposure and model guidance from the committed state. Do not recreate the conversation or restart MCP just to switch clusters.
- Support selecting a valid context to recover from a startup selection error.

### Acceptance criteria and tests

- Named selection, interactive selection, cancel, unknown name, same-name no-op, and unavailable registry behave as specified.
- A selector opened before a restart cannot commit a choice from a stale registry.
- Switching while a model/tool operation is active is blocked; the original call retains its original context.
- After an idle switch, the next agent turn/tool call uses the new context; the transcript remains intact.
- Tests compare the fixture kubeconfig before/after and prove no config mutation, write tool, or shell fallback occurs.

## 12. Slice 6 — Make Operational Scope Visible to User and Model

**Outcome:** User status, `/context`, model guidance, and execution use the same authoritative scope.

### Work

- Register operational `/context` to report selected context, selection source, namespace policy, read-only state, registry state, and MCP state. Show only sanitized endpoint metadata if useful; never credentials or kubeconfig.
- Use Pi's public status/footer APIs to display `context | Namespace: * | READ ONLY | MCP status` continuously.
- Distinguish `NOT SELECTED`, `NOT CONFIGURED`, and unavailable/failed enumeration. If displaying a previous selection while disconnected, label it unavailable rather than ready.
- Keep the scope and read-only indication readable on narrow terminals; verify wrapping/truncation does not hide the safety state.
- Supply current operational scope through a public Pi prompt/context hook. Refresh guidance for each model request so connection loss or restart during a turn cannot leave a stale access claim.
- Explain that selection is application-owned, historical observations belong to their recorded context, cross-cluster searching is prohibited, and unbound calls are blocked.
- Dispose subscriptions on session replacement, extension reload, and shutdown; preserve Pi's model/session UI and resource isolation.

### Acceptance criteria and tests

- Command, footer, and effective model guidance agree in every scope/connection state.
- Selection and connection changes update status without requiring an unrelated user message.
- New/resumed/forked conversations and resource reloads preserve SRE policy and use current scope.
- Control-character fixtures and sensitive endpoint fields do not become unsafe terminal or prompt content.
- Live terminal verification covers narrow width, selection dialogs, streaming, restart, and read-only visibility.

## 13. Slice 7 — Enable the Reviewed Diagnostic Tool Surface

**Outcome:** A small useful set of read-only tools is available only when its scope contract is safe.

### Work

- Review candidates `pods_list`, `pods_get`, `pods_log`, `events_list`, and `namespaces_list` against Slice 0's actual descriptors. These names are candidates, not assertions that every server version supplies them.
- Record the exact approved names, cluster dependence, explicit-context schema, namespace behavior, and any necessary argument restrictions in the tool policy/schema documentation.
- Require compatible context schemas and read-only metadata for each tool; unknown, destructive, malformed, duplicate, or incompatible descriptors fail closed.
- Keep diagnostic tools hidden while unbound or unavailable, and independently block captured handlers at execution time.
- Review pod-log arguments for finite/bounded requests. Do not introduce streaming/follow behavior that outlives a diagnostic call; enforce verified server-side bounds as appropriate in addition to model-facing size limits.
- Continue excluding `configuration_view`, exec/attach, mutation operations, and generic Secret-capable access. Do not infer safety solely from names or annotations.

### Acceptance criteria and tests

- Every newly enabled tool has a descriptor fixture and a scoped-call test asserting final MCP arguments.
- Unsafe or missing capabilities remain unavailable without disabling unrelated compatible tools.
- Fresh inventory after a server change cannot automatically expose a new operation.
- Read-only configuration, tool-picker exclusion, shell denial, result redaction, and bounded results remain covered.

## 14. Slice 8 — Reconcile Scope During MCP Recovery

**Outcome:** `/mcp_restart` restores usable access without silently changing the selected cluster or reviving stale tools.

### Work

- Extend the existing serialized restart path to publish transport, registry, scope, and tool state coherently.
- Cancel/drain old calls, discard old registry authority, enumerate the replacement connection, and apply Section 4's selection-intent rules before enabling diagnostics.
- Preserve healthy restart no-op behavior and conversation state. Forced replacement retains its existing cancellation behavior.
- Do not conflate an MCP ping with Kubernetes authentication. Keep authentication, authorization, and resource-operation failures distinct and scoped.
- Test changing tool schemas, context inventories, and configured defaults between retries.

### Acceptance criteria and tests

- Failed startup → repaired configuration → restart resolves the pending startup selection correctly.
- A user-selected context survives recovery when present; a removed context yields unbound state without fallback.
- An initially unbound session is not silently rebound because a new default appears.
- Connection drop hides tools and changes visible/model access state immediately.
- Failed enumeration, repeated retries, forced restart during a call, concurrent restart/switch attempts, and late responses cannot leak access or children.
- Old handlers cannot call the replacement connection; application-home changes still require a full restart.

## 15. Slice 9 — Phase Gate and Live Scope Acceptance

**Outcome:** Automated and live evidence demonstrate explicit cluster targeting through the complete application path.

### Automated gate

Run the narrowest affected tests first using the existing Vitest commands. Then run the canonical gate, stopping on failure:

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run build
```

Use `npm run test:integration` and `npm run test:e2e` for focused acceptance. Extend packaged CLI checks for `--cluster` help and parsing, and keep package tests offline. CI must continue to require no live infrastructure or provider credentials.

Add deterministic full-path tests for startup precedence, invalid selection, empty contexts, attempted model override, runtime switching, and recovery. The fake server must record exact tool names/arguments and return different resource markers per context, so a passing natural-language answer alone cannot conceal a misrouted call.

### Manual live scope test

1. Record package revision, Node/Pi/MCP versions, OS/terminal, and model identifier without credentials. Use the installed package outside the checkout.
2. Prepare two distinguishable MCP contexts backed by read-only credentials and fixtures. Prefer two local kind clusters for cross-cluster proof. The Phase 1 namespace contexts point at one cluster and alone do not prove different cluster routing.
3. Confirm the actual MCP server exposes context enumeration and explicit context parameters. Establish distinct non-sensitive resource markers in each cluster through the test setup, outside Pi SRE.
4. Launch with `--cluster <A>`. Check `/context`, footer, and a model-driven pod/event observation; assert that only A's marker appears.
5. While idle, select B with `/cluster` and repeat. Confirm B's marker, retained conversation, and unchanged kubeconfig content/current context.
6. Attempt a switch during a pending model/tool operation. Confirm refusal and preservation of that operation's original scope.
7. Exercise CLI precedence, configured default, MCP fallback, unknown CLI/config names, and unbound/no-default behavior using dedicated safe configurations.
8. Exercise degraded startup, successful restart, and removal of the selected context from the replacement registry. Confirm no silent fallback or diagnostic call while unbound.
9. Request a different context through model tool arguments and ask for a mutation. Confirm the selected scope is enforced and no write tool or shell fallback executes.
10. Quit; verify child-process cleanup and terminal restoration.

Creating fault/resource fixtures belongs to the explicit test setup, not Pi SRE's runtime capabilities. Keep live tests in an explicit suite/runbook. Phase 5 still owns automated kind fault-diagnosis evaluation and RCA grading.

Create `docs/PHASE2_ACCEPTANCE.md` in this slice with pass/fail evidence and limitations. Fake-MCP success does not establish live cross-cluster targeting. Mark Phase 2 complete only after the automated gate and live scope acceptance pass.

### Exit criteria

- Contexts come only from validated MCP enumeration on the application-owned connection.
- Startup precedence and invalid-selection behavior are deterministic.
- `--cluster`, `/cluster`, and operational `/context` work in the installed application.
- Selected cluster, namespace policy, read-only mode, and MCP availability are continuously visible.
- Every approved cluster-dependent request contains the authoritative explicit context.
- Model arguments, stale tool handlers, active-turn switches, and recovery cannot alter a call's target.
- Unbound, unavailable, and incompatible states produce no cluster-dependent requests.
- Kubernetes authentication/authorization failures remain distinct from transport and selection errors.
- Scope and tool exposure reconcile safely after MCP restart.
- No kubeconfig mutation, shell bypass, coding tools, write capability, or raw-response persistence is introduced.
- Automated checks and live scope acceptance pass with recorded evidence.

## 16. Suggested Pull Request Boundaries

| PR  | Slice | Review focus                                                 |
| --- | ----- | ------------------------------------------------------------ |
| 1   | 0–1   | Supported wire contracts, validation, and immutable registry |
| 2   | 2     | CLI and pure startup-resolution behavior                     |
| 3   | 3     | Application-owned state and startup coordination             |
| 4   | 4     | One explicit-context tool through the Pi agent loop          |
| 5   | 5     | User selection and concurrency protection                    |
| 6   | 6     | Operational command, persistent status, and model guidance   |
| 7   | 7     | Per-tool capability and read-only review                     |
| 8   | 8     | Recovery, generation isolation, and selection preservation   |
| 9   | 9     | Installed CLI, live targeting evidence, and phase acceptance |

Slices proceed in order. Slice 4 proves the bridge through test-owned tool definitions; Slices 5–6 can exercise switching and presentation with those fixtures. Production cluster-dependent tools remain hidden until scope enforcement, switching coordination, continuously visible status, and the Slice 7 capability review are all in place. Do not enable diagnostic tools without their enforcement path merely to make a slice runnable.

## 17. Risks and Phase 3 Handoff

| Risk                                                              | Required mitigation                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Actual context response differs from design examples              | Verify supported server fixtures before writing the adapter.                               |
| Server omits context discovery or explicit context support        | Report incompatibility; no implicit-current-context fallback.                              |
| Registry derives from truncated model output                      | Validate complete bounded raw enumeration separately.                                      |
| Model overrides cluster through arguments                         | Hide context in model schema, overwrite at execution, validate final arguments.            |
| Switch changes the target midway through an agent turn            | Guard active work in the application and capture immutable dispatch scope.                 |
| Recovery changes cluster or exposes stale handlers                | Revalidate retained selection intent and bind handlers to a connection generation.         |
| Bound context is mistaken for working Kubernetes auth             | Show selection and operation failures separately; claim access only from successful calls. |
| Same-cluster namespace contexts masquerade as cross-cluster proof | Use distinct cluster fixtures/markers for live targeting acceptance.                       |
| Context names or metadata inject terminal/prompt content          | Validate and sanitize display fields; never expose endpoint credentials.                   |

Phase 3 consumes immutable scope snapshots and scoped result metadata. It adds stable `Incident.scope`, evidence provenance, hypotheses, and investigation lifecycle without allowing historical incidents to change scope when `/cluster` changes. Phase 2 does not prebuild those services or reinterpret Pi conversation state as an incident.
