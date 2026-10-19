# Phase 5 Implementation Slices — Kubernetes MCP Config/Core Parity

**Status:** Planned (2026-10-17), explicitly requested by the user. Documentation only;
no additional tool or write capability is enabled by this change.

**Prerequisite:** Complete Phase 3 context selection/routing and Phase 4 incident scope, leases, evidence, and lifecycle integration. See the [accepted multi-cluster plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md). The 2026-10-18 scope update is planned, not implemented.

**Scope:** Support the **22 documented tool definitions** in Kubernetes MCP Server's
`config` (3) and `core` (19) toolsets, including their write-capable operations.

**Inventory and sources:** [HolmesGPT Kubernetes MCP comparison](./HOLMESGPT_KUBERNETES_MCP_PARITY.md).
The reference inventory is upstream v0.0.61, matching the base version named in the
inspected HolmesGPT OAuth image. Verify compatibility with Pi SRE's actual server;
the historical version is not a downgrade requirement.

## 1. Roadmap and Scope Change

| Phase   | Delivery                                              |
| ------- | ----------------------------------------------------- |
| 1–2     | Completed runtime/MCP and singleton context baseline  |
| 3 — new | Context Selection and Multi-Cluster Routing           |
| 4       | Investigation Domain                                  |
| 5       | Kubernetes MCP config/core parity: all 22 definitions |
| 6       | Kubernetes Diagnostic Skills                          |
| 7       | Eval Framework                                        |
| 8       | TUI Refinement                                        |

Historical Phase 1/2 slice and acceptance records retain their original phase references.
Use this roadmap and DESIGN.md for the current sequencing.

This is an explicit design expansion from the original read-only V0.1 scope. Phases 1–4
retain their read-only contracts. Phase 5 adds an opt-in controlled-operations profile;
the default profile remains read-only. Completion requires both expanded reads and
controlled operations; shipping only the reads does not complete the requested parity.

The application still uses Kubernetes MCP Server for all Kubernetes execution. There is
no local Kubernetes client implementation, generic local shell, `kubectl` bypass, exploration outside incident permission, or automatic remediation loop. Phase 3 supplies model-driven cross-cluster routing; Phase 4 binds it to incidents for diagnosis inside exact sets or live `*`, through one agent and one MCP server. Human-approved individual operations
become in scope here; autonomous remediation remains outside this milestone.

## 2. Parity Contract

The reference document enumerates all 22 target names. Track every entry in a capability
matrix with classification, discovered server name/schema, availability condition,
execution profile, argument restrictions, result handling, and automated/live evidence.

- Preserve discovered input schemas and validate model and final transport arguments.
  Do not introduce exact schema snapshots as runtime admission requirements.
- Keep application-owned classification and operation allowlists. MCP annotations do not
  authorize capabilities. Unknown operations remain unavailable until reviewed.
- Require one exact context admitted by the Phase 4 incident rule/current resolution for every cluster-dependent operation. All rules, including singleton, require and validate an exact model-selected context; no injection/overwrite is permitted. Manifests/exec inputs cannot expand scope or override that target.
- Support conditional tools when the server/provider/platform actually supplies them.
  Report unsupported, disabled-by-policy, unavailable-scope, and failed-operation states
  separately. Do not manufacture an always-present 22-tool inventory.
- Record historical names or verified successor mappings explicitly when server versions
  differ. Do not implement local substitutes or silently equate unrelated capabilities.
- Preserve bounded/redacted presentation, cancellation, budgets, connection generations,
  immutable incident rules, current exact/live resolution, and evidence provenance across all added reads.
- Keep raw retention disabled. Configuration contents, Secret values, credentials, and
  sensitive manifests/exec output must not enter logs, Pi history, or model-facing details.

## 3. Execution Profiles and Approval Boundary

### Default read-only profile

Keep application policy, MCP `read_only = true`, and read-only RBAC aligned. Expand to
the applicable read capabilities while blocking all six controlled operations:

