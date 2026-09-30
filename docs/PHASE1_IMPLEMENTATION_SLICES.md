# Phase 1 Implementation Slices

**Status:** Slices 0–2 implemented; later slices proposed

**Applies to:** Pi SRE V0.1, Phase 1

**Source of truth:** [DESIGN.md](./DESIGN.md), especially Section 63

## 1. Goal

Phase 1 establishes the smallest safe vertical path from the Pi terminal UI to Kubernetes MCP:

```text
pi-sre
  → Pi InteractiveMode
  → Pi AgentSessionRuntime
  → Pi SRE MCP tool adapter
  → Pi MCP client and managed stdio transport
  → Kubernetes MCP Server
  → read-only MCP tool result
  → Pi TUI
```

At the end of this phase, running `pi-sre` opens the Pi TUI, uses an SRE-owned system prompt and resource policy, discovers approved Kubernetes MCP tools, and can invoke those tools through the Pi agent loop.

Phase 1 is infrastructure work. It does not implement incident state, diagnostic skills, cluster switching, or remediation.

## 2. Scope Boundary

### In scope

- a launchable TypeScript CLI;
- Pi model, authentication, session, streaming, and TUI reuse;
- an SRE-owned `ResourceLoader` configuration;
- Pi MCP client and managed stdio lifecycle;
- MCP initialization, health checking, and tool discovery;
- an explicit Pi-side diagnostic tool allowlist;
- MCP JSON Schema to Pi `ToolDefinition` adaptation;
- normalized, size-bounded MCP results;
- graceful startup and shutdown behavior;
- automated tests using a fake stdio MCP server;
- an optional live smoke test against Kubernetes MCP Server.

### Out of scope

- `--cluster`, `/cluster`, `/context`, or active-cluster state;
- automatic context injection into cluster-dependent calls;
- incident, evidence, hypothesis, or investigation persistence;
- Kubernetes diagnostic skills;
- custom SRE footer and commands;
- shell, `kubectl`, repository read/write, or other coding tools;
- HTTP MCP transport;
- remediation or any write-capable Kubernetes operation.

## 3. Safe Interpretation of the Phase 1 Success Criterion

Phase 2 owns explicit cluster selection and context injection. Therefore Phase 1 must not invoke a cluster-dependent tool by relying on kubeconfig's mutable current context.

The live Phase 1 end-to-end proof uses the read-only, non-cluster-dependent `configuration_contexts_list` MCP tool. `targets_list` may also be exposed if the discovered server marks it read-only and the Pi SRE allowlist includes it.

Core tools such as `pods_list`, `events_list`, and `pods_log` may be discovered in Phase 1, but they remain unavailable to the model until Phase 2 can inject an explicit context. This preserves the design invariant that every cluster-dependent operation has deterministic scope.

## 4. Implementation Principles

1. **Build vertical slices.** Each slice must produce a runnable or testable outcome.
2. **Fail closed.** A missing annotation, invalid schema, unknown tool, missing cluster scope, or policy ambiguity excludes the tool.
3. **Keep adapters thin.** Pi's MCP package owns the protocol and transport; Pi SRE enforces policy and maps results to its domain.
4. **Keep startup recoverable.** MCP failure disables Kubernetes tools but does not prevent the TUI from opening when the Pi runtime itself is available.
5. **Own all lifecycle edges.** Startup, abort, process exit, and TUI shutdown must close the MCP transport exactly once.
6. **Do not load arbitrary project behavior.** The launch directory must not inject `AGENTS.md`, extensions, prompts, or tools into Pi SRE.

## 5. Target Module Shape

Phase 1 should result in this implemented subset:

```text
src/
├── main.ts
├── app/
│   ├── create-runtime.ts
│   └── sre-application.ts
├── config/
│   ├── config.ts
│   ├── loader.ts
│   └── schema.ts
├── runtime/
│   ├── resource-loader.ts
│   ├── system-prompt.ts
│   └── tool-policy.ts
└── mcp/
    ├── connection.ts
    ├── tool-bridge.ts
    └── result-normalizer.ts

tests/
├── fixtures/
│   └── fake-mcp-server.ts
├── unit/
│   ├── config/
│   ├── mcp/
│   └── runtime/
└── integration/
    ├── mcp-lifecycle.test.ts
    └── runtime-tools.test.ts
```

