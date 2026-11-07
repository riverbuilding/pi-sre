# Phase 5 Implementation Slices — Kubernetes MCP Config/Core Parity

**Design alignment (2026-10-30):** Consume the [simplified execution architecture](./INVESTIGATION_CONTEXT_SIMPLIFICATION.md), not Incident/EvidenceStore APIs. Controlled operations remain separately planned and opt-in; this update enables no mutation. Concrete approval contracts must be frozen in Slice 0 without restoring removed domain revisions. Historical Phase 4 delivery is not a new implementation dependency.

**MVP scope revision (2026-11-05):** Only the **Multi-Context kubeconfig Provider** is supported. Other providers and their target discovery/parameter mappings are deferred for consideration until after MVP; they are not Phase 5 acceptance gaps. **Exec tools, including `pods_exec`, are unsupported in every profile**, even with human approval or improved server limits. The 22-row upstream inventory remains reference evidence; the MVP delivery target is **20 definitions: 15 reads (some platform/API-conditional) and 5 controlled operations**, excluding `targets_list` and `pods_exec`.

Pi SRE has no dedicated adapter that understands or compensates for Kubernetes MCP Server operation semantics. Users and the LLM interpret discovered descriptions, choose arguments, assess side effects, and decide any preflight, follow-up verification or correction through ordinary permitted calls. The server owns Kubernetes execution semantics. Pi SRE retains a thin shared bridge for discovered-schema validation, explicit context and policy checks, approval of the exact call, budgets, cancellation, connection identity, and bounded/redacted results. It does not synthesize operation-specific plans, infer dependent effects, emulate create-only behavior, or compensate/rollback operations. Human approval authorizes the displayed call; it is not a guarantee of inferred effects or atomic resource identity.

**Status:** Slice 0 delivered (2026-11-05): [frozen capability and design contracts](./PHASE5_CONTRACTS.md),
22-entry matrix, real-server discovery fixtures and contract tests. Slice 1 delivered
(2026-11-06): narrowing-only resource policy and structural read projections with offline
coverage. Slices 2–6 remain planned. No additional runtime tool or write capability is
enabled; full parity is not complete.

**Prerequisite:** Complete the accepted context-routing baseline and the investigation/context simplification migration: current selection, request budgets, unified bridge, cancellation and model-visible provenance. See the [accepted multi-cluster plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md). Simplification Slice 6 switched production on 2026-11-04; its Slice 7 full acceptance remains pending. Extend `CurrentClusterSelection`, `RequestExecution`, `RequestMcpController` and `createRequestMcpToolBridge`; do not recreate incident authority.

**Scope:** Deliver the **20 MVP tool definitions** from Kubernetes MCP Server's
`config` (2) and `core` (18) toolsets under the provider and Exec exclusions above.
Keep all 22 historical entries in the matrix, marking the two exclusions explicitly.

**Inventory and sources:** [HolmesGPT Kubernetes MCP comparison](./HOLMESGPT_KUBERNETES_MCP_PARITY.md).
The reference inventory is upstream v0.0.61, matching the base version named in the
inspected HolmesGPT OAuth image. Verify compatibility with Pi SRE's actual server;
the historical version is not a downgrade requirement.

## 1. Roadmap and Scope Change

| Phase   | Delivery                                             |
| ------- | ---------------------------------------------------- |
| 1–2     | Completed runtime/MCP and singleton context baseline |
| 3 — new | Context Selection and Multi-Cluster Routing          |
| 4       | Historical Investigation Domain (superseded target)  |
| 5       | Kubernetes MCP config/core MVP: 20 definitions       |
| 6       | Kubernetes Diagnostic Skills                         |
| 7       | Eval Framework                                       |
| 8       | TUI Refinement                                       |

Historical Phase 1/2 slice and acceptance records retain their original phase references.
Use this roadmap and DESIGN.md for the current sequencing.

This is an explicit design expansion from the original read-only V0.1 scope. Phases 1–4
retain their read-only contracts. Phase 5 adds an opt-in controlled-operations profile;
the default profile remains read-only. Completion requires both expanded reads and
controlled operations; shipping only the reads does not complete the requested parity.

The application still uses Kubernetes MCP Server for all Kubernetes execution. There is
no local Kubernetes client implementation, generic local shell, `kubectl` bypass, exploration outside current user selection, or automatic remediation loop. Phase 3 supplies model-driven cross-cluster routing; the simplified pipeline enforces the current exact/all selection for diagnosis, through one agent and one MCP server. Human-approved individual operations
become in scope here; autonomous remediation remains outside this milestone.

## 2. Parity Contract

The reference document enumerates all 22 target names. Track every entry in a capability
matrix with classification, discovered server name/schema, availability condition,
execution profile, argument restrictions, result handling, and automated/live evidence.