```text
pods_delete
pods_exec
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

Each controlled execution requires a concrete human approval covering the exact incident,
cluster, namespace, resource identity, operation, and final arguments. Show a safe preview
of the change or container command. Freeze arguments before approval, then revalidate
scope, connection generation, permissions, and freshness immediately before dispatch.
Changed arguments, scope-rule/inventory revision, session/incident binding, or replacement connection invalidate approval. Approval is single-use. Live wildcard additions grant diagnostic permission only; no approval authorizes a set-wide operation or silently follows a new target.

Approval denial/expiry or cancellation before dispatch makes no external call. Do not automatically retry a
mutation: a transport timeout or cancellation after dispatch can leave its outcome unknown.
Report that uncertainty and gather read-only verification before proposing another attempt.
Do not run conflicting controlled operations concurrently.

Continuously display the actual profile and incident scope. A write-enabled MCP connection
must never be labelled READ ONLY. Distinguish “controlled operations; approval required”
from the default READ ONLY state, even while only read tools are being used.

## 4. Special Capability Handling

| Capability                         | Required handling                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_view`               | Return a deliberately safe structural summary. Withhold auth fields, certificates, tokens, exec credential configuration, and raw kubeconfig content before logging, retention, or Pi publication. Pattern redaction alone is insufficient.                                              |
| `targets_list`                     | Respect provider-specific advertised names and target-list availability. Discovery updates inventory and re-resolves the unchanged rule; live `*` follows it while exact rules retain named membership. It never amends the user rule. Document applicability to the supported provider. |
| `projects_list`                    | Enable only when advertised by a compatible OpenShift server. Test conditional absence on ordinary Kubernetes.                                                                                                                                                                           |
| `resources_list` / `resources_get` | Define an explicit resource-access policy, including Secret denial by default. Enforce it before MCP dispatch and in server/RBAC configuration; do not rely on output redaction to prevent disallowed access.                                                                            |
| Node logs and metrics              | Apply finite retrieval/presentation limits where supported. Treat missing Metrics Server, kubelet access, and RBAC denial as distinct operational failures.                                                                                                                              |
| `pods_list_in_namespace`           | Preserve namespace semantics from the discovered schema; do not infer that another listing tool is equivalent without verified behavior.                                                                                                                                                 |
| `pods_exec`                        | Treat arbitrary container execution as controlled even for an apparently read command. Bound duration/output and prohibit unbounded interactive sessions. Keep execution through MCP.                                                                                                    |
| `pods_run`                         | Preview the full safe pod-creation intent, including image and applicable security settings. Pod creation can execute code; it always requires approval.                                                                                                                                 |
| Generic create/update/delete       | Derive and validate affected resource identities and namespaces from proposed input before approval. Reject hidden scope expansion, ambiguous multi-object targets, or disallowed resource kinds. Keep Kubernetes execution server-owned.                                                |
| `resources_scale`                  | Preview target and requested replicas. Apply the controlled-operation gate for the whole tool, including its read option.                                                                                                                                                                |

Parsing fields needed for policy, approval, or target identity does not justify full diagnostic
response schemas. Accept additional server fields and keep response handling focused on
presentation and the application state actually consumed.

## 5. Implementation Slices

### Slice 0 — Capability Matrix and Design Contracts

Freeze the 22-entry matrix against a selected supported server version. Verify discovered
schemas, provider-dependent names, OpenShift behavior, log/exec limits, and server read-only
filtering. Inspect public Pi approval/UI APIs and document their ordering and cancellation
behavior. Define configuration/profile names, sensitive-resource policy, approval identity,
operation budgets, and safe execution records before enabling new capabilities.

**Acceptance:** Every target has a supported, conditional, or explicitly incompatible
status with fixture evidence. Specify how any incompatibility will be resolved; do not
mark full parity complete while an unconditional target is missing. Create
`docs/PHASE5_CONTRACTS.md`; preserve the default read-only application throughout.

### Slice 1 — Resource and Configuration Read Policy

Implement policy for generic resource reads and sanitized configuration inspection.
Cover group/version/kind identity, namespaces, denied sensitive resources, nested credential
material, safe endpoint metadata, and control-character handling. Never persist an
unredacted intermediate artifact. Reuse the existing normalizer after sensitive fields
have been withheld.

**Acceptance:** Deterministic fixtures prove that extra server fields are accepted,
Secret requests are denied before transport by default, configuration credentials never
reach output/storage, and policy errors differ from empty results or MCP failures.

### Slice 2 — Expand Core Diagnostic Reads

Add the remaining applicable reads: `pods_list_in_namespace`, `pods_top`, `nodes_log`,
`nodes_stats_summary`, `nodes_top`, `resources_list`, `resources_get`, and conditional
`projects_list`. Reuse Phase 4 scope leases and evidence capture; keep tool handlers thin.

