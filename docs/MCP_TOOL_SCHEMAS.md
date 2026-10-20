# MCP Tool Policy and Schemas

**Implementation baseline:** Phase 3 Slice 2 implements exact/all session routing through one MCP connection. Every cluster-dependent call requires one explicit model-supplied context, including singleton scope. Execution snapshots and connection generations protect direct and agent callers. Atomic recovery publication/change notices remain Slice 3; full scope presentation remains Slice 4. See the [delivery slices](./PHASE3_IMPLEMENTATION_SLICES.md).

## Trust boundary

Pi SRE trusts the configured Kubernetes MCP Server to execute its tools and return diagnostic data. The server owns Kubernetes access, tool descriptions, input schemas, and result formats. Pi SRE owns its diagnostic capability allowlist, model-argument validation, cluster selection, and retrieval/presentation limits.

Pi SRE does not compare discovered input or output schemas against local per-tool copies, require read-only/destructive annotations, or validate diagnostic results against Kubernetes resource schemas. Descriptor checks cannot establish that a server holding cluster credentials is honest. Read-only MCP configuration and Kubernetes RBAC remain required, alongside the Pi SRE capability allowlist.

## Discovery and compatibility

The approved operations are `configuration_contexts_list`, `pods_list`, `pods_get`, `pods_log`, `events_list`, and `namespaces_list`. New operation names require a policy change. Changes to arguments, required fields, constraints, descriptions, annotations, or output declarations do not require updating a local schema snapshot.

The adapter reads the descriptor fields it uses and rejects duplicate names. It requires object inputs with usable top-level `properties` and `required` fields. Cluster-dependent tools must declare a top-level `context` parameter, even if additional properties are allowed. The controller publishes those tools when at least one permitted available context satisfies that parameter's discovered schema. A missing scope capability does not authorize an implicit-current-context fallback.

Startup enumeration calls `configuration_contexts_list` with `{}`. Optional arguments are accepted; a server requiring arguments for that call produces an actionable enumeration incompatibility. This is a small integration requirement, not an exact interface or server-version pin.

The [0.0.67 capture](../tests/fixtures/phase2-server-0.0.67.json) records historical server behavior and supplies deterministic fixtures. The explicit `npm run test:contracts` command checks that historical snapshot against that version; it does not define runtime schema admission or restrict supported runtime versions.

## Call flow

[tool-policy.ts](../src/runtime/tool-policy.ts) stores only approved names and cluster dependence. `prepareMcpToolSchema` creates one argument schema from the discovered input schema, making `context` a required nonempty string while retaining its original constraints. Session permission and availability are checked against argument values by `validateMcpToolExecution`, without generating a scope enum in the schema. Available contexts are communicated through scope guidance. All other server constraints and object openness remain intact. The bridge gives Pi a separate copy so public tool-definition changes do not change execution validation.

Every call:

1. Rechecks the tool allowlist, connection readiness and captured connection generation.
2. Copies arguments without rewriting context and applies application defaults.
3. Validates arguments once against the prepared schema using TypeBox, without coercion or server defaults.
4. Validates execution values against retrieval limits and current session permission and availability; no implicit target is allowed.
5. Captures an immutable snapshot of rule, exact context, selection/inventory revisions, connection generation, namespace policy, and read-only profile.
6. Holds a direct-work guard through execution. All registered MCP tools declare `executionMode: "sequential"`, including enumeration. Pi schedules model calls one at a time; direct callers own their scheduling. Parallel execution and application capacity admission are deferred to Slice 4a.
7. Invokes MCP with caller/connection/application cancellation. Rechecks snapshot validity and cancellation before publishing normalized results, and explicitly releases snapshots and work guards in `finally`.

Current-generation handlers use the current rule for subsequent calls after idle selection changes; scope is not captured in their schemas. Public tool/descriptor mutations cannot change private validators. Pi settles agent work before conversation replacement, and interactive reload requires idle work. The application retains its MCP connection and scope across those transitions. Old generations and invalidated snapshots produce `stale-scope` with any admitted origin retained and diagnostic payload withheld.

Schema evaluation errors reject the call rather than dispatching unchecked arguments. Unknown arguments follow the server's `additionalProperties` policy. Newly advertised arguments on approved operations are available subject to application limits; Pi SRE does not maintain a second argument allowlist.

