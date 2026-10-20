# Pi SRE — Project Design Document

**Status:** Draft  
**Version:** 0.1  
**Primary Language:** TypeScript  
**Agent Runtime:** Pi 0.99 / `@earendil-works/pi-coding-agent`<br>
**MCP Client:** `@earendil-works/pi-mcp`<br>
**Kubernetes Integration:** Kubernetes MCP Server  
**Primary Domain:** Kubernetes Incident Diagnosis

This document describes the V0.1 target. The current implementation uses Pi runtime `@earendil-works/pi-coding-agent` 0.99.0 and MCP client `@earendil-works/pi-mcp` 0.99.0, upgraded during Phase 1.

**Roadmap update (2026-10-18):** Phases 1–2 are implemented and accepted. Add a new **Phase 3 — Context Selection and Multi-Cluster Routing** that upgrades that existing runtime independently of incidents/evidence. Move Investigation Domain to Phase 4, Kubernetes MCP config/core parity to Phase 5, Diagnostic Skills to Phase 6, Evals to Phase 7, and TUI Refinement to Phase 8. Historical Phase 1/2 plans and acceptance records remain unchanged. The controlled-operations expansion requested on 2026-10-17 is preserved under Phase 5; the default remains read-only.

**Accepted context target:** one Pi agent/one MCP server, exact sets or default live `*`, only `/clusters`, and one required model-supplied context per diagnostic call, including singleton. Reconnect re-enumerates tools/contexts and publishes a consistent resolution with change notices before dispatch resumes. Phase 3 changes session selection while idle. Phase 4 later captures incident-owned rules, adds evidence/hypotheses/budgets, and separates active incident scope from next selection. Patterns and active-incident rule amendment remain later extensions.

The remaining architectural sections describe the staged target; they are not claims that the current Phase 2 runtime already implements it. Use the [new Phase 3 migration plan](./PHASE3_IMPLEMENTATION_SLICES.md), [Phase 4 domain plan](./PHASE4_IMPLEMENTATION_SLICES.md), [Phase 5 parity plan](./PHASE5_IMPLEMENTATION_SLICES.md), and [cross-phase scope design](./MULTI_CLUSTER_INVESTIGATION_PLAN.md). Documentation changes enable no runtime capabilities.

---

# 1. Overview

Pi SRE is an independent Kubernetes SRE agent built on top of the Pi agent harness.

Pi SRE is not intended to turn Pi Coding Agent into a coding agent with additional Kubernetes tools. It treats live infrastructure as the primary operating environment and reuses Pi as the underlying agent runtime.

The central architectural idea is:

> Pi provides the generic agent runtime. Kubernetes MCP Server provides Kubernetes capabilities. Pi SRE defines the SRE operating model that connects the two.

Pi provides:

- LLM interaction and streaming
- agent loop
- tool execution
- model selection
- authentication and provider integration
- conversation sessions
- session persistence
- compaction
- skills infrastructure
- extension infrastructure
- settings
- TUI / `InteractiveMode`
- MCP protocol client, stdio transport, tool discovery, cancellation, and connection cleanup through `@earendil-works/pi-mcp`

Kubernetes MCP Server provides:

- Kubernetes API access
- Kubernetes resource tools
- events
- pod/log operations
- context discovery
- multi-cluster support
- structured tool schemas
- Kubernetes authentication handling
- Kubernetes API error handling

Pi SRE provides:

- SRE system prompt
- MCP connection orchestration and operational health
- MCP-to-Pi policy and tool bridge
- cluster/context management
- incident scope rules and current context resolution
- SRE skills
- incident context
- investigation state
- evidence representation
- hypothesis tracking
- investigation policy
- SRE-specific configuration
- SRE-specific TUI commands/widgets
- evaluation framework

The first version is focused entirely on:

```text
Observe
→ Diagnose
→ Explain
```

Automatic remediation is outside V0.1.

---

# 2. Problem Statement

A coding agent normally treats a repository as its primary environment.

```text
Repository
├── source code
├── Git
├── tests
├── project instructions
└── build output
```

Its normal actions are:

```text
Read
Edit
Search
Run
Test
```

An SRE agent operates against a fundamentally different environment.

```text
Incident
├── Cluster
├── Namespace
├── Workload
├── Kubernetes resources
├── Events
├── Logs
├── Metrics
├── Deployment history
└── Infrastructure relationships
```

Its typical reasoning loop is:

```text
Observe
   ↓
Form hypothesis
   ↓
Gather evidence
   ↓
Validate / reject hypothesis
   ↓
Gather more evidence
   ↓
Determine root cause
   ↓
Explain findings
```

Therefore the central architectural problem is not:

> How do we implement Kubernetes tools for Pi?

The Kubernetes MCP Server already provides that capability.

The actual problem is:

> How do we reuse Pi's mature agent runtime and Kubernetes MCP capabilities to create an infrastructure-centric SRE investigation environment?

---

# 3. V0.1 Goals

Pi SRE V0.1 should:

1. run as an independent TypeScript SRE application;
2. reuse Pi's Agent runtime as extensively as practical;
3. reuse Pi's TUI instead of building a new terminal interface;
4. integrate Kubernetes through Kubernetes MCP Server;
5. dynamically expose selected MCP tools to the Pi Agent;
6. support explicit Kubernetes cluster/context management;
7. support `/clusters` runtime selection;
8. support `--clusters` startup rule selection;
9. support a configured exact/all cluster rule equivalent to CLI selection;
10. continuously display the incident scope rule, resolved context availability, and execution profile;
11. bind every cluster-dependent MCP operation to one exact context permitted by the incident rule;
12. maintain incident investigation state separately from Pi conversation state;
13. implement reusable SRE diagnostic Skills;
14. prevent uncontrolled Kubernetes data from overwhelming model context;
15. operate read-only by default, with controlled operations available only through the explicit Phase 5 opt-in profile and human approval;
16. provide realistic E2E evaluation against Kubernetes clusters;
17. support exact context sets and live `*`, including deterministic reconnect reconciliation and bounded exploratory routing.

---

# 4. Non-Goals

V0.1 will not:

- implement its own Kubernetes API tools;
- reproduce HolmesGPT Kubernetes tool implementations;
- expose Pi SRE as a Pi Package;
- search contexts outside the application-resolved incident rule;
- let the LLM change the incident rule or rely on implicit MCP defaults;
- support active-rule amendment, patterns, multiple MCP servers, or remote workers in the first multi-cluster delivery;
- modify the user's kubeconfig `current-context`;
- provide unrestricted shell access;
- automatically remediate incidents;
- build a custom LLM runtime;
- build a custom TUI;
- implement a multi-agent system;
- support every Kubernetes MCP toolset;
- implement Prometheus, Loki, cloud, database or Git integrations yet.

---

# 5. Core Architecture

