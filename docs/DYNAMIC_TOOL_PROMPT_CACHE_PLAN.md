# Dynamic Tool Changes and Prompt Cache Preservation

**Target alignment (2026-10-30):** Apply the [simplified conversation/request architecture](./INVESTIGATION_CONTEXT_SIMPLIFICATION.md). Cache optimization must not retain Incident APIs, binding epochs or unsupported session/reload recovery. Retain MCP connection protection and publication readiness; selection changes preserve already admitted diagnostic calls. Dated provider/upstream observations below are historical and have not been reverified by this documentation update.

**Status:** Tracked design and verification work; implementation pending.  
**Recorded:** 2026-10-20.  
**Current dependency baseline:** Pi coding agent, MCP, and TUI 0.99.0.  
**Scope of this record:** Documentation only. No dependency upgrade, provider implementation, tool-policy change, or cache-performance claim is enabled.

This feature follows the [shared discussion about dynamic tools and prompt caching](https://chatgpt.com/share/6ad7b27a-248c-83ea-b79d-1c716751be0b). It records the intended Pi SRE behavior, upstream dependencies, and evidence needed before adoption. Read alongside [DESIGN.md](./DESIGN.md#111-dynamic-tools-and-prompt-cache-preservation) and the [session projection guide](./SESSION_PROJECTION_AND_TRANSCRIPT_CONTEXT.md).

## Problem and goal

Pi SRE changes tool exposure during MCP startup, connection loss, reconnect, schema rediscovery, and scope selection. A model request already in flight uses the declarations sent with that request; changing the runtime registry cannot retroactively change those declarations. Execution must therefore validate the actual call against current application authority.

These changes also affect cost and latency. Tool declarations contribute to the rendered prompt prefix. Rewriting early definitions can prevent reuse of the following prefix even when conversation text is unchanged. This is a cache miss for the changed request, rather than proof that the provider deleted all older cache entries. OpenAI recommends stable tool definitions and ordering, and supports appending tool-loading history where appropriate. [Official prompt caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching).

The goal is to preserve reusable request prefixes across legitimate tool changes through Pi's provider support, while retaining immediate execution refusal for unavailable, stale, incompatible, or unauthorized calls. Cache preservation is an optimization; explicit scope and read-only enforcement remain mandatory.

## Verified upstream references

These are observations checked on 2026-10-20. A merged change is distinct from a published package and from verified behavior in Pi SRE.

| Reference                                                                         | Observed state and relevance                                                                                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Pi PR #9548](https://github.com/earendil-works/pi/pull/9548)                     | Merged September 16, 2026. Records prompt/tool changes in the transcript and supports provider-specific projection.                                      |
| [Pi v1.0.1](https://github.com/earendil-works/pi/releases/tag/v1.0.1)             | October 3 release notes describe inline Anthropic additions and same-name redefinitions that preserve earlier cache prefixes.                            |
| [Pi issue #10940](https://github.com/earendil-works/pi/issues/10940)              | Closed through #11142. Reports repeated prefix rewrites after tool removal followed by later loading.                                                    |
| [Pi PR #11142](https://github.com/earendil-works/pi/pull/11142)                   | Merged October 20, 2026, merge commit `caa6967`. Adds improved Responses handling for tool changes.                                                      |
| [Follow-up commit `530015d`](https://github.com/earendil-works/pi/commit/530015d) | The maintainer's post-merge comment identifies a correction to removal-notice ordering and a regression test. Verify its inclusion as well as the merge. |
| [Pi issue #10489](https://github.com/earendil-works/pi/issues/10489)              | Open at review time. Reports forced system-prompt projection moving later tool declarations into the request head. Track independently of #11142.        |

The #11142 description reports a capability-dependent Responses path that places initial and later definitions in `additional_tools`. It reports same-name replacement between those items, a limitation on overriding top-level definitions, and removal announcements as text rather than native deletion. Its live coverage excludes plain OpenAI Platform API keys and Azure; its measurements are upstream reports, not Pi SRE results. The first npm release containing the fix and follow-up has **not been established in this record**. [Upstream implementation and validation notes](https://github.com/earendil-works/pi/pull/11142).

OpenAI independently documents developer-role `additional_tools` items and requires preserving their position when replaying conversation items. This confirms an API mechanism, not universal compatibility across providers, models, authentication paths, or Pi versions. [Official tool-loading documentation](https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input).

## Current repository baseline

The inspected checkout pins Pi 0.99.0. Its installed `pi-ai` transcript resolver anchors additions only while no removal or redeclaration has occurred; otherwise it resolves the current tools into the request-level catalog. This predates the resolver behavior described in #11142.

Relevant application boundaries are:

- [MCP controller](../src/app/mcp-controller.ts): connection generations, discovery, scope reconciliation, and publication.
- [MCP recovery extension](../src/tui/mcp-restart-command.ts): registers current tools and hides withdrawn tools through Pi.
- [System prompt](../src/runtime/system-prompt.ts) and [resource loader](../src/runtime/resource-loader.ts): stable policy and application-owned loading.
- [Scope extension](../src/tui/cluster-extension.ts): persists changing scope as messages; its turn-start hook restores a scope message rather than returning a replacement system prompt.
- [Tool bridge](../src/mcp/tool-bridge.ts): validates arguments and current execution authority, and withholds stale results.

Two installed Pi projections require particular attention during a future upgrade: hidden declarations can be filtered throughout the projected history, and a forced prompt can collapse system messages with the current catalog at the head. Consequently, append-only serialization in a provider alone is insufficient proof that Pi SRE's actual hide/re-register sequence preserves the prefix.

No live cache measurements or provider compatibility tests were performed for this documentation change.

## Intended design

### Ownership and stable declarations

Pi owns provider request serialization, transcript tool deltas, and provider capability detection. Pi SRE should consume supported upstream behavior rather than implement `additional_tools`, Anthropic inline blocks, or a second provider adapter itself.

Keep names, descriptions, schema representation, and ordering deterministic when their meaning is unchanged. Replacing an execution handler for a new MCP generation does not by itself require changing its model-facing declaration. Genuine discovered-schema changes still require truthful publication and validation; cache reuse must not preserve an obsolete contract.

Current selection and availability remain application state and bounded environment messages. Keep connection identity internal; do not reintroduce domain or selection/inventory revision combinations into result authority. Avoid embedding these changing values in stable tool descriptions or the system prompt merely to communicate availability. Preserve discovered context constraints and require the model's exact target on every cluster-dependent call.

### Publication and execution safety

Maintain the existing transactional reconnect contract: block dispatch, invalidate and cancel old work, discover tools and inventory, resolve the unchanged rule, publish matching tools and notices, then resume dispatch. Keep withdrawn tools unreachable and reject captured handlers from old generations.

Historical declarations and provider removal notices are informational. A model may still propose a removed tool; runtime policy must refuse it. Do not retain executable tools through an outage, expand scope, delay revocation, or replay interrupted calls to improve cache hits. Any future separation of historical declarations from current exposure must preserve these guarantees and be explicitly tested.

Distinguish capability changes from contract changes. Newly available tools can be announced at a request boundary. Redefining an existing schema or implementation must not reinterpret a call generated under an older contract. Retain schema validation, generation checks, exact target checks, cancellation, and stale-result withholding.

### Provider fallback and lifecycle

Use Pi's supported capability path for each provider/model. Unsupported paths may legitimately rebuild the request catalog and incur a miss; correct requests and current authority take precedence. Do not assume Responses, Chat Completions, Codex sign-in, API-key access, gateways, and Anthropic have equivalent support.

Avoid per-turn system-prompt replacement for scope updates. During verification, inspect both the configured resource-loader prompt and extension hooks for the projection issue reported in #10489. Preserve delta ordering through MCP tool replacement and manual/automatic compaction. The simplified architecture assumes a single session and no reload/resume/branch-navigation compatibility; entry-point restrictions ship separately. Compaction, model changes, or an upgrade may establish a new cache baseline; unchanged-prefix assertions apply within comparable baselines.

## Work tracker

- [x] Read the originating conversation and check its main upstream references.
- [x] Inspect the installed dependency baseline and relevant Pi SRE integration points.
- [x] Record the feature and its execution-safety constraints in the design.
- [ ] Identify a released, compatible Pi package set containing #11142 and `530015d`; record exact versions and release evidence.
- [ ] Recheck #10489 and the hidden-declaration projection in that candidate version.
- [ ] Define the provider/model/authentication matrix actually supported by Pi SRE.
- [ ] Upgrade dependencies in a separate implementation change and resolve public API changes without bypassing application policy.
- [ ] Exercise production Pi SRE composition with synthetic MCP discovery and captured, sanitized provider requests.
- [ ] Run explicit live cache measurements for each claimed supported path.
- [ ] Record results, unsupported paths, and any expected one-time baseline misses before declaring adoption complete.

**Proposed sequencing:** Treat this as cross-cutting runtime maintenance after current context-routing correctness work. It does not add a Phase 3 acceptance prerequisite or renumber the roadmap. Revisit before expanding the tool surface in Phase 5. Documentation records the work; implementation scheduling remains open.

## Acceptance and measurement

| Scenario                                                          | Required evidence                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Unchanged discovery or idle selection with unchanged declarations | Deterministic declarations and ordering; no unnecessary schema/text churn.                                                            |
| Addition after prior requests                                     | On a supported append-only path, previous serialized content stays in place and the new declaration appears later.                    |
| Removal followed by further additions                             | The removed tool remains unexecutable; later additions do not repeatedly rewrite the earlier catalog on the claimed supported path.   |
| Same-name schema redefinition                                     | The new contract is published truthfully; obsolete arguments or old-generation handlers cannot dispatch under a substituted contract. |
| MCP loss, failed enumeration, empty resolution, and recovery      | Existing dispatch gates, stale-result rejection, and exact/all semantics pass using the real hide/re-register path.                   |
| MCP replacement and manual/automatic compaction                   | Tool history and current execution authority remain consistent; expected cache-baseline resets are documented.                        |
| Unsupported provider or authentication path                       | Valid fallback requests and truthful availability; no unsupported append-only or cache-hit claim.                                     |

Offline tests should inspect synthetic request structure without logging real prompts, credentials, kubeconfig, or Kubernetes payloads. Test both the supported provider path and its fallback. Existing scope, cancellation, and recovery tests remain correctness gates.

Live measurements should record dependency versions, provider/API, model, authentication category, scenario, input/cache-read/cache-write tokens when available, and latency. Compare a warmed unchanged-tools control with the same synthetic conversation containing tool transitions, using enough input to meet that model's caching requirements. Report repeated observations rather than promising a fixed hit rate. Pi's normalized usage and provider usage fields must be reconciled before comparing results; unavailable metrics should remain unknown. Cache eviction, routing, retention, and model behavior can still cause misses even when the request prefix is preserved.

Completion requires the dependency evidence, production-path structural tests, safety regressions, and a dated provider-specific result record. It does not require a custom provider implementation, tool-search product feature, new Kubernetes operation, or incident/evidence service.
