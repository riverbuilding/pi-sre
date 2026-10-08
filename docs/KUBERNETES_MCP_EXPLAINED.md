# How Kubernetes MCP Works in Our Tests

The Kubernetes MCP Server can list its tools even when the configured Kubernetes endpoint is unreachable. Tool definitions live inside the MCP server executable. Listing them does not require a successful Kubernetes connection.

This document describes our contract tests with Kubernetes MCP Server **0.0.67**. The main example uses [multiple-default.json](../tests/fixtures/phase2-server/kubeconfigs/multiple-default.json).

## Two separate connections

```text
Test code
    ↓ MCP messages through stdin/stdout
Local Kubernetes MCP Server subprocess
    ↓ HTTP requests when Kubernetes access is needed
Kubernetes API endpoint
```

`client` in the test is Pi's MCP client. It talks to the local server subprocess through `StdioTransport`. It does not connect directly to Kubernetes.

`await client.connect(...)` starts the subprocess and completes the MCP initialization handshake. This establishes communication with the MCP server; it does not establish that Kubernetes is reachable or that credentials work.

## What selects the Kubernetes endpoint?

The test launches the server with these arguments:

```text
--config <fixture folder>/server.toml
--kubeconfig <fixture folder>/kubeconfigs/multiple-default.json
--cluster-provider kubeconfig
--list-output yaml
```

| Setting                         | What it controls                                                      |
| ------------------------------- | --------------------------------------------------------------------- |
| `command: executable`           | Which MCP server executable starts.                                   |
| `--config`                      | Server behavior, including read-only mode and enabled tools.          |
| `--kubeconfig`                  | Kubernetes endpoints, credentials, contexts, and the default context. |
| `--cluster-provider kubeconfig` | Uses the supplied kubeconfig as the source of cluster targets.        |
| `--list-output yaml`            | Formats resource-list results as YAML.                                |
| `cwd`                           | The subprocess working directory.                                     |
| `stderr: "pipe"`                | Allows the test to capture server diagnostics.                        |

The supplied kubeconfig contains:

| Context | Kubernetes endpoint             | Namespace  | Default? |
| ------- | ------------------------------- | ---------- | -------- |
| `alpha` | `https://alpha.example.invalid` | `ns-alpha` | Yes      |
| `beta`  | `https://beta.example.invalid`  | `ns-beta`  | No       |

These are synthetic, unreachable endpoints. There are no user credentials in this fixture. The explicit `--kubeconfig` argument selects this file rather than the user's default kubeconfig.

## What do `options.provider` values mean?

The test helper accepts `options.provider` as `"kubeconfig" | "disabled"` and passes it to the server through `--cluster-provider`:

```ts
"--cluster-provider",
options.provider ?? "kubeconfig",
```

| Value          | Meaning in our tests                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"kubeconfig"` | Reads contexts from the supplied kubeconfig and supports selecting among them. With our two-context fixture, the server exposes `configuration_contexts_list` and adds a `context` argument to cluster-dependent tools, allowing calls to target alpha or beta. |
| `"disabled"`   | Disables multi-cluster selection and uses only the supplied kubeconfig's current context: alpha in our fixture. The server omits context listing and the tools' `context` argument.                                                                             |

**`"disabled"` does not disable Kubernetes access or make the server a mock.** It disables choosing between clusters. A resource tool can still attempt to access the current context's endpoint.

The `?? "kubeconfig"` expression makes `"kubeconfig"` the default when no provider is supplied. Only the `disabled` test scenario explicitly chooses `"disabled"`, to compare the resulting tool inventory with the captured expectation. The test helper supports these two values; the server itself also supports other provider strategies.

For server 0.0.67, `"kubeconfig"` alone does not guarantee that context-selection tools are exposed: a single-context kubeconfig still lacks those capabilities. The behavior above uses our two-context fixture. See [the versioned configuration options](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/README.md#configuration-options).

## Supported toolsets and their tools

Kubernetes MCP Server **0.0.67 supports eight toolsets**. The table below lists the version's documented tool catalog before read-only and configuration filtering. These are tools, not prompts or resources. See [the versioned tool catalog](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/README.md#tools-and-functionalities).

| Toolset     | Tools                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`    | `configuration_contexts_list`, `configuration_view`, `targets_list`                                                                                                                                                                                                                                                           |
| `core`      | `events_list`, `namespaces_list`, `projects_list`, `nodes_log`, `nodes_stats_summary`, `nodes_top`, `pods_list`, `pods_list_in_namespace`, `pods_get`, `pods_delete`, `pods_top`, `pods_exec`, `pods_log`, `pods_run`, `resources_list`, `resources_get`, `resources_create_or_update`, `resources_delete`, `resources_scale` |
| `helm`      | `helm_install`, `helm_list`, `helm_uninstall`                                                                                                                                                                                                                                                                                 |
| `kcp`       | `kcp_workspaces_list`, `kcp_workspace_describe`                                                                                                                                                                                                                                                                               |
| `kiali`     | `kiali_get_mesh_traffic_graph`, `kiali_get_mesh_status`, `kiali_manage_istio_config_read`, `kiali_manage_istio_config`, `kiali_list_mesh_clusters`, `kiali_get_resource_details`, `kiali_list_traces`, `kiali_get_trace_details`, `kiali_get_pod_performance`, `kiali_get_logs`, `kiali_get_metrics`                          |
| `kubevirt`  | `vm_clone`, `vm_create`, `vm_guest_info`, `vm_lifecycle`, `vm_create_from_template`, `vm_troubleshoot`                                                                                                                                                                                                                        |
| `netobserv` | `netobserv_list_flows`, `netobserv_get_flow_metrics`, `netobserv_export_flows`                                                                                                                                                                                                                                                |
| `tekton`    | `tekton_pipeline_start`, `tekton_pipelinerun_lifecycle`, `tekton_pipelinerun_logs`, `tekton_task_start`, `tekton_taskrun_restart`, `tekton_taskrun_logs`                                                                                                                                                                      |

