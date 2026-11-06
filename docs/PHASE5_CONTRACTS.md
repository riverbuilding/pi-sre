# Phase 5 Contracts — Kubernetes MCP Config/Core Parity

Frozen for Slice 0 on 2026-11-05. This is a design and compatibility contract,
not a claim that the later slices are implemented. Production still exposes the
six existing diagnostics, accepts only `safety.mode: read-only`, and uses the
unchanged read-only MCP example. No controlled tool was invoked for this work.

**MVP scope revision (2026-11-05):** Only the **Multi-Context kubeconfig Provider** is supported. Other providers and their target discovery/parameter mappings are deferred for consideration until after MVP; they are not Phase 5 acceptance gaps. **Exec tools, including `pods_exec`, are unsupported in every profile**, even with human approval or improved server limits. The 22-row upstream inventory remains reference evidence; the MVP delivery target is **20 definitions: 15 reads (some platform/API-conditional) and 5 controlled operations**, excluding `targets_list` and `pods_exec`.

Pi SRE has no dedicated adapter that understands or compensates for Kubernetes MCP Server operation semantics. Users and the LLM interpret discovered descriptions, choose arguments, assess side effects, and decide any preflight, follow-up verification or correction through ordinary permitted calls. The server owns Kubernetes execution semantics. Pi SRE retains a thin shared bridge for discovered-schema validation, explicit context and policy checks, approval of the exact call, budgets, cancellation, connection identity, and bounded/redacted results. It does not synthesize operation-specific plans, infer dependent effects, emulate create-only behavior, or compensate/rollback operations. Human approval authorizes the displayed call; it is not a guarantee of inferred effects or atomic resource identity.

## Selected versions and evidence

- Kubernetes MCP Server **0.0.67**, the installed executable and existing Phase 2
  baseline. The 22 reference definitions remain those from 0.0.61; no downgrade.
- Pi coding agent **0.99.0**, as pinned in `package.json`. Approval/UI inspection
  used its installed public declarations and implementation, not guessed APIs.
- [Captured descriptors](../tests/fixtures/phase5-server-0.0.67.json) contain full
  discovered input schemas, annotations and descriptions for six scenarios.
  These are test evidence only; production continues consuming discovered schemas
  without exact schema matching or annotation-based authorization.
- [Source facts](../tests/fixtures/phase5-server/source-facts.json) identify the
  versioned source paths, SHA-256 digests and facts not demonstrated by discovery.
  In particular, the generic provider example is source-derived, not a live ACM test.
- [Probe](../tests/fixtures/phase5-server/probe.ts) starts the real stdio server
  against a temporary synthetic kubeconfig and loopback API discovery. It performs
  `tools/list`, never `tools/call`; it uses no real kubeconfig, credentials or cluster.
  Temporary files and processes are cleaned up. OpenShift/metrics evidence is
  simulated discovery, not a live OpenShift or Metrics Server acceptance run.
- [Contract tests](../tests/unit/mcp/phase5-contracts.test.ts) run offline by default;
  setting `PI_SRE_CONTRACT_SERVER` also compares all six real-server scenarios.

Reproduce with the selected executable:

```bash
PI_SRE_CONTRACT_SERVER=kubernetes-mcp-server node --import tsx scripts/capture-phase5-server.ts
npm run format
PI_SRE_CONTRACT_SERVER=kubernetes-mcp-server npm test -- tests/unit/mcp/phase5-contracts.test.ts
npm run verify
```

Review regenerated fixtures; do not update snapshots to conceal incompatibility.
The capture script checks the version before writing the repository fixture.

## Capability matrix

**Status** describes compatibility with the selected server, not current application
exposure. **Supported** means a descriptor exists and can use the shared policy/tool bridge;
**conditional** requires the supported platform/API stated; **excluded** is outside MVP; **incompatible** blocks
safe enablement until the specified resolution. All rows share final-schema validation,
bounded/redacted presentation, no raw retention, request limits and original-connection
ownership. Every core operation additionally requires one exact model-supplied context,
even with one selected context. Configuration inspection/discovery are inventory reads.

