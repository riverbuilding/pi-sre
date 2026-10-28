# Pi SRE

Pi SRE is a read-only Kubernetes incident diagnosis application built on the Pi agent runtime and Kubernetes MCP Server. It is intentionally an independent TypeScript application, not a Pi package.

The implementation follows the architecture in [docs/DESIGN.md](docs/DESIGN.md). Phase 1 Slices 0–8 provide configuration validation, a Pi TUI, an isolated SRE resource boundary, a managed Kubernetes MCP connection, read-only tool discovery, model-facing context listing through MCP, bounded, redacted result normalization, deterministic startup/shutdown, and in-session MCP recovery.

Slice 9 completes the [Phase 1 acceptance gate and live smoke test](docs/PHASE1_ACCEPTANCE.md). Automated checks cover the packed CLI and fake MCP agent loop; the user confirmed completion of the manual live Kubernetes smoke test on 2026-10-07. Phase 1 is complete and ready for Phase 2 cluster-context management.

The [Phase 2 implementation slices](docs/PHASE2_IMPLEMENTATION_SLICES.md) cover context discovery, startup selection, explicit scope enforcement, cluster commands and status, MCP recovery, and live targeting acceptance. Slices 1–3 provide validated MCP enumeration, exact startup selection, and application-owned scope. Slice 4 enforces explicit context injection at the bridge. Slice 5 adds `/cluster`, safe idle switching, and persistent scope-change messages. Slice 6 adds `/cluster --status` and a continuous scope widget. Slice 7 enables reviewed pod, log, event, and namespace diagnostics when a compatible explicit cluster scope is bound. Slice 8 reconciles scope and tool availability during MCP recovery while retaining exact selection intent.

Slice 9 adds full-path routing acceptance and expanded packaged CLI checks. The [Phase 2 acceptance record and live runbook](docs/PHASE2_ACCEPTANCE.md) track the gate and operator-confirmed Slice 9 live acceptance. Slice 10 adds distinct operational command feedback. The operator confirmed the live tests, including the updated installed-package and terminal regression, passed on 2026-10-17. Phase 2 is complete. Phase 3 Slices 1–4b now implement rule state, startup resolution, CLI selection, explicit model routing, transactional MCP recovery, unified scope presentation, and bounded parallel execution with cancellable FIFO admission.

Slice 5 adds full-path acceptance and installed-package checks against two disposable read-only kind clusters. Automated and live routing checks passed, and the operator confirmed all manual terminal checks passed on 2026-10-20. Phase 3 is complete; see the [Phase 3 acceptance record](docs/PHASE3_ACCEPTANCE.md).

The completed milestone is [Phase 3 — Context Selection and Multi-Cluster Routing](docs/PHASE3_IMPLEMENTATION_SLICES.md), an explicit migration from the completed Phase 2 runtime. It delivers unified `/clusters`, default live `*`, exact sets, required model-supplied context on every diagnostic call, and deterministic reconnect reconciliation. It works with the current tools and one MCP server **without** an incident model or evidence store.

[Phase 4 — Investigation Domain](docs/PHASE4_IMPLEMENTATION_SLICES.md) has completed Slices 0–5: domain models, incident-owned evidence storage, investigation service, application controller/lifecycle, and automatic observation capture. An eligible first user question creates an incident after credential preflight when diagnostic scope is usable. Successful diagnostics commit bounded, redacted evidence before Pi receives an evidence ID. The incident retains its exact/all rule; idle `/clusters` changes the next investigation selection. Per-incident dispatch budgets are active. Inspection tools, hypothesis/conclusion commands and full-path Phase 4 acceptance remain Slices 6–7. Until Slice 6, use a new Pi session to start another investigation; there is no public incident replacement or conclusion command yet. State is process-owned and is lost on exit; reload and same-process session resume preserve retained state.

| Phase | Delivery                                                                              | Status      |
| ----- | ------------------------------------------------------------------------------------- | ----------- |
| 1     | Runtime and MCP integration                                                           | Complete    |
| 2     | Original singleton context management                                                 | Complete    |
| 3     | New context selection and multi-cluster routing                                       | Complete    |
| 4     | Investigation Domain                                                                  | In progress |
| 5     | All 22 Kubernetes MCP config/core definitions, including opt-in controlled operations | Planned     |
| 6     | Kubernetes Diagnostic Skills                                                          | Planned     |
| 7     | Eval Framework                                                                        | Planned     |
| 8     | TUI Refinement                                                                        | Planned     |