Our [server.toml](../tests/fixtures/phase2-server/server.toml) selects only two toolsets:

```toml
read_only = true
toolsets = ["core", "config"]
disabled_tools = ["configuration_view"]
```

Selecting a toolset makes its tools candidates for exposure. It does not expose every tool in that row: `read_only = true` excludes tools that do not declare read-only behavior, and `disabled_tools` explicitly excludes `configuration_view`.

Provider and context settings can further change the inventory. For example, `configuration_contexts_list` is exposed for a multi-target kubeconfig provider. `targets_list` is a generic definition used for other providers and is renamed according to their target parameter. See [target-list filtering](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/mcp/tool_filter.go) and [target-list renaming](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/mcp/tool_mutator.go).

Pi SRE applies its own tool allowlist after server-side filtering. A tool appearing in the server's `listTools()` response does not automatically make it available to the model in Pi SRE.

## Why does `listTools()` succeed?

```ts
const tools = await client.listTools();
```

This asks the running MCP server: **“Which tools do you provide?”**

The server already contains definitions of tools such as `pods_list`: their names, descriptions, argument schemas, annotations, and execution handlers. It prepares its available tool inventory using the local configuration:

1. Load the built-in `core` and `config` toolsets selected by `server.toml`.
2. Read the two contexts and default context from the fixture kubeconfig.
3. Add an optional `context` argument to cluster-aware tools because multiple contexts are configured.
4. Apply read-only filtering and exclude the explicitly disabled `configuration_view` tool.
5. Register the resulting tool definitions with its MCP SDK.

`listTools()` returns those registered definitions over stdin/stdout. It does not execute `pods_list`, fetch Pods, or verify access to either endpoint. The test then filters that inventory to the candidate names it wants to compare with the checked-in snapshot.

The server may attempt Kubernetes discovery during startup and through its cluster-state watcher. Those attempts fail against the fixture endpoint, but do not prevent this tool inventory from being returned. Therefore, this test does not prove that the server makes zero network attempts; it proves that listing these tools does not depend on successful cluster access.

The relevant server code is [tool collection and registration](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/mcp/mcp.go), [context parameter construction](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/mcp/tool_mutator.go), and [the cluster-state watcher](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/kubernetes/watcher/cluster.go).

## Why call `configuration_contexts_list` after `listTools()`?

These calls answer different questions:

- `listTools()` asks **“Which tools does this MCP server expose?”**
- `configuration_contexts_list` asks **“Which Kubernetes contexts are configured in its loaded kubeconfig?”**

In the test, the sequence is:

1. Call `listTools()` and check whether the returned definitions include `configuration_contexts_list`.
2. If it is exposed, invoke it with `client.callTool("configuration_contexts_list", {})`. Otherwise, the test records `response: null`.
3. The MCP server executes the configuration tool using its loaded kubeconfig metadata. For this scenario, that comes from `multiple-default.json`, selected by `--kubeconfig`.
4. Return the context names `alpha` and `beta`, their configured server URLs, and `alpha` as the default.