Do not create Phase 2 or Phase 3 abstractions speculatively. In particular, Phase 1 does not need placeholder implementations for cluster managers, incidents, evidence stores, or hypotheses.

## 6. Stable Contracts Introduced in Phase 1

The implementation should converge on small contracts with no Pi types in configuration or process-management code.

```ts
interface McpServerConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs: number;
  readonly toolCallTimeoutMs: number;
}

interface McpConnection {
  listTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface ToolPolicy {
  evaluate(tool: McpToolDescriptor): ToolPolicyDecision;
}

type ToolPolicyDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
```

Pi MCP and Pi Coding Agent types belong at adapter boundaries:

- `connection.ts` wraps `@earendil-works/pi-mcp` and owns the one connection;
- `tool-bridge.ts` owns Pi `ToolDefinition` creation;
- `config/` does not import Pi;
- the rest of the application consumes Pi SRE-owned interfaces.

## 7. Slice 0 — Freeze the Phase 1 Contract

**Implementation status:** Complete. Configuration loading, path normalization, MCP TOML safety validation, and the initial tool allowlist are covered by unit tests.

### Outcome

The team has one executable definition of Phase 1 configuration and safety behavior before runtime wiring begins.

### Work

- Define and validate the Pi SRE YAML configuration with Zod.
- Normalize `~`, relative paths, command arguments, timeouts, and environment overrides once at startup.
- Keep all Pi SRE configuration and persisted runtime state under one application root: `~/.pi-sre`.
- Store Pi SRE model credentials and model metadata in that root; do not read or write Pi Coding Agent's `~/.pi/agent` storage.
- Add `typebox` as a direct dependency because Pi tool definitions expose TypeBox schemas at the public boundary.
- Update the example Kubernetes MCP command to pass `--config <path>` explicitly.
- Define the initial exact tool allowlist:
  - `configuration_contexts_list`;
  - optionally `targets_list` after confirming its discovered read-only annotation.
- Explicitly exclude `configuration_view` because it can expose kubeconfig content.

### Application-home layout

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

Pass `~/.pi-sre` as Pi's `agentDir`. Construct `ModelRuntime` with the root's `auth.json` and `models.json`, construct `SettingsManager` with the same `agentDir`, and give `SessionManager` the root's `sessions/` directory explicitly. Pi SRE reuses Pi's runtime and provider integration, not its default storage location.

### Configuration behavior

The normalized process arguments should be equivalent to:

```text
kubernetes-mcp-server --config /absolute/path/to/kubernetes-mcp.toml
```

Runtime settings such as `read_only` and `toolsets` belong in TOML, not invented CLI flags. The Kubernetes MCP Server currently limits its CLI bootstrap surface to `--config`, `--config-dir`, and `--version`.

### Acceptance criteria

- Valid example configuration parses.
- Unknown configuration keys fail with an actionable path and message.
- A missing MCP command or config path fails configuration validation.
- Relative paths are resolved before runtime or session creation.
- Model credentials, settings, and sessions resolve under `~/.pi-sre`.
- No default startup path reads from or writes to `~/.pi/agent`.
- Secrets and full inherited process environments are never printed in diagnostics.

### Tests

- valid configuration;
- missing required field;
- unknown field;
- invalid transport;
- path expansion and normalization;
- environment override precedence;
- single-root runtime-path construction;
- redacted error rendering.

## 8. Slice 1 — Launch a Pi TUI With No Operational Tools

### Outcome

`npm run dev` and the built `pi-sre` executable open `InteractiveMode` using an `AgentSessionRuntime` with all built-in coding tools disabled.

### Work