- Preserve discovered input schemas and validate model and final transport arguments.
  Do not introduce exact schema snapshots as runtime admission requirements.
- Keep application-owned classification and operation allowlists. MCP annotations do not
  authorize capabilities. Unknown operations remain unavailable until reviewed.
- Require one exact context admitted by the current user rule and validated availability for every cluster-dependent operation. All rules, including singleton, require and validate an exact model-selected context; no injection/overwrite is permitted. Manifest inputs cannot expand scope or override that target.
- Support conditional tools when the supported kubeconfig provider/platform actually supplies them.
  Report unsupported, disabled-by-policy, unavailable-scope, and failed-operation states
  separately. Do not manufacture an always-present 22-tool inventory.
- Record historical names or verified successor mappings explicitly when server versions
  differ. Do not implement local substitutes or silently equate unrelated capabilities.
- Preserve bounded/redacted presentation, cancellation, budgets, original connection identity,
  current exact/live selection, request limits, and tool-result provenance across all added reads.
- Keep raw retention disabled. Configuration contents, Secret values, credentials, and
  sensitive manifests must not enter logs, Pi history, or model-facing details.

## 3. Execution Profiles and Approval Boundary

### Default read-only profile

Keep application policy, MCP `read_only = true`, and read-only RBAC aligned. Expand to
the applicable read capabilities while blocking all five controlled operations (Exec is unsupported in every profile):

```text
pods_delete
pods_run
resources_create_or_update
resources_delete
resources_scale
```

The read variant of `resources_scale` does not make that mixed-capability tool eligible
for the default profile. Read-only selection must not be inferred from model-supplied arguments.

### Explicit controlled-operations profile

Require an explicit operator-selected startup configuration, appropriately scoped Kubernetes
credentials, and a separately reviewed MCP configuration permitting the requested operations.
Do not silently change the existing read-only TOML or expand RBAC. Use one managed connection
for the selected profile; profile changes require a deliberate restart with new configuration.

Each controlled execution requires a concrete human approval covering the exact request/call,
cluster, namespace, resource identity, operation, and final arguments. Show a safe preview
of the exact tool name, context and final arguments under the sensitive-data policy. Freeze arguments before approval, then revalidate
current selection, original connection identity, permissions, and approval freshness immediately before dispatch.
Changed final arguments, user selection, relevant context identity/availability, execution profile, cancellation, expiry or replacement connection invalidate approval. Compare concrete approval facts; do not recreate incident bindings or domain revisions. Freeze the precise invalidation contract in Phase 5 Slice 0; the read-only rule that later selection changes preserve admitted calls does not grant mutation approval. Approval is single-use. Live wildcard additions grant diagnostic permission only; no approval authorizes a set-wide operation or silently follows a new target.

Approval denial/expiry or cancellation before dispatch makes no external call. Do not automatically retry a
mutation: a transport timeout or cancellation after dispatch can leave its outcome unknown.
Report that uncertainty; the user and LLM decide whether to gather read-only verification or propose another attempt, which requires fresh approval.
Do not run conflicting controlled operations concurrently.

Continuously display the actual profile and current selection. A write-enabled MCP connection
must never be labelled READ ONLY. Distinguish “controlled operations; approval required”
from the default READ ONLY state, even while only read tools are being used.

## 4. Special Capability Handling

