# Pi SRE

Pi SRE is a read-only Kubernetes incident diagnosis application built on the Pi agent runtime and Kubernetes MCP Server. It is intentionally an independent TypeScript application, not a Pi package.

The implementation follows the architecture in [docs/DESIGN.md](docs/DESIGN.md). Phase 1 Slices 0–8 provide configuration validation, a Pi TUI, an isolated SRE resource boundary, a managed Kubernetes MCP connection, read-only tool discovery, model-facing context listing through MCP, bounded, redacted result normalization, deterministic startup/shutdown, and in-session MCP recovery.

Slice 9 completes the [Phase 1 acceptance gate and live smoke test](docs/PHASE1_ACCEPTANCE.md). Automated checks cover the packed CLI and fake MCP agent loop; the user confirmed completion of the manual live Kubernetes smoke test on 2026-10-07. Phase 1 is complete and ready for Phase 2 cluster-context management.

The [Phase 2 implementation slices](docs/PHASE2_IMPLEMENTATION_SLICES.md) cover context discovery, startup selection, explicit scope enforcement, cluster commands and status, MCP recovery, and live targeting acceptance. Slices 1–3 provide validated MCP enumeration, exact startup selection, and application-owned scope. Slice 4 enforces explicit context injection at the bridge. Slice 5 adds `/cluster`, safe idle switching, and persistent scope-change messages. Slice 6 adds `/cluster --status` and a continuous scope widget. Slice 7 enables reviewed pod, log, event, and namespace diagnostics when a compatible explicit cluster scope is bound. Slice 8 reconciles scope and tool availability during MCP recovery while retaining exact selection intent.

Slice 9 adds full-path routing acceptance and expanded packaged CLI checks. The [Phase 2 acceptance record and live runbook](docs/PHASE2_ACCEPTANCE.md) track the gate and operator-confirmed Slice 9 live acceptance. Slice 10 adds distinct operational command feedback. The operator confirmed the live tests, including the updated installed-package and terminal regression, passed on 2026-10-17. Phase 2 is complete; new Phase 3 context selection is the next implementation step.

The next milestone is [Phase 3 — Context Selection and Multi-Cluster Routing](docs/PHASE3_IMPLEMENTATION_SLICES.md), an explicit migration from the completed Phase 2 runtime. It delivers unified `/clusters`, default live `*`, exact sets, required model-supplied context on every diagnostic call, and deterministic reconnect reconciliation. It works with the current tools and one MCP server **without** an incident model or evidence store.

[Phase 4 — Investigation Domain](docs/PHASE4_IMPLEMENTATION_SLICES.md) then adds incidents, evidence storage, hypotheses, and per-incident budgets on the accepted Phase 3 execution seam. Before incidents exist, idle `/clusters` changes session selection immediately. In Phase 4, an active incident keeps its own rule and selection applies to the next incident.

| Phase | Delivery                                                                              | Status                       |
| ----- | ------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | Runtime and MCP integration                                                           | Complete                     |
| 2     | Original singleton context management                                                 | Complete                     |
| 3     | New context selection and multi-cluster routing                                       | Planned; next implementation |
| 4     | Investigation Domain                                                                  | Planned                      |
| 5     | All 22 Kubernetes MCP config/core definitions, including opt-in controlled operations | Planned                      |
| 6     | Kubernetes Diagnostic Skills                                                          | Planned                      |
| 7     | Eval Framework                                                                        | Planned                      |
| 8     | TUI Refinement                                                                        | Planned                      |

The [multi-cluster plan](docs/MULTI_CLUSTER_INVESTIGATION_PLAN.md) records accepted semantics and the staged handoff. Exact names stay fixed; live `*` follows validated inventory, with new members marked not checked. The model supplies a context even for singleton rules; the application validates it without injection/overwrite. [Phase 5](docs/PHASE5_IMPLEMENTATION_SLICES.md) and the [HolmesGPT capability comparison](docs/HOLMESGPT_KUBERNETES_MCP_PARITY.md) cover the separate tool-parity milestone.

The command/setup documentation below describes the **currently implemented Phase 2 package**. Repeated `--cluster`, `--all-clusters`, unified `/clusters`, default live `*`, and model-supplied routing are Phase 3 targets, not runnable behavior yet. Completed Phase 1/2 acceptance records are preserved; no runtime code changes accompany this roadmap update.

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