Schema references below are exact tool names under `cases.unfiltered` in the capture,
unless another case is specified. Required arguments shown exclude Pi SRE's required
context. `R` means eligible for either future profile after its slice; `C` means
controlled profile with individual approval only. Only rows marked **current** are
enabled today. No historical tool has been silently mapped to a different operation.

| #   | Toolset / reference and discovered name                | Status / availability / schema evidence                                            | Profile and argument policy                                                                                | Result handling / delivery evidence                                                                                            |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | config / `configuration_contexts_list`                 | Conditional: multi-context kubeconfig; absent in singleton/disabled cases          | R; accepts `{}`; no context injection                                                                      | Validated inventory fields; default metadata does not narrow selection. Current; existing discovery tests plus all probe cases |
| 2   | config / `targets_list` → `{targetParameterName}_list` | Excluded from MVP: non-kubeconfig provider discovery; source-derived evidence only | No profile; no aliases or provider mapping                                                                 | Consider other providers only after MVP; no delivery gap                                                                       |
| 3   | config / `configuration_view`                          | Supported; schema optional `minified` boolean; remains in server read-only case    | R; safe local projection required; never publish raw configuration                                         | Structural summary only, described below. Slices 1/3; descriptor evidence only                                                 |
| 4   | core / `events_list`                                   | Supported; optional namespace/fieldSelector                                        | R; namespace omission is server policy, not proof of all namespaces                                        | Bounded events with exact source. Current; existing tests and descriptor probe                                                 |
| 5   | core / `namespaces_list`                               | Supported; optional fieldSelector                                                  | R; cluster scoped                                                                                          | Bounded namespace summary. Current; existing tests and descriptor probe                                                        |
| 6   | core / `projects_list`                                 | Conditional: Project GVK; compare kubernetes and openshift-metrics cases           | R; cluster scoped; advertisement alone cannot establish target support                                     | Project summary; per-target failure remains possible. Slice 2; simulated discovery only                                        |
| 7   | core / `nodes_log`                                     | Supported; required name/query; optional tailLines                                 | R; service query only initially, finite tailLines 1–1000, default 100; reject file paths                   | Bounded redacted logs; kubelet/proxy/RBAC failures distinct. Slice 2; schema plus source facts                                 |
| 8   | core / `nodes_stats_summary`                           | Supported; required name                                                           | R; finite request deadline; no server item/output parameter                                                | Bounded statistics, not raw node/pod details. Slice 2; descriptor evidence                                                     |
| 9   | core / `nodes_top`                                     | Conditional: NodeMetrics API; filtering cases demonstrate absence/presence         | R; optional name/label_selector, finite deadline                                                           | Bounded CPU/memory; missing metrics differs from empty results and RBAC denial. Slice 2                                        |
| 10  | core / `pods_list`                                     | Supported; selectors, no namespace argument                                        | R; server lists all namespaces in the exact context                                                        | Bounded pods; do not describe it as a namespaced list. Current; schema/probe and existing tests                                |
| 11  | core / `pods_list_in_namespace`                        | Supported; required namespace plus selectors                                       | R; explicit nonblank namespace; no substitution with pods_list                                             | Bounded namespace-attributed pods. Slice 2; distinct schema captured                                                           |
| 12  | core / `pods_get`                                      | Supported; required name; optional namespace                                       | R; omission retains server/context namespace policy                                                        | Bounded redacted pod. Current; existing tests and descriptor probe                                                             |
| 13  | core / `pods_delete`                                   | Supported; required name; optional namespace in server schema                      | C; explicit namespace/name; shared exact-call approval                                                     | Bounded safe result/receipt; user and LLM assess dependent effects and verification. Slice 5                                   |
| 14  | core / `pods_top`                                      | Conditional: PodMetrics API; filtering cases demonstrate absence/presence          | R; honor all_namespaces (server default true), namespace/name/label_selector; no silent namespace widening | Bounded metrics with actual namespace coverage. Slice 2                                                                        |
| 15  | core / `pods_exec`                                     | Unsupported by Pi SRE, regardless of server limits                                 | No profile; never expose or dispatch                                                                       | Historical descriptor/source facts only; no enablement work                                                                    |
| 16  | core / `pods_log`                                      | Supported; required name; optional namespace/container/tail/previous               | R; tail 1–1000, default 100; no streaming                                                                  | Existing bounded redacted logs. Current; existing tests, schema and source facts                                               |
| 17  | core / `pods_run`                                      | Supported; required image; optional name/namespace/port                            | C; explicit name/namespace; shared policy and exact-call approval                                          | User and LLM interpret apply behavior, defaults and side effects; no create-only emulation. Slice 5                            |
| 18  | core / `resources_list`                                | Supported; required apiVersion/kind; optional namespace/selectors                  | R; exact GVK allowlist; list omission means all namespaces for namespaced kinds                            | Structural resource projection before normalizer. Slices 1/2; schema captured                                                  |
| 19  | core / `resources_get`                                 | Supported; required apiVersion/kind/name; optional namespace                       | R; exact GVK allowlist; omission uses configured namespace                                                 | Structural resource projection; distinguish empty/not-found/failure. Slices 1/2                                                |
| 20  | core / `resources_create_or_update`                    | Supported; required resource string; server owns apply semantics                   | C; single object, explicit identity/namespace; sensitive-resource and authority policy                     | Safe exact-input preview and receipt; user and LLM assess omission/removal semantics. Slice 5                                  |
| 21  | core / `resources_delete`                              | Supported; required apiVersion/kind/name; optional namespace/gracePeriodSeconds    | C; explicit namespace, allowlisted GVK; discovered-schema and shared policy checks                         | Safe exact-call preview/receipt; user and LLM assess cascading effects and verification. Slice 5                               |
| 22  | core / `resources_scale`                               | Supported; required apiVersion/kind/name; optional namespace/scale                 | C for the whole tool, including omitted scale; initial controlled GVK policy applies                       | Exact arguments and server outcome; user and LLM interpret requested/ready replicas. Slice 5                                   |