**Acceptance:** Each added capability has tests for validated final arguments, explicit
incident context, known/omitted namespace, success/empty results, malformed presentation,
MCP failures, timeout/cancellation, truncation, recovery, and stale-result withholding.
Different resource kinds are handled through MCP's generic tools, not local Kubernetes code.

### Slice 3 — Complete Config Discovery and Inspection

Add safe `configuration_view` and conditional generic target discovery. Keep
`configuration_contexts_list` as the current kubeconfig discovery path. Handle provider
name adaptation only through verified descriptors and explicit application selection rules.

**Acceptance:** Inventory tests cover multi-target versus single-target filtering,
mutually exclusive context/generic target listings, sanitized configuration results, and
no rule amendment or authoritative inventory install caused by model-driven enumeration; application reconnect resolves live `*` before publication. No fabricated aliases bypass scope.

### Slice 4 — Controlled Profile and Human Approval Infrastructure

Add validated opt-in application/MCP configuration and profile-aware capability publication.
Implement safe previews, single-use approvals bound to immutable final calls, scope and
scope-rule/inventory revision and generation rechecks, serialization, execution records, and truthful status display. Keep
controlled tools disabled until their individual Slice 5 adapters pass.

**Acceptance:** Unit and real-Pi integration tests prove no write/exec call in default mode,
no dispatch on denied/expired/cancelled approval, no reusable approval after argument or
connection changes, no direct-handler bypass, and no false READ ONLY display.

### Slice 5 — All Six Controlled Capabilities

Integrate `pods_delete`, `pods_exec`, `pods_run`, `resources_create_or_update`,
`resources_delete`, and `resources_scale` through the existing MCP boundary and approval
service. Include operation-specific previews, argument policy, deadlines, and safe outcomes.

Keep an execution record separate from diagnostic evidence. A successful mutation response
records what the server reported; fresh read calls provide verification evidence. Preserve
pre-operation observations with their original timestamps. Do not automatically conclude an
incident as resolved, treat “request accepted” as recovery, or add automatic rollback.

**Acceptance:** Each operation has approved-success, denied, validation/scope failure,
tool failure, and uncertain post-dispatch timeout/cancellation coverage. Server-side success
followed by lost acknowledgement must not trigger an automatic duplicate operation.

### Slice 6 — Full-Path Parity and Acceptance

Create `docs/PHASE5_ACCEPTANCE.md` and a test matrix for all 22 reference definitions.
Exercise production application composition with real Pi, deterministic model streams,
and the recording fake MCP server. Cover default versus controlled profiles, resource
policy, conditional inventory, approvals, restart, session replacement, and result handling.

Run affected tests first, then the existing canonical gate:

```bash
npm run format:check
npm run lint
npm run check
npm test
npm run build
```

Keep live coverage in an explicit disposable-cluster suite/runbook. Verify expanded reads
and every controlled operation against named disposable resources with human approvals,
including read-after-write verification. Use provider/OpenShift fixtures and an explicit
compatible test environment for conditional capabilities; record which checks are offline
and which are live. Check installed-package behavior outside the checkout, status visibility,
unchanged kubeconfig, bounded output, safe records, and process cleanup. Include exact-set versus live-`*` reconnect cases, per-context attribution, and approval invalidation on inventory/generation change. No production
mutation is necessary for acceptance.

## 6. Exit Criteria

- All **3 config + 19 core = 22** reference definitions have explicit capability coverage;
  provider/platform conditions and version mappings are recorded and tested.
- All applicable read capabilities work through the incident-scoped bridge and EvidenceStore.
- All six controlled capabilities work through the opt-in profile and per-execution human
  approval. Their absence from default mode is tested independently of tool visibility.
- Discovery, generic resource access, configuration inspection, manifests, and exec arguments
  cannot bypass cluster ownership or sensitive-resource policy.
- Read evidence, controlled-operation records, failures, and uncertain outcomes remain distinct.
- Canonical checks and recorded installed/disposable-cluster acceptance pass.
- The broader 45-tool inventory is reference context only; `helm`, `kcp`, `kiali`, `kubevirt`,
  and `tekton` are outside this milestone.

Phase 6 diagnostic skills then use the expanded read surface and Phase 4 evidence APIs.
Skills do not authorize controlled operations or substitute for application enforcement.