The [multi-cluster plan](docs/MULTI_CLUSTER_INVESTIGATION_PLAN.md) records accepted semantics and the staged handoff. Exact names stay fixed; live `*` follows validated inventory, with new members marked not checked. The model supplies a context even for singleton rules; the application validates it without injection/overwrite. [Phase 5](docs/PHASE5_IMPLEMENTATION_SLICES.md) and the [HolmesGPT capability comparison](docs/HOLMESGPT_KUBERNETES_MCP_PARITY.md) cover the separate tool-parity milestone.

The command/setup documentation below reflects **Phase 4 Slice 5**. Startup supports exact sets and default live `*`; diagnostic calls require one model-supplied exact context, including singleton rules. Pi executes independent MCP calls in parallel with one application-wide limit of four active calls and 32 FIFO waiters, shared across tools and contexts including model-driven enumeration. A fifth call waits; only a full queue returns `capacity-exceeded`. Queued calls expire after 30 seconds with `timeout`; the existing MCP timeout starts separately at dispatch. The unified `/clusters` command and staged multi-selection picker are implemented. Recovery keeps dispatch blocked until matching tools, inventory, rule resolution, and bounded added/removed/changed notices reach the UI and model. The widget and model snapshots show rule/source, bounded membership, availability, namespace policy, and revisions; `/clusters --status` provides full membership inspection. Historical Phase 1/2 acceptance records remain unchanged.

## Prerequisites

- Node.js 22.19.0 or later
- A Kubernetes MCP Server executable available as `kubernetes-mcp-server`
- Kubernetes credentials with read-only RBAC

## Setup

```bash
npm install
mkdir -p ~/.pi-sre
cp config/pi-sre.example.yaml ~/.pi-sre/config.yaml
cp config/kubernetes-mcp.example.toml ~/.pi-sre/kubernetes-mcp.toml
```

Review the copied configuration before use. The MCP server configuration and Kubernetes RBAC must both remain read-only.
Pi SRE requires `read_only = true` in the MCP TOML and launches the server with `--config ~/.pi-sre/kubernetes-mcp.toml`.

## Application Home

Pi SRE stores its configuration and persisted runtime state in one application-owned directory:

```text
~/.pi-sre/
├── config.yaml
├── kubernetes-mcp.toml
├── auth.json
├── models.json
├── settings.json
├── sessions/
└── logs/
```

The runtime uses this directory for model credentials, model metadata, settings, and sessions. Pi may create additional runtime files there. It reuses Pi's runtime and provider integration without reading from or writing to Pi Coding Agent's default storage.

The configuration loader uses `~/.pi-sre/config.yaml` by default. `PI_SRE_HOME` changes the application root; `PI_SRE_CONFIG` selects another YAML file; and `PI_SRE_MCP_COMMAND` overrides the MCP executable. Relative paths in YAML resolve from that YAML file's directory. The loader requires a readable MCP TOML file with `read_only = true` and stdio transport, then appends `--config <absolute path>` to the server command.

## Commands

```bash
npm run check
npm run lint
npm run format:check
npm test
npm run test:e2e
npm run build
npm run dev -- --help
npm run dev
```

The built executable is `dist/main.js`; `npm link` also makes `pi-sre` available on your PATH. The current runtime opens Pi's TUI with no coding-agent tools or shell execution. It uses a Pi SRE system prompt and does not load project instructions, extensions, skills, or prompt templates. It starts and health-checks the configured Kubernetes MCP process, discovers tools, and registers approved read-only tools before opening the TUI. Ask **“List configured Kubernetes contexts”** to invoke `configuration_contexts_list` through the agent loop. The tool does not access a cluster. With available permitted contexts and compatible server descriptors, the agent can also use `pods_list`, `pods_get`, `pods_log`, `events_list`, and `namespaces_list`. A diagnostic tool is available when an open incident is bound and at least one permitted target satisfies its discovered context schema. Discovery remains available without an incident. Every call requires and preserves one exact model-supplied context; missing, excluded, unavailable, or incompatible targets are refused before MCP dispatch. Successful diagnostic results carry evidence/execution/incident IDs, completion time, exact context, scope/selection/inventory revisions, and connection generation. Pod logs default to 100 lines and accept only 1–1,000 lines per call; streaming is disabled. Namespace omission uses server/context policy and does not establish all-namespace coverage. See the [tool policy and discovered schemas](docs/MCP_TOOL_SCHEMAS.md#diagnostic-surface).

`npm pack` builds the executable before producing an installable archive. `npm run test:e2e` verifies the extracted package offline using the checkout's locked dependencies. The acceptance runbook covers installing the archive and exercising its npm-linked `pi-sre` command in a terminal.

### Manual `/clusters` test with the fixture MCP server

