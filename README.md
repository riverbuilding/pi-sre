# Pi SRE

Pi SRE is an independent TypeScript application for Kubernetes diagnosis, read-only by default, built on the Pi agent runtime and Kubernetes MCP Server. Pi owns the conversation and terminal UI; Pi SRE owns context selection, execution limits, cancellation, MCP lifecycle, and bounded, redacted results with explicit provenance.

[Investigation/context simplification Slices 0–6](docs/INVESTIGATION_CONTEXT_SIMPLIFICATION_IMPLEMENTATION_SLICES.md) are implemented. Production uses Pi messages and request execution controls. Ask a question, query permitted contexts, revise the explanation through follow-up messages, and report directly. There is no Incident prerequisite, independent EvidenceStore, hypothesis object, conclusion tool, or structured investigation archive. `/incident`, `/evidence` and the five local investigation tools have been removed. Compaction is lossy; missing facts or provenance may require fresh queries.

[Slice 7 acceptance](docs/INVESTIGATION_CONTEXT_SIMPLIFICATION_ACCEPTANCE.md) records passing offline, extracted-package/TTY, real-server contract and disposable kind checks. Visual terminal acceptance remains pending. Pi entry-point restrictions are a [separate delivery gap](docs/TUI_COMMAND_VISIBILITY_AND_RESTRICTIONS.md): session selectors, history navigation, reload, shortcuts and programmatic paths are not comprehensively blocked. The application initializes one Session and its extensions once and provides no switch/reload recovery. Restart the application for a fresh session or extension changes.

Historical milestones remain recorded: [Phase 1](docs/PHASE1_ACCEPTANCE.md) live confirmation on 2026-10-07, [Phase 2](docs/PHASE2_ACCEPTANCE.md) installed/terminal confirmation on 2026-10-17, and [Phase 3](docs/PHASE3_ACCEPTANCE.md) automated/live checks and manual terminal confirmation on 2026-10-20. [Phase 4](docs/PHASE4_ACCEPTANCE.md) automated and installed/live checks passed, with visual terminal acceptance still pending as recorded then. Its domain-based runtime has now been superseded; these records do not establish acceptance of the new pipeline. [Phase 5 tool parity and controlled operations](docs/PHASE5_IMPLEMENTATION_SLICES.md), diagnostic skills, evals and further TUI refinement remain separate work. No write capabilities or autonomous remediation are enabled.

## Setup

Requires Node.js 22.19.0 or later, a `kubernetes-mcp-server` executable, and Kubernetes credentials with read-only RBAC.

```bash
npm install
mkdir -p ~/.pi-sre
cp config/pi-sre.example.yaml ~/.pi-sre/config.yaml
cp config/kubernetes-mcp.example.toml ~/.pi-sre/kubernetes-mcp.toml
```

Review both files. The default profile requires `read_only = true` and stdio transport in the MCP TOML, and appends `--config <absolute path>` when launching the server. The application allowlist, server configuration and Kubernetes RBAC all enforce the read-only boundary.

The application home contains `config.yaml`, `kubernetes-mcp.toml`, Pi `auth.json`, `models.json`, `settings.json`, `sessions/`, and `logs/`. It is the runtime context; the repository working directory is not operational scope. Pi's default coding-agent storage and project instructions/extensions/skills/templates are excluded. Generic shell and coding tools are unavailable.

`PI_SRE_HOME` changes the home (default `~/.pi-sre`); `PI_SRE_CONFIG` selects the YAML; `PI_SRE_MCP_COMMAND` overrides the executable. Relative paths resolve from the YAML directory. Model credentials and sessions stay under the application home.

## Configuration and request limits

```yaml
kubernetes:
  # Omit contexts for live all. CLI overrides this explicit choice.
  contexts: [prod-us, prod-eu]
  # contexts: ["*"]
  mcp:
    transport: stdio
    command: kubernetes-mcp-server
    args: []
    configFile: kubernetes-mcp.toml
    startupTimeoutMs: 15000
    toolCallTimeoutMs: 30000
execution:
  maxToolCalls: 40
  maxModelIterations: 80
safety:
  mode: read-only
results:
  maxTextChars: 8000
  maxItems: 50
  rawRetention: disabled
```