## Availability and compatibility resolutions

The unfiltered kubeconfig probe advertises **21** definitions; generic target listing
is mutually exclusive with context discovery. The server read-only case advertises
**15** and removes exactly the six controlled definitions. This does not authorize
all 15 in Pi SRE: configuration inspection and resource reads still need access/presentation policy.

Compatibility filtering is experimental and disabled by default in 0.0.67. Without
it, the ordinary Kubernetes mock still advertises projects and metrics tools. With
`experimental_enable_target_compatibility_tool_filters = true`, ordinary discovery
advertises 18 definitions; OpenShift plus metrics discovery advertises 21. Filtering
checks whether **any** target has a GVK; one matching target does not establish that
all selected targets support it. The shared bridge must retain context-attributed failures.
The [server filter](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/mcp/mcp.go)
and [namespace registration](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/toolsets/core/namespaces.go)
support these observations.

The supported-provider compatibility boundary remains explicit:

**Singleton/disabled-provider mode:** 0.0.67 removes context discovery and core
context arguments. A singleton _application selection_ is supported when the server
retains a multi-context inventory; a singleton _server inventory_ is incompatible.
Keep fail-closed behavior. Resolution requires a reviewed upstream version/change
retaining context enumeration and explicit context transport in singleton mode,
followed by new fixtures. Never infer or inject context to bypass this boundary.

Other-provider naming and unbounded exec observations in the captured source facts
remain historical compatibility evidence only. `targets_list` and provider-specific
successors are deferred beyond MVP; `pods_exec` is explicitly unsupported even if a
later server supplies limits. Neither is a blocker for the 20-definition MVP target.

The server's pod deletion side effects and pod-run apply semantics are facts for users
and the LLM to interpret from server descriptions/results. Pi SRE does not add dedicated
pod adapters, mandatory semantic preflight, absence checks, semantic diffs, dependent
resource enumeration, resource-version race emulation or create-only guarantees. It
approves the exact permitted MCP call and reports the server outcome with provenance.
Any verification or corrective action is a separately chosen call under the same policy
and approval boundary; there is no automatic retry, compensation or rollback.

## Startup configuration and resource policy

Slice 4 will extend the existing `safety.mode` with exactly `read-only` (default) and
`controlled-operations`. No model argument, skill, UI tool call or context wildcard can
change the profile. Profile changes require process restart. A separately supplied,
reviewed MCP TOML and Kubernetes credentials must match it; never rewrite the current
read-only file or expand RBAC automatically. A write-enabled or unverifiable connection
must not display READ ONLY. Controlled mode always displays
`CONTROLLED OPERATIONS — APPROVAL REQUIRED`, even during diagnostics.

