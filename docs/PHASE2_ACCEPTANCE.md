# Phase 2 Acceptance — Cluster Context Management

**Status (2026-10-17): Complete.** The automated gate passed, and the operator confirmed the live tests passed, including Slice 9 scope acceptance and Slice 10 updated installed-package, command-feedback, recovery, and terminal regression. See the validation records and final operator confirmation below.

The [slice plan](./PHASE2_IMPLEMENTATION_SLICES.md#15-slice-9--phase-gate-and-live-scope-acceptance) requires both automated checks and installed-application live evidence. A fake server, a simulated provider stream, or two namespace contexts on one cluster cannot establish live cross-cluster targeting.

## Automated gate

Run the affected tests first:

```bash
npx vitest run tests/integration/phase2-acceptance.test.ts tests/unit/app/cli.test.ts tests/e2e/package.test.ts
```

Then run each canonical command, stopping on failure:

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run build
```

Focused acceptance commands are `npm run test:integration` and `npm run test:e2e`. CI continues to use the canonical gate without Kubernetes, Docker, a local MCP executable, or provider credentials.

| Evidence                                                               | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Full-path acceptance](../tests/integration/phase2-acceptance.test.ts) | CLI parsing → on-disk configuration loader → production controller/discovery/bridge → production Pi runtime and commands → managed stdio MCP. Both CLI forms, config/MCP precedence, unavailable names without fallback, empty registry, no default, attempted model context override, idle switching, forced recovery, removed selection, stale handlers, history preservation, and child cleanup. Exact recorded requests and per-context result markers are asserted. Only the provider stream/authentication preflight is simulated. |
| [Packaged CLI](../tests/e2e/package.test.ts)                           | Builds and extracts the npm payload outside the checkout; checks shebang, both selection/help forms, precedence/status help, invalid/missing/duplicate/unsafe arguments (including alongside help), failure before application-home creation, and shipped read-only configuration. Uses locked dependencies by symlink, offline.                                                                                                                                                                                                         |
| [Diagnostic surface](../tests/integration/diagnostic-surface.test.ts)  | All five diagnostic operations, final arguments, namespace attribution, log bounds, redaction, changed discovered schemas, hidden tools, captured-handler enforcement, reload and transport loss.                                                                                                                                                                                                                                                                                                                                        |
| [Scoped Pi loop](../tests/integration/scoped-tool-bridge.test.ts)      | Active-turn switch refusal, exact dispatch scope, successive cluster markers, persistent model scope updates, cancellation and classified failures.                                                                                                                                                                                                                                                                                                                                                                                      |
| [Recovery](../tests/integration/mcp-restart.test.ts)                   | Degraded startup/repair, pending startup intent, changed defaults/inventory/schemas, concurrent restart, cancelled diagnostic results, transport loss, authentication/authorization/operation failures, retained scope, and process cleanup.                                                                                                                                                                                                                                                                                             |
| Unit and other integration suites                                      | Registry validation/limits, pure precedence, command/picker races, scope/status agreement, unavailable/incompatible states, read-only shell/tool isolation and resource-loading policy.                                                                                                                                                                                                                                                                                                                                                  |

The optional `npm run test:contracts` exercises the installed server against synthetic kubeconfigs and loopback Kubernetes endpoints. It is separate from offline CI and live acceptance. See [the contract record](./PHASE2_CONTRACTS.md) for the supported server 0.0.67 setup and its limitations.

## Live setup

Follow [the step-by-step live test commands](./PHASE2_LIVE_TEST_COMMANDS.md) to provision fixtures and execute this procedure. All live checks, including terminal acceptance for the Slice 6 UI, belong to Slice 9 and use the current Phase 2 package. No historical checkout is required. [Slice 10](./PHASE2_IMPLEMENTATION_SLICES.md#16-slice-10--operational-command-feedback) adds command feedback and owns the affected regression checks; the operator confirmed those live regression checks passed for the updated package on 2026-10-17.

Use two disposable local kind clusters, each with a distinct API server and a non-sensitive marker Pod in the same test namespace. Prepare resources and read-only credentials outside Pi SRE. Administrative setup tools belong to the operator's terminal; Pi SRE must never acquire them as model tools.

Before launching:

1. Provision clusters A and B with different marker Pod names, for example `phase2-alpha-marker` and `phase2-beta-marker`, in namespace `phase2-scope`. Give both Pods the label `pi-sre-scope-test=true`. Use the same namespace and label on both clusters so namespace differences cannot masquerade as cluster routing.
2. Bind dedicated credentials to read-only RBAC for Pods, Pod logs, events and namespace listing as needed. Do not use kind administrator credentials in Pi SRE. Confirm the test identity cannot create, patch, update or delete resources and cannot read Secrets. Keep credentials outside the checkout and the acceptance record.
3. Prepare a dedicated kubeconfig containing both read-only contexts. Keep its current context set to A throughout the main routing test. Record a local checksum before launch; do not print or commit its content. Keep the ordinary user kubeconfig separate and unchanged.
4. Confirm `configuration_contexts_list` returns both exact names and that each enabled diagnostic descriptor declares `context`. Server 0.0.67 requires multiple contexts and a valid current context for these capabilities. One-context inventories omit the required descriptors; no-current-context startup fails. Those outcomes are incompatibility/startup failures, not successful empty/unbound states.
5. Record expected marker names independently using the operator's read-only credentials. For stronger proof, capture API audit records limited to test identity, verb, path, response status and cluster label. Never capture authorization headers, tokens, bodies, or raw application responses.

Install the archive outside the checkout, using a dedicated application home:

```bash
task_scope_dir=$(mktemp -d)
npm pack --pack-destination "$task_scope_dir"
npm install --prefix "$task_scope_dir/install" "$task_scope_dir/pi-sre-0.1.0.tgz"
mkdir -p "$task_scope_dir/app"
cp config/pi-sre.example.yaml "$task_scope_dir/app/config.yaml"
cp config/kubernetes-mcp.example.toml "$task_scope_dir/app/kubernetes-mcp.toml"
```

Use the emitted archive filename if the version changes. Review the copied files. Keep stdio, `read_only = true`, `configuration_view` disabled, and multi-cluster support enabled. Set an absolute MCP executable path if necessary. Configure a usable model in this dedicated app via `/login` and `/model`; keep authentication files private.

Set `task_scope_kubeconfig` to the absolute path of the prepared read-only test kubeconfig. Record its checksum locally with `shasum -a 256 "$task_scope_kubeconfig"`. Launch from outside the checkout, substituting A's exact MCP name:

```bash
cd "$task_scope_dir"
KUBECONFIG="$task_scope_kubeconfig" PI_SRE_HOME="$task_scope_dir/app" \
  "$task_scope_dir/install/node_modules/.bin/pi-sre" --cluster A
```

The MCP process consumes the kubeconfig selected by this environment; Pi SRE does not parse it. The package test's offline dependency symlink is not evidence of npm bin installation; verify the installed command above for live acceptance.

## Live procedure and expected evidence

Record sanitized tool results and status alongside observations. A model's final answer alone cannot prove routing. Historical A observations may remain visible after selecting B; check the new tool result and its originating scope.

| Step                | Action                                                                                                                                                                                       | Pass condition                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial scope       | Launch with `--cluster A`; run `/cluster --status`.                                                                                                                                          | Exact A, source `cli`, namespace policy `*`, READ ONLY, current registry and MCP status agree with the widget. Selection does not imply Kubernetes authentication succeeded.                                                                        |
| A observation       | Ask to list Pods with label `pi-sre-scope-test=true`, then inspect A's marker and events explicitly in `phase2-scope`.                                                                       | New scoped results contain only A's marker; explicit tool context is A. Use `pods_get` with explicit namespace if `pods_list` uses a context namespace. Namespace omission does not prove all-namespace coverage.                                   |
| Idle switch         | Select B using `/cluster` picker; repeat the same queries.                                                                                                                                   | New results contain only B's marker and scope B; source becomes `user`; prior conversation remains. MCP default/current context stays A.                                                                                                            |
| Active work         | While a model/tool request is pending, enter `/cluster A`.                                                                                                                                   | Switch is refused with wait/cancel guidance; the operation retains B's scope. Retry while idle succeeds.                                                                                                                                            |
| Status during work  | Run `/cluster --status` while streaming.                                                                                                                                                     | Reports current scope without changing selection or starting a model turn.                                                                                                                                                                          |
| Terminal visibility | Repeat at normal and narrow terminal widths, with a long context name, picker dialog, streaming and forced restart.                                                                          | READ ONLY and cluster/namespace/availability remain readable; Pi model/session UI works. Record terminal and dimensions.                                                                                                                            |
| Model override      | While A is selected, ask the model to pass B as a diagnostic tool's context.                                                                                                                 | Schema hides context; any supplied override cannot route to B. Check new result scope and marker/API evidence. If the model never emits an override, record this as refusal plus automated enforcement evidence, not a live injected-argument test. |
| Mutation/shell      | Ask to modify a deployment; enter `!echo PI_SRE_SCOPE_SMOKE`.                                                                                                                                | No write/coding tool or shell executes; explicit shell denial appears. Audit records show no mutation by the test identity.                                                                                                                         |
| Healthy recovery    | On B, change only the copied configured default to A; run `/mcp_restart`, then `/mcp_restart --force`.                                                                                       | Healthy retry is a no-op; replacement re-enumerates and retains B/user selection despite defaults. A fresh query still returns B's marker; conversation remains.                                                                                    |
| Removed selection   | Launch a separate session using a disposable copy of the test kubeconfig, select B, then replace that copy outside Pi SRE with an inventory omitting B but retaining A and C; force restart. | B becomes an unavailable selection with no fallback. Diagnostics are hidden/blocked; neither A nor C is queried until explicit selection. A single remaining context on 0.0.67 instead tests incompatibility, so cannot satisfy this case.          |
| Degraded startup    | Set the copied YAML's executable to a nonexistent absolute path and start with `--cluster B`; repair it in another terminal, then `/mcp_restart`.                                            | TUI remains usable with no infrastructure access claim/tools before repair. First successful enumeration binds pending B; fresh query returns B's marker.                                                                                           |
| Kubernetes failure  | Use a prepared expired identity, a read-only identity denied a diagnostic resource, or request a missing Pod.                                                                                | Authentication, authorization or resource failure retains originating cluster/namespace and remains distinct from unavailable MCP or missing selection.                                                                                             |
| Quit                | Record owned MCP PID locally; quit after normal work and after cancelling pending work.                                                                                                      | Child is gone, terminal input/echo/cursor restored. Post-run kubeconfig checksum matches baseline; current context remains A.                                                                                                                       |

### Slice 10 follow-up — command feedback (complete; live regression operator-confirmed)

Live recovery testing on 2026-10-17 exposed ambiguous feedback: an existing ready notification could not distinguish a new `/mcp_restart` invocation from an earlier one. This observation does not establish a restart or routing failure. Preserve existing live observations under their original package identity.

Install the updated Slice 10 package and repeat the affected checks:

- Submit identical `/cluster --status`, same-context selection, and healthy `/mcp_restart` commands repeatedly, including within one second. Every invocation must show a readable timestamp, a distinct session invocation number, and its explicit outcome.
- Exercise selection changes, cancelled pickers, invalid selections, and active-turn refusal. Verify that each outcome is acknowledged without changing the established scope rules.
- Exercise forced restart and degraded recovery/failure. Associate acknowledgement/progress and completion with the same invocation number; verify honest transport and enumeration/selection outcomes. Use owned-PID comparison and fresh scoped diagnostics to establish restart and routing behavior.
- Repeat at normal and narrow widths, including streaming and picker dialogs. Verify feedback and continuous READ ONLY/scope/availability remain readable and Pi's model/session UI works.
- Record the updated package revision/checksum and results separately. Run the affected deterministic tests and canonical gate; require this follow-up before declaring Phase 2 complete.

Repeat startup with dedicated copies of the safe YAML:

| CLI         | Config default | MCP default               | Expected                                             |
| ----------- | -------------- | ------------------------- | ---------------------------------------------------- |
| B           | A              | A                         | B / cli                                              |
| none        | B              | A                         | B / config                                           |
| none        | none           | A                         | A / mcp-default                                      |
| absent name | B              | A                         | Unbound selection error; no fallback                 |
| none        | absent name    | A                         | Unbound selection error; no fallback                 |
| none        | none           | none, successful registry | Unbound, even with one entry; no diagnostic requests |
| none        | none           | successful empty registry | NOT CONFIGURED; no diagnostic requests               |

The last two states are covered deterministically offline. Server 0.0.67 cannot produce these successful startup registries in the observed setup. Record them as a live server limitation unless using a configured server/provider that supports them; do not relabel a startup failure as a passing empty/unbound case. After a successfully unbound session, a replacement default must not silently bind it.

## Acceptance record — 2026-10-16

Baseline revision: `7fa01a466e993f579e3ed25a3f2830060c28bc0e` plus the Slice 9 working-tree changes. Node `26.0.0`, Pi runtime/MCP client `0.99.0` from the lockfile, installed Kubernetes MCP Server `0.0.67`, Darwin arm64. No live model identifier or terminal result is recorded because live acceptance has not run.

| Check                                                  | Result                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Focused acceptance, CLI and package tests              | Passed: 34 tests                                                                        |
| Format, lint, typecheck, full tests, build             | Passed: 385 tests; 7 optional executable tests skipped in the offline run               |
| Explicit integration/e2e suites                        | Passed: 90 integration tests; 1 package test                                            |
| Installed MCP synthetic contract probe                 | Passed separately: all 7 tests on server 0.0.67; synthetic endpoints, not live clusters |
| Installed npm-linked CLI with real model               | Pending                                                                                 |
| Two distinct live clusters and read-only identities    | Pending                                                                                 |
| Live scope, recovery, kubeconfig immutability, cleanup | Pending                                                                                 |
| Narrow terminal, dialogs, streaming and restart        | Pending (Slice 9 owns terminal acceptance of the Slice 6 UI)                            |

Append the exact tested revision (including dirty state/archive identity), date, OS, Node/Pi/MCP versions, model identifier, terminal/dimensions, safe A/B labels and marker names, per-step pass/fail, and limitations after live execution. Do not commit credentials, kubeconfig, sensitive endpoints, raw responses, or credential-bearing sessions. Mark Phase 2 complete only when the automated gate and required live acceptance have passed.

The dated records below preserve the evidence and outstanding items as they stood at each stage. The final operator confirmation closes the live gate.

## Live observation — 2026-10-17

User-supplied Step 8 evidence from the [live runbook](./PHASE2_LIVE_TEST_COMMANDS.md#8-degraded-startup-and-repair), after repairing the nonexistent executable path with `ln -s "$P2_MCP" "$P2_DIR/nonexistent-mcp"`:

- Post-repair scope showed `phase2-beta-with-a-long-context-name-for-terminal-verification`, selection source `cli`, namespace policy `*`, READ ONLY, MCP ready, and a validated registry with 3 contexts.
- A fresh `pods_list` call used `fieldSelector="metadata.namespace=phase2-scope"` and `labelSelector="pi-sre-scope-test=true"`. Its bridge result recorded the exact B context and returned only `phase2-beta-marker` in `phase2-scope`, Ready `1/1`, Running, with 0 restarts.
- The bridge reported namespace as `server/context policy (not asserted)` because the call had no explicit `namespace` argument. The field selector and returned namespace match the request; this is not evidence of all-namespace coverage.

**Result:** Post-repair recovery and pending B/cli binding are observed, with a successful diagnostic against B's marker. The supplied excerpt does not include the pre-repair unavailable state or the `/mcp_restart` invocation itself; those portions of Step 8 remain unverified by this excerpt. Slice 10 command-feedback retesting remains pending. Tested package revision/archive identity, model, and terminal dimensions must still be associated with this observation before closing the live gate. Phase 2 remains incomplete.

## Operator live confirmation — 2026-10-17

The operator subsequently confirmed that all live tests in the current Slice 9 runbook passed. This confirmation covers installed-application operation, two-cluster routing, switching and scope enforcement, read-only restrictions, terminal visibility, healthy/forced recovery, removed selection, degraded startup and repair, startup precedence, Kubernetes operation/authorization failures, and quit/cleanup verification. It completes the Step 8 confirmation beyond the earlier post-repair excerpt. These are operator-reported results; the agent did not independently execute the live tests.

Server 0.0.67 limitations documented above remain: successful empty/no-default registry cases and authentication failures are covered by automated evidence unless separately exercised live. No additional live coverage is inferred from the overall pass confirmation.

The 2026-10-16 pending rows are retained as the historical automated-gate baseline; the current Slice 9 live result is **passed, operator-confirmed**. Exact tested revision/dirty state, archive checksum, model identifier, and terminal dimensions have not been supplied in this conversation and remain to be attached to the record. This confirmation predates Slice 10; it does not cover the updated command feedback or its subsequent installed-package regression tests. Phase 2 remains open for that follow-up.

## Slice 10 automated regression — 2026-10-17

Tested source: baseline `79acf5de5ccf9a8e712c05592f0bc12adeb21252` plus the uncommitted Slice 10 implementation and documentation changes. Node `26.0.0`, Pi runtime/MCP client `0.99.0`, Darwin arm64. The pre-existing Slice 9 operator observations above remain associated with their original run.

- Focused command, recovery, active-turn routing and scope-presentation checks: 46 passed.
- Canonical gate passed: `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (390 passed; 7 optional executable-dependent contract tests skipped), and `npm run build`. Full tests include offline packaged-CLI acceptance.
- Public command/UI tests control the clock and assert same-second invocation numbers, progress/completion association, cancellation and refusal, changed/already-selected outcomes, healthy retention, failed recovery, enumeration/selection errors, shared concurrent restart with one replacement PID and fresh B-scoped diagnostics, sanitized unexpected rejection, reload continuity, and new-session isolation. Unchanged commands add no transcript messages or MCP calls.
- The installed Pi notification implementation was inspected: consecutive informational statuses replace the previous status. Each replacement now carries its own timestamp and invocation number; asynchronous completion retains its invocation number.

Updated installed-package/model/terminal regression is **pending**. Repeat the Slice 10 follow-up above and record package identity, model and terminal dimensions; physical normal/narrow-width rendering, dialogs and streaming are not established by these automated results. Phase 2 remains open.

Slice 10 regression archive: `pi-sre-0.1.0.tgz`, SHA-256 `13eb9a4e5e6f6632632ac0509820d67ae7ab9a774f201e724f3edf49b608644d`. Generated from the tested working tree above before appending this archive-identity paragraph; this archive is distinct from the earlier Slice 9 live package. Packaging succeeded; live installation and terminal regression have not been run.

## Final operator confirmation — 2026-10-17

The operator confirmed the live test passed and requested that Phase 2 be marked complete. This closes the remaining Slice 10 updated installed-package and terminal regression gate, following the earlier Slice 9 live confirmation and the passing automated gate recorded above. These live results are operator-reported; the agent did not independently execute the live tests.

The Slice 10 regression archive identity remains recorded above. No additional tested package identity, model identifier, or terminal dimensions were supplied with this final confirmation. Earlier metadata gaps and server coverage limitations remain documented; no new measurements or coverage are inferred.

**Phase 2 gate: Complete.** Slices 0–10 are complete and ready for Phase 3 investigation state.