| Capability                         | Required handling                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_view`               | Return a deliberately safe structural summary. Withhold auth fields, certificates, tokens, exec credential configuration, and raw kubeconfig content before logging, retention, or Pi publication. Pattern redaction alone is insufficient. |
| `targets_list`                     | Outside MVP: only Multi-Context kubeconfig discovery through `configuration_contexts_list` is supported; other providers are considered after MVP.                                                                                          |
| `projects_list`                    | Enable only when advertised by a compatible OpenShift server. Test conditional absence on ordinary Kubernetes.                                                                                                                              |
| `resources_list` / `resources_get` | Define an explicit resource-access policy, including Secret denial by default. Enforce it before MCP dispatch and in server/RBAC configuration; do not rely on output redaction to prevent disallowed access.                               |
| Node logs and metrics              | Apply finite retrieval/presentation limits where supported. Treat missing Metrics Server, kubelet access, and RBAC denial as distinct operational failures.                                                                                 |
| `pods_list_in_namespace`           | Preserve namespace semantics from the discovered schema; do not infer that another listing tool is equivalent without verified behavior.                                                                                                    |
| `pods_exec`                        | Unsupported in every profile. Do not expose, dispatch, alias, or substitute an Exec tool; approval cannot enable it.                                                                                                                        |
| `pods_run`                         | Use the shared exact-call preview and approval boundary. Users and the LLM interpret server defaults, apply behavior and side effects.                                                                                                      |
| Generic create/update/delete       | Validate explicit context, resource identity/namespace and sensitive-resource policy before approval. Show the exact proposed input safely; do not derive semantic diffs, dependent effects, create-only guarantees or compensation plans.  |
| `resources_scale`                  | Show the exact arguments and apply the shared controlled-operation gate for the whole tool, including its read option. The user and LLM interpret replica semantics.                                                                        |

Parsing fields needed for policy, approval, or target identity does not justify full diagnostic
response schemas. Accept additional server fields and keep response handling focused on
presentation and the application state actually consumed.

## 5. Implementation Slices

### Slice 0 — Capability Matrix and Design Contracts

Freeze the 22-entry reference matrix with 20 MVP targets and two explicit exclusions. Verify discovered
schemas for the Multi-Context kubeconfig Provider, OpenShift behavior, log limits, and server read-only
filtering. Other providers and Exec require no enablement or live-operation acceptance; test their exclusion. Inspect public Pi approval/UI APIs and document their ordering and cancellation
behavior. Define configuration/profile names, sensitive-resource policy, approval identity,
operation budgets, and safe execution records before enabling new capabilities.

**Acceptance:** Every reference entry has a supported, conditional, excluded, or explicitly incompatible
status with fixture evidence. Specify how any incompatibility will be resolved; do not
mark MVP parity complete while an unconditional in-scope target is missing. Create
`docs/PHASE5_CONTRACTS.md`; preserve the default read-only application throughout.

**Delivered (2026-11-05):** [PHASE5_CONTRACTS.md](./PHASE5_CONTRACTS.md) freezes server
0.0.67 / Pi 0.99.0, all 22 rows, profile/resource policy, approval identity and sticky
invalidation, operation budgets and safe receipts. Six descriptor-probe scenarios use
the real server and synthetic Kubernetes discovery; no tools are executed. Provider
name adaptation and exec-limit observations remain reference evidence only; neither expands
MVP scope. Singleton server routing retains its explicit-context incompatibility. OpenShift/metrics
fixtures are not live platform acceptance. Simplification Slice 7 visual acceptance
remains pending independently; no runtime cutover is introduced here.

### Slice 1 — Resource and Configuration Read Policy

Implement policy for generic resource reads and sanitized configuration inspection.
Cover group/version/kind identity, namespaces, denied sensitive resources, nested credential
material, safe endpoint metadata, and control-character handling. Never persist an
unredacted intermediate artifact. Reuse the existing normalizer after sensitive fields
have been withheld.

**Acceptance:** Deterministic fixtures prove that extra server fields are accepted,
Secret requests are denied before transport by default, configuration credentials never
reach output/storage, and policy errors differ from empty results or MCP failures.

**Delivered (2026-11-06):** `safety.resources.allowedReadKinds` defaults to the 19
reviewed canonical pairs in the frozen contract. Operators may narrow it (including
an empty set); Secret/List kinds, aliases, paths, wildcards, unknown GVKs and duplicate
pairs are rejected. `validateResourceRead` provides the synchronous pre-transport
policy boundary, preserving namespace omission and rejecting unsafe identities or
namespaces on cluster-scoped kinds.

`normalizeSensitiveReadResult` projects both text YAML/JSON and structured channels
before using the existing bounded normalizer. Resource projections retain reviewed
identity/ownership, conditions, replica counts, scheduling, CPU/memory requests and
limits, service/endpoint routing, and ConfigMap key counts. Configuration projections
retain only context/cluster names, context namespaces and endpoint origins. Extra
fields are discarded; malformed selected fields, identity mismatches, unsafe identity
controls, ambiguous YAML and unsupported content fail closed without source payloads.
Text controls are neutralized; credential-bearing URLs and unreviewed content are
withheld. MCP errors, policy denial, empty lists and malformed presentation remain
distinct. No raw artifacts or additional retention are introduced.

These are foundations for Slices 2/3: generic resource reads and configuration_view
remain absent from the application allowlist and configuration_view remains disabled
in the MCP template. Those slices must wire the policy into admission (including
direct handlers), pass the configured narrowing policy, use the safe normalizer in
the unified bridge, verify actual server response formats, and exercise Pi history
boundaries before enabling tools. Operators must also configure server resource deny
rules and scoped RBAC before enabling generic reads; read_only alone does not deny
Secrets. Existing read behavior and controlled/Exec exclusions are unchanged.

Validation on 2026-11-06: targeted offline policy/configuration/contract tests passed
(98 passed, 6 opt-in real-server cases skipped). `npm run verify` passed formatting,
lint, TypeScript, 453 tests (15 explicit opt-in tests skipped), and build. No live
cluster or controlled operation was exercised by Slice 1.

### Slice 2 — Expand Core Diagnostic Reads

Add the remaining applicable reads: `pods_list_in_namespace`, `pods_top`, `nodes_log`,
`nodes_stats_summary`, `nodes_top`, `resources_list`, `resources_get`, and conditional
`projects_list`. Reuse the unified admission/dispatch/result pipeline; keep tool handlers thin.

**Acceptance:** Each added capability has tests for validated final arguments, explicit
model-supplied exact context, known/omitted namespace, success/empty results, malformed presentation,
MCP failures, timeout/cancellation, truncation, recovery, and stale-result withholding.
Different resource kinds are handled through MCP's generic tools, not local Kubernetes code.

### Slice 3 — Complete Config Discovery and Inspection

Add safe `configuration_view` and retain `configuration_contexts_list` as the only
provider discovery path. Do not add generic target discovery, provider adapters, aliases,
or target-parameter mappings during MVP.

**Acceptance:** Inventory tests cover multi-target versus single-target filtering,
refusal of unsupported provider/target listings, sanitized configuration results, and
no rule amendment or authoritative inventory install caused by model-driven enumeration; application reconnect resolves live `*` before publication. No fabricated aliases bypass scope.

### Slice 4 — Controlled Profile and Human Approval Infrastructure

Add validated opt-in application/MCP configuration and profile-aware capability publication.
Implement safe previews, single-use approvals bound to immutable final calls; recheck current selection, concrete target/argument facts and the original connection. Add serialization, execution records and truthful status display. Keep
controlled tools disabled until their Slice 5 shared-policy and approval tests pass.

**Acceptance:** Unit and real-Pi integration tests prove no write call in default mode and no Exec call in any profile,
no dispatch on denied/expired/cancelled approval, no reusable approval after argument or
connection changes, no direct-handler bypass, and no false READ ONLY display.

### Slice 5 — Five Controlled Capabilities

Integrate `pods_delete`, `pods_run`, `resources_create_or_update`,
`resources_delete`, and `resources_scale` through the existing MCP boundary and approval
service. Use shared call previews, argument policy, deadlines, and safe outcomes. Do not
introduce per-operation semantic adapters or application-generated preflight/compensation.
The user and LLM interpret server semantics and choose verification calls.

Keep an execution record separate from diagnostic evidence. A successful mutation response
records what the server reported; fresh read calls provide verification evidence. Preserve
pre-operation observations with their original timestamps. Do not treat “request accepted” as recovery, or add automatic rollback.

**Acceptance:** Each operation has approved-success, denied, validation/scope failure,
tool failure, and uncertain post-dispatch timeout/cancellation coverage. Server-side success
followed by lost acknowledgement must not trigger an automatic duplicate operation.

### Slice 6 — Full-Path Parity and Acceptance

Create `docs/PHASE5_ACCEPTANCE.md` and a test matrix for all 20 MVP definitions plus the two explicit exclusions.
Exercise production application composition with real Pi, deterministic model streams,
and the recording fake MCP server. Cover default versus controlled profiles, resource
policy, conditional inventory, approvals, MCP restart, cancellation, single-session operation, and result handling.

Run affected tests first, then the existing canonical gate:

```bash
npm run verify
```

Keep live coverage in an explicit disposable-cluster suite/runbook. Verify expanded reads
and every controlled operation against named disposable resources with human approvals,
including user/LLM-selected read-after-write verification. Use kubeconfig/OpenShift fixtures and an explicit
compatible test environment for conditional capabilities; record which checks are offline
and which are live. Check installed-package behavior outside the checkout, status visibility,
unchanged kubeconfig, bounded output, safe records, and process cleanup. Include exact-set versus live-`*` reconnect cases, per-context attribution, and approval invalidation on relevant target/selection or connection changes. No production
mutation is necessary for acceptance.

## 6. Exit Criteria

- All **2 config + 18 core = 20** MVP definitions have explicit capability coverage;
  platform/API conditions are recorded and tested. The 22-row reference matrix marks
  `targets_list` as deferred beyond MVP and `pods_exec` as unsupported.
- All applicable read capabilities work through the current-selection bridge with bounded, redacted results in messages.
- All five controlled capabilities work through the opt-in profile and per-execution human
  approval. Their absence from default mode is tested independently of tool visibility.
- Discovery, generic resource access, configuration inspection, and manifest arguments
  cannot bypass cluster ownership or sensitive-resource policy.
- Read evidence, controlled-operation records, failures, and uncertain outcomes remain distinct.
- Canonical checks and recorded installed/disposable-cluster acceptance pass.
- The broader 45-tool inventory is reference context only; `helm`, `kcp`, `kiali`, `kubevirt`,
  and `tekton` are outside this milestone.

Phase 6 diagnostic skills then use the expanded read surface and prior tool results in messages.
Skills do not authorize controlled operations or substitute for application enforcement.