Planned controlled configuration is `safety.controlledOperations` with:

| Field                     | Frozen policy                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `enabledTools`            | Explicit reviewed subset of the five controlled names; default empty; Exec names always rejected       |
| `approvalTimeoutMs`       | Default 60,000; positive integer at most 60,000                                                        |
| `callTimeoutMs`           | Default 30,000; positive integer at most 60,000; effective deadline also respects existing MCP timeout |
| `maxOperationsPerRequest` | Default 1; integer 1–10; independent subset of maxToolCalls                                            |

Reject controlled-only settings in read-only mode; reject unknown fields and names.
These keys are contracts only in Slice 0: the existing schema still rejects them.
No changes to execution.maxToolCalls/maxModelIterations defaults or reset semantics.

Slice 1 introduces `safety.resources.allowedReadKinds`, exact canonical apiVersion/kind
pairs covered by the resource presentation policy. Initial defaults:
`v1/{Pod,Service,Endpoints,Node,Namespace,Event,ConfigMap,PersistentVolumeClaim,PersistentVolume}`,
`apps/v1/{Deployment,ReplicaSet,StatefulSet,DaemonSet}`,
`batch/v1/{Job,CronJob}`, `networking.k8s.io/v1/{Ingress,NetworkPolicy}`,
`discovery.k8s.io/v1/EndpointSlice`, and `events.k8s.io/v1/Event`.
Configuration may narrow this set; adding CRDs or aliases needs policy and presentation review.
Use canonical exact GVKs; deny subresource/path syntax, wildcard kinds, ambiguous group
versions, Secret/List kinds and unknown kinds before transport. Do not resolve kinds
by fetching prohibited resources. ConfigMaps expose metadata and key counts only;
withhold data/binaryData. No configurable Secret opt-in is included in this milestone.

Generic resource presentation allowlists safe fields for identity, ownership,
conditions, replica counts, scheduling, resource requests/limits and service routing.
Withhold arbitrary annotations (including last-applied configuration), managedFields,
literal environment values, arbitrary data/status extensions and credential-bearing
URLs. Accept extra response fields and discard them; do not require full resource
response schemas. Apply structural withholding to text and structured content before
the existing bounded normalizer, error logging or Pi publication. Reject malformed
presentation safely without echoing source payloads. Control characters in identities
are rejected; text controls are neutralized. Server resource restrictions and narrowly
scoped RBAC must deny sensitive resource access too; read_only alone does not deny Secrets.

Initial controlled GVKs are namespaced Pod, Deployment and StatefulSet only; deny
Secrets, RBAC, CRDs, namespaces, nodes, admission configuration and other authority
expansion. Manifests cannot set another namespace/context, request privileged/host
access, mount host paths, or introduce credential material. Validate only policy and
identity fields; Kubernetes owns full validation. Raw manifests must not enter
logs or execution records. If sensitive material prevents a useful review of the exact call, reject
the proposal rather than approving hidden arguments.

configuration_view gets a separate safe projection: context/cluster names, context
namespace, and sanitized endpoint origin only. Withhold users/auth-infos, auth-provider,
exec configuration, certificates/keys, tokens, file paths, proxy URLs, extensions and
unknown fields. Never forward raw YAML, even with minified=true; it refers to the
server default, not the user's current selection. Extract only necessary structure
in memory, discard raw content, then redact/bound the projection. Fail closed on
parse errors. Pattern redaction is a final presentation layer, not the access policy.

## Pi UI and execution ordering

Inspected public APIs: `ExtensionUIContext.select`, `confirm`, `custom`, context `hasUI`,
`ExtensionUIDialogOptions { signal, timeout }`, tool `prepareArguments`, `execute`
and `executionMode`, and tool_call/message_end events. Installed implementation paths
are relative to `node_modules/@earendil-works/pi-coding-agent/dist/`:

- `core/extensions/types.d.ts` declares the contracts. `ToolCallEventResult` documents
  that handlers can mutate input and later handlers see those mutations without
  automatic revalidation. `core/extensions/runner.js:emitToolCall` awaits handlers in
  registration order and stops when blocked.
