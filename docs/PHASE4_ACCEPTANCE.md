# Phase 4 — Investigation Domain Acceptance

**Status (2026-10-29): Automated gate and installed-package/live-cluster smoke passed. Visual terminal acceptance is pending; Slice 7 and Phase 4 are not yet fully accepted.**

This record covers [Slice 7](./PHASE4_IMPLEMENTATION_SLICES.md#13-slice-7--full-path-acceptance-and-phase-gate). Historical Phase 1–3 acceptance records remain unchanged. No Kubernetes operation, mutation capability, archive UI, or cross-process restoration was added.

## Automated acceptance

[phase4-acceptance.test.ts](../tests/integration/phase4-acceptance.test.ts) adds **21 cases** using CLI parsing, configuration loading, production `McpController`/`createSreRuntime`, real Pi command dispatch and agent execution, and the recording stdio MCP fixture. Only provider output and credential preflight are synthetic. CI requires neither cluster access nor provider credentials.

The suite verifies:

- Default live `*` despite MCP default metadata, explicit CLI/config precedence, invalid explicit startup without fallback, singleton/exact/all model targeting, and distinct evidence for same-named resources.
- Evidence already stored when Pi emits each successful tool completion; local evidence inspection, multi-context supporting hypotheses, deferred supported conclusion, and terminal-state inspection without creating a successor.
- Compaction/reload preserving evidence identity, timestamps and consumed budget; next-B selection preserving exact-A authority; explicit successor using B and refusing predecessor evidence.
- Active exact/all reconciliation from `{alpha, beta}` to `{alpha, gamma}`, unavailable next-B without disabling usable incident scope, newly admitted gamma reported not checked, stale handler refusal, and unchanged historical evidence/budgets.
- Failed/empty inventory, per-context authorization failure, authentication/operation/malformed/timeout failures, empty success, bounded large success, rediscovered schema validation, and budget refusal across reconnect without dispatch.
- Cancellation, restart and shutdown of active/queued parallel calls without false evidence or leaked children; fork/new isolation, same-process resume, and a fresh application owner refusing evidence/authority reconstructed from the same transcript.

The [packaged CLI test](../tests/e2e/package.test.ts) now checks incident/evidence help, next-selection semantics, process lifetime, and required Investigation Domain modules in the npm payload. It still launches the extracted executable outside the checkout without network access, reusing locked dependencies.

Focused domain/investigation tests and the new acceptance/package suites passed. The canonical stop-on-failure gate passed:

```text
npm run format:check
npm run lint
npm run check
npm test                 670 passed; 7 optional executable-dependent contract tests skipped
npm run build
```

The initial formatting gate found existing table/list formatting violations in the two investigation usage/history guides. Those changes are formatting only. The live harness initially compared Python-formatted baseline JSON with an operator-restored JavaScript serialization; its checksum assertion correctly failed. The harness was corrected to restore the original bytes, and all three smoke variants were rerun successfully. No application kubeconfig rewrite was observed.

Existing focused suites remain part of acceptance rather than duplicating all race harnesses:

| Contract                                                                                                                                         | Executable coverage                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final lease/cancellation check, retained/returned excerpt and provenance, out-of-order completion, completion-time storage refusal               | [incident-diagnostic.test.ts](../tests/unit/mcp/incident-diagnostic.test.ts), [incident-observations.test.ts](../tests/integration/incident-observations.test.ts)                              |
| Public argument validation, revision conflicts, foreign cursors, interrupted/stale conclusions, bounded summaries, inspection during outage/work | [investigation-tools.test.ts](../tests/integration/investigation-tools.test.ts)                                                                                                                |
| Eligible input, preflight, queued delivery, session transitions, vetoes and lifecycle identity                                                   | [phase4-controller-lifecycle.test.ts](../tests/integration/phase4-controller-lifecycle.test.ts), [phase4-lifecycle-contracts.test.ts](../tests/integration/phase4-lifecycle-contracts.test.ts) |
| Publication gating, schema replacement, generation invalidation, queue limits, admission races and cancellation                                  | [mcp-restart.test.ts](../tests/integration/mcp-restart.test.ts), [queued-admission.test.ts](../tests/unit/mcp/queued-admission.test.ts)                                                        |

## Installed-package and disposable-cluster smoke

Executed on 2026-10-29, finishing **18:45:08 UTC**, with:

- macOS arm64; Node **26.0.0**, npm **11.12.1**.
- Pi coding agent/MCP/TUI **0.99.0**; Kubernetes MCP Server **0.0.67**.
- Docker **29.6.1**, kind **0.33.0**, kubectl **1.36.1**; kind node image **v1.37.0**.
- Checkout base `1b3003d117b0b515a8942e8cb369268a1646785e` plus uncommitted Slice 7 acceptance tests, packaged help/checks and formatting fixes. The acceptance record, status documentation and manual-launch hints were written later; runtime source was unchanged after packing.
- Archive SHA-256: `3950e6bc58d7ea810e4acc3baae103cff1f3b508d7eb111de1505b0fdfcc7825`.
- Model: deterministic synthetic provider stream; Pi selected its offline `unknown` model descriptor. No remote model request, provider authentication, or reasoning quality is claimed.

`npm pack` built the archive. It was extracted into `/tmp/pi-sre-phase4-20261029/package`, with a symlink to the checkout's locked dependencies. The driver ran outside the checkout and imported application code exclusively from that extracted `dist`. This is extracted-package execution, not an independent dependency installation or visual TUI test.

Two owned clusters, `pi-sre-p4-alpha` and `pi-sre-p4-beta`, contained same-named Pod `p4-scope/api` with distinct `p4-marker` labels. Operator setup created reader ServiceAccounts with only get/list/watch on diagnostic resources. Independent reads verified the markers; Pod create/patch/update/delete and Secret reads were denied. Pi SRE used only the reader kubeconfig; MCP used `read_only = true`, core/config toolsets and disabled `configuration_view`. Administrator kubeconfigs were confined to fixture preparation.

Observed passes:

1. **Exact singleton:** create on alpha, query and inspect its evidence, compact/reload, select next beta, and make another fresh alpha observation. Explicit replacement created a new incident and fresh beta evidence. A supported hypothesis and resolved conclusion remained inspectable through local tools and commands. The successor ended with one evidence record and one spent attempt.
2. **Exact set and default live `*`:** each created one incident with independent alpha/beta observations for the same Pod name, then preserved evidence, budgets and rule across compaction/reload and reconnect. Each concluded with five evidence records and five spent attempts, all with matching context/marker provenance.
3. **Removal/reappearance:** the operator removed beta from a disposable inventory copy. MCP 0.0.67 omits enumeration for a singleton inventory, so Pi SRE reported enumeration failure and blocked diagnostics without fallback. Stored evidence remained locally inspectable and old handlers failed. Restoring both contexts recovered fresh alpha/beta observations under the unchanged incident rule. Partial availability, added gamma, not-checked reporting and exact/all distinctions are proved by deterministic acceptance fixtures; no third live cluster or alias is claimed.
4. **Interruption/recovery:** terminating the owned MCP process reported transport unavailability while local evidence remained inspectable. `/mcp_restart` recovered fresh alpha evidence without resetting incident identity or budget.
5. **Presentation callbacks:** `/incident`, `/evidence`, `/clusters --status` and recovery commands executed through real Pi. Widget callbacks included READ ONLY. These assertions do not establish readability at physical terminal widths.
6. **Boundary and cleanup:** the reader kubeconfig checksum remained unchanged across application activity, including selection/recovery; operator inventory changes restored original bytes. No raw-result/archive artifact appeared in the application-home top-level entries. Every observed owned MCP child exited. Both disposable kind clusters and private admin/reader kubeconfig files were removed after the run. No credentials, raw resource payloads or transcript files are committed here.

## Remaining visual gate and short runbook

Computer Use refused access to `com.apple.Terminal`. No visual terminal pass is inferred from widget callbacks, historical Phase 3 confirmation, or live SDK execution. Operator confirmation is required to close this remaining acceptance item.

Use the packaged fixture launcher, with no Kubernetes or model credentials required for commands:

```bash
npm run manual:clusters
```

It builds/extracts a fresh archive outside the checkout and prints its isolated workspace and relaunch command. This new package has a separate identity from the live archive above; record its checksum if retaining detailed evidence.

1. Record terminal application/version and actual rows/columns. At normal and narrow physical widths, run `/clusters alpha`, `/incident new Inspect alpha`, `/clusters beta`, `/incident`, `/evidence`, and `/clusters --status`. Verify READ ONLY, namespace policy, effective incident alpha versus next beta, availability, revisions, readable inspection/empty-evidence feedback, and distinct repeated-command acknowledgments.
2. Run `/incident new Inspect beta`; verify current beta and reset incident counts. Try `/clusters`, inspect picker Apply/Cancel, and `/clusters missing`; cancellation and invalid input must preserve selection. Run `/mcp_restart --force` and inspect the retained incident/next display.
3. For visual evidence rendering, use `/login` only in the isolated home and ask to inspect a Pod with exact context beta. Inspect its returned ID using `/evidence <id>`, then `/evidence`. A provider is optional for the command/layout checks; the automated/live SDK runs already establish stored evidence and conclusion behavior.
4. Quit with `/quit`; verify terminal input/echo/cursor restoration and that the printed fixture PID exited. Report observed outcomes, terminal/version, dimensions, and any limitations. Do not include credentials or raw transcripts.

For a future live repetition, use two disposable clusters, same-named marker Pods and reader-only identities as above. Keep all operator fixture writes separate from Pi SRE. Repeat alpha-to-next-beta, replacement, exact/all routing, compact/reload, MCP interruption, inventory removal/reappearance, local supported/inconclusive conclusion and inspection. Record revision/archive identity, versions, deterministic versus remote model, safe context labels, kubeconfig checksum and cleanup. MCP 0.0.67's singleton enumeration limitation must be recorded separately from partial-availability success.

Close Slice 7 and Phase 4 only after the visual result is explicitly recorded. Phase 5 remains a separate opt-in controlled-operations design; diagnosis is still read-only.
