# Phase 3 — Context Selection and Multi-Cluster Routing Acceptance

**Status (2026-10-20, America/Toronto): Complete. Automated, installed-package/live-cluster, and operator-confirmed visual terminal acceptance passed.**

This record covers [Slice 5](./PHASE3_IMPLEMENTATION_SLICES.md#slice-5--full-path-and-installed-acceptance) after Slices 1–4b. Historical Phase 1/2 acceptance records remain unchanged. No incident, evidence store, new diagnostic operation, or mutation workflow was added.

## Automated acceptance

[phase3-acceptance.test.ts](../tests/integration/phase3-acceptance.test.ts) adds 13 cases through CLI parsing, configuration loading, the production MCP controller and runtime, real Pi command dispatch/agent loop, and recording stdio MCP fixtures. Only the provider stream and credential preflight are simulated; no provider credentials or remote model requests are required.

The suite checks singleton/set/all rules and precedence; identical `default/api` resource names with different context markers; required model context and zero-dispatch refusals; invalid selection preserving prior authority; exact/all reconciliation from `{alpha, beta}` to `{alpha, gamma}`; changed configured/MCP defaults; failed and empty enumeration; stale handlers; per-target authorization failures; retained transcript provenance; four overlapping reads with FIFO waiting; selection refusal during work; compaction/reload continuity; cancellation and reconnect settlement without replay; and owned MCP child cleanup.

Existing focused suites supply the remaining race and boundary cases rather than duplicating their harnesses:

| Contract                                                                                                                                                    | Executable coverage                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four active/32 waiting, shared enumeration capacity, overflow, 30-second queue expiry, cancellation removal, handoff races, cleanup                         | [queued-admission.test.ts](../tests/unit/mcp/queued-admission.test.ts), [multi-context-routing.test.ts](../tests/unit/mcp/multi-context-routing.test.ts) |
| Reentrant publication, schema replacement, queued restart/drop/shutdown, late-result withholding, failed/malformed/empty discovery, selection races, reload | [mcp-restart.test.ts](../tests/integration/mcp-restart.test.ts)                                                                                          |
| Real Pi parallel batch, exact origins, active-turn selection guard, cancellation                                                                            | [scoped-tool-bridge.test.ts](../tests/integration/scoped-tool-bridge.test.ts)                                                                            |
| Persisted messages, compaction restoration, deduplication, active-work/outage status                                                                        | [cluster-scope-messages.test.ts](../tests/integration/cluster-scope-messages.test.ts)                                                                    |
| Packaged CLI, variadic/equals/wildcard forms, whitespace names, default-all help, rejected legacy/conflicting/extra arguments before startup                | [package.test.ts](../tests/e2e/package.test.ts)                                                                                                          |

The focused acceptance/recovery/queue/message/package run passed **104 tests**. Canonical formatting, lint, type checking, all tests (**519 passed, 7 optional server-contract tests skipped**), and build passed. The executable-dependent historical MCP contract probe is separate from these results.

## Installed-package and disposable-cluster smoke

The agent executed this smoke on 2026-10-20 local time, completing at **2026-10-21 02:59:35 UTC**, using:

- macOS arm64, Node **26.0.0**, npm **11.12.1**.
- Pi runtime and MCP client **0.99.0**, Kubernetes MCP Server **0.0.67**.
- Docker **29.6.1**, kind **0.33.0**, kubectl **1.36.1**.
- Checkout base `c5d8829b1350f0aee76da17f5c64c9ac1b7bb73e` plus the uncommitted Slice 5 acceptance tests and fixtures. The package preceded the final documentation/template-comment and test-assertion refinements; runtime source was unchanged.
- Archive SHA-256: `3d0b9daacc0c83a1a0a34cb3483456a1411cbd0ed9356d523a930078b6404bcf`.

`npm pack` built the archive. `npm install --prefix /tmp/pi-sre-phase3-20261020/install <archive> --ignore-scripts --no-audit --no-fund` installed it and its dependencies independently of the checkout. The smoke driver imported the installed `dist` controller/runtime, used an isolated application home, and supplied deterministic model tool calls through real Pi. This verifies installed composition and live Kubernetes routing; it does not establish provider behavior or terminal layout.

Two owned kind clusters, `pi-sre-p3-alpha` and `pi-sre-p3-beta`, each contained Pod `p3-scope/api`, distinguished by `p3-marker: alpha` or `p3-marker: beta`. Operator setup created reader ServiceAccounts with only get/list/watch for diagnostic resources. Independent checks confirmed correct marker reads and denial of Pod create/patch/update/delete. Pi SRE received only the reader kubeconfig; MCP used `read_only = true`, the core/config toolsets, and disabled `configuration_view`. Administrator kubeconfigs were confined to operator setup.

Observed passes:

1. With no CLI/configured rule, the installed application selected live all despite MCP default alpha. With CLI `--clusters alpha beta`, it selected the exact set. Both runs read the same-named Pods in both live clusters with correct distinct markers and exact result provenance.
2. `/clusters --status`, `/clusters beta`, and `/clusters --all` executed through real Pi commands. Singleton beta selection refused missing and excluded alpha model contexts while allowing beta. The widget callback received a standalone READ ONLY line; this callback assertion is not visual terminal verification.
3. Replacing inventory with only alpha exposed the known MCP 0.0.67 singleton limitation: the server omits `configuration_contexts_list`. Pi SRE reported enumeration failure and withdrew all tools, with no fallback.
4. Recovery used `{alpha, gamma}`, where **gamma explicitly aliases alpha's cluster/reader**. Live all admitted alpha/gamma; exact alpha/beta retained alpha and marked beta unavailable. Beta calls and old-generation handlers failed; alpha remained usable. Gamma is not a third physical cluster. Independent added-context behavior is also covered by deterministic fixtures.
5. Restoring the two-context inventory recovered both runs without changing the rule. The original read-only kubeconfig SHA-256 remained unchanged throughout. Application commands never ran `kubectl config use-context` or rewrote kubeconfig.
6. Both runtimes and MCP connections were disposed. Both owned kind clusters were deleted; `kind get clusters` returned **No kind clusters found**. Owned test kubeconfigs were deleted and no owned Kubernetes MCP child remained. No credentials or raw resource payloads are committed to this record.

## Operator-confirmed visual terminal acceptance

The operator confirmed “checked, all passed” and requested Phase 3 completion on 2026-10-20 after receiving the terminal verification steps. This closes the remaining visual terminal gate, including the standalone READ ONLY line, scope/source, members/availability, namespace policy, revisions, MCP state, and the manual checklist below.

Acceptance is based on the operator’s confirmation. The agent did not visually inspect the terminal because computer use denied access to `com.apple.Terminal`. Terminal application/version, exact dimensions, and the operator-tested archive identity were not supplied; no values are inferred. The installed/live smoke archive identity above remains a separate recorded result.

The manual checks use the packaged fixture without Kubernetes or model credentials:

```bash
npm run manual:clusters
```

This launches the packed application outside the checkout using synthetic alpha/beta MCP fixtures and prints its isolated workspace and relaunch command. In the actual terminal:

1. Record terminal application/version and `stty size` before launch. Check the standalone READ ONLY line, scope/source, members/availability, namespace policy, revisions, and MCP state.
2. Run `/clusters --status`, inspect a full name, and close. Run `/clusters`, toggle names, Apply, reopen and Cancel/Escape. Verify cancellation preserves the rule.
3. Run `/clusters alpha`, `/clusters beta`, `/clusters --all`, `/clusters missing`, and `/mcp_restart --force`. Confirm explicit feedback and unchanged selection after an invalid name.
4. Repeat status/picker/cancellation/restart at normal and narrow physical window widths. Record actual dimensions; an escape sequence alone is not visual proof. Use `npm run manual:contexts` to inspect 20/20/5-name pagination.
5. Quit with `/quit`; verify the fixture PID printed in the workspace is no longer running and the terminal is usable. When retaining detailed run evidence, record the tested archive identity, observed results, and terminal dimensions.

Slice 5 and Phase 3 are complete. Phase 4 can build on the accepted execution seam; Investigation Domain and controlled operations remain future phases.