Pod logs default to 100 lines; explicit tails must be integers from 1 to 1,000. `follow: true` and `stream: true` are blocked even if a server advertises them. Server constraints may impose tighter limits. Line count and model presentation budgets do not provide a transport byte ceiling.

## Results and application state

Diagnostic results are presented without validating pod, event, namespace, or log shapes, and without comparing them to descriptor `outputSchema`. [result-normalizer.ts](../src/mcp/result-normalizer.ts) reads MCP content for rendering, classifies errors, redacts credentials, and applies text/item budgets. These are presentation responsibilities. Empty success remains distinct from a tool or transport failure. Raw retention remains disabled.

[context-discovery.ts](../src/mcp/context-discovery.ts) is different because it constructs the cluster registry used for application decisions. It parses only the fields needed for that state: a `contexts` array containing nonempty string names and boolean default flags, an optional string endpoint, and an optional `defaultContext` string. Additional fields and accompanying presentation blocks are ignored. An absent endpoint is allowed and displayed as withheld. Missing selection data, duplicate identities, or contradictory defaults produce an enumeration error rather than an empty or partial registry.

The adapter also retains inventory/field limits, exact identity rules, endpoint sanitization, error classification, and the supported text-only empty-result sentinel. It never derives cluster membership from a model-facing truncated result, prose, or a table. This parsing supports application correctness; it is not a security check of the server's honesty.

## Diagnostic surface

All five diagnostic operations require and preserve exact model-supplied context. Arguments below describe the historical 0.0.67 capture; actual inputs follow discovery.

| Operation         | Captured model arguments                                        | Namespace behavior                                                                        |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pods_list`       | `context`, `fieldSelector`, `labelSelector`                     | No captured namespace argument; coverage follows server/context and authorization policy. |
| `pods_get`        | `context`, `name`, `namespace`                                  | Omitted namespace uses server/context policy.                                             |
| `pods_log`        | `context`, `name`, `namespace`, `container`, `previous`, `tail` | Finite log retrieval; application limits apply.                                           |
| `events_list`     | `context`, `namespace`, `fieldSelector`                         | Explicit namespace is forwarded; omission does not assert all-namespace coverage.         |
| `namespaces_list` | `context`, `fieldSelector`                                      | Cluster-scoped namespace inventory.                                                       |

`configuration_view`, exec/attach, mutation operations, generic resource/Secret access, and shell remain outside the allowlist. Result details retain originating exact context, selection revision, inventory revision, connection generation, namespace policy, read-only profile, and any explicit namespace. Missing-context failures invent no origin. Namespace `*` in application status means no application-level namespace restriction, not that every tool queries every namespace.

## Selection and recovery boundaries

Every cluster-dependent model schema retains a required exact `context` for singleton, exact-set, and live-`*` rules. Preserve discovered constraints in schema validation and check application permission separately at execution. Never remove, infer, inject, or overwrite that value; missing or out-of-scope model targets fail before dispatch. Context-independent discovery does not require a selector. Startup defaults to live `*` unless explicitly overridden; `/clusters` is the sole scope command.

Phase 3 has no incident/evidence dependency: validate the current session rule and publish bounded result provenance. Phase 4 later supplies incident-owned authority and evidence capture through the same seam.

Slice 3 will make reconnect tool discovery, context enumeration, schema publication, dispatch gating, and bounded change notices one transaction. Existing generation invalidation and cancellation already withhold stale responses. Exact names remain fixed; wildcard membership follows validated inventory. Removed targets are unavailable, new members are not checked, and old-generation success is withheld; Phase 4 additionally prevents stale evidence commits. Model enumeration alone cannot install a new authoritative registry. See the [delivery plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md).

## Code map

| Module                             | Responsibility                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `runtime/tool-policy.ts`           | Capability allowlist, scope metadata, one discovered argument schema, argument checks |
| `runtime/tool-call-preparation.ts` | Private argument copy, unchanged model context, application defaults                  |
| `runtime/tool-execution-policy.ts` | Value-based scope validation and application log retrieval limits                     |
| `mcp/tool-discovery.ts`            | Descriptor fields, duplicate names, per-tool admission decisions                      |
| `mcp/tool-bridge.ts`               | Scope/lifecycle guards, argument validation, MCP invocation, result presentation      |
| `mcp/context-discovery.ts`         | Minimal registry parsing, inventory consistency, limits, sanitization                 |
| `mcp/result-normalizer.ts`         | MCP content rendering, failure classification, redaction, presentation budgets        |