- Implement `src/main.ts` as a thin executable entrypoint with a Node shebang.
- Implement `SreApplication.run()` and idempotent `SreApplication.close()`.
- Create Pi services and a session through `createAgentSessionRuntime` or the equivalent `createAgentSessionServices` plus `createAgentSessionFromServices` factory path.
- Pass `noTools: "builtin"` and exclude every built-in coding tool from the registry so Pi's tool picker cannot re-enable them while later custom MCP tools remain eligible.
- Intercept Pi's user-facing `!` shell shortcut and return a read-only denial without executing a command.
- Construct `InteractiveMode` with the runtime and call `run()`.
- Use a Pi SRE-owned runtime directory rather than treating the shell launch directory as operational context.
- Use the Pi SRE application home as the Pi `agentDir`, model-authentication directory, settings directory, and session root.
- Preserve Pi's model selection, authentication flow, session persistence, streaming, and compaction behavior without sharing Pi Coding Agent storage.

### Acceptance criteria

- `npm run dev -- --help` exits successfully and documents configuration lookup.
- `npm run build` produces `dist/main.js` with a preserved shebang.
- `npm link` followed by `pi-sre` starts the Pi TUI.
- The model has no `bash`, `read`, `write`, or `edit` tool.
- Pi runtime files are created only below `~/.pi-sre`.
- Closing the TUI exits without a hanging process.

### Tests

- CLI argument and help tests;
- runtime factory test asserting built-in tools are disabled;
- application close is safe when called zero, one, or multiple times.

## 9. Slice 2 — Own the SRE Resource Boundary

**Implementation status:** Complete. The Pi service factory and standalone loader share the same SRE resource policy and prompt.

### Outcome

The model receives a Pi SRE system prompt and no arbitrary project instructions, skills, extensions, or prompt templates.

### Work

- Implement `createSreResourceLoader()` in `src/runtime/resource-loader.ts`.
- Configure Pi's `DefaultResourceLoader` as the underlying mechanism with:
  - project context files disabled;
  - project extensions disabled;
  - project prompt templates disabled;
  - project themes disabled unless Pi requires its built-in theme path;
  - no Phase 4 SRE skills yet;
  - an SRE-owned system prompt.
- Keep the system prompt in `src/runtime/system-prompt.ts` as a testable function.
- State that Kubernetes access is unavailable until an MCP tool is actually registered.
- State that the environment is read-only and that the model must not suggest that a tool call succeeded without evidence.

### Acceptance criteria

- A fixture `AGENTS.md` in the launch directory does not appear in the effective system prompt.
- A fixture project extension does not load.
- The effective prompt identifies Pi SRE as a Kubernetes diagnostic agent in read-only mode.
- Reloading resources preserves the same policy.

### Tests

- resource-loader isolation test with hostile fixture project resources;
- system-prompt snapshot or focused semantic assertions;
- resource reload test.

## 10. Slice 3 — Connect to a Managed MCP Process

### Outcome

Pi SRE can start, initialize, health-check, and stop a Kubernetes MCP Server over stdio without involving the model.

### Work

- Upgrade the Pi dependencies to a compatible 0.99 release and add `@earendil-works/pi-mcp` as a direct dependency.
- Remove the direct `@modelcontextprotocol/sdk` dependency once its remaining uses have been replaced by Pi MCP.
- Wrap Pi MCP `McpClient` and `StdioTransport` in `src/mcp/connection.ts` behind the small `McpConnection` contract.
- Let Pi's `StdioTransport` own the child process; do not spawn a second process or implement MCP framing.
- Capture stderr separately because stdout is reserved for MCP JSON-RPC.
- Bound retained stderr and redact credential-like content before surfacing diagnostics.
- Add startup and request timeouts.
- Forward abort signals into MCP request options.
- Model connection state explicitly:
  - `starting`;
  - `ready`;
  - `failed`;
  - `closed`.
- Make `close()` idempotent and safe after partial startup failure.

### Acceptance criteria

- A fake stdio server completes MCP initialization and responds to `ping`.
- Missing executable, early process exit, malformed protocol output, and startup timeout produce distinct diagnostics.
- Closing Pi SRE terminates the managed MCP child.
- MCP startup failure does not crash an otherwise usable Pi TUI; it starts without Kubernetes tools and shows a startup diagnostic.

