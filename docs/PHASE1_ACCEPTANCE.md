# Phase 1 Acceptance

The automated gate verifies the Runtime + MCP Skeleton without infrastructure or model credentials. The live smoke test verifies the installed CLI, terminal behavior, and a real model calling Kubernetes MCP Server. Both are required to declare the Phase 1 exit criteria complete.

## Automated gate

From the checkout, run each command and stop on failure:

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run build
```

CI runs these same commands. For focused acceptance checks, use `npm run test:integration` and `npm run test:e2e`.

`tests/integration/runtime-tools.test.ts` starts a fake MCP subprocess, discovers the approved context-listing tool, and invokes its Pi tool definition through the real Pi agent loop with a deterministic model stream. It checks the exact returned context names and forwarded arguments, normalized success/error/truncation results in the model transcript and TUI events, exclusion of coding tools, and child-process termination. Lifecycle and restart integration tests cover degraded startup, cancellation, signal handling, recovery, stale tools, and conversation preservation.

`tests/e2e/package.test.ts` packs the application, extracts the archive outside the checkout, and runs its built CLI with Node. It checks the shebang, help output, and packaged read-only configuration. Dependencies are linked from the checkout's locked installation to keep the test offline. `prepack` builds the application before packaging. This check does not exercise npm's bin linking, physical terminal rendering, or a live provider; those are covered by the manual procedure.

## Live smoke test

Prerequisites:

- Node.js matching `package.json` (`>=22.19.0`);
- Kubernetes MCP Server installed and executable;
- a valid kubeconfig available to that server;
- Pi SRE authentication and a usable model, configured in the selected application home or through its TUI.

Context listing does not query a cluster. Keep all cluster-dependent operations deferred until Phase 2. Do not change kubeconfig's current context for this test.

### Install and configure

Use a dedicated local directory for the package and application state. From the checkout:

```bash
task_smoke_dir=$(mktemp -d)
npm pack --pack-destination "$task_smoke_dir"
npm install --prefix "$task_smoke_dir/install" "$task_smoke_dir/pi-sre-0.1.0.tgz"
mkdir -p "$task_smoke_dir/app"
cp config/pi-sre.example.yaml "$task_smoke_dir/app/config.yaml"
cp config/kubernetes-mcp.example.toml "$task_smoke_dir/app/kubernetes-mcp.toml"
```

Use the emitted archive filename if the package version changes. Review the copied YAML and TOML; keep `read_only = true`, stdio transport, and `configuration_view` disabled. Set `kubernetes.mcp.command` to an absolute executable path if the server is not on PATH. The YAML's `defaultCluster` has no operational effect in Phase 1.

Launch from outside the checkout:

```bash
cd "$task_smoke_dir"
PI_SRE_HOME="$task_smoke_dir/app" "$task_smoke_dir/install/node_modules/.bin/pi-sre"
```

Use `/login` and `/model` as needed to configure a provider and select a usable model. Credentials and sessions belong to the dedicated application home. Keep credentials, kubeconfig contents, raw process diagnostics, and sensitive context names out of committed acceptance records.

### Healthy connection

1. Confirm the Pi TUI opens and reports approved read-only tools.
2. Ask: `List the configured Kubernetes contexts.`
3. Confirm a `configuration_contexts_list` tool call appears and succeeds. Check the names in the rendered tool response against the final answer. For an independent comparison, invoke the same tool using an MCP client connected to the same server configuration; do not use `configuration_view`.
4. Ask: `Modify a deployment to use a different image.` Confirm the model declines the operation and no write tool, cluster-dependent tool, or shell fallback executes.
5. Enter `!echo PI_SRE_SHELL_SMOKE`. Confirm the explicit read-only shell denial appears and the command produces no execution output.
6. Run `/mcp_restart`. Confirm it reports ready without replacing the healthy child. Run `/mcp_restart --force`, then repeat context listing to verify the replacement.
7. Record the owned MCP child PID locally using the operating system's process viewer. Exit with Ctrl+D on an empty editor or `/quit`. Confirm that PID is gone and normal terminal input, echo, and cursor visibility return.

### Degraded startup and recovery

1. In the copied YAML, temporarily set `kubernetes.mcp.command` to an absolute nonexistent path. Leave the readable, read-only TOML in place; invalid YAML or TOML fails validation before the TUI starts.
2. Start the installed CLI again. Confirm the TUI opens with an MCP-unavailable diagnostic and recovery guidance.
3. Ask for configured contexts. Confirm the model reports access is unavailable and does not invent results or execute a fallback.
4. In another terminal, repair the copied YAML's executable path. In the original TUI, enter `/mcp_restart`.
5. Confirm connecting and ready diagnostics, then repeat context listing. Confirm the tool succeeds and the conversation remains present in the same TUI.
6. Exit and confirm the replacement MCP child terminates and the terminal is restored. Also exercise Ctrl+C during a pending model/tool request and confirm work cancels; quit afterward and check cleanup.

## Acceptance record — 2026-10-06

| Check                                                                                                     | Result                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck, tests, build                                                                     | Passed; 210 tests across 15 files                                                                                                 |
| Packed CLI outside checkout                                                                               | Passed with locked dependencies linked locally; npm bin installation remains part of live smoke                                   |
| Pi agent loop → fake stdio MCP → normalized transcript/TUI events → child cleanup                         | Passed                                                                                                                            |
| Real Pi TUI in a pseudo-terminal with fake MCP                                                            | Passed startup, read-only diagnostic, shell denial, healthy restart, Ctrl+D exit, terminal reset sequences, and child termination |
| Degraded pseudo-terminal startup and `/mcp_restart` recovery with fake MCP                                | Passed unavailable diagnostic, configuration repair, connecting/ready transition, Ctrl+D exit, and replacement child termination  |
| Installed npm bin, live model, real Kubernetes MCP, context comparison, and physical terminal restoration | Not run on 2026-10-06; subsequently confirmed complete by the user on 2026-10-07 (see below)                                      |

The pseudo-terminal check uses the built CLI and an isolated application home without model credentials. It verifies terminal protocol behavior, not a human-operated physical terminal or a live model call. Existing application authentication was not used or changed during those automated and pseudo-terminal checks.

## Manual live acceptance record — 2026-10-07

**Result:** Passed, based on the user's confirmation that the manual smoke test was completed. This is user-reported acceptance, separate from the agent-observed automated and MCP preflight checks.

The manual procedure exercised the installed npm CLI outside the checkout, model-driven context listing, read-only refusal and shell denial, healthy and forced MCP restart, degraded startup and in-session recovery, and exit/child-process/terminal cleanup. The user confirmed completion after receiving that procedure and requested that the smoke test be marked done.

Known setup: macOS on Apple Silicon, Pi SRE 0.1.0, Pi runtime/MCP client 0.99.0, Kubernetes MCP Server 0.0.67, and a local kind 0.33.0 cluster. The agent separately verified a Ready Kubernetes node, read-only kubeconfig permissions, denial of writes and Secret reads, and a successful approved MCP context-listing call. The kubeconfig contains two namespace contexts for the same local cluster; this enables the server's context-listing tool. Model/provider identifier and terminal application were not supplied in the completion report.

The user-specified temporary package installation and configuration directory was removed after the test. The local kind cluster, read-only kubeconfig, and Pi SRE application home are retained for further development.

**Phase 1 gate:** Complete. The automated checks passed on 2026-10-06, and manual live acceptance was confirmed on 2026-10-07. Slices 0–9 are complete and ready for Phase 2 cluster-context management.

For a live run, record the date, OS/terminal, Node/Pi/Kubernetes MCP versions, model identifier, installed package revision, pass/fail for each numbered step, child cleanup, and any limitation. Record only a count or redacted labels for contexts. Do not mark the live gate complete based on fake-server results alone.
