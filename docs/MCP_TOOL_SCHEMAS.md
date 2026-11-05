# MCP Tool Policy and Schemas

Production uses the request pipeline as of simplification Slice 6 (2026-11-04). [Execution contracts](./INVESTIGATION_CONTEXT_SIMPLIFICATION_CONTRACTS.md) define request budgets, selection and publication boundaries. Phase 1–4 contracts remain historical; no incident lease, evidence write or revision authority remains.

## Trust boundary

Pi SRE trusts the configured Kubernetes MCP Server to execute its tools and return diagnostic data. The server owns Kubernetes access, tool descriptions, input schemas, and result formats. Pi SRE owns its diagnostic capability allowlist, model-argument validation, cluster selection, and retrieval/presentation limits.

Pi SRE does not compare discovered input or output schemas against local per-tool copies, require read-only/destructive annotations, or validate diagnostic results against Kubernetes resource schemas. Descriptor checks cannot establish that a server holding cluster credentials is honest. Read-only MCP configuration and Kubernetes RBAC remain required, alongside the Pi SRE capability allowlist.

## Discovery and compatibility

The approved operations are `configuration_contexts_list`, `pods_list`, `pods_get`, `pods_log`, `events_list`, and `namespaces_list`. New operation names require a policy change. Changes to arguments, required fields, constraints, descriptions, annotations, or output declarations do not require updating a local schema snapshot.

The adapter reads the descriptor fields it uses and rejects duplicate names. It requires object inputs with usable top-level `properties` and `required` fields. Cluster-dependent tools must declare a top-level `context` parameter, even if additional properties are allowed. Call admission checks that the explicit context satisfies both discovered constraints and the current available selection. A missing scope capability does not authorize an implicit-current-context fallback.

Startup enumeration calls `configuration_contexts_list` with `{}`. Optional arguments are accepted; a server requiring arguments for that call produces an actionable enumeration incompatibility. This is a small integration requirement, not an exact interface or server-version pin.

The [0.0.67 capture](../tests/fixtures/phase2-server-0.0.67.json) records historical server behavior and supplies deterministic fixtures. The explicit `npm run test:contracts` command checks that historical snapshot against that version; it does not define runtime schema admission or restrict supported runtime versions.

## Call flow

1. Copy parameters; preserve exact model context and apply finite log defaults.
2. Consume the discovered input schema and application policy without coercion or server defaults. Schema evaluation errors fail closed. Unknown arguments follow the server's additionalProperties policy.
3. Reserve enough result space for complete safe source identity and worst-case execution metadata; refuse before dispatch if it cannot fit.
4. Synchronously validate and register request/call identity, parameters, explicit context, current selection, target availability, tool and original connection. Queueing means accepted.
5. Acquire the shared bounded queue slot. Before dispatch, check original request/cancellation, connection/tool/target availability and synchronously charge its request allowance. Later user selection does not reauthorize an accepted call or replace its target.
6. Call MCP with request/caller/connection cancellation, normalize, recheck original runtime conditions, and return bounded redacted content directly to Pi messages. Release resources on every outcome. No observation adapter, domain write, raw storage or conclusion commit is involved.

Tools use Pi parallel execution with one shared four-active/32-waiter FIFO queue, 30-second waiting timeout and separate MCP call timeout. Dispatched failures/timeouts/cancellation do not refund allowance; pre-dispatch refusals are free. Model inventory queries use the same request budget, while connection lifecycle discovery is uncharged.

`RequestToolResultBoundary` is created once per application Session and registered at `message_end`. Pi schema/abort refusals can bypass handlers and contain original arguments; this hook substitutes a bounded not-executed result before transcript persistence/provider input. Results already marked by the same boundary keep their original source across MCP publications.

Pod logs default to 100 lines; explicit tails must be integers from 1 to 1,000. `follow: true` and `stream: true` are blocked even if advertised. Server constraints can be tighter. These are retrieval/presentation limits, not a transport byte ceiling.

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

`configuration_view`, exec/attach, mutation operations, generic resource/Secret access, and shell remain outside the allowlist. Namespace `*` in application status means no application-level namespace restriction, not that each tool queries every namespace. Provenance is in model-visible content, not just details.

## Source, limits and recovery

Each tool result's content carries operation, complete safe context for cluster-dependent calls, namespace/omission policy, READ ONLY, status, execution and truncation. Undispatched calls have no query time; dispatched calls include client dispatch/settlement times, not object observation times. Failures remain failures rather than empty successful observations. The whole serialized result shares `results.maxTextChars`; details contain only compact safe status metadata. Raw retention is disabled and truncated content cannot be retrieved.

Selection is one current all/exact rule. Startup is CLI → explicit config → live all; unknown startup names block without fallback. Runtime exact intent retains unavailable names and uses its available intersection; all follows validated inventory. Only `/clusters` changes selection; every cluster-dependent call requires a supplied exact context, including singleton sets.

MCP replacement closes dispatch and withdraws tools, cancels/settles old calls, discovers tools/schema/inventory on a new connection, publishes tools and environment, then opens dispatch. Failure remains closed; old captured handlers cannot reach a new connection. Calls are never replayed. This does not reset request budgets or rebuild extensions. Model enumeration does not install authoritative inventory. Historical results retain their original context/time; a changed same-named target does not make them current observations.

## Code map

| Module                             | Responsibility                                                 |
| ---------------------------------- | -------------------------------------------------------------- |
| `runtime/tool-policy.ts`           | Approved names, cluster dependence and discovered schemas      |
| `runtime/tool-call-preparation.ts` | Private parameter copy, exact context, finite log default      |
| `runtime/tool-execution-policy.ts` | Application log limits                                         |
| `cluster/current-selection.ts`     | Strict startup and current exact/all availability              |
| `execution/accept-mcp-call.ts`     | Synchronous acceptance, original connection/tool/target checks |
| `execution/request-execution.ts`   | Request identity, budgets, calls and cancellation              |
| `app/request-mcp-controller.ts`    | Connection replacement and ready publication barrier           |
| `mcp/request-tool-bridge.ts`       | One tool pipeline, source envelope and message safety boundary |
| `mcp/context-discovery.ts`         | Minimal validated application inventory                        |
| `mcp/result-normalizer.ts`         | Content presentation, redaction, failure categories and limits |