### Tests

- successful connect and close;
- command-not-found failure;
- initialization timeout;
- child exits during initialization;
- malformed JSON-RPC response;
- repeated close;
- abort during startup.

## 11. Slice 4 — Discover and Filter Tools

### Outcome

Pi SRE can list MCP tools and produce a deterministic report of which tools are exposed, rejected, or deferred.

### Work

- Use Pi MCP's paginated `listTools()` rather than implementing MCP pagination.
- Validate every discovered descriptor before use.
- Preserve name, description, input schema, annotations, and output schema metadata.
- Apply a fail-closed `ToolPolicy`:
  1. the tool name must be on Pi SRE's exact allowlist;
  2. `annotations.readOnlyHint` must be `true`;
  3. `annotations.destructiveHint` must not be `true`;
  4. the input schema must be a supported object schema;
  5. cluster-dependent tools are deferred until Phase 2;
  6. duplicate or invalid names are rejected.
- Keep policy decisions visible in structured startup diagnostics without dumping schemas or sensitive configuration.
- Treat Kubernetes MCP `read_only = true` as defense in depth, not as a replacement for Pi-side filtering.

### Acceptance criteria

- Only explicitly allowed, annotated read-only tools survive filtering.
- A newly added server tool is not automatically exposed after a server upgrade.
- A write tool remains unavailable even if its name resembles a read operation.
- The same discovered inventory always produces the same ordered exposed set.

### Tests

- allowed tool;
- unknown tool;
- absent `readOnlyHint`;
- destructive annotation;
- invalid input schema;
- duplicate tool name;
- cluster-dependent tool deferred;
- deterministic ordering.

## 12. Slice 5 — Bridge One Tool End to End

### Outcome

The Pi model can invoke `configuration_contexts_list`, the bridge calls MCP, and the result appears in the TUI.

### Work

- Adapt approved MCP JSON object schemas to Pi TypeBox-compatible tool definitions in one isolated module; do not build a general MCP schema converter.
- Create a Pi `ToolDefinition` for each approved descriptor.
- Keep arguments typed as `Record<string, unknown>` at the dynamic boundary.
- Validate arguments in Pi before transport and rely on MCP validation as a second boundary.
- Preserve the caller's `AbortSignal` and configured timeout.
- Return a Pi-compatible `AgentToolResult` with:
  - concise model-facing text;
  - structured details for TUI rendering and tests;
  - a clear error state when MCP returns `isError`.
- Prefix or namespace names only if Pi and MCP naming constraints require it; maintain an explicit reversible mapping either way.

### Acceptance criteria

- The tool appears in Pi's active tool inventory.
- A model tool call reaches the fake MCP server with the expected name and arguments.
- The fake MCP response is visible to the model and TUI.
- Cancellation interrupts the MCP request.
- No built-in coding tool becomes enabled as a side effect.
- With a live Kubernetes MCP Server, asking the agent to list configured contexts causes a real `configuration_contexts_list` call.

### Tests

- supported object schema adaptation for strings, numbers, booleans, arrays, nested objects, enums, and required fields;
- unsupported schema construct fails closed with a diagnostic;
- tool name mapping round trip;
- arguments forwarded exactly;
- abort and timeout;
- MCP `isError` conversion;
- successful end-to-end fake server invocation.

## 13. Slice 6 — Normalize Results and Failures

### Outcome

Tool results are useful to the model without allowing unbounded MCP responses to consume the conversation context.

### Work

- Implement `result-normalizer.ts` for MCP text, structured content, embedded resources, resource links, images, and error responses.
- Set explicit per-result model-facing size and item limits in configuration.
- Prefer `structuredContent` when it is present and valid.
- Retain raw data outside model context only when policy permits, with explicit size and lifetime limits; do not assume Pi's built-in MCP 20 KB text truncation is evidence handling.
- Mark every truncation visibly; never silently cut data.
- Redact known credential and token patterns from diagnostics and rendered errors.
- Distinguish:
  - MCP transport unavailable;
  - Kubernetes authentication failure;
  - Kubernetes authorization failure;
  - invalid tool arguments;
  - MCP tool execution failure;
  - empty successful result.

