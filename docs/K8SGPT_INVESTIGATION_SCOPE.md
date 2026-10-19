# K8sGPT and HolmesGPT Investigation Scope and Kubernetes Tool Binding

Research date: October 18, 2026. K8sGPT source reviewed at commit [`bd42af70d3ba55eb328241b59555949ef49450fa`](https://github.com/k8sgpt-ai/k8sgpt/tree/bd42af70d3ba55eb328241b59555949ef49450fa), dated October 17, 2026.

HolmesGPT source reviewed at commit [`5feabfca750b63061866755708f0cc14d6eeb738`](https://github.com/HolmesGPT/holmesgpt/tree/5feabfca750b63061866755708f0cc14d6eeb738), dated October 18, 2026. Documentation links describe the versions indicated in their URLs and were reviewed on the research date.

This document compares K8sGPT's analysis and MCP execution models and HolmesGPT's local and cross-cluster investigation models with Pi SRE's implemented single-context baseline and accepted multi-cluster target. It records source observations and their implications; it does not change Pi SRE's scope or architecture. [DESIGN.md](./DESIGN.md) remains authoritative for Pi SRE.

**Pi SRE design update (2026-10-18):** The accepted target is exact context sets and default live `*` through one agent and one MCP server, with `/clusters` as the only scope command and an explicit model-supplied context for every cluster-dependent call, including singleton scopes. New Phase 3 upgrades session-level context selection directly from completed Phase 2, without an incident/evidence dependency. Phase 4 then captures a fixed incident rule; the application recomputes its resolution after validated discovery and the model explores within it. Patterns and active-rule amendment follow later. Runtime implementation is pending; see the [accepted plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md).

## Main finding

K8sGPT's built-in analysis model is **one analysis run, one Kubernetes client**. Built-in analyzers share a client constructed for that run. Its MCP interface does not consistently preserve the same binding across tools: analysis uses configured Kubernetes options, while resource and log handlers construct clients using environment defaults.

The distinction matters because a client bound to one cluster for a scan is different from an application guaranteeing that every tool call targets one context permitted by the incident rule under the current inventory.

HolmesGPT supports a broader investigation scope: local Kubernetes access is normally bound by its execution environment, while external observability data and optional Robusta remote tools can bring evidence from other clusters into the same investigation. One investigation belonging to exactly one cluster is therefore not a universal HolmesGPT invariant.

## 1. Investigation model

The standard CLI flow is:

```text
Resolve Kubernetes client
    → Run selected programmed analyzers
    → Collect detected failures
    → Optionally ask an LLM to explain findings
```

The application selects and runs checks. The normal explanation stage sends detected failures to an AI backend rather than letting the model choose successive Kubernetes calls. This differs from Pi SRE's agent-driven investigation loop.

The CLI's interactive mode adds conversation about the existing output. Its interaction loop sends the original analysis output and the user's question to the AI completion API; it does not itself fetch fresh Kubernetes evidence.

Sources: [analysis implementation](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/analysis/analysis.go), [interactive implementation](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/ai/interactive/interactive.go).

## 2. Cluster resolution and client binding

The CLI exposes `--kubecontext` and `--kubeconfig`. `NewAnalysis` reads these settings and calls `kubernetes.NewClient(kubecontext, kubeconfig)`.

The client constructor resolves Kubernetes access as follows:

1. Try in-cluster configuration.
2. If an explicit kubeconfig path was supplied, or in-cluster configuration is unavailable, load kubeconfig using client-go's default loading rules and the optional explicit path.
3. During kubeconfig loading, apply `kubecontext` through an in-memory `CurrentContext` override.
4. Construct typed, controller-runtime, and dynamic clients from the resolved REST configuration.

This does not modify kubeconfig's current context. A context argument alone does not override successful in-cluster configuration in the reviewed implementation; supplying a kubeconfig path enters the kubeconfig-loading branch.

An `Analysis` stores the constructed client and passes it to built-in analyzers through their shared analyzer configuration. Calls made through that client continue using its resolved configuration rather than reselecting a kubeconfig context for every API operation.

Sources: [root flags](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/cmd/root.go), [client construction](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/kubernetes/kubernetes.go), [analysis construction and analyzer dispatch](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/analysis/analysis.go).

## 3. Scope within a cluster

The CLI supports the following scan selections:

| Option                 | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `--namespace`          | Select a namespace to analyze               |
| `--selector`           | Select resources by labels                  |
| `--filter`             | Select analyzers such as Pod or Deployment  |
| `--resource Kind/Name` | Select an analyzer kind and a resource name |

The CLI rejects contradictory resource/filter combinations. For example, selecting `Deployment/foo` while requesting both Deployment and Service analyzers is rejected instead of also scanning a Service named `foo`.

These options control scan selection. They do not replace Kubernetes authorization or establish a conversation-wide scope policy. The MCP analysis schema describes an empty namespace as all namespaces; cluster-scoped resource operations remain separate from namespace selection.

Sources: [CLI selection and validation](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/cmd/analyze/analyze.go), [MCP schemas](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/server/mcp.go).

## 4. MCP tool binding

MCP mode makes analysis and Kubernetes queries callable by an external assistant. The reviewed schemas do not expose a cluster/context argument. The MCP server struct does not hold a shared Kubernetes client or an investigation target, and the HTTP transport explicitly enables stateless mode.

There are two client-construction paths:

| MCP operation                                       | How Kubernetes access is resolved                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `analyze`                                           | Calls `NewAnalysis`, which reads configured `kubecontext` and `kubeconfig` |
| `list-resources`, `get-resource`                    | Calls `kubernetes.NewClient("", "")` inside each handler                   |
| `get-logs`, `list-events`, `list-namespaces`        | Calls `kubernetes.NewClient("", "")` inside each handler                   |
| `cluster-info` and Kubernetes information resources | Calls `kubernetes.NewClient("", "")`                                       |

Empty arguments still allow client-go's environment/default kubeconfig loading outside a cluster. They do not carry the explicit context/path settings read by `NewAnalysis`.

### Consequences inferred from the source

Consider a local MCP server where the configured context is A but kubeconfig's current context is B:

```text
analyze
    → NewAnalysis
    → NewClient(configured context A, configured kubeconfig)
    → Cluster A

get-logs
    → NewClient("", "")
    → Environment/default kubeconfig resolution
    → Cluster B
```

When those configurations resolve to different clusters, analysis and a follow-up query can target different clusters. A later default-client construction can also observe an externally changed kubeconfig context. Neither behavior requires a model-visible cluster-switch tool.

These are code-derived implications, not runtime-reproduced failures. They do not imply that every deployment mixes targets: an in-cluster deployment using one ServiceAccount, or an environment whose defaults match the configured target, can resolve all operations to the same cluster. Stateless HTTP transport alone also does not cause a mismatch; the independent client-resolution paths are the relevant issue.

Sources: [MCP server, analysis handler, and cluster information](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/server/mcp.go), [resource, event, and log handlers](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/server/mcp_handlers.go), [client resolution](https://github.com/k8sgpt-ai/k8sgpt/blob/bd42af70d3ba55eb328241b59555949ef49450fa/pkg/kubernetes/kubernetes.go).

## 5. Multi-cluster monitoring through the operator

The operator documents monitoring remote clusters by referencing a kubeconfig Secret in a `K8sGPT` resource. It creates a K8sGPT deployment using that configuration. Without a kubeconfig reference, the instance targets its deployment cluster through its ServiceAccount.

Results are labeled with the owning K8sGPT instance's name and namespace, allowing consumers to distinguish configured monitoring targets. Multiple clusters can therefore be monitored through separate configured instances. This is different from an agent dynamically traversing clusters within one investigation.

Source: [operator multi-cluster documentation](https://github.com/k8sgpt-ai/k8sgpt-operator#monitor-multiple-clusters). This operator reference was reviewed on the research date and is not pinned to the core K8sGPT commit above.

## 6. HolmesGPT investigation scope and tool binding

### Local Kubernetes access

HolmesGPT's built-in Kubernetes tools shell out to `kubectl`. Local CLI usage inherits the current kubeconfig context; in-cluster deployments normally use the pod's ServiceAccount and its RBAC permissions.

The reviewed built-in core query tools do not accept a cluster/context parameter or inject an investigation-owned context into each invocation. They inherit the Kubernetes target of their execution environment. Optional namespace and selector arguments narrow queries; unscoped queries can span namespaces. The built-in Kubernetes integration is read-only by default, and the documentation also describes separate Kubernetes MCP and remediation MCP integrations.

The architectural interpretation is that default local single-cluster behavior is largely a property of deployment and configuration. Pi SRE instead makes the selected cluster application state and enforces that selection at the MCP tool boundary. These observations about built-in tools should not be generalized to every optional HolmesGPT integration.

Sources: [Kubernetes integration documentation](https://holmesgpt.dev/dev/data-sources/builtin-toolsets/kubernetes/), [built-in core tool implementation](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/plugins/toolsets/kubernetes.yaml).

### Direct Kubernetes MCP integration

HolmesGPT also integrates with `containers/kubernetes-mcp-server` as a replacement for built-in Kubernetes toolsets. This is a different access path from the kubectl tools above and the Robusta remote-agent path below. The documented modes include a single-cluster ServiceAccount, a multi-context mounted kubeconfig, and per-user OAuth/OIDC. The examples disable built-in Kubernetes tools and Bash; read-only mode is configured at the MCP server.

In the multi-context example, the model is instructed to enumerate contexts first, pass an explicit `context` per call, search other contexts when a resource is missing, and label findings by origin. These stronger instructions are supplied by the example's `llmInstructions`, not imposed by a singleton application scope. The default chart instructions only ask the model to check context and specify namespace.

The generic MCP adapter imports discovered schemas and forwards model arguments, removing omitted optional nulls. The inspected path does not inject or compare an application-selected incident target. With OAuth enabled, it supplies the user's bearer token and suppresses static Authorization fallback when the user token is absent; identity enforcement is separate from incident scope.

Sources: [MCP integration guide](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/docs/data-sources/builtin-toolsets/kubernetes-mcp.md), [default instructions](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/helm/holmes/templates/mcp-servers/kubernetes/_helpers.tpl), [adapter and OAuth headers](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/plugins/toolsets/mcp/toolset_mcp.py).

### MCP reconnect and context changes

At the inspected revision, each generic MCP invocation opens and initializes a session, executes one call, and closes the session. Exceptions become error results; the adapter has no reconnect-and-replay loop for the failed operation. A later invocation opens a fresh session. Server-mode background refresh rechecks toolsets and re-fetches tools; tool catalog discovery is distinct from Kubernetes `configuration_contexts_list`.

The multi-cluster instructions call for enumeration on a fresh investigation, but the inspected integration does not define a deterministic context-inventory reconciliation after reconnect. New contexts can be discovered by a subsequent model enumeration; removed/remapped names are interpreted by the current server. An existing model run can retain an older executor reference even after the server cache is replaced. These source-derived observations do not establish runtime behavior for every MCP server/version or its kubeconfig reload policy.

Pi SRE's accepted target explicitly blocks dispatch, invalidates old generations, rediscovers tools and context inventory, re-resolves exact/live rules, publishes state and changes, and then resumes dispatch. New wildcard targets start as not checked; existing evidence is not rewritten.

Sources: [adapter session lifecycle](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/plugins/toolsets/mcp/toolset_mcp.py#L274), [server refresh loop](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/server.py#L293), [executor replacement](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/config.py#L566), [LLM executor ownership](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/core/tool_calling_llm.py#L284).

### Evidence from external systems

HolmesGPT's investigation prompt explicitly distinguishes the local Kubernetes cluster from external observability systems. Elasticsearch, Datadog, Loki, Grafana, Prometheus, and similar sources may contain data from other clusters.

When the user asks about another cluster, the prompt directs the model to investigate available external sources, verify the returned data's cluster identity using its metadata, and label findings with their actual cluster of origin. It prohibits presenting data from a different cluster as evidence for the requested incident.

This is a model instruction about evidence attribution. It permits investigations to use evidence from multiple clusters rather than imposing a single-cluster access restriction.

Source: [investigation prompt](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/holmes/plugins/prompts/generic_ask.jinja2).

### Cross-cluster tools through Robusta

Robusta-connected HolmesGPT can route tool calls to another cluster's Holmes instance and return the result to the same investigation:

```text
Investigation on Holmes A
    → Robusta routes a remote tool call
    → Holmes B executes its cluster-local tool
    → Result returns to the investigation on A
```

The documented remote interface uses `agent_name` to select the executor cluster. Availability depends on account feature settings, toolset exposure through `expose_remotely`, and target-cluster permissions. Multi-agent investigations and external MCP access have independent account settings, both disabled by default.

The mechanism requires Robusta-connected executor instances and is unavailable in standalone CLI-only Holmes. The documented restrictions include matching Holmes versions and read-only/pre-approved remote operations; calls requiring approval are denied remotely.

Source: [cross-cluster tools documentation](https://holmesgpt.dev/0.43.0/data-sources/cross-cluster-tools/).

### Optional model-driven context switching example

The repository includes a custom-tool example exposing `switch_cluster` with the command `kubectl config use-context {{ cluster_name }}`. This is an optional example, not a default built-in capability. It demonstrates that forbidding model-driven context changes is not a framework-wide HolmesGPT rule.

Pi SRE explicitly disallows this approach: active cluster state belongs to the application, and selecting a cluster must not modify kubeconfig.

Source: [custom toolset example](https://github.com/HolmesGPT/holmesgpt/blob/5feabfca750b63061866755708f0cc14d6eeb738/examples/custom_toolset.yaml).

## 7. Comparison with Pi SRE and HolmesGPT

| Concern                 | K8sGPT built-in analysis                            | K8sGPT MCP                                         | Pi SRE accepted target (pending implementation)                                               |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Unit of scope           | Analysis run                                        | Individual tool invocation                         | Explicit investigation/session scope                                                          |
| Cluster binding         | Client constructed for the run                      | Configuration or environment, depending on handler | One context bound by the application after validating incident rule and current inventory     |
| Kubernetes collection   | Programmed analyzers                                | Tools selected by an external assistant            | Tools selected by the Pi agent under Pi SRE policy                                            |
| Model cluster selection | Outside the normal explanation flow                 | No cluster argument in reviewed schemas            | Model chooses permitted targets; cannot amend the incident rule                               |
| Cross-call consistency  | Built-in analyzers share a client                   | No shared investigation target in reviewed server  | Explicit cluster binding is an application invariant                                          |
| Missing target          | Resolve configuration or fail client initialization | Resolve configuration/environment or fail          | Reject missing model context for every cluster-dependent call, even with one permitted member |

HolmesGPT's scope choices can be compared directly with Pi SRE's intended guarantees:

| Concern                            | HolmesGPT                                                                                    | Pi SRE accepted target (pending implementation)                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Investigation scope                | Can include multiple clusters and data sources                                               | Exact context set or live `*`                                                               |
| Default built-in Kubernetes target | Execution environment                                                                        | MCP target explicitly bound under the incident rule                                         |
| Per-call cluster binding           | Built-in tools inherit context; direct MCP uses model context; Robusta tools select executor | Validated model-supplied exact target for every rule                                        |
| Cross-cluster evidence             | Explicitly supported with origin verification instructions                                   | Supported within rule resolution, retaining exact origin                                    |
| Cluster attribution                | Prompt directs the model to verify and label evidence origin                                 | Per-call context/scope/inventory/generation provenance                                      |
| Model-driven context changes       | Direct MCP permits per-call routing; optional example mutates kubeconfig                     | Routing within permission is allowed; rule amendment and kubeconfig mutation are prohibited |

K8sGPT's built-in scan binds its analyzers through an analysis-owned client. HolmesGPT binds built-in local tools through its environment, supports direct multi-context MCP, and can separately route to remote executors. Pi SRE places binding in its application scope and MCP bridge.

HolmesGPT references: [local Kubernetes access](https://holmesgpt.dev/dev/data-sources/builtin-toolsets/kubernetes/), [cross-cluster tools](https://holmesgpt.dev/0.43.0/data-sources/cross-cluster-tools/). Pi SRE references: [project design](./DESIGN.md), [repository instructions](../AGENTS.md).

## 8. Implications for Pi SRE

K8sGPT's analysis-owned client demonstrates a useful principle: bind Kubernetes access before executing diagnostic work and reuse that binding for the work's lifetime.

Pi SRE implements the corresponding guarantee across a different boundary. Because Kubernetes access belongs to an MCP server that supports multiple contexts, the application must consistently bind calls to its selected scope. Every cluster-dependent path must use the same scope policy, including logs, events, resource reads, and auxiliary queries.

Not exposing a cluster selector to the model is insufficient by itself. Default configuration resolution can change a call's target even when the tool arguments contain no cluster field. The planned Pi SRE bridge requires and validates an explicit model context for every cluster-dependent call rather than relying on server defaults or application injection.

The reviewed K8sGPT code supports the narrower conclusion that its built-in analyzers share one resolved target per analysis run. It does not establish Pi SRE's stronger intended guarantee that every Kubernetes call is admitted under an application-owned incident rule and current inventory.

HolmesGPT's broader investigation scope likewise does not make Pi SRE's enforcement unnecessary. Its local deployment boundary, evidence attribution instructions, and remote executor selection address different operating models. Pi SRE now accepts exploratory routing inside exact sets or live `*`, with deterministic application reconciliation after reconnect. The stronger guarantee is consistent admission under the rule, not universal single-cluster operation. The current runtime remains the accepted Phase 2 singleton baseline; Phase 3 migrates context selection and Phase 4 adds incident-owned investigation state.