The built executable is `dist/main.js`; `npm link` also makes `pi-sre` available on your PATH. The current runtime opens Pi's TUI with no coding-agent tools or shell execution. It uses a Pi SRE system prompt and does not load project instructions, extensions, skills, or prompt templates. It starts and health-checks the configured Kubernetes MCP process, discovers tools, and registers approved read-only tools before opening the TUI. Ask **“List configured Kubernetes contexts”** to invoke `configuration_contexts_list` through the agent loop. The tool does not access a cluster. With a selected context and compatible server descriptors, the agent can also use `pods_list`, `pods_get`, `pods_log`, `events_list`, and `namespaces_list`. Diagnostic tools stay hidden while scope is unbound or unavailable. Each call injects the selected context and returns its originating scope. Pod logs default to 100 lines and accept only 1–1,000 lines per call; streaming is disabled. Namespace omission uses server/context policy and does not establish all-namespace coverage. See the [tool policy and discovered schemas](docs/MCP_TOOL_SCHEMAS.md#diagnostic-surface).

`npm pack` builds the executable before producing an installable archive. `npm run test:e2e` verifies the extracted package offline using the checkout's locked dependencies. The acceptance runbook covers installing the archive and exercising its npm-linked `pi-sre` command in a terminal.

`npm run test:contracts` compares Kubernetes MCP Server 0.0.67 against the checked-in Phase 2 contract snapshot using static synthetic kubeconfigs and local mock endpoints. It requires `kubernetes-mcp-server` on PATH. This is a historical snapshot probe, not a runtime version requirement. Regular tests skip this executable-dependent suite; see [the contract record](docs/PHASE2_CONTRACTS.md) for an alternate executable path.

If MCP startup or inventory discovery fails, the TUI opens with a warning and no Kubernetes tools. An incompatible individual tool is excluded without disabling unrelated compatible tools; failed context enumeration blocks diagnostic access. Repair the configuration and run `/mcp_restart` to retry within the same conversation. A healthy connection with a validated registry is left running; an enumeration failure can be retried with `/mcp_restart`; `/mcp_restart --force` cancels active MCP calls and replaces it. Unknown arguments show usage. Each retry rereads the YAML and read-only TOML configuration; application home and session path changes require a full `pi-sre` restart. Connecting, ready tool counts, and safe failure diagnostics appear in the TUI. Connection drops and failed retries hide MCP tools until recovery.

`pi-sre --cluster <name>` and `pi-sre --cluster=<name>` now parse and retain an exact context request in application state. Names are preserved without trimming or case folding. Missing, blank, unsafe, oversized, duplicate, or unknown arguments fail before startup. `--help` and `-h` work alongside a valid selection without loading configuration or starting MCP; invalid arguments still fail when help is requested. A name beginning with `-` can use the equals form.

Recovery re-enumerates contexts and validates replacement tool schemas before restoring diagnostics. It retains the exact previous selection, including a `/cluster` choice, despite changed configured or MCP defaults. If that name disappears, scope stays unbound with a selection warning and no fallback. A previously unbound session stays unbound when defaults appear. If initial enumeration never succeeded, the first successful retry resolves pending CLI intent against refreshed configuration and inventory. Captured handlers cannot use a replacement connection, and cancelled or stale results cannot become new observations.

The pure resolver chooses `--cluster` > `kubernetes.defaultCluster` > MCP default > unbound. An unavailable CLI or configured name produces a recoverable selection error with its provenance and requested name, without falling back. A single context without default metadata stays unbound; an empty inventory is not configured. The example YAML leaves `defaultCluster` unset; opt in only with an actual MCP context name. The running application invokes the resolver after one validated startup enumeration on its managed MCP connection. Startup diagnostics identify the selected name and source, or explain selection/enumeration failures. A bound scope records selection only; it does not verify Kubernetes authentication or authorization.