- The pinned nested pi-agent-core `agent-loop.js:prepareToolCall` finds the tool,
  runs prepareArguments, validates arguments, awaits beforeToolCall (AgentSession
  emits tool_call), checks abort/block, then prepares execution. The execution scheduler
  can run parallel tools; a UI hook is not a serialization boundary. Direct execute
  calls can bypass these hooks. Mandatory policy and approval belong in the shared
  application admission/dispatch path and must revalidate final arguments there.
- `modes/interactive/interactive-mode.js:showExtensionConfirm` maps a selector of
  Yes/No to boolean. Abort, Escape and timeout dismiss without approval; an already
  aborted signal never opens it. `components/extension-selector.js` starts on the
  first option. Use `ctx.ui.select` with **Deny first**, then an explicit approval
  option; only that exact returned value approves. Serialize dialogs.
- Dialog cancellation is opt-in through the supplied signal, not an implicit link to
  the request. Combine call, request, connection retirement, policy invalidation and
  expiry signals. Recheck after the dialog resolves; a late positive UI response
  cannot revive an invalid proposal. Dispose listeners on all settlement paths.
- The runner's no-UI implementation returns false/undefined. RPC provides response
  promises with cancellation/timeout, but is not an authenticated approval channel
  for this milestone. Initial controlled approvals require the application interactive
  terminal; print, RPC and headless/direct paths fail closed without that channel.

Slice 4 must exercise these public APIs with real Pi: changed arguments after a hook,
direct-handler invocation, pending approval abort/timeout, late response, dialog cleanup,
and no-UI refusal. Slice 0 source inspection is not visual terminal acceptance. New
sensitive proposal/result paths also require message-boundary tests proving Pi history,
renderers and validation errors cannot retain raw sensitive input/output. Tool_result
hooks alone are insufficient, as pre-handler errors can bypass them. Reuse the existing
message_end protection and extend it before enabling any new sensitive capability.

## Approval identity, freshness and dispatch

Use one AgentSession, existing request identity, selection and connection controller.
Approval is an ephemeral, immutable **single-call permit**, not an incident, transcript
authority, domain revision, reusable token or persisted grant.

1. Validate model arguments and copy final transport arguments. Resolve no implicit
   context. For controlled calls require explicit resource identity/namespace, including
   identity fields in a single manifest where applicable. Freeze the exact transport
   string; reject duplicate keys, identity-obscuring aliases, multi-document input and
   generated names. These are scope/policy checks, not Kubernetes semantic validation.
2. Acquire the session-wide controlled-operation slot before approval. Serialize every
   controlled operation through terminal settlement; diagnostics retain ordinary budgets.
   Pi SRE does not generate preflight calls. Users and the LLM may choose ordinary
   permitted read calls, which consume the ordinary request tool budget.
3. Freeze requestId, toolCallId, operation, final-argument canonical fingerprint and
   immutable copy, explicit context/namespace/GVK/name where applicable, original
   connection and descriptor objects, profile, capability/resource policy, concrete
   selection rule, available context token, safe exact-call preview and absolute expiry.
   Fingerprints are private in-memory comparison aids, not model-visible records.
   Do not require inferred dependent identities, UID/resourceVersion preflight or
   physical-cluster guarantees that the provider does not supply.
4. Show the exact tool, context and policy-safe final arguments. Do not generate semantic
   change plans or claim to enumerate effects. If sensitive material prevents a useful
   review, refuse the proposal. Users and the LLM assess operation semantics from the
   server descriptions and chosen observations. Denial, no UI, cancellation or expiry
   makes no controlled call. Validity ends at the earlier of the dialog deadline and
   60 seconds from proposal creation; queueing never renews it.
5. Immediately before dispatch compare the frozen call and application-owned authority
   facts; revalidate final schema, selection, availability, profile and permissions.
   This checks approval of the exact call, not resource freshness or atomic identity.
   The server owns operation semantics and supported Kubernetes preconditions.
6. With no await between final local checks and invocation, consume approval, charge
   maxOperationsPerRequest and maxToolCalls once, record dispatch and invoke the original
   connection. No automatic mutation retry, migration, replay or compensation.