Phase 5 Slice 4 also accepts the explicit startup profile `safety.mode: controlled-operations`.
Use the separate [application YAML](config/pi-sre.controlled.example.yaml) and
[MCP TOML](config/kubernetes-mcp.controlled.example.toml) after reviewing configuration
and credentials. The matching TOML must explicitly set `read_only = false`; a mismatch
or missing setting is refused. CLI arguments cannot override `read_only`. No files or
RBAC are rewritten. Safety profile and policy changes require a process restart.
The widget, call renderer and result provenance show
`CONTROLLED OPERATIONS — APPROVAL REQUIRED`, including during diagnostic reads.

`safety.controlledOperations` accepts only `enabledTools` (a reviewed subset of the five
controlled names, default `[]`), `approvalTimeoutMs` (default/max 60,000), `callTimeoutMs`
(default 30,000, max 60,000), and `maxOperationsPerRequest` (default 1, range 1–10).
Timeouts must be positive integers. Controlled-only settings are rejected in read-only
mode. **All controlled tools remain disabled in Slice 4**, including when listed in
`enabledTools`; discovery reports enabled candidates as deferred. Slice 5 owns operation
policy, sensitive message boundaries and capability enablement. Exec is unsupported in
every profile. Approval infrastructure tests use synthetic policy and transport; no live
operation or visual approval acceptance is claimed.

Migrate `investigation.maxToolCalls` to `execution.maxToolCalls`; delete `investigation` and `defaultTimeRange`. Old fields are rejected, with no compatibility aliases. Execution limits default to 40 dispatches (range 1–1,000) and 80 model iterations (range 1–2,000).

Every user message receives an independent request identity and complete allowance when processing actually begins, including user steering and follow-up. Both queues are fixed to one-at-a-time. Commands and consumed input do not create requests. Tool loops, retries, compaction, continuation, application environment messages and MCP recovery retain the current allowance. Actual MCP dispatch consumes a tool allowance synchronously; dispatched failures, timeout and cancellation are not refunded. Pre-dispatch refusal is free. Model iterations have an independent enforced ceiling, including invalid-tool and exhausted-dispatch loops.

Independent tools run in parallel through one shared limit of four active calls and 32 FIFO waiters. Queued calls expire after 30 seconds; MCP timeout begins separately at dispatch. Normal completion settles accepted calls. Cancellation prevents queued dispatch, attempts active abort, and returns matching error/cancelled outcomes; late success cannot enter a later request.

## Commands and context selection

```bash
npm run dev
npm run dev -- --clusters prod-us prod-eu
npm run dev -- --clusters '*'
npm run dev -- --help
```

`npm run build` creates `dist/main.js`; `npm link` exposes `pi-sre` on PATH. Help skips configuration and MCP startup but still validates arguments.

Startup precedence is CLI `--clusters` > explicit `kubernetes.contexts` > live `*`. MCP default metadata never narrows selection. `--clusters=<name>` accepts one exact name, including a leading `-`; the flag occurs once. Names are opaque and preserve whitespace and case; patterns are not expanded. Exact sets contain 1–1,024 unique safe names. `'*'` must be the sole value and should be quoted against shell expansion. Unknown explicit startup names block diagnostics without fallback. The removed `defaultCluster`, `kubernetes.clusters`, `--cluster` and `--all-clusters` forms are rejected.

| TUI command              | Behavior                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `/clusters`              | Stage exact names or All (*), then Apply selection; Cancel/Escape discards the draft |
| `/clusters <exact-name>` | Select one exact context                                                             |
| `/clusters --all`        | Select live all                                                                      |
| `/clusters --status`     | Show complete current selected availability                                          |
| `/mcp_restart`           | Recover unavailable MCP; retain a healthy connection                                 |
| `/mcp_restart --force`   | Cancel old calls and replace even a healthy connection                               |

Selection can change during active work. It affects only newly accepted calls. Acceptance synchronously validates parameters, current selection, explicit context, capability and availability, then fixes original request/call identity, arguments and connection before queueing. A call already accepted for A keeps A after the user selects B; a later A call is refused. Dispatch still checks original connection/tool/target, request cancellation and limits. Context is never inferred, injected, overwritten, or routed through a global current context.