```text
┌───────────────────────────────────────────────┐
│               Pi InteractiveMode              │
│                                               │
│ Conversation                                  │
│ Editor                                        │
│ Tool rendering                                │
│ Commands                                      │
│ Model/session controls                        │
│ SRE status footer                             │
└──────────────────────┬────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────┐
│              Pi AgentSessionRuntime           │
│                                               │
│ AgentSession                                  │
│ Agent loop                                    │
│ Streaming                                     │
│ Tool execution                                │
│ Session persistence                           │
│ Compaction                                    │
│ Models                                        │
│ Skills                                        │
│ Extensions                                    │
└──────────────────────┬────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────┐
│                Pi SRE Runtime                 │
│                                               │
│ SRE System Prompt                             │
│ ResourceLoader                                │
│ ClusterContextManager                         │
│ InvestigationController                       │
│ Tool Policy                                   │
│ SRE Extensions                                │
└───────────────┬───────────────────┬───────────┘
                │                   │
                ▼                   ▼
┌────────────────────────┐  ┌──────────────────────────┐
│ Investigation Domain   │  │ MCP Integration         │
│                        │  │                          │
│ Incident               │  │ Pi MCP Client/Transport │
│ Scope                  │  │ Pi SRE Tool Policy      │
│ Target                 │  │ Pi SRE Tool Bridge      │
│ Evidence               │  │ Context Injection       │
│ Hypothesis             │  │ Result Normalization    │
│ InvestigationState     │  │                         │
└────────────────────────┘  └────────────┬─────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │ Kubernetes MCP Server        │
                         │                              │
                         │ config toolset               │
                         │ core toolset                 │
                         │ Kubernetes API access        │
                         │ Multi-cluster contexts       │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                              Kubernetes Cluster
```

---

# 6. Major Architectural Decision: Do Not Implement Kubernetes Tools

Earlier designs proposed implementing tools such as:

```text
kubernetes_jq_query
kubernetes_tabular_query
kubernetes_count
kubernetes_logs
```

inside Pi SRE.

V0.1 no longer follows this approach.

Pi SRE instead consumes tools exposed by Kubernetes MCP Server.

The MCP server already provides:

- generic Kubernetes resources;
- pod operations;
- logs;
- events;
- namespace discovery;
- multi-cluster support;
- configuration/context inspection;
- native Kubernetes API interaction.

It interacts directly with the Kubernetes API instead of simply wrapping `kubectl`.

Therefore:

```text
Pi SRE
   │
   │ MCP
   ▼
Kubernetes MCP Server
   │
   ▼
Kubernetes API
```

replaces:

```text
Pi SRE
   │
   ▼
Our Kubernetes Tools
   │
   ▼
kubectl / JS Kubernetes client
   │
   ▼
Kubernetes API
```

---

# 7. Why MCP Is the Kubernetes Boundary

Using MCP provides several advantages.

## 7.1 Avoid duplicated infrastructure

Pi SRE does not need to implement:

```text
Kubernetes authentication
kubeconfig parsing
context handling
API discovery
CRUD/query semantics
resource serialization
pod logs
event retrieval
multi-cluster transport
```

---

## 7.2 Better architectural boundary

Pi SRE becomes responsible for:

```text
SRE reasoning
investigation state
cluster scope
evidence interpretation
skills
UX
```

while MCP owns:

```text
Kubernetes access
```

---

## 7.3 Independent testability

The MCP server can be tested independently.

Pi SRE's integration tests can then test:

```text
Pi
→ MCP protocol
→ Kubernetes
```

rather than testing a custom Kubernetes client implementation.

---

# 8. Kubernetes MCP Server

V0.1 uses the Kubernetes MCP Server from the `containers/kubernetes-mcp-server` project.

It provides toolsets including:

```text
config
core
```

The default MCP configuration includes these toolsets, and multi-cluster operation causes applicable tools to receive an additional `context` parameter.

The `config` toolset includes:

```text
configuration_contexts_list
configuration_view
targets_list
```

The `core` toolset includes Kubernetes resource, event, pod and related operations.

---

# 9. MCP Connection Model

Pi SRE uses Pi 0.99's standalone `@earendil-works/pi-mcp` package for the MCP protocol client and transport. One application-owned connection serves startup context discovery and subsequent diagnostic calls. Pi SRE does not implement MCP framing, initialization, pagination, cancellation, or stdio process management.

Conceptually:

```text
Pi Tool Interface
       │
       ▼
Pi SRE policy, target validation, and result normalization
       │
       ▼
@earendil-works/pi-mcp client and transport
       │
       ▼
Kubernetes MCP Server
```

Pi SRE does not reinterpret each Kubernetes operation into a custom implementation. Its thin adapter:

1. creates and closes the Pi MCP client;
2. calls `configuration_contexts_list` during startup/reconnect and validates the response for rule resolution;
3. discovers server tools and selects allowlisted capabilities with explicit-context support;
4. adapts approved tool schemas to Pi tool definitions;
5. validates each model call and its exact supplied context under the incident rule, then calls MCP;
6. converts results into evidence and compact model-facing output.

Pi 0.99 also has a built-in MCP extension with `/mcp`, tool exposure, and `tool_call`/`tool_result` hooks. That extension owns its connection and does not expose a documented application-side call for startup context enumeration. Pi SRE therefore uses the standalone client in V0.1 and does not start a second MCP connection through the built-in extension. Reconsider the built-in extension if it gains a suitable programmatic call interface or the startup contract changes.