Invalidation is sticky for the permit: changing selection away and back, target
removal/reappearance, descriptor replacement, reconnect, profile/policy change, argument
change, request finish/replacement/cancellation or expiry cannot restore it. Observe
these transitions while the permit is pending; comparing only final values is
insufficient. This requires lifecycle notifications/latching invalidation in Slice 4,
not restoration of domain revisions. A same-value selection reaffirmation and an
unrelated inventory refresh preserving the target token do not invalidate it. A new
live-* inventory member does not expand the permit: it remains bound to one original
target. Changing exact membership or exact/all mode does invalidate it.

The existing diagnostic rule remains: selection changes do not retroactively reauthorize
or cancel accepted reads. The stricter controlled checks are an additional dispatch
gate, not a change to that read contract. Approval must be enforced below tool visibility
and Pi hooks, including direct programmatic calls.

## Budgets, outcomes and safe execution records

Pre-dispatch refusal consumes neither controlled nor dispatch budget. Already-dispatched
failures, timeouts and cancellation consume both and never refund. Environment messages,
compaction, reconnect and continuation never reset request budgets. Approval cannot
outlive the owning request. Expired or denied calls require a fresh proposal, not a
renewed permit. All five operations share the session-wide serialized slot.

Logs use 100 lines by default and a hard 1000-line argument limit; no zero/unlimited
or streaming mode. Node log schema defaults do not prove actual retrieval defaults:
source shows omitted/zero tailLines omits the query limit. Always send the finite
validated value. Metrics/stats use the existing finite MCP timeout and presentation
limits where the server offers no retrieval-size argument. Exec is excluded, not waiting
for a server upgrade or bounded-output implementation.

Maintain only bounded session-memory execution receipts, maximum 100 FIFO entries,
separate from diagnostic messages; no file/archive/export/raw payload storage. A receipt
contains operationId, requestId/toolCallId, safe operation and target/resource identity,
profile, proposed/approved/dispatched/settled times where applicable, and an outcome:
`not-executed` (denied/expired/invalidated/refused), `server-reported-success`,
`server-reported-failure`, or `outcome-unknown`. Include only a safe reason code and
bounded approved summary (e.g. requested replicas); omit manifest, command output,
raw arguments, configuration, credentials and unfiltered error messages.

Any post-dispatch transport loss, timeout, cancellation or ambiguous server error
may follow an external effect: classify **outcome-unknown**, not rollback or definite
failure. Do not imply that remote execution stopped. The user and LLM assess the reported
uncertainty and choose any read-only verification or further proposal; Pi SRE does not
implement a reconciliation engine or infer when Kubernetes effects are safe. Any further
controlled call requires a fresh approval; restart is not proof of remote termination.
Never issue another attempt automatically. An MCP tool error is a server-reported
failure, not proof that no partial effects occurred; retain that uncertainty in the
result rather than inferring rollback or atomicity. Fresh read calls carry their own
timestamps and provenance and can verify
state; successful mutation acknowledgement alone establishes neither recovery nor
health. Original observations retain their original times.

## Slice 0 acceptance and remaining work

The 22 rows now have descriptor or explicit conditional source evidence, with
MVP exclusions, incompatibilities and resolution paths recorded. Offline fixtures and the opt-in
six-case real-server discovery suite cover inventory, platform filtering, namespace
schema distinctions, historical log/exec facts and unchanged application allowlisting.
The six server-controlled definitions in the fixture describe server filtering, not
the five-operation Pi SRE target; fixtures are preserved as upstream evidence. Runtime
implementation begins in Slice 1; later slices own policy/approval tests, server
compatibility work for the supported provider, live operations, installed-package and visual acceptance.
Full Phase 5 parity is **not complete**.

Validation on 2026-11-05: the targeted suite passed **13/13**, including all six
opt-in real-server scenarios. `npm run verify` passed formatting, lint, TypeScript,
**407 tests** (15 explicit opt-in tests skipped), and build. The six Phase 5 server
tests were run separately with opt-in enabled; the existing seven Phase 2 server
and two live-cluster tests were not rerun in this slice. Initial sandbox attempts
to bind the synthetic loopback listener were refused; the authorized reruns passed.
No live cluster or controlled operation was exercised.