Exact selections retain disappeared members as **unavailable selected**; executable targets are selected ∩ available. Returning names become candidates again; new unselected names remain excluded. Live all follows validated inventory discovered at startup/recovery. Inventory membership does not establish authentication, authorization, cluster health or inspection.

The wrapping widget continuously displays the actual startup profile (READ ONLY by default), current all/exact selection, available targets, unavailable selected names, MCP state and namespace policy. Call UI shows the complete safe requested context. Environment messages describe selection, inventory/target changes and MCP changes without endpoints or credentials. Identical refreshes/default-metadata changes are deduplicated. Idle updates append messages without starting the model; active updates use custom steering and do not allocate a user request. Before every model request, a context hook restores a missing/outdated environment snapshot, including after automatic compaction directly retries. It never reconstructs authority from history.

## MCP recovery and tools

Startup attempts a connection; failures open the TUI with diagnostics closed. Repair configuration and use `/mcp_restart`. Replacement rereads and validates YAML and profile-matched TOML, withdraws tools and blocks dispatch, cancels/settles old calls, closes the old connection, discovers tools/schema/contexts, publishes tools/environment/notices, then opens dispatch. Failure stays closed. There is no background reconnect. Recovery retains current selection and does not reset budgets, rebuild extensions, replay calls, or wake an idle model. Execution/result limits and application paths require an application restart to change.

Approved operations are `configuration_contexts_list`, `configuration_view`, `pods_list`, `pods_list_in_namespace`, `pods_get`, `pods_log`, `pods_top`, `events_list`, `namespaces_list`, `nodes_log`, `nodes_stats_summary`, `nodes_top`, `resources_list`, `resources_get`, and conditional `projects_list`, subject to discovered compatible schemas and per-target API availability. Every cluster-dependent call requires one exact model-supplied context, even with a singleton selection. Pod and node logs default to 100 lines and permit 1–1,000; streaming is disabled. Node log queries permit a single service name, excluding file paths. Namespace omission uses server/context policy, never a promise of all-namespace coverage. Model-driven enumeration shares the request dispatch budget; lifecycle discovery alone is uncharged and cannot serve model queries.

Generic reads enforce `safety.resources.allowedReadKinds` before transport, including direct admission. The default is the 19 reviewed canonical GVK pairs in [Phase 5 contracts](docs/PHASE5_CONTRACTS.md); configuration may narrow this list, including `[]`. Secret, List, aliases, subresources and unreviewed kinds are denied. Resource policy changes require application restart. Resource results structurally withhold arbitrary annotations, literal environment values and data before ordinary redaction/bounding; ConfigMaps expose metadata and key counts only. Malformed presentation fails safely rather than forwarding raw output.

Update existing MCP TOML files to use `list_output = "yaml"` and the `denied_resources` Secret rule from the versioned template, with read-only RBAC excluding sensitive resources. Table output cannot satisfy safe generic resource presentation. `read_only = true` alone permits Secret access. The template enables experimental compatibility filtering: platform/metrics tools are advertised when any target supports them; individual targets can still report unsupported APIs, missing Metrics Server, kubelet access or RBAC errors. Controlled operations and Exec remain unavailable.

`configuration_view` returns only context/cluster names, context namespaces and sanitized endpoint origins. Authentication fields, paths, extensions and raw kubeconfig are structurally withheld before publication. The server defaults `minified` to true, referring to its default context rather than the current user selection. Full metadata may mention unselected contexts without authorizing calls to them. Neither model-driven configuration tool changes selection or installs authoritative inventory; application startup/reconnect alone refreshes inventory. Remove `configuration_view` from an existing TOML `disabled_tools` list to enable safe inspection.

Pi SRE trusts the configured server. It consumes discovered input schemas, not exact local snapshots, mandatory annotations or Kubernetes diagnostic response schemas. Only fields needed to construct application state (notably context inventory) are parsed for consistency. [Tool policy and schemas](docs/MCP_TOOL_SCHEMAS.md) describe this boundary.