### Acceptance criteria

- Small results remain complete.
- Large results stay within the configured model-facing budget and carry a truncation notice.
- Empty success is not rendered as a failure.
- MCP errors are not rendered as successful observations.
- No credential-like content appears in snapshots or logs.

### Tests

- small text response;
- structured response;
- empty success;
- large response;
- multiple content blocks;
- resource and image blocks;
- `isError` response;
- redaction fixtures;
- each error category.

## 14. Slice 7 — Integrate Startup, Shutdown, and Diagnostics

### Outcome

The complete application has deterministic orchestration and remains usable when Kubernetes MCP is unavailable.

### Startup order

```text
load and validate Pi SRE config
        ↓
create SRE ResourceLoader
        ↓
start and initialize Pi MCP client/stdio transport
        ↓
discover and filter tools
        ↓
convert allowed tools to Pi ToolDefinitions
        ↓
create AgentSessionRuntime with noTools="builtin"
        ↓
start InteractiveMode
```

If MCP setup fails, startup continues from runtime creation with an empty custom-tool list and an MCP-unavailable diagnostic.

### Shutdown order

```text
stop accepting new work
        ↓
abort active MCP calls
        ↓
dispose AgentSessionRuntime
        ↓
close MCP transport and child process
        ↓
restore terminal and exit
```

### Work

- Centralize orchestration in `SreApplication`.
- Keep the Kubernetes connection application-owned so Phase 2 can call `configuration_contexts_list` during startup on the same connection used for diagnosis. Pi's built-in MCP extension is not loaded for this connection.
- Install `SIGINT` and `SIGTERM` handling once.
- Ensure startup failures unwind already-created resources in reverse order.
- Convert expected failures into concise user-facing diagnostics.
- Preserve unexpected errors as causes for local debugging without printing secrets.

### Acceptance criteria

- Successful startup and shutdown leave no child process behind.
- TUI startup succeeds when MCP is unavailable, with Kubernetes tools absent.
- A fatal Pi runtime failure closes MCP before exit.
- Ctrl+C during an active tool call cancels work and restores the terminal.
- No process-level handler is registered more than once.

### Tests

- full startup and shutdown against the fake MCP server;
- MCP unavailable degraded mode;
- runtime creation failure cleanup;
- signal-driven shutdown;
- active-call cancellation;
- no dangling handles after the integration suite.

## 15. Slice 8 — Phase Gate and Live Smoke Test

### Outcome

Phase 1 is demonstrably complete and ready for Phase 2 cluster-context management.

### Automated gate