After `npm install`, run:

```bash
npm run manual:clusters
```

This builds and packs the project, extracts the archive into a temporary directory, reuses the checkout's `node_modules`, writes an isolated read-only config, and launches the packaged TUI outside the checkout. The packaged fixture MCP server supplies synthetic `alpha` and `beta` contexts and diagnostic responses; no Kubernetes server or kubeconfig is needed. Existing application config and MCP command overrides are replaced for this launch. Keep the checkout and its dependencies available while using the fixture.

Try `/clusters --status` to inspect membership, select a row to show its complete name, and close with **Close status** or Escape. Then try `/clusters` to toggle names and **Apply selection** or **Cancel**. Test `/clusters alpha`, `/clusters beta`, `/clusters --all`, and `/mcp_restart --force`. Startup uses `kubernetes.contexts: ["*"]`. The first eligible question captures the selected rule for its incident. Later selections apply to the next investigation; start a new Pi session to use a different rule before Slice 6 commands land. Both contexts can be queried when permitted by that incident; each model call must supply `alpha` or `beta` explicitly. An unknown name such as `/clusters missing` must preserve the previous selection. These commands work without model credentials. Use `/login` in this isolated application home to test model-driven fixture queries, such as “List pods”; their responses contain synthetic context/tool markers.

The script prints its retained workspace, config, fixture call log (`app/fixture.pid.calls`), and a `launch.sh` command for returning to the same test home. Call records append across MCP restarts. Quit with `/quit`; remove the printed workspace when finished. `npm run manual:clusters -- --prepare-only` prepares the same package/config without opening the TUI. Pass startup arguments to the generated launcher, for example `launch.sh --clusters alpha`, to test CLI precedence.

To test context-viewer pagination with 45 synthetic contexts (`context-001` through `context-045`), run:

```bash
npm run manual:contexts
```

In the TUI, run `/clusters --status`. Expect three pages containing 20, 20, and 5 names. Test **Next page**, **Previous page**, individual-name inspection, and Escape or **Close status**. Then run `/clusters context-001` and reopen status to see the remaining contexts labeled outside the exact selection; `/clusters --all` restores live all. This uses the same isolated packaged fixture setup and requires no model login or Kubernetes access. `npm run manual:contexts -- --prepare-only` prepares it without opening the TUI.

`npm run test:contracts` compares Kubernetes MCP Server 0.0.67 against the checked-in Phase 2 contract snapshot using static synthetic kubeconfigs and local mock endpoints. It requires `kubernetes-mcp-server` on PATH. This is a historical snapshot probe, not a runtime version requirement. Regular tests skip this executable-dependent suite; see [the contract record](docs/PHASE2_CONTRACTS.md) for an alternate executable path.

If MCP startup or inventory discovery fails, the TUI opens with a warning and no Kubernetes tools. An incompatible individual tool is excluded without disabling unrelated compatible tools; failed context enumeration blocks diagnostic access. Repair the configuration and run `/mcp_restart` to retry within the same conversation. A healthy connection with a validated registry is left running; an enumeration failure can be retried with `/mcp_restart`; `/mcp_restart --force` cancels active MCP calls and replaces it. Unknown arguments show usage. Each retry rereads the YAML and read-only TOML configuration; application home and session path changes require a full `pi-sre` restart. Connecting, ready tool counts, and safe failure diagnostics appear in the TUI. Connection drops and failed retries hide MCP tools until recovery.

`pi-sre --clusters prod-us prod-eu` requests an exact set; `pi-sre --clusters '*'` explicitly requests live all-contexts. Quote `'*'` to prevent shell expansion. `--clusters=<name>` accepts one exact name, including a name beginning with `-`; values following the equals form are not additional members. The flag occurs once. Names retain whitespace and case, and pattern-like names are literal identities. Empty, unsafe, oversized, duplicate, conflicting wildcard/set, legacy `--cluster`/`--all-clusters`, and unknown arguments fail before startup. Sets have at most 1,024 names. `--help` and `-h` skip configuration/MCP startup but still validate other arguments.

Startup precedence is CLI rule > explicitly configured `kubernetes.contexts` exact/all rule > live `*`. MCP default metadata never narrows selection, even with one context. `contexts: ["*"]` means live all, matching the CLI; a literal context named `*` remains selectable through the picker. An unknown explicit selection blocks diagnostics atomically without fallback. Empty or failed inventory retains rule intent. Availability records inventory membership, not authentication, authorization, or health.

Configuration supports the same choices and validation as CLI values:

```yaml
kubernetes:
  contexts: [prod-us, prod-eu] # Exact set; use [prod-us] for one context
  # contexts: ["*"]          # Live all; also the default when omitted
```

The configuration field must be a nonempty list of at most 1,024 valid names. Duplicates and mixed wildcard/exact values are rejected. CLI replaces the configured rule entirely. The former `kubernetes.clusters` key is rejected; rename it to `kubernetes.contexts`. The previous `defaultCluster` field is removed; replace `defaultCluster: staging` with `contexts: [staging]`. Invalid configuration structure still fails loading before MCP startup.

Recovery re-enumerates contexts against the unchanged incident rule and the next selection independently. An unavailable next selection does not block a usable incident. Exact sets never expand: an initially invalid set remains blocked until all members validate; after validation, removed members become unavailable and remaining members stay permitted. Live `*` follows successful discovery, including empty inventories. Selection and inventory have separate revisions. Discovery failure blocks diagnostics while retaining the last successful inventory for inspection. Recovery reloads transport configuration but never reinterprets `contexts`, including after initial startup failure. A new configuration choice requires a new launch or explicit selection. Captured handlers cannot use a replacement connection, and stale results are withheld. Dispatch remains blocked through tool and scope publication, including calls attempted from publication listeners. The widget and persistent model scope snapshot include bounded added/removed/changed context notices without endpoint metadata. New live-wildcard members are not checked; exact selection never grants permission to unselected additions. Interrupted calls are not replayed.

Use `/clusters` to open the staged multi-selection picker. Toggle context names with Space or Enter; the cursor stays on the toggled row. Choose **All (\*)** for live all. **Apply selection** and **Cancel** appear as buttons below the context choices; Tab moves to the buttons, and Left/Right switches between them. Choose **Apply selection** to commit the entire draft once. **Cancel** or Escape discards the draft. An empty exact draft cannot apply. `/clusters <exact-name>` selects one opaque name directly; `/clusters --all` selects live all; `/clusters --status` inspects without mutation. There is no `/cluster` alias. Selection uses the current validated MCP registry and changes application state only. While an incident is open it changes the next investigation selection; status and the widget show the effective incident rule and a distinct next choice. Names are exact, without trimming or case folding; cancellation or an invalid name preserves the existing selection. Wait for or cancel active agent work before switching. A picker opened before a restart, another selection, extension/session replacement, or work that starts and ends cannot commit a stale choice. Switching preserves the conversation and MCP process. Fixed scope rules live in the stable system prompt; an initial scope snapshot and subsequent scope/availability changes are recorded as persistent application messages. Unchanged state adds no messages per model request, preserving the existing request prefix. New sessions receive the current snapshot, reloads deduplicate it, and a turn-start hook restores it if compaction or navigation removed it. The application and tool bridge enforce cluster targeting independently of these informational messages. `/clusters --status` reports rule/source, available and unavailable selected counts, selection/inventory/connection revisions, registry, and MCP availability without changing selection, even during active work or outages. In the TUI it also opens a read-only membership view with 20 names per page, **Next page**, **Previous page**, and **Close status**. Select a name to show its complete identity and availability in a notification; Escape closes. Outside-selection inventory names are labeled separately. During outages, retained inventory is labeled as last successful inventory and grants no dispatch authority. Refresh or session replacement invalidates an open status view. A wrapping widget below the editor continuously displays READ ONLY, rule/source, bounded available/unavailable member previews, namespace policy, revisions, and MCP/registry status. READ ONLY occupies its own line so long context names cannot truncate it. Namespace `*` means no application-level namespace restriction; it does not imply every tool queries all namespaces. Endpoint metadata is omitted. Automatic model scope snapshots are at most 8,000 characters, with at most eight complete names per category and omitted counts; names are never truncated into different identities. Phase 3 Slice 5 owns installed-terminal and disposable-cluster acceptance; the [Phase 2 terminal runbook](docs/PHASE2_LIVE_TEST_COMMANDS.md) remains historical.

`/clusters`, `/clusters --status`, and `/mcp_restart` feedback includes local time (`HH:MM:SS`) and a session invocation number, for example `[12:34:01 #7] /mcp_restart: MCP already healthy; existing connection retained.` Repeated commands receive new numbers even within one second. Picker/restart progress and its outcome share a number. Concurrent retries report joining existing work; restart completion distinguishes ready transport from registry or selection errors. Numbers survive extension reloads and reset with a new Pi session. Feedback uses Pi notifications above the editor; consecutive informational notifications replace the prior status, with the new time/number identifying the latest invocation. It adds no model messages or Kubernetes calls.