## Results and conversation history

The model-visible `content` includes exact context, operation, namespace or omission policy, the actual execution profile, execution status and truncation. Dispatched calls include client dispatch/settlement times, which are not Kubernetes object observation times. Undispatched refusals have no query time. Empty success, tool failure, transport failure, authentication/authorization failure, timeout and cancellation remain distinct. Same-named resources retain their original context and time after selection or target changes.

`results.maxTextChars` (256–64,000) limits each tool call's normalized result body, including any truncation notice, independently of other calls. The limit is applied during normalization; source metadata, details and JSON wrapping are excluded. Presentation preserves the complete safe source identity without further truncation or size checks. This is a JavaScript string-length limit, not a transport byte or token limit. `results.maxItems` (1–1,000) bounds content blocks or nested structured fields/array entries; structured nesting beyond 32 is truncated. Binary payloads are omitted; links are not fetched. Known credential fields/patterns are redacted, error payloads replaced with safe categories, and truncated stderr tails withheld. Arbitrary sensitive application data cannot all be identified by pattern redaction.

Raw retention is fixed to `disabled`. There are no raw files, independent evidence IDs, storage quotas, archive/import API or truncated-content retrieval. Pi persists bounded tool results and reasoning as messages. Its compaction can lose facts or provenance and is not a domain audit trail. The model should explain gaps and query again when needed; historical context names may now refer to changed targets. See [projection and model context](docs/SESSION_PROJECTION_AND_TRANSCRIPT_CONTEXT.md).

Quit and process signals share idempotent cleanup: abort work, release execution subscriptions and Pi session, close MCP, then stop the TUI. Startup and terminal failures also clean up acquired resources.

## Development and verification

Run `npm run verify` before committing or pushing, including documentation-only changes. It runs formatting, lint, TypeScript, tests and build. Use `npm run format` for formatting failures and review its diff.

```bash
npm run verify
npm run check
npm run lint
npm test
npm run test:e2e
npm run build
```

Builds clear stale `dist` output so removed domain modules are not packed. `npm pack` runs the build; the automated package test extracts it outside the checkout and reuses locked dependencies offline. The package test also reruns the production application lifecycle suite against extracted dist modules, with terminal/provider I/O replaced. Actual TTY and live checks are recorded separately in the Slice 7 acceptance document.

`npm run manual:clusters` prepares an isolated packed fixture TUI with synthetic alpha/beta contexts. Try the commands above, direct diagnostic questions, follow-up queries and active selection changes. No Kubernetes access is needed; commands need no model login. Use `npm run manual:clusters -- --offline-model` for a local deterministic model and delayed MCP responses suitable for Escape cancellation; no login is needed. Ordinary fixture mode can use `/login` for model-driven queries. `npm run manual:contexts` supplies 45 contexts for full status/name inspection. Both support `-- --prepare-only`, print a retained workspace, fixture call log and relaunch script, and replace inherited app/MCP config for the fixture. Keep the checkout dependencies available and remove the printed workspace when finished.

`npm run test:contracts` is an opt-in probe of Kubernetes MCP Server 0.0.67 against the historical [Phase 2 snapshot](docs/PHASE2_CONTRACTS.md). It requires the executable and is not a runtime version pin or proof of new live acceptance. Normal tests use deterministic MCP fixtures. The opt-in `evals/slice7-live.test.ts` requires `PI_SRE_SLICE7_KUBECONFIG` pointing to the explicitly named disposable kind context; setup and cleanup commands are in the Slice 7 acceptance record.

## Layout

- `src/app/` — application and MCP lifecycle composition
- `src/runtime/` — Pi integration, request adapter, prompt and environment guidance
- `src/execution/` — request/call limits, identity, admission and cancellation
- `src/cluster/` — inventory, current selection and shared queue
- `src/mcp/` — transport, discovery, unified bridge, redaction and normalization
- `src/config/`, `config/` — validation and safe templates
- `src/tui/` — current selection, environment widget and recovery command
- `tests/`, `evals/`, `skills/` — tests, evaluation scaffolding and diagnostic knowledge