Pi references: [0.99 release](https://github.com/earendil-works/pi/releases/tag/v0.99.0), [standalone MCP package](https://github.com/earendil-works/pi/blob/v0.99.0/packages/mcp/README.md), [built-in MCP and SDK loading](https://pi.dev/docs/latest/mcp).

---

# 10. MCP Transport

The preferred V0.1 transport is:

```text
stdio
```

Pi SRE uses Pi's `StdioTransport` to start the MCP server as a managed subprocess.

Conceptually:

```text
pi-sre
   │
   └── Pi MCP StdioTransport
         ├── starts Kubernetes MCP Server
         ├── establishes MCP stdio connection
         └── closes the process with the connection
```

Pi's MCP package also supports Streamable HTTP. V0.1 uses stdio; a future version may configure an externally managed HTTP server without introducing another MCP client implementation.

Kubernetes MCP Server supports running as both a local/native process and an HTTP MCP endpoint.

---

# 11. MCP Tool Discovery

During startup:

```text
connect through Pi MCP client
    ↓
list tools through Pi MCP client
    ↓
select allowlisted tools with usable input schemas and explicit-context support
    ↓
call approved configuration_contexts_list and resolve startup scope rule
    ↓
adapt approved schemas to Pi tools
    ↓
register tools with AgentSessionRuntime
```

Pi SRE does not need compile-time implementations for individual Kubernetes operations.

A conceptual adapter:

```ts
interface SreMcpAdapter {
    listApprovedTools(): Promise<readonly AgentTool[]>;
    listClusterContexts(): Promise<readonly ClusterContext[]>;
}
```

The example describes Pi SRE's boundary, not an additional MCP client implementation. Pi SRE trusts the configured MCP server. The server owns descriptions, input schemas, output formats, and Kubernetes execution. Pi SRE owns an operation allowlist, cluster-dependence metadata, model-argument validation, explicit cluster scope, and application retrieval/presentation limits.

Discovered input schemas supply executable argument constraints. Pi SRE copies the server schema for transport validation. Every cluster-dependent tool exposes a required exact model-supplied `context`, constrained by current rule resolution and tool compatibility while preserving server constraints. The same contract applies to singleton sets, multi-context sets, and live `*`; the bridge never hides, infers, injects, or overwrites the target. Other constraints and object openness remain intact. Adding arguments or changing constraints does not require editing local schema copies. New operation names still require a policy change. Minimal integration requirements remain: object inputs, a declared context parameter for cluster-dependent operations, and context enumeration callable with empty arguments. Bound context values must satisfy the discovered parameter schema.

Pi SRE does not compare input/output declarations with reviewed templates, require read-only/destructive annotations, or validate diagnostic resource shapes. It parses fields needed to construct application state, such as context identities and default metadata, while accepting extra server fields and ignoring accompanying presentation content. That parsing provides usable state; it cannot establish server honesty.

Call preparation copies arguments, handles context according to the incident rule, and supplies application defaults. TypeBox validates model arguments against the derived discovered schema. Execution policy independently limits pod logs to 1–1,000 lines, defaults to 100, and blocks streaming. The bridge resolves a per-call incident execution lease for the supplied context and validates final arguments against the original server schema without substituting a target. Cancellation, scope/generation guards, error classification, redaction, and bounded presentation remain separate responsibilities. See [MCP Tool Policy and Schemas](./MCP_TOOL_SCHEMAS.md) for the code map and compatibility details.

---

# 12. Tool Filtering

The Kubernetes MCP Server contains both read and write capabilities.

The default profile is diagnosis-only. Phase 5 adds a separately configured controlled-operations profile with application-owned per-execution approval; it does not weaken the default profile's read-only enforcement.

Therefore read-only behavior should be enforced at multiple layers.

First:

```text
Kubernetes RBAC
```

should provide read-only credentials.

Second, Kubernetes MCP Server should run with:

```toml
read_only = true
```

Third, Pi SRE should register only approved diagnostic tools and check the allowlist again at execution time. A newly discovered tool, a model-supplied `context`, or an MCP annotation alone cannot grant access. Read-only/destructive annotations are not admission requirements; the configured server is trusted.

The MCP server supports `read_only`, `enabled_tools`, `disabled_tools`, and resource deny rules.

Defense therefore becomes:

```text
Pi tool allowlist
       ↓
MCP read_only
       ↓
Kubernetes RBAC
```

---

# 13. AgentSession Is Not Incident

Pi remains responsible for LLM conversation state.

```text
AgentSession
├── messages
├── tool calls
├── model
├── compaction
├── conversation tree
└── streaming state
```

Pi SRE separately tracks operational state.

```text
Incident
├── InvestigationScope
├── Targets
├── Evidence
├── Hypotheses
├── Timeline
└── Findings
```

Therefore:

```text
AgentSession != Incident
```

This distinction remains one of the central architectural principles.

---

# 14. Investigation Domain

V0.1 contains the following core domain objects:

```text
Incident
InvestigationScope
Target
Evidence
Hypothesis
InvestigationState
```

These objects should avoid direct dependencies on Pi runtime classes wherever practical.

---

# 15. Incident

```ts
interface Incident {
    id: string;

    question: string;

    createdAt: Date;

    scope: InvestigationScope;

    status:
        | "new"
        | "investigating"
        | "resolved"
        | "inconclusive";
}
```

An Incident represents an operational investigation.

---

# 16. Investigation Scope

Phase 3 implements exact/all session rules without an incident model. Phase 4 then captures those rules in InvestigationScope. The following illustrative domain contracts describe Phase 4, not prerequisites for Phase 3:

```ts
type ClusterScopeRule =
    | { readonly kind: "exact"; readonly contexts: readonly string[] }
    | { readonly kind: "all" };

interface InvestigationScope {
    readonly rule: ClusterScopeRule;
    readonly revision: number;
    readonly namespacePolicy: "unrestricted";
    readonly timeRange?: TimeRange;
}
```

Exact sets are nonempty and preserve exact named identities. Live `all`, displayed as `*`, resolves to the current validated inventory. The rule is immutable within an incident in the first delivery. Its resolution is separate live application state: wildcard members may join or leave after rediscovery without amending the rule. Newly available contexts start as not checked.

Do not freeze connection generations or inventory revisions into permanent scope authority. Each dispatch captures a current execution lease. Next selection, incident rule, inventory, resolved availability, and actual investigation coverage are distinct.

---

# 17. Cluster Identity

Available contexts come from MCP. Permitted contexts come from applying the incident rule to validated inventory. Each call chooses one exact permitted context.

A context is a named access configuration, not proof of an immutable physical-cluster identity. Multiple contexts may refer to the same cluster with different credentials and remain distinct targets. Do not deduplicate by endpoint or silently infer aliases. Show changed safe endpoint metadata after discovery without claiming to detect every server-side remapping.

```text
Inventory:       prod-us, prod-eu, staging
Incident rule:   exact {prod-us, prod-eu}
Call target:     prod-eu
Next selection:  *
```

---

# 18. Context Enumeration

At startup, Pi SRE calls the already connected Pi MCP client directly:

```text
configuration_contexts_list
```

through the Kubernetes MCP Server. The same connection later serves approved diagnostic tools; context enumeration does not require a model turn or a second MCP subprocess.

The MCP server returns structured information including:

```text
defaultContext
contexts[]
```

with individual context names, server endpoints and default metadata.

Conceptually:

```text
Kubeconfig
    ↓
Kubernetes MCP Server
    ↓
configuration_contexts_list
    ↓
ClusterContextManager
    ↓
AvailableCluster[]
```

---

# 19. Cluster Context Manager

In Phase 3 the cluster layer owns validated MCP inventory, connection generations, and current session selection; its execution snapshots do not require incident identity. In Phase 4 the investigation layer adds the active incident rule and lifecycle. An application controller resolves that rule against the current cluster inventory and supplies immutable per-call leases to the bridge.

Keep the existing context registry and managed connection. Do not implement a second registry/client in the investigation service. Separate inventory revision from next-selection revision; the current Phase 2 manager combines those changes under `registryRevision` and must evolve.

---

# 20. Cluster Selection Sources

Use the explicit CLI rule if supplied, otherwise an explicitly configured `kubernetes.contexts` exact/all rule, otherwise live all-contexts (`*`). With no user choice, `*` is the default even when MCP advertises a default context. An invalid explicit selection never falls back to broader wildcard access.

In Phase 3, idle `/clusters` changes the current session rule for subsequent calls. In Phase 4, while an incident is active, it selects the next incident's rule without changing that active rule. The singular command has no planned alias.

---

# 21. Startup Cluster Resolution

```text
Discover tools and complete MCP context inventory
    → Explicit CLI exact set or all-contexts rule, if supplied
    → Otherwise explicit kubernetes.contexts exact set or all-contexts rule
    → Otherwise live *
```

Validate explicit exact names atomically. MCP default metadata is informational, not a selection source. Empty/failed inventory leaves the selected/default rule pending or unavailable; it does not change that rule or silently infer another context. Incident creation requires at least one permitted context in validated inventory. Every diagnostic call still requires a model-supplied target; default wildcard scope is not a default call target.

---

# 22. CLI Scope Selection

Planned first-delivery syntax:

```bash
pi-sre
pi-sre --clusters prod-us
pi-sre --clusters prod-us prod-eu
pi-sre --clusters '*'
```

With no explicit CLI/config choice, `pi-sre` selects live `*`. `--clusters` accepts one or more exact names as a set, or a sole quoted `*` for live all (including overriding a configured exact choice). Quote the wildcard to prevent shell expansion. [Phase 3 Slice 0](./PHASE3_CONTRACTS.md) freezes parsing and validation and supersedes the earlier repeated-`--cluster`/`--all-clusters` proposal. Pattern matching is deferred. These extensions are not implemented in the current Phase 2 CLI, which accepts only one `--cluster`.

Selection changes application state only; kubeconfig stays unchanged.

---

# 23. Configured Cluster Rule

Configuration accepts the same selection values as CLI:

```yaml
kubernetes:
  contexts: [prod-us, prod-eu]
  # contexts: ["*"] # Live all
```

One name is an exact singleton; several names form an exact set; sole `"*"` means live all. Omission defaults to live all. Both input boundaries normalize to `ClusterScopeRule` before startup selection. Preserve exact names, reject duplicates and empty lists, limit sets to 1,024 names, and reject mixed wildcard/exact values. A literal context named `*` remains reachable through the picker. `defaultCluster` is removed without an alias.

CLI overrides the configured rule entirely. Invalid configuration structure fails loading; an unknown exact name rejects initial resolution atomically without fallback. Recovery re-resolves the unchanged launch-time rule rather than applying edited configuration as new selection intent.

---

# 24. MCP Default Context

MCP's `defaultContext` may be retained as inventory metadata, but it never narrows the incident rule or supplies a missing model argument. Without an explicit user choice, Pi SRE defaults to live `*` even if MCP identifies one context as default. Missing `context` in a cluster-dependent call is always an argument error.

---

# 25. No Usable Scope Resolution

The normal default rule is live `*`, not an unselected state. If inventory discovery fails, or no permitted contexts are available, retain the rule and block diagnostic dispatch. Display the discovery/availability issue and guide the user to `/clusters --status`, `/clusters`, or `/mcp_restart` as appropriate. Do not fabricate cluster access or fall back after an invalid explicit choice.

---

# 26. Unified `/clusters` Command

Use one command for all scope sizes:

| Command | Planned behavior |
| --- | --- |
| `/clusters` | Open a picker for one exact context, an exact set, or live `*` |
| `/clusters <exact-name>` | Select an exact singleton session rule; in Phase 4, next rule while an incident is active |
| `/clusters --all` | Select live `*` for the session; in Phase 4, next rule while an incident is active |
| `/clusters --status` | Inspect session rule/resolution; Phase 4 additionally shows active incident and next selection |

Phase 3 replaces the current singular command without an alias. Selection requires idle state and current inventory; stale pickers cannot commit. It changes the session rule immediately because no incident exists yet. Phase 4 adds next-selection semantics while an incident is open and displays both when different. Active-incident amendment remains deferred; that later domain initially requires another incident for a changed rule.

---

# 27. Selection Does Not Change kubeconfig

Never implement selection or routing with `kubectl config use-context` or other kubeconfig mutation. Keep target identity in application state and final MCP arguments. One call to A must not retarget a concurrent call to B.

---

# 28. Scope Rule and Execution Authority

Phase 3 captures the session rule/revision, exact context, inventory revision, and connection generation per call. Pi owns agent cancellation and settlement before conversation replacement; interactive reload requires idle work. Pi SRE does not add runtime attachment tokens or a separate detach protocol. Phase 4 extends that execution seam with `Incident.scope.rule` as the durable incident boundary. The application computes its current resolution and checks each target against inventory, discovered tool constraints, lifecycle, and budgets.

The Phase 4 incident execution lease adds incident ID and lifecycle epoch to the Phase 3 execution snapshot, alongside scope revision, one exact context, inventory revision, and connection generation. It is not a global active-context pointer. Ordinary evidence updates and next-selection changes do not invalidate other good calls. Connection replacement, incident/session replacement, conclusion, and cancellation invalidate pending authority.

---

# 29. Unified Model-Supplied Context

Every cluster-dependent model tool requires one exact `context`, regardless of whether the incident rule is an exact singleton, an exact multi-context set, or live `*`.

```text
Incident rule: exact {prod-us}
Agent: pods_get(name="billing", namespace="payments", context="prod-us")
Bridge: validate the supplied context against rule, inventory, and tool schema
MCP: dispatch the same explicit target
```

Do not hide the selector, infer a missing value, inject the sole member, or overwrite a disallowed value. Missing context is an error even with one permitted choice. Context-independent discovery/local tools do not require a cluster target. Each diagnostic operation targets one context; no implicit per-call fan-out or server-default fallback is allowed.

---

# 30. Tool Bridge

```text
Validate arguments and operation allowlist
    → Resolve one permitted context and capture a current incident lease
    → In Phase 4, reserve incident call/storage capacity
    → Preserve the model target and validate final MCP arguments
    → Invoke MCP with cancellation
    → Revalidate snapshot before success publication; Phase 4 also commits evidence
```

Preserve server schema constraints. A tool is visible if compatible with at least one permitted target, but execution always checks the actual target again. Direct callers and stale model schemas cannot bypass scope. If policy moves into Pi hooks, validate final mutated arguments explicitly rather than assuming Pi revalidates them.

---

# 31. Model Exploration Within Application Scope

The user selects the rule; the application resolves/enforces it; the model chooses one permitted context per call. Wildcard selection intentionally enables broad discovery without making the model responsible for scope consistency or reconnect handling.

No tool call, prompt text, skill, or discovered context alone can amend an exact rule or turn it into `*`. Existing read-only policy, MCP configuration, and RBAC still apply.

---

# 32. Cross-Cluster Discovery and Reconnect

From Phase 3 the agent may investigate another permitted context under the session rule; Phase 4 later supplies an incident-owned rule. An exact `{prod-us}` rule excludes prod-eu; exact `{prod-us, prod-eu}` and live `*` can permit it. Permission does not require exhaustive scanning or establish query coverage.

On MCP replacement:

1. Block dispatch, invalidate old connection authority, and cancel/settle old calls.
2. Reconnect and rediscover compatible tools and complete context inventory on the new connection.
3. Validate inventory and re-resolve the unchanged session rule (Phase 3), or active incident rule (Phase 4): exact names stay fixed; live `*` follows the new inventory.
4. Atomically publish connection, inventory, resolution, and tools; publish added/removed/changed/unavailable notices before dispatch resumes. Failed inventory discovery keeps diagnostics blocked.

Old-generation results cannot commit evidence. Already committed observations retain their origin/time. Missing exact targets remain unavailable without replacement; other permitted targets can continue. New wildcard targets require no reselection but start as not checked. No interrupted operation is automatically replayed by reconnect.

“Live” follows successful application refreshes, initially startup/reconnect; it is not continuous server watching. Model-driven enumeration does not install a new authoritative registry. Tool-list refresh alone is not context discovery. Rule revision, inventory revision, next-selection revision, connection generation, and coverage remain separate.

---

# 33. Persistent Scope Display

Show the incident rule, resolved membership/count, availability, namespace policy, and READ ONLY or actual controlled profile. Each tool rendering shows its exact context. Show next selection separately when it differs.

```text
READ ONLY
Incident: INC-0007 | Rule: * | Contexts: 3 available
Namespace: * | MCP: ready
Inventory update: +prod-ap (not checked), -retired-eu (unavailable)
```

Keep full membership inspectable with bounded/paginated reads; limited notices do not imply omitted names are absent. A shared transport outage blocks all targets, while a target-specific operation/auth error remains scoped to that target. Availability never implies health or investigation coverage.

---

# 34. Namespace Context

V0.1 may optionally maintain a current namespace.

Conceptually:

```text
Active Cluster:
prod-us

Active Namespace:
payments
```

However namespace selection is weaker than cluster selection.

The agent may still perform cross-namespace discovery when the investigation requires it and policy allows it.

The incident rule remains user-controlled; the model may route between contexts permitted by its current resolution.

---

# 35. SRE Configuration

Example Pi SRE configuration:

```yaml
kubernetes:

  contexts: [staging]

  mcp:
    transport: stdio

    command: kubernetes-mcp-server

    configFile: kubernetes-mcp.toml

investigation:

  defaultTimeRange: 30m

  maxToolCalls: 40

safety:

  mode: read-only
```

## 35.1 Pi SRE Application Home

Pi SRE uses one application-owned home directory by default:

```text
~/.pi-sre/
├── config.yaml
├── kubernetes-mcp.toml
├── auth.json
├── models.json
├── settings.json
├── sessions/
└── logs/
```

This directory contains all Pi SRE configuration and persisted runtime state, including model credentials, model metadata, Pi settings, and conversation sessions. Pi SRE reuses Pi's runtime and provider integration, but it does not reuse Pi Coding Agent's `~/.pi/agent` storage by default.

Pi SRE configures its single Kubernetes MCP connection from validated SRE configuration. It does not load arbitrary user or project `mcp.json` servers as operational tools. The Pi coding agent's built-in MCP extension is not loaded for the V0.1 Kubernetes connection.

At runtime, Pi SRE passes this directory as Pi's `agentDir`, creates its `ModelRuntime` with the `auth.json` and `models.json` paths shown above, and places sessions in `~/.pi-sre/sessions`. This keeps the SRE application's operational state and credentials isolated in one predictable location.

Paths in `config.yaml`, including `kubernetes.mcp.configFile`, resolve relative to the YAML file's directory unless absolute or prefixed with `~/`.

An explicit future migration may import credentials into this directory, but Pi SRE must not silently read, modify, or couple itself to another Pi application's storage.

---

# 36. MCP Server Configuration

The corresponding MCP server should independently enforce read-only access in the default profile. The Phase 5 controlled profile requires explicit operator configuration permitting its approved operations; Pi SRE must never silently rewrite this read-only configuration or expand RBAC.

Example:

```toml
read_only = true

toolsets = [
    "core",
    "config"
]
```

Potentially sensitive or unnecessary tools can additionally be filtered using:

```toml
enabled_tools = [...]
disabled_tools = [...]
```

Kubernetes MCP Server supports these controls directly.

---

# 37. SRE System Prompt

The stable Pi SRE system prompt should communicate policy:

```text
You are a Kubernetes SRE diagnostic agent.

The application owns the incident rule and its current resolution.
Choose only permitted contexts; every multi-context/all call names one exact target.
Distinguish observed facts, hypotheses, availability, and query coverage.
```

It should also establish:

- infrastructure is the primary environment;
- investigation must be evidence-driven;
- facts and hypotheses must remain distinct;
- mutation is prohibited in the default profile; Phase 5 controlled operations require the explicit profile and application-enforced human approval;
- Kubernetes access is through MCP tools;
- tools should be preferred over speculation;
- the application-owned incident rule and current resolution are authoritative;
- the model may choose permitted targets but cannot amend the rule;
- multi-context/all calls require explicit context, and findings must disclose origin and incomplete coverage.

Stable policy belongs in the system prompt. Current membership, inventory changes, and availability belong in bounded application messages restored after compaction; they are informative, not execution authority.

---

# 38. MCP Tools vs Skills

MCP tools provide capabilities.

```text
pods_list
pods_get
pods_log
events_list
resources_list
resources_get
...
```

Skills provide diagnostic knowledge.

```text
CrashLoopBackOff
OOMKilled
Pending Pods
ImagePullBackOff
DNS
Service Connectivity
```

Therefore:

```text
MCP
=
what the agent CAN DO
```

while:

```text
Skill
=
how the agent SHOULD INVESTIGATE
```

---

# 39. Skills

Pi SRE continues to reuse Pi's Skill infrastructure.

Suggested initial skills:

```text
skills/
└── kubernetes/
    ├── crashloopbackoff/
    │   └── SKILL.md
    ├── oomkilled/
    │   └── SKILL.md
    ├── pending-pod/
    │   └── SKILL.md
    ├── image-pull/
    │   └── SKILL.md
    └── dns/
        └── SKILL.md
```

Skills should teach diagnostic reasoning rather than hard-code fixed workflow graphs.

---

# 40. Example Diagnostic Flow

User starts:

```bash
pi-sre --clusters prod-us
```

Startup:

```text
Pi SRE
   ↓
Start/connect Kubernetes MCP
   ↓
configuration_contexts_list
   ↓
prod-us
prod-eu
staging
   ↓
resolve --clusters prod-us
   ↓
Next rule = exact {prod-us}
```

Footer:

```text
prod-us | Namespace: * | READ ONLY
```

User:

```text
billing service is not working
```

Flow:

```text
User request
      ↓
Pi AgentSession
      ↓
Create Incident
      ↓
InvestigationScope

rule = exact {prod-us}
      ↓
Agent reasons about "billing"
      ↓
Agent selects MCP resource tool
      ↓
MCP bridge validates model-supplied

context = prod-us
      ↓
Kubernetes MCP Server
      ↓
Kubernetes API
      ↓
result
      ↓
Evidence
      ↓
Hypothesis
      ↓
next MCP tool
      ↓
more evidence
      ↓
RCA
```

---

# 41. Investigation State

```ts
interface InvestigationState {
    incident: Incident;

    targets: KubernetesTarget[];

    evidence: Evidence[];

    hypotheses: Hypothesis[];

    currentFocus?: string;

    startedAt: Date;

    updatedAt: Date;
}
```

The incident captures `incident.scope.rule`. Store its current resolution separately. Exact membership stays fixed by name; live `*` changes with validated inventory. Historical evidence retains its own context, timestamps, scope/inventory revisions, and connection generation regardless of later selection or resolution changes.

---

# 42. Cluster Switching During an Investigation

Cluster changes create an important semantic boundary.

If an active investigation is already scoped to:

```text
prod-us
```

and the user runs:

```text
/clusters prod-eu
```

Pi SRE should not silently mutate the existing incident's scope.

The first multi-cluster delivery treats this as selecting an exact singleton rule for the next investigation.

Routing to another already permitted context does not change the rule. Adding a context to an exact rule or changing exact selection to `*` requires an explicit active-rule amendment, deferred until after the first delivery. Live `*` automatically includes newly discovered contexts under the existing rule after application reconciliation; it needs no user reselection.

This keeps:

```text
Incident.scope
```

stable.

---

# 43. Evidence

Evidence represents operational facts returned through MCP.

```ts
interface Evidence {
    id: string;

    source: "kubernetes";

    collectedAt: Date;

    cluster: string;

    target?: KubernetesTarget;

    tool: string;

    summary: string;

    metadata?: Record<string, unknown>;

    artifactRef?: string;
}
```

Every evidence item records its exact originating context, incident/execution identity, scope and inventory revisions, connection generation, known namespace, completion time, and truncation. Same-named resources in different contexts remain distinct. Cross-cluster hypotheses can link evidence within one incident without merging observation identities.

---

# 44. Hypothesis

```ts
interface Hypothesis {
    id: string;

    statement: string;

    supportingEvidence: string[];

    contradictingEvidence: string[];

    status:
        | "candidate"
        | "supported"
        | "rejected";
}
```

Hypotheses contain interpretation.

Evidence contains observed facts.

The distinction should remain explicit.

---

# 45. MCP Result Handling

Pi SRE should not blindly place every raw MCP response into the conversation.

The flow should be:

```text
MCP response
     ↓
size inspection
     ↓
normalization
     ↓
Evidence
     ↓
compact model-facing result
```

For small responses, the complete result may be returned.

For large responses, Pi SRE may retain only:

```text
relevant structured data
summary
artifact reference
```

This reduction must happen before a result is returned to the Pi Agent. Pi's built-in MCP extension truncates model-facing text above 20 KB, but it can also retain the complete result in `structuredContent` and write the full text to a temporary file. Those defaults are not Pi SRE's evidence, retention, or sensitive-data policy. The Pi SRE adapter reads MCP content for presentation, classifies MCP `isError` separately from an empty success, and controls both model-facing content and any retained raw artifact. Diagnostic resource shapes and declared output schemas are not validated against application-owned templates.

---

# 46. Context Management

There are now two meanings of "context" that must remain distinct.

## Kubernetes Context

```text
prod-us
prod-eu
staging
```

This identifies a Kubernetes cluster/access configuration.

## LLM Context

```text
messages
skills
tool results
evidence summaries
system prompt
```

These should never be conflated.

Within the codebase, names should prefer:

```text
ClusterContext
```

and:

```text
ModelContext
```

rather than an ambiguous `Context`.

---

# 47. Pi Resource Context

Pi's own `cwd` and project discovery represent a third form of context.

Pi SRE explicitly minimizes reliance on it.

```text
Pi cwd
    !=
Kubernetes Context
    !=
Incident Context
```

This distinction should remain clear throughout the implementation.

---

# 48. Resource Loader

Pi SRE controls its own `ResourceLoader`.

Arbitrary current-directory resources should not automatically redefine SRE behavior.

Pi SRE owns loading of:

```text
SRE System Prompt
SRE Skills
SRE Extensions
SRE configuration
```

The current repository should not be the default semantic environment.

---

# 49. Pi TUI

Pi SRE reuses Pi's `InteractiveMode`.

It keeps Pi functionality such as:

```text
conversation UI
streaming
tool rendering
model selection
session selection
thinking control
```

and adds SRE-specific features using Pi extensions.

---

# 50. SRE TUI Commands

Initial commands:

```text
/clusters
/clusters --status
/clusters --all
/incident
/evidence
```

Potential later commands:

```text
/namespace
/hypotheses
/mcp
```

---

# 51. `/clusters --status`

`/clusters --status` displays the incident rule, resolved contexts/availability, next selection/source when different, namespace policy, actual profile, inventory revision, and MCP state without changing selection. It remains useful when resolution is unavailable or MCP is disconnected. Only sanitized endpoint metadata may be shown.

Example:

```text
Kubernetes

Cluster:
  prod-us

Server:
  https://...

Namespace:
  *

Mode:
  READ ONLY

Incident:
  INC-0007
```

This command refers to SRE operational context, not LLM token context.

---

# 52. MCP Health

Pi SRE should distinguish:

```text
MCP process unavailable
```

from:

```text
Kubernetes authentication unavailable
```

from:

```text
specific Kubernetes API operation failed
```

Possible startup states:

```text
MCP disconnected
MCP connected / no contexts
MCP connected / context unavailable
MCP connected / active cluster ready
```

---

# 53. Startup Failure Flow

Example:

```text
start Pi SRE
     ↓
start MCP
     ↓
configuration_contexts_list fails
```

TUI remains available but Kubernetes diagnosis is disabled.

Display:

```text
Kubernetes MCP unavailable.

Use /clusters --status for connection details.
```

The agent should not hallucinate infrastructure access.

---

# 54. No Kubernetes Contexts

If MCP connects successfully but returns no usable contexts:

```text
Cluster: NOT CONFIGURED
```

Pi SRE should guide the user to configure Kubernetes access.

The agent must not attempt diagnostic calls requiring a cluster.

---

# 55. Security Model

V0.1 trusts the configured MCP server and uses multiple application and infrastructure safety boundaries. Pi SRE cannot constrain independent actions of a server holding cluster credentials or verify its honesty through descriptor checks. The diagram below describes the default read-only profile; the Phase 5 controlled profile additionally requires operation previews, single-use human approvals, scoped credentials, and truthful profile display.

```text
Human-selected scope rule (exact set or live *)
         ↓
Application resolution and per-call context lease
         ↓
Pi diagnostic-tool allowlist
         ↓
MCP read_only
         ↓
MCP resource restrictions
         ↓
Kubernetes RBAC
```

No single layer is treated as sufficient protection.

---

# 56. Generic Shell Access

Generic shell access is disabled by default.

Pi built-in coding tools should initially be disabled.

The Kubernetes MCP boundary should be the normal infrastructure access mechanism.

This avoids:

```text
safe MCP policy
     ↓
LLM bypasses it using bash/kubectl
```

---

# 57. Evaluation Architecture

Evaluation exercises the complete flow:

```text
Fault scenario
    ↓
Kubernetes cluster
    ↓
Kubernetes MCP Server
    ↓
Pi SRE
    ↓
LLM investigation
    ↓
MCP calls
    ↓
Evidence
    ↓
RCA
    ↓
Grader
```

---

# 58. E2E Eval Setup

Recommended local test environment:

```text
kind
```

Example scenario:

```text
create kind cluster
     ↓
deploy faulty workload
     ↓
start Kubernetes MCP against kubeconfig
     ↓
start Pi SRE programmatically
     ↓
set active context
     ↓
ask diagnostic question
     ↓
collect result
     ↓
grade RCA
```

---

# 59. Cluster-Aware Evals

The context layer requires evaluation. Preserve completed Phase 1/2 records as history; Phase 3 acceptance tests the new session-level contracts below. Phase 4 adds incident-pinned/next-selection cases without reimplementing context selection.

Examples:

### Correct CLI context

```text
--clusters cluster-a

agent must only query cluster-a
```

### Invalid CLI context

```text
--clusters unknown

startup must report invalid context
```

### Default live wildcard and explicit configuration

```text
No CLI/config choice; MCP default = kind-test
Incident rule = live *; all discovered contexts are permitted

Explicit kubernetes.contexts = [staging, production]
Incident rule = exact {staging, production}

Explicit kubernetes.contexts = ["*"]
Incident rule = live *

Invalid explicit CLI/config name
Selection error; never broaden to *
```

Every case still requires an exact model-supplied context on every diagnostic call. Singleton membership never supplies a missing argument.

---

### Cluster switch

```text
/clusters prod-eu

Phase 3: subsequent session calls use rule exact {prod-eu}
Phase 4: an open incident keeps its rule; the next incident uses prod-eu
```

### Exact sets and live wildcard after reconnect

```text
Inventory {A, B} → reconnect → {A, C}
Exact {A, B}: A usable; B unavailable; C refused
Live *: A and C permitted; B unavailable; C not checked
Old-generation results withheld; prior evidence unchanged
```

Cover independent parallel calls, schema incompatibility per target, empty/failed enumeration, stale arguments, per-cluster auth failures, shared budgets, and unchanged kubeconfig. Newly available is not investigated; partial/failed queries cannot establish global absence.

### No cluster

```text
no contexts

diagnostic tools remain unavailable
```

---

# 60. Diagnostic Evals

Initial scenarios:

```text
CrashLoopBackOff
OOMKilled
ImagePullBackOff
Missing ConfigMap
Missing Secret reference
Failed readiness probe
Pending due to resource limits
Service selector mismatch
DNS failure
```

These scenarios test diagnosis, not our Kubernetes API implementation.

That API implementation belongs to the MCP server.

---

# 61. Proposed Source Structure

```text
pi-sre/
│
├── src/
│   ├── main.ts
│   │
│   ├── app/
│   │   ├── sre-application.ts
│   │   ├── create-runtime.ts
│   │   └── investigation-controller.ts
│   │
│   ├── runtime/
│   │   ├── resource-loader.ts
│   │   ├── system-prompt.ts
│   │   ├── session.ts
│   │   └── tool-policy.ts
│   │
│   ├── mcp/
│   │   ├── connection.ts
│   │   ├── tool-bridge.ts
│   │   └── result-normalizer.ts
│   │
│   ├── cluster/
│   │   ├── cluster-context.ts
│   │   ├── context-manager.ts
│   │   ├── context-resolver.ts
│   │   └── context-registry.ts
│   │
│   ├── domain/
│   │   ├── incident.ts
│   │   ├── investigation-scope.ts
│   │   ├── target.ts
│   │   ├── evidence.ts
│   │   ├── hypothesis.ts
│   │   └── investigation-state.ts
│   │
│   ├── investigation/
│   │   ├── evidence-store.ts
│   │   ├── hypothesis-manager.ts
│   │   └── investigation-service.ts
│   │
│   ├── config/
│   │   ├── config.ts
│   │   ├── loader.ts
│   │   └── schema.ts
│   │
│   └── tui/
│       ├── extension.ts
│       ├── cluster-command.ts
│       ├── cluster-status.ts
│       └── status-widget.ts
│
├── skills/
│   └── kubernetes/
│       ├── crashloopbackoff/
│       │   └── SKILL.md
│       ├── oomkilled/
│       │   └── SKILL.md
│       ├── pending-pod/
│       │   └── SKILL.md
│       └── dns/
│           └── SKILL.md
│
├── evals/
│   ├── framework/
│   └── cases/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── package.json
├── tsconfig.json
└── DESIGN.md
```

---

# 62. Important Dependency Boundary

There is no longer:

```text
tools/kubernetes/
```

containing Kubernetes implementations.

Instead:

```text
mcp/
```

contains protocol/runtime integration.

The dependency direction becomes:

```text
Pi Agent Runtime
       ↓
Pi SRE Application
       ↓
Investigation Domain
       │
       └─────────────┐
                     │
               MCP Tool Bridge
                     ↓
            Kubernetes MCP Server
                     ↓
              Kubernetes API
```

---

# 63. Phase 1 — Runtime + MCP Skeleton

Detailed implementation plan: [Phase 1 Implementation Slices](./PHASE1_IMPLEMENTATION_SLICES.md).

Deliver:

```text
TypeScript application
Pi AgentSessionRuntime
Pi InteractiveMode
custom ResourceLoader
Pi MCP client/stdio transport integration
Pi MCP tool discovery with SRE filtering
read-only tool exposure
```

Success criterion:

```text
pi-sre
```

opens a Pi-based TUI and can invoke Kubernetes MCP tools.

---

# 64. Phase 2 — Cluster Context Management

Detailed implementation plan: [Phase 2 Implementation Slices](./PHASE2_IMPLEMENTATION_SLICES.md).

This is the historical implemented baseline. Its singular command, singleton-default precedence, and context injection are replaced by the accepted Phase 3 target: unified `/clusters`, default live `*`, and required model context for every diagnostic call. The historical names below are not planned aliases.

Deliver:

```text
configuration_contexts_list integration
ClusterContextRegistry
ClusterContextManager
--cluster
config.defaultCluster
MCP default fallback
/cluster
/cluster --status
TUI cluster footer
context injection into MCP calls
```

Success criterion:

The cluster used by every Kubernetes operation is explicit, visible and deterministic.

This is part of **V0.1**, not a future feature.

---

# 65. Phase 3 — Context Selection and Multi-Cluster Routing

Detailed migration plan: [Phase 3 Implementation Slices](./PHASE3_IMPLEMENTATION_SLICES.md).

Start directly from completed Phase 2. Deliver session-level exact sets/default live `*`, unified `/clusters`, required model-supplied context on every cluster-dependent call, per-call execution snapshots, consistent schema/tool publication, reconnect reconciliation, bounded provenance messages, and packaged/live acceptance. Use the existing diagnostic tools and managed MCP connection.

Success criterion: the upgraded application works without `Incident`, `EvidenceStore`, hypotheses, or incident budgets. No future domain implementation gates context selection. Phase 2 records remain unchanged; intentionally superseded assertions are updated in Phase 3 implementation/tests.

---

# 66. Phase 4 — Investigation Domain

Detailed implementation plan: [Phase 4 Implementation Slices](./PHASE4_IMPLEMENTATION_SLICES.md).

After Phase 3 acceptance, add Incident, InvestigationScope, Target, Evidence, Hypothesis, InvestigationState, and EvidenceStore. Reuse Phase 3 selection, routing, schema validation, snapshots, and reconnect behavior; extend the authority seam with incident lifecycle/session binding, evidence capture, per-context outcome records, and shared per-incident budgets.

Success criterion: operational investigation state exists independently from the Pi transcript. An active incident owns its immutable rule while `/clusters` can select a different rule for the next incident. Incident/evidence wiring lands together without disabling or rebuilding the accepted Phase 3 application.

---

# 67. Phase 5 — Kubernetes MCP Config/Core Parity

Detailed implementation plan: [Phase 5 Implementation Slices](./PHASE5_IMPLEMENTATION_SLICES.md).
Reference inventory and research: [HolmesGPT Kubernetes MCP Comparison](./HOLMESGPT_KUBERNETES_MCP_PARITY.md).

Deliver support for all **22 documented tool definitions** in the reference inventory:

| MCP toolset | Documented tools, including writes | Enabled by default in the MCP server |
| --- | ---: | --- |
| config | 3 | Yes |
| core | 19 | Yes |
| **Total** | **22** | **2 toolsets** |

Every expanded call uses one exact target admitted by Phase 4 incident rule resolution, built on Phase 3 routing. Wildcard diagnostic permission never grants blanket controlled-operation approval. Approvals bind final arguments, exact target, incident/scope and inventory revisions, and connection generation.

The target includes 16 read definitions and 6 controlled-operation definitions. Actual discovery depends on server version, provider, platform, selected mode, and configuration; parity does not require 22 simultaneously advertised tools. Keep discovered-schema validation and explicit incident cluster scope.

This is the explicit design expansion authorizing planned support for `pods_delete`, `pods_exec`, `pods_run`, `resources_create_or_update`, `resources_delete`, and `resources_scale`. The default profile remains read-only. Controlled operations require an opt-in startup profile, operator-configured MCP/RBAC permissions, concrete per-call human approval, and safe outcome/verification records. Configuration inspection and generic resource reads require sensitive-data policy. All Kubernetes execution continues through MCP.

Success criterion:

Every reference definition has tested capability handling, including conditional availability. Applicable reads produce scoped evidence; all six controlled capabilities execute only through the opt-in approval boundary. The default profile remains read-only. Full parity requires both read and controlled-operation delivery.

---

# 68. Phase 6 — Kubernetes Diagnostic Skills

Implement:

```text
CrashLoopBackOff
OOMKilled
Pending
ImagePullBackOff
DNS
Service connectivity
```

Success criterion:

The agent can apply reusable diagnostic knowledge to MCP capabilities.

---

# 69. Phase 7 — Eval Framework

Build kind-based end-to-end evaluation.

Success criterion:

```text
inject fault
→ select cluster
→ invoke Pi SRE
→ inspect MCP calls
→ collect evidence
→ grade RCA
```

runs automatically.

---

# 70. Phase 8 — TUI Refinement

Add:

```text
/clusters
/clusters --status
/clusters --all
/incident
/evidence

cluster footer
namespace footer
READ ONLY state
incident status
MCP connection status
```

Display the actual execution profile continuously: READ ONLY for the default profile, or controlled operations / approval required for the Phase 5 opt-in profile. A write-enabled connection must never be labelled READ ONLY.

---

# 71. Future Integrations

After the first exact-set/live-`*` delivery, extend in this order: explicit active scope amendment, pattern rules, richer fleet workflows/comparison views, then multiple MCP servers/per-user authentication/remote workers when deployment requirements justify them. These are not first-delivery prerequisites; remote execution does not mandate multiple reasoning agents.

After Kubernetes diagnosis is stable:

```text
Prometheus MCP
Loki / observability MCP
GitHub
cloud infrastructure
databases
deployment systems
```

should preferably follow the same external-tool-provider model when good MCP servers exist.

This creates a broader architecture:

```text
                   Pi SRE
                     │
               Agent Runtime
                     │
               Investigation
                     │
        ┌────────────┼──────────────┐
        ▼            ▼              ▼
 Kubernetes MCP   Metrics MCP    Database MCP
```

The Investigation Domain remains independent of which provider produced the evidence.

---

# 72. Controlled Operations and Broader Remediation

Phase 5 brings the six config/core write-capable or exec operations into scope as individual human-approved actions. This replaces the original blanket deferral of all write capabilities. Autonomous remediation, automatic rollback, and general remediation workflows remain outside this milestone.

The controlled-operation boundary is:

```text
Diagnosis
    ↓
Remediation Proposal
    ↓
Risk / Policy Check
    ↓
Human Approval
    ↓
Write-capable MCP
    ↓
Execution
    ↓
Verification
```

The write-capable MCP configuration is an explicit opt-in profile separate from the default read-only configuration. An approval binds to a concrete call and its incident scope; a successful operation response is distinct from read-after-write verification. The Phase 5 implementation plan defines delivery and acceptance.

---

# 73. Accepted Architectural Decisions

### ADR-1
Pi SRE is an independent application, not a Pi Package.

### ADR-2
Pi `AgentSessionRuntime` is reused as the Agent runtime.

### ADR-3
Pi `InteractiveMode` is reused as the TUI.

### ADR-4
Pi SRE does not implement Kubernetes diagnostic tools itself.

### ADR-5
Kubernetes capabilities come from Kubernetes MCP Server.

### ADR-6
Pi SRE reuses `@earendil-works/pi-mcp` for the MCP client and transport, with a thin SRE-owned policy/tool bridge. V0.1 does not also run Pi's built-in MCP extension for Kubernetes.

### ADR-7
MCP `config` and `core` toolsets form the initial Kubernetes capability surface.

### ADR-8
Read-only is the default. Phases 1–4 remain diagnosis-only. The explicitly requested Phase 5 design expansion adds an opt-in controlled-operations profile with per-execution human approval; no autonomous remediation is enabled.

### ADR-9
Generic shell access is disabled by default.

### ADR-10
Kubernetes cluster/context management is part of V0.1.

### ADR-11
Available contexts are discovered using MCP.

### ADR-12
Phase 3 session rule/resolution is application-owned. Phase 4 separates an active incident rule from next-investigation selection.

### ADR-13
The unified `/clusters` command changes current session selection in Phase 3; Phase 4 adds next-selection semantics while an incident is active. It never changes kubeconfig, and the singular command is replaced without an alias.

### ADR-14
`--clusters <exact-name> <exact-name>` selects an explicit exact set and `--clusters '*'` explicitly selects live `*`. Wildcard is the sole value and should be quoted against shell expansion. Without CLI/config choice, live `*` is already the default. Parsing is frozen in [Phase 3 contracts](./PHASE3_CONTRACTS.md).

### ADR-15
An explicitly configured `kubernetes.contexts` is a user choice establishing an exact set or live-all rule, with the same validation as CLI values; otherwise startup defaults to live `*` unless CLI overrides it.

### ADR-16
MCP default-context metadata does not select or narrow investigation scope. Without an explicit user choice, the rule is live `*`.

### ADR-17
Every cluster-dependent MCP operation uses exactly one explicit validated `context`; operational enumeration is context-independent.

### ADR-18
The model may explore contexts permitted by the incident rule; it cannot amend that rule or grant itself access. Every cluster-dependent call requires a model-selected exact target for every rule, including singleton; the application validates it without injection or overwrite.

### ADR-19
The scope rule, resolution/availability, and actual execution profile remain visible; every tool call identifies its context.

### ADR-20
`AgentSession` and `Incident` remain different abstractions.

### ADR-21
Evidence records its source cluster.

### ADR-22
Skills provide investigation knowledge; MCP tools provide execution capability.

### ADR-23
Evaluation is a first-class system component.

### ADR-24
V0.1 remains a single TypeScript project.

### ADR-25
Pi SRE trusts the configured MCP server and consumes its discovered schemas. Application policy defines approved operation names, scope ownership, and retrieval limits. The bridge validates model arguments and the supplied context against application-owned rule resolution, then validates final transport arguments; it does not inject or overwrite context. Exact schema matching, mandatory annotation checks, and diagnostic output contracts are not used. Only fields consumed as application state are parsed for usability and consistency.

### ADR-26
Phase 3 allows explicit idle session selection. Phase 4 incident rules are immutable in their initial delivery. Exact membership is fixed by name; live `*` membership is recomputed from validated inventory. Rule revision, inventory revision, selection revision, connection generation, and evidence revision are distinct.

### ADR-27
MCP reconnect blocks dispatch and invalidates old work, rediscovers tools and contexts, and atomically publishes resolved scope/tools and change notices before dispatch resumes. Availability is not investigation coverage.

---

# 74. Open Questions

The following remain intentionally open.

## MCP lifecycle

V0.1 uses one Pi MCP client and managed stdio transport. Should a later version also allow an externally managed Streamable HTTP server? Pi's MCP package supports that transport without changing Pi SRE's policy boundary.

---

## MCP tool description guidance

How much should the Pi-facing MCP tool descriptions be modified for SRE-specific guidance?

The MCP server supports tool-description overrides, so some guidance may belong server-side rather than in Pi.

---

## Namespace state

Should `/namespace` become a first-class V0.1 command, or should namespace discovery remain LLM-driven initially?

---

## Evidence persistence

Should raw MCP responses be stored only in memory or persisted as artifacts?

---

## Investigation state injection

How much structured InvestigationState should be included in each model turn?

---

## Eval grading

Initial evaluation should likely combine:

```text
deterministic assertions
+
LLM semantic grading
```

but the exact framework remains open.

---

# 75. Core Architectural Thesis

Pi SRE is not another Kubernetes client.

It is not another general-purpose Agent Harness either.

Pi already provides the Agent runtime.

Kubernetes MCP Server already provides the Kubernetes capability layer.

The project's actual architectural responsibility is the layer between them:

```text
                  Pi
                   │
            Agent Runtime
                   │
                   ▼
           ┌───────────────┐
           │    Pi SRE     │
           │               │
           │ Scope         │
           │ Investigation │
           │ Evidence      │
           │ Hypotheses    │
           │ Skills        │
           │ Safety        │
           │ UX            │
           └───────┬───────┘
                   │
                   ▼
             Kubernetes MCP
                   │
                   ▼
              Kubernetes
```

In other words:

> **Pi owns how the agent runs.**

> **Kubernetes MCP owns how Kubernetes is accessed.**

> **Pi SRE owns what is being investigated, where the investigation is allowed to operate, how evidence is interpreted, and how the user interacts with the SRE agent.**

---

# 76. Final V0.1 Flow

```text
                    User
                      │
                      ▼
              Pi InteractiveMode
                      │
                      ▼
            Pi AgentSessionRuntime
                      │
                      ▼
                Pi SRE Runtime
                      │
          ┌───────────┴────────────┐
          │                        │
          ▼                        ▼
 ClusterContextManager      Investigation
          │                        │
          │ Scope resolution       │
          │                        │
          └───────────┬────────────┘
                      │
                      ▼
                MCP Tool Bridge
                      │
        validate model-supplied context
                      │
                      ▼
             Kubernetes MCP Server
                      │
                      ▼
               Kubernetes API
                      │
                      ▼
                 MCP Result
                      │
                      ▼
                   Evidence
                      │
                      ▼
                  Hypothesis
                      │
                      ▼
                     RCA
```

The user's operational boundary remains visible throughout:

```text
prod-us | payments | READ ONLY
```

For multi-cluster rules the display shows the rule and resolved membership/count, and each call shows its exact target. Every Kubernetes request executes against one context permitted by that boundary.
