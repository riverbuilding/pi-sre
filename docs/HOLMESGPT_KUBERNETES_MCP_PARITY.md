# HolmesGPT Kubernetes MCP Comparison

**Research date:** 2026-10-17. Source inspection, not a measurement of a running HolmesGPT deployment.

**Purpose:** Record the comparison behind the requested
[Phase 5 config/core parity milestone](./PHASE5_IMPLEMENTATION_SLICES.md).

**Scope update (2026-10-18):** This historical capability inventory remains the Phase 5 baseline. The accepted [multi-cluster plan](./MULTI_CLUSTER_INVESTIGATION_PLAN.md) and [scope/binding research](./K8SGPT_INVESTIGATION_SCOPE.md) distinguish built-in kubectl, direct multi-context Kubernetes MCP, and Robusta remote tools. Phase 3 targets exact sets/live `*`, application-owned reconnect reconciliation, and model-selected permitted targets; it remains unimplemented. The counts and Phase 2 enabled column below are unchanged historical observations.

## Integration and version baseline

HolmesGPT integrates with `containers/kubernetes-mcp-server`. Its MCP adapter discovers
server tools through `session.list_tools()` and creates remote tool instances from that
inventory. It does not impose Pi SRE's current six-operation diagnostic allowlist.
See the [HolmesGPT MCP adapter at the inspected revision](https://github.com/HolmesGPT/holmesgpt/blob/2b9140c266f1a879afe295a3bc2465bbcc55ab00/holmes/plugins/toolsets/mcp/toolset_mcp.py).

The inspected HolmesGPT chart specifies `kubernetes-mcp-server:v0.0.61-oauth`, enables
read-only mode by default, and exposes a configurable toolset list. An empty toolset
setting uses the server defaults, `config` and `core`. The Kubernetes MCP addon itself
is opt-in; the two default toolsets apply after enabling that addon.
See the [versioned chart values](https://github.com/HolmesGPT/holmesgpt/blob/2b9140c266f1a879afe295a3bc2465bbcc55ab00/helm/holmes/values.yaml)
and [deployment arguments](https://github.com/HolmesGPT/holmesgpt/blob/2b9140c266f1a879afe295a3bc2465bbcc55ab00/helm/holmes/templates/mcp-servers/kubernetes/deployment.yaml).

The inventory below counts upstream **v0.0.61** documented tool definitions. It does not
claim that HolmesGPT's OAuth image is identical to upstream, or that Pi SRE must downgrade
its server. Pi SRE's Phase 2 contract probe used server 0.0.67; Phase 5 must verify the
actual selected server's discovered capabilities.

## Available toolsets

| MCP toolset | Documented tools, including writes | Enabled by default in the MCP server |
| ----------- | ---------------------------------: | ------------------------------------ |
| `config`    |                                  3 | Yes                                  |
| `core`      |                                 19 | Yes                                  |
| `helm`      |                                  3 | No                                   |
| `kcp`       |                                  2 | No                                   |
| `kiali`     |                                 10 | No                                   |
| `kubevirt`  |                                  3 | No                                   |
| `tekton`    |                                  5 | No                                   |
| **Total**   |                             **45** | **2 toolsets**                       |

Counts were obtained by enumerating the tool entries in the
[upstream v0.0.61 inventory](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.61/README.md#tools-and-functionalities).
Prompts are excluded. These counts include read and write definitions before runtime filtering.

## Exact Phase 5 target: 22 config/core definitions

“Controlled operation” below means write-capable or arbitrary in-container execution.
It is not eligible for Pi SRE's default read-only profile. Tool classification is
application policy, not an admission decision inferred solely from server annotations.

| #   | Toolset  | Tool                          | Capability                                        | Pi SRE Phase 2 |
| --- | -------- | ----------------------------- | ------------------------------------------------- | -------------- |
| 1   | `config` | `configuration_contexts_list` | Read: context discovery                           | Enabled        |
| 2   | `config` | `targets_list`                | Read: provider target discovery                   | Not enabled    |
| 3   | `config` | `configuration_view`          | Sensitive read: configuration inspection          | Not enabled    |
| 4   | `core`   | `events_list`                 | Read: Kubernetes events                           | Enabled        |
| 5   | `core`   | `namespaces_list`             | Read: namespaces                                  | Enabled        |
| 6   | `core`   | `projects_list`               | Read: OpenShift projects                          | Not enabled    |
| 7   | `core`   | `nodes_log`                   | Read: node logs                                   | Not enabled    |
| 8   | `core`   | `nodes_stats_summary`         | Read: node resource statistics                    | Not enabled    |
| 9   | `core`   | `nodes_top`                   | Read: node CPU/memory metrics                     | Not enabled    |
| 10  | `core`   | `pods_list`                   | Read: pod listing                                 | Enabled        |
| 11  | `core`   | `pods_list_in_namespace`      | Read: namespaced pod listing                      | Not enabled    |
| 12  | `core`   | `pods_get`                    | Read: pod inspection                              | Enabled        |
| 13  | `core`   | `pods_delete`                 | Controlled operation: delete a pod                | Not enabled    |
| 14  | `core`   | `pods_top`                    | Read: pod CPU/memory metrics                      | Not enabled    |
| 15  | `core`   | `pods_exec`                   | Controlled operation: execute a container command | Not enabled    |
| 16  | `core`   | `pods_log`                    | Read: pod logs                                    | Enabled        |
| 17  | `core`   | `pods_run`                    | Controlled operation: create/run a pod            | Not enabled    |
| 18  | `core`   | `resources_list`              | Read: generic resource listing                    | Not enabled    |
| 19  | `core`   | `resources_get`               | Read: generic resource inspection                 | Not enabled    |
| 20  | `core`   | `resources_create_or_update`  | Controlled operation: create/update resources     | Not enabled    |
| 21  | `core`   | `resources_delete`            | Controlled operation: delete resources            | Not enabled    |
| 22  | `core`   | `resources_scale`             | Controlled operation: get/update replica count    | Not enabled    |

This is **16 read definitions and 6 controlled-operation definitions**; 6 are currently
enabled in Pi SRE and 16 remain to be covered. `resources_scale` includes a read option,
but the same tool can mutate resources, so the entire operation is conservatively gated.
`pods_exec` can also mutate or disclose data even when used for an apparently diagnostic command.

Names and capabilities come from the versioned inventory linked above and the
[core implementations](https://github.com/containers/kubernetes-mcp-server/tree/v0.0.61/pkg/toolsets/core).
“Enabled” means approved subject to compatible discovered descriptors and usable scope;
it does not mean available during every connection state.

## Why a deployment may expose fewer tools

- **Read-only mode:** the upstream server filters out tools without a true read-only hint.
  Explicit enabled/disabled tool settings also affect the inventory.
  See [server filtering](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.61/pkg/mcp/mcp.go).
- **Provider and target count:** `configuration_contexts_list` and the generic target-list
  capability are mutually exclusive for the relevant providers. Generic `targets_list`
  can be renamed to a provider-specific name, and target-list tools can be absent for a
  single target. See [target filtering](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.61/pkg/mcp/tool_filter.go)
  and [name adaptation](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.61/pkg/mcp/tool_mutator.go).
- **Platform:** `projects_list` is exposed for OpenShift.
  See [namespace/project registration](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.61/pkg/toolsets/core/namespaces.go).
- **Configuration:** HolmesGPT's documented multi-cluster example disables `configuration_view`.
  See the [HolmesGPT integration guide](https://holmesgpt.dev/latest/data-sources/builtin-toolsets/kubernetes-mcp/#multiple-clusters-mounted-kubeconfig).
- **Version:** tool names and argument contracts may change. A documented historical inventory
  is a parity baseline, not an exact runtime schema or fixed live tool count.

For ordinary Kubernetes, the upstream baseline has 12 applicable read tools in `core`.
With multiple kubeconfig contexts, context discovery enabled, and `configuration_view`
disabled, the source-derived total is **13 read tools**. This comparison excludes
OpenShift projects, provider-alternative discovery, and all six controlled operations.

## Parity decision

The user requested all **22 config/core definitions**, including writes, as the new
Phase 5. This expands the original diagnosis-only scope. Full parity means implementing
capability handling and tests for every entry, including provider/platform-dependent
availability and controlled operations. It does not mean exposing 22 tools simultaneously
or enabling writes by default. The detailed delivery and acceptance contract is in the
[Phase 5 plan](./PHASE5_IMPLEMENTATION_SLICES.md).