The tool's operation does not query the Kubernetes API. It can return `https://alpha.example.invalid` simply because that string is in the kubeconfig. Returning a context or URL does not verify endpoint reachability, credentials, or permissions. The server's separate discovery attempts described above do not make this response a connectivity check.

The data comes from the **`--kubeconfig` file**. `server.toml`, selected by `--config`, controls which toolsets are enabled and which tools are filtered; it does not supply these context names or endpoint URLs. Listing contexts also does not select or switch the active context in Pi SRE.

## What happens when a tool is invoked?

Tools have different requirements:

| Call with this fixture                               | What the server needs                        | Expected behavior                               |
| ---------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `client.listTools()`                                 | Its registered tool definitions              | Succeeds despite unreachable cluster endpoints. |
| `client.callTool("configuration_contexts_list", {})` | Context metadata from the local kubeconfig   | Succeeds and returns alpha/beta metadata.       |
| `client.callTool("pods_list", { context: "alpha" })` | A Kubernetes API request to alpha's endpoint | Fails because that endpoint is unreachable.     |

`configuration_contexts_list` can return an endpoint URL as text without successfully connecting to it. Its implementation reads kubeconfig metadata; see [the server's configuration tools](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/toolsets/config/configuration.go).

The separate routing test uses two local mock HTTP servers instead of `.example.invalid` endpoints. Its temporary kubeconfig points alpha and beta at their respective loopback ports. That allows real MCP tool execution to return synthetic Pods and verifies which endpoint receives each request. It does not contact a real Kubernetes cluster.

## Does a failed invocation throw an exception?

A Kubernetes operation failure and an MCP connection failure are different:

| Failure                                                                                            | How it can reach the client                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The MCP server receives the tool call, but its Kubernetes operation fails                          | The call commonly resolves with a tool result containing `isError: true`. |
| The MCP process exits, the connection closes, a request times out, or an MCP protocol error occurs | The client call can reject, requiring exception handling.                 |

For example, an unreachable Kubernetes endpoint can produce a result shaped like this illustrative response:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "failed to list pods: connection error" }]
}
```

An awaited call resolving does not by itself mean the tool succeeded. The caller must check the returned result as well as handle rejected calls. Pi SRE's [result normalizer](../src/mcp/result-normalizer.ts) handles error results and provides bounded, sanitized failure messages; its bridge also handles call failures.

## What can Pi SRE claim?

These states must remain separate:

| State                          | What it establishes                             | What it does not establish                                         |
| ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------ |
| MCP connected                  | Communication with the MCP server is available. | Kubernetes connectivity, authentication, or authorization.         |
| Cluster selected               | The application has chosen an explicit context. | That the endpoint is reachable or credentials are valid.           |
| Kubernetes operation succeeded | That particular request completed successfully. | That every resource, namespace, or future operation is accessible. |

A successful `listTools()` must never be presented as “connected to Kubernetes.” A failed Kubernetes request must never be treated as an empty resource list. The application must preserve the distinction between unavailable MCP transport, failed authentication, denied authorization, and a failed operation.

## Connecting to a real cluster

To use a real cluster, provide a kubeconfig containing its actual API endpoint, TLS settings, and read-only credentials through `--kubeconfig`. Keep the MCP TOML read-only. The kubeconfig's current context supplies the server default; an explicit tool `context` argument selects a particular configured context when supported.

For Pi SRE Phase 2, the application must own that selection and inject it into every cluster-dependent call. It must not rely on the server's implicit default. Server 0.0.67 exposes the required context-selection capabilities in our two-context setup, but omits them with a single context or the `disabled` provider. See [the frozen contract record](./PHASE2_CONTRACTS.md) for those compatibility limits.

## Running the tests

```bash
npm run test:contracts
```

This runs [capture-phase2-server.test.ts](../tests/unit/mcp/capture-phase2-server.test.ts) against the real MCP executable on PATH. Static inputs live under [tests/fixtures/phase2-server](../tests/fixtures/phase2-server/). Results are generated in memory and compared with [phase2-server-0.0.67.json](../tests/fixtures/phase2-server-0.0.67.json); the expected file is not overwritten.

Regular `npm test` skips this executable-dependent suite unless `PI_SRE_CONTRACT_SERVER` is set. The offline tests still use the captured fixture.