Startup and active MCP operations are cancellable. On shutdown, Pi SRE aborts work, disposes the Pi runtime, closes the managed MCP child, and stops the TUI. Quit and process signals share an idempotent cleanup path; runtime and terminal startup failures also release acquired resources.

## MCP Trust and Policy

Pi SRE trusts the MCP server you configure. It exposes only allowlisted diagnostic operations, validates model arguments against discovered server schemas and the effective incident rule, preserves the supplied exact context, and enforces application limits. It does not require exact schema snapshots or read-only/destructive annotations. Added arguments and changed output declarations on approved tools do not require Pi SRE schema changes; new tool names still require approval in the allowlist. Cluster-dependent tools must expose an explicit context parameter compatible with the selection.

Diagnostic data is rendered without Kubernetes resource-schema validation. Responses that populate application state, such as the context registry, are parsed only for the fields and consistency needed to operate Pi SRE. Read-only server configuration, read-only RBAC, redaction, and result budgets continue to apply.

## MCP Results

The bridge prefers valid JSON `structuredContent`, otherwise it renders text, embedded resource text, resource links, and image metadata. Image and resource binary payloads are omitted with a visible notice; links are never fetched. Unsupported or malformed content fails closed. Empty successful results remain successful. MCP errors and call failures carry distinct categories for unavailable transport, authentication, authorization, invalid arguments, timeout, or tool execution failure. Caller cancellation still aborts the operation. Pi aborts and settles agent work before conversation replacement; interactive reload requires idle work. MCP reconnect cancels outstanding calls and invalidates old-generation handlers and results. All registered MCP tools use Pi’s parallel execution mode with the shared four-active/32-waiting limit. Waiting calls retain their exact supplied arguments and authority revisions; cancellation removes them promptly. Before dispatch, the bridge checks incident/session authority, scope, availability, connection generation, revisions, cancellation, and the publication gate. It admits a lease through the shared queue and spends one diagnostic attempt immediately before transport. Queued work holds an idle-selection guard but spends no diagnostic attempt. Inventory enumeration does not consume the incident diagnostic budget or create evidence. Transport loss, reconnect, and shutdown settle invalidated waiters without replay. Slots and snapshots remain held through normalization and release on every exit. These concurrency bounds are application constants. `investigation.maxToolCalls` now limits dispatched diagnostic attempts per incident; failures remain spent and reconnect does not reset the budget.

Configure `results.maxTextChars` (default 8,000, range 256–64,000) and `results.maxItems` (default 50, range 1–1,000) in YAML. For incident diagnostics, the character budget covers the serialized result envelope, including evidence IDs, exact provenance and `[Result truncated]`. If the required envelope cannot fit, dispatch is refused. Additional truncation is reflected in both the stored excerpt and returned metadata. The item budget covers content blocks, or all nested structured fields and array entries combined. Structured nesting beyond 32 levels is also visibly truncated. Reduced JSON may be cut at the character limit; truncated results are partial observations, not complete JSON documents.

Known credential patterns and structured credential fields are redacted before results enter the model context or Pi transcript. Error payloads are replaced with safe category messages. Process diagnostics use the same redactor; truncated stderr tails are withheld to avoid exposing credential fragments. Pattern redaction does not identify arbitrary sensitive application data.

`results.rawRetention` is fixed to `disabled`: raw MCP results have no retained artifact, retention budget, or lifetime after normalization (zero bytes retained for zero time). Pi receives only bounded text and safe status details. Every successful incident diagnostic observation, including empty results, is committed to its incident-owned EvidenceStore before publication. The stored excerpt exactly matches the returned observation excerpt. Each incident has 1,000 evidence records and 8 MiB of retained UTF-8 content; actual completion-time capacity refusal creates no evidence or successful publication, while the attempt stays spent. Failed, cancelled, stale and malformed results create safe outcomes rather than facts. Archival exists only as an explicit service API for concluded investigations; production archive UI and cross-process restoration are not available.

## Layout

The [MCP tool policy and schemas](docs/MCP_TOOL_SCHEMAS.md) describes the trusted-server boundary, capability allowlist, discovered argument schemas, application-state parsing, and diagnostic limits.

The [session projection and transcript context guide](docs/SESSION_PROJECTION_AND_TRANSCRIPT_CONTEXT.md) explains how persisted Pi messages become model request context, including cluster scope messages.

- `src/` — application, runtime, MCP bridge, cluster state, domain, configuration, and TUI modules
- `skills/` — reusable Kubernetes diagnostic skills
- `tests/` — unit, integration, and end-to-end test suites
- `evals/` — kind-based diagnosis evaluation framework and cases
- `config/` — safe, versioned configuration templates