Use `/cluster` to open the context picker showing the current selection, or `/cluster <exact-name>` to select directly. Selection uses the current validated MCP registry and changes application state only. Names are exact, without trimming or case folding; cancellation or an invalid name preserves the existing selection. Wait for or cancel active agent work before switching. A picker opened before a restart or another selection cannot commit a stale choice. Switching preserves the conversation and MCP process. Fixed scope rules live in the stable system prompt; an initial scope snapshot and subsequent scope/availability changes are recorded as persistent application messages. Unchanged state adds no messages per model request, preserving the existing request prefix. New sessions receive the current snapshot, reloads deduplicate it, and a turn-start hook restores it if compaction or navigation removed it. The application and tool bridge enforce cluster targeting independently of these informational messages. `/cluster --status` reports scope, selection source, registry, and MCP availability without changing selection, even during active work. A wrapping widget below the editor continuously displays READ ONLY, cluster, namespace policy, and MCP/registry status. READ ONLY occupies its own line so long context names cannot truncate it. Namespace `*` means no application-level namespace restriction; it does not imply every tool queries all namespaces. Endpoint metadata is omitted. Slice 9 owns physical terminal acceptance for narrow widths, selection dialogs, streaming, and restart against the current Phase 2 package; see the [step-by-step live commands](docs/PHASE2_LIVE_TEST_COMMANDS.md).

`/cluster`, `/cluster --status`, and `/mcp_restart` feedback includes local time (`HH:MM:SS`) and a session invocation number, for example `[12:34:01 #7] /mcp_restart: MCP already healthy; existing connection retained.` Repeated commands receive new numbers even within one second. Picker/restart progress and its outcome share a number. Concurrent retries report joining existing work; restart completion distinguishes ready transport from registry or selection errors. Numbers survive extension reloads and reset with a new Pi session. Feedback uses Pi notifications above the editor; consecutive informational notifications replace the prior status, with the new time/number identifying the latest invocation. It adds no model messages or Kubernetes calls.

Startup and active MCP operations are cancellable. On shutdown, Pi SRE aborts work, disposes the Pi runtime, closes the managed MCP child, and stops the TUI. Quit and process signals share an idempotent cleanup path; runtime and terminal startup failures also release acquired resources.

## MCP Trust and Policy

Pi SRE trusts the MCP server you configure. It exposes only allowlisted diagnostic operations, validates model arguments against discovered server schemas, injects the selected cluster, and enforces application limits. It does not require exact schema snapshots or read-only/destructive annotations. Added arguments and changed output declarations on approved tools do not require Pi SRE schema changes; new tool names still require approval in the allowlist. Cluster-dependent tools must expose an explicit context parameter compatible with the selection.

Diagnostic data is rendered without Kubernetes resource-schema validation. Responses that populate application state, such as the context registry, are parsed only for the fields and consistency needed to operate Pi SRE. Read-only server configuration, read-only RBAC, redaction, and result budgets continue to apply.

## MCP Results

The bridge prefers valid JSON `structuredContent`, otherwise it renders text, embedded resource text, resource links, and image metadata. Image and resource binary payloads are omitted with a visible notice; links are never fetched. Unsupported or malformed content fails closed. Empty successful results remain successful. MCP errors and call failures carry distinct categories for unavailable transport, authentication, authorization, invalid arguments, timeout, or tool execution failure. Caller cancellation still aborts the operation.

Configure `results.maxTextChars` (default 8,000, range 256–64,000) and `results.maxItems` (default 50, range 1–1,000) in YAML. The character budget includes `[Result truncated]`. The item budget covers content blocks, or all nested structured fields and array entries combined. Structured nesting beyond 32 levels is also visibly truncated. Reduced JSON may be cut at the character limit; truncated results are partial observations, not complete JSON documents.

Known credential patterns and structured credential fields are redacted before results enter the model context or Pi transcript. Error payloads are replaced with safe category messages. Process diagnostics use the same redactor; truncated stderr tails are withheld to avoid exposing credential fragments. Pattern redaction does not identify arbitrary sensitive application data.

`results.rawRetention` is fixed to `disabled`: raw MCP results have no retained artifact, retention budget, or lifetime after normalization (zero bytes retained for zero time). Pi receives only bounded text and safe status details. This slice does not create an evidence store.

## Layout

The [MCP tool policy and schemas](docs/MCP_TOOL_SCHEMAS.md) describes the trusted-server boundary, capability allowlist, discovered argument schemas, application-state parsing, and diagnostic limits.

The [session projection and transcript context guide](docs/SESSION_PROJECTION_AND_TRANSCRIPT_CONTEXT.md) explains how persisted Pi messages become model request context, including cluster scope messages.

- `src/` — application, runtime, MCP bridge, cluster state, domain, configuration, and TUI modules
- `skills/` — reusable Kubernetes diagnostic skills
- `tests/` — unit, integration, and end-to-end test suites
- `evals/` — kind-based diagnosis evaluation framework and cases
- `config/` — safe, versioned configuration templates