Run:

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run build
```

The integration test must start a fake MCP subprocess, discover an allowed tool, invoke it through a Pi tool definition, assert the normalized result, and verify process cleanup.

### Manual live smoke test

Prerequisites:

- Pi SRE authentication and a usable model;
- Kubernetes MCP Server installed;
- a valid kubeconfig;
- the checked-in MCP example copied to a local path with `read_only = true`.

Procedure:

1. Start `pi-sre` with the local Pi SRE configuration.
2. Confirm the Pi TUI opens and identifies read-only mode.
3. Ask: `List the configured Kubernetes contexts.`
4. Confirm the TUI shows a `configuration_contexts_list` tool call.
5. Confirm the returned context names match the Kubernetes MCP response.
6. Ask the model to modify a deployment.
7. Confirm no write tool is available and no shell fallback exists.
8. Exit and confirm the MCP child process terminates.

### Phase 1 exit criteria

- `pi-sre` launches the Pi TUI from the installed package.
- Pi built-in coding and shell tools are disabled.
- Arbitrary launch-directory resources are not loaded.
- Kubernetes MCP runs as a managed stdio child.
- Tool discovery and filtering are deterministic and fail closed.
- At least one safe MCP tool works through the full Pi agent loop.
- Results are normalized and size-bounded.
- MCP failure produces degraded mode rather than false capability.
- Shutdown leaves no subprocess or terminal corruption.
- All automated checks pass.

## 16. Suggested Pull Request Boundaries

Keep each pull request independently reviewable:

| PR  | Slice | Review focus                                  |
| --- | ----- | --------------------------------------------- |
| 1   | 0     | configuration contract and safety defaults    |
| 2   | 1–2   | Pi runtime/TUI boot and resource isolation    |
| 3   | 3     | Pi MCP client and stdio lifecycle             |
| 4   | 4     | discovery and read-only policy                |
| 5   | 5     | dynamic schema and Pi tool bridge             |
| 6   | 6     | result normalization and error taxonomy       |
| 7   | 7–8   | application orchestration and acceptance gate |

Do not merge a slice with skipped acceptance tests unless the limitation and follow-up are explicitly documented.

## 17. Known Risks and Mitigations

| Risk                                                         | Mitigation                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Dynamic MCP schemas do not map cleanly to Pi TypeBox schemas | Isolate the narrow adaptation and reject unsupported schemas                               |
| Server upgrades expose new tools                             | Exact Pi-side allowlist; unknown tools remain hidden                                       |
| `read_only` is misconfigured                                 | Require Pi policy checks and recommend read-only Kubernetes RBAC                           |
| Kubeconfig data leaks through a config tool                  | Do not expose `configuration_view`                                                         |
| Large Kubernetes responses overwhelm model context           | Normalize, cap, and visibly mark truncation                                                |
| MCP child survives TUI failure                               | Central idempotent cleanup and signal tests                                                |
| Launch-directory instructions alter SRE behavior             | Disable project context and extension discovery                                            |
| Phase 1 accidentally relies on current context               | Only invoke non-cluster-dependent tools until Phase 2                                      |
| Dependency API drift                                         | Keep the lockfile authoritative and validate Pi/MCP adapter contracts in integration tests |

## 18. Deferred Decisions

The following decisions belong to later phases and must not block Phase 1:

- interactive cluster selection UX;
- context injection rules for each core tool;
- evidence artifact persistence;
- investigation-state injection into model context;
- custom MCP tool rendering beyond the standard Pi renderer;
- SRE diagnostic skill content;
- retry and reconnection UX after startup;
- external Streamable HTTP MCP servers.

Phase 1 should leave clean seams for these features without implementing them early.

## 19. External Compatibility Notes

- The repository lockfile is authoritative for the Pi 0.99 coding agent and `@earendil-works/pi-mcp` API versions used by this plan. The current implementation still uses Pi 0.87.1; Slice 3 includes the upgrade.
- Pi's public runtime path provides `AgentSessionRuntime`, `InteractiveMode`, `DefaultResourceLoader`, custom `ToolDefinition` support, and `noTools: "builtin"`.
- Pi SRE passes explicit `agentDir`, authentication, model, settings, and session paths so all persisted state lives below `~/.pi-sre` rather than Pi Coding Agent's default directory.
- Pi's standalone MCP package provides `McpClient`, `StdioTransport`, `connect`, paginated `listTools`, `callTool`, cancellation, `ping`, and `close`. Pi's SDK does not load its built-in MCP extension automatically; V0.1 uses the standalone client so startup and tool calls share one connection.
- Kubernetes MCP Server stdio mode reserves stdout for MCP protocol traffic.
- Kubernetes MCP Server runtime policy belongs in TOML. Use `--config` to select the file.
- Keep `read_only = true` and limit toolsets/tools in the Kubernetes MCP configuration.

Reference: [Kubernetes MCP Server configuration](https://github.com/containers/kubernetes-mcp-server/blob/main/docs/configuration.md).

Pi references: [Pi 0.99 release](https://github.com/earendil-works/pi/releases/tag/v0.99.0), [Pi MCP package](https://github.com/earendil-works/pi/blob/v0.99.0/packages/mcp/README.md), [Pi SDK MCP loading](https://pi.dev/docs/latest/sdk).
