# Pi SRE — Project Design Document

**Status:** Draft  
**Version:** 0.1  
**Primary Language:** TypeScript  
**Agent Runtime:** Pi / `@earendil-works/pi-coding-agent`  
**Kubernetes Integration:** Kubernetes MCP Server  
**Primary Domain:** Kubernetes Incident Diagnosis

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
- MCP lifecycle and integration
- MCP-to-Pi tool bridge
- cluster/context management
- active-cluster state
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
7. support `/cluster` runtime selection;
8. support `--cluster` startup selection;
9. support a configured default cluster;
10. continuously display the active cluster in the TUI;
11. pass the selected context explicitly into Kubernetes MCP operations;
12. maintain incident investigation state separately from Pi conversation state;
13. implement reusable SRE diagnostic Skills;
14. prevent uncontrolled Kubernetes data from overwhelming model context;
15. operate read-only;
16. provide realistic E2E evaluation against Kubernetes clusters.

---

# 4. Non-Goals

V0.1 will not:

- implement its own Kubernetes API tools;
- reproduce HolmesGPT Kubernetes tool implementations;
- expose Pi SRE as a Pi Package;
- automatically search arbitrary clusters;
- let the LLM silently change the active cluster;
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
│ Incident               │  │ MCP Client              │
│ Scope                  │  │ Tool Discovery          │
│ Target                 │  │ Pi Tool Bridge          │
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

Pi SRE contains an MCP integration layer.

Conceptually:

```text
Pi Tool Interface
       │
       ▼
McpToolBridge
       │
       ▼
MCP Client
       │
       ▼
Kubernetes MCP Server
```

Pi SRE does not reinterpret each Kubernetes operation into a custom implementation.

Instead it:

1. connects to MCP;
2. discovers available tools;
3. filters allowed tools;
4. converts their schemas into Pi-compatible tool definitions;
5. invokes MCP when the Pi Agent calls the tool;
6. returns MCP results to Pi.

---

# 10. MCP Transport

The preferred V0.1 transport is:

```text
stdio
```

Pi SRE may start the MCP server as a managed subprocess.

Conceptually:

```text
pi-sre
   │
   ├── starts Kubernetes MCP Server
   │
   ├── establishes MCP stdio connection
   │
   └── owns process lifecycle
```

Future versions may also support an externally managed MCP server over Streamable HTTP.

Kubernetes MCP Server supports running as both a local/native process and an HTTP MCP endpoint.

---

# 11. MCP Tool Discovery

During startup:

```text
connect MCP
    ↓
initialize
    ↓
list tools
    ↓
filter allowed tools
    ↓
convert to Pi tools
    ↓
register tools with AgentSessionRuntime
```

Pi SRE does not need compile-time implementations for individual Kubernetes operations.

A conceptual adapter:

```ts
interface McpToolBridge {
    discoverTools(): Promise<McpToolDefinition[]>;

    createPiTools(
        tools: McpToolDefinition[]
    ): AgentTool[];
}
```

---

# 12. Tool Filtering

The Kubernetes MCP Server contains both read and write capabilities.

V0.1 is diagnosis-only.

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

Third, Pi SRE should expose only approved diagnostic tools.

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

Cluster context is now explicitly part of V0.1.

```ts
interface InvestigationScope {
    cluster: ClusterRef;

    namespaces?: string[];

    workloads?: WorkloadRef[];

    timeRange?: TimeRange;
}
```

The initial V0.1 model intentionally has one active cluster per investigation.

Multi-cluster investigation is not part of the initial automatic investigation behavior.

---

# 17. Cluster Identity

Pi SRE distinguishes:

```text
Available Clusters
```

from:

```text
Active Cluster
```

Available clusters come from MCP.

Active cluster is application/session state owned by Pi SRE.

Example:

```text
Available:
  prod-us
  prod-eu
  staging

Active:
  prod-us
```

---

# 18. Context Enumeration

At startup, Pi SRE calls:

```text
configuration_contexts_list
```

through the Kubernetes MCP Server.

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

Pi SRE introduces:

```ts
interface ClusterContextManager {
    list(): readonly ClusterContext[];

    getActive(): ClusterContext | undefined;

    setActive(name: string): void;

    refresh(): Promise<void>;
}
```

Example context:

```ts
interface ClusterContext {
    name: string;

    server?: string;

    mcpDefault: boolean;
}
```

The manager represents Pi SRE's view of MCP Kubernetes contexts.

---

# 20. Cluster Selection Sources

An active cluster can come from four sources.

```text
1. --cluster
2. session /cluster selection
3. Pi SRE config default
4. MCP default context
```

The active cluster always resolves to an actual MCP context.

---

# 21. Startup Cluster Resolution

On startup:

```text
enumerate MCP contexts
        ↓
validate --cluster if provided
        ↓
otherwise check config default
        ↓
otherwise check MCP defaultContext
        ↓
otherwise remain unbound
```

Formally:

```text
--cluster
   >
config.defaultCluster
   >
MCP defaultContext
   >
UNBOUND
```

A `/cluster` selection occurs after startup and overrides the session's current active cluster.

---

# 22. `--cluster`

Users can explicitly select the startup cluster:

```bash
pi-sre --cluster prod-us
```

This establishes:

```text
ActiveCluster = prod-us
```

for the current Pi SRE session.

It does not modify:

```text
kubectl current-context
```

and does not modify kubeconfig.

---

# 23. Configured Default Cluster

Example:

```yaml
kubernetes:
  defaultCluster: staging
```

Starting:

```bash
pi-sre
```

then selects:

```text
staging
```

provided `staging` exists in the MCP context registry.

If the configured context does not exist, startup reports the configuration problem instead of silently selecting another cluster.

---

# 24. MCP Default Context

When neither:

```text
--cluster
```

nor:

```text
config.defaultCluster
```

is set, Pi SRE may adopt MCP's reported:

```text
defaultContext
```

as the initial active cluster.

This makes first-time usage convenient while preserving explicit Pi SRE state after startup.

---

# 25. Unbound State

If MCP reports multiple contexts but there is no usable default:

```text
ActiveCluster = undefined
```

The TUI displays:

```text
Cluster: NOT SELECTED | READ ONLY
```

Cluster-dependent Kubernetes operations are blocked.

The user is guided to run:

```text
/cluster
```

or restart with:

```text
--cluster <name>
```

The LLM should not guess.

---

# 26. `/cluster`

Pi SRE provides a runtime command:

```text
/cluster
```

Without an argument it opens an interactive context selector.

Example:

```text
Select Kubernetes cluster

● prod-us
  prod-eu
  staging
```

With an argument:

```text
/cluster prod-eu
```

the active cluster changes immediately.

---

# 27. `/cluster` Does Not Change kubeconfig

This is a critical architectural rule.

Pi SRE must not implement `/cluster` by executing:

```bash
kubectl config use-context ...
```

or otherwise changing global kubeconfig state.

Instead:

```text
/cluster prod-eu
        ↓
ClusterContextManager
        ↓
activeCluster = prod-eu
```

The kubeconfig remains unchanged.

---

# 28. Why Active Cluster Is Application State

Mutable process-global Kubernetes context creates concurrency hazards.

For example:

```text
Investigation A → prod

Investigation B → staging
```

must never cause one investigation's tool calls to accidentally execute against the other's cluster.

Therefore cluster identity should remain explicit data.

```text
InvestigationScope.cluster
```

is authoritative.

---

# 29. Explicit Context on Every MCP Call

Although the user interacts with one active cluster, Kubernetes operations should internally include an explicit MCP `context`.

For example:

```text
Agent:
pods_list(namespace="billing")
```

becomes internally:

```text
MCP:
pods_list(
    namespace="billing",
    context="prod-us"
)
```

The LLM does not need to repeatedly decide the cluster.

The Pi SRE execution layer injects it.

---

# 30. Context Injection

The MCP bridge performs:

```text
Pi Agent Tool Call
      │
      ▼
McpToolBridge
      │
      ├── inspect active InvestigationScope
      │
      ├── inject MCP context
      │
      ▼
Kubernetes MCP Tool
```

Conceptually:

```ts
const args = {
    ...agentArguments,
    context: investigation.scope.cluster.contextName,
};

return mcp.callTool(toolName, args);
```

---

# 31. Why the Agent Does Not Normally Choose the Cluster

HolmesGPT's MCP multi-cluster flow allows the LLM to enumerate and choose contexts.

Pi SRE V0.1 deliberately chooses a different safety model.

```text
Human / application establishes scope
            ↓
Agent investigates inside scope
```

instead of:

```text
Agent decides operational scope
            ↓
Agent investigates
```

The active cluster is therefore:

- explicit;
- visible;
- stable;
- user-controlled.

---

# 32. Cross-Cluster Discovery

Automatic cross-cluster discovery is outside V0.1.

If:

```text
Active cluster = prod-us
```

and:

```text
billing
```

does not exist there, the agent should not automatically investigate `prod-eu`.

It may explain:

```text
No matching billing workload was found in prod-us.
```

The user can then:

```text
/cluster prod-eu
```

This constraint may be revisited later.

---

# 33. TUI Footer

The selected cluster is always visible.

Example:

```text
prod-us | Namespace: * | READ ONLY
```

or:

```text
prod-us | payments | READ ONLY
```

If unbound:

```text
NO CLUSTER | READ ONLY
```

This is not merely cosmetic.

The footer is part of the safety model because users should always know the operational scope of the agent.

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

Cluster switching remains explicitly user-controlled.

---

# 35. SRE Configuration

Example Pi SRE configuration:

```yaml
kubernetes:

  defaultCluster: staging

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

At runtime, Pi SRE passes this directory as Pi's `agentDir`, creates its `ModelRuntime` with the `auth.json` and `models.json` paths shown above, and places sessions in `~/.pi-sre/sessions`. This keeps the SRE application's operational state and credentials isolated in one predictable location.

Paths in `config.yaml`, including `kubernetes.mcp.configFile`, resolve relative to the YAML file's directory unless absolute or prefixed with `~/`.

An explicit future migration may import credentials into this directory, but Pi SRE must not silently read, modify, or couple itself to another Pi application's storage.

---

# 36. MCP Server Configuration

The corresponding MCP server should independently enforce read-only access.

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

The Pi SRE system prompt should communicate:

```text
You are a Kubernetes SRE diagnostic agent.

The current operational scope is:

Cluster: prod-us
Mode: READ ONLY
```

It should also establish:

- infrastructure is the primary environment;
- investigation must be evidence-driven;
- facts and hypotheses must remain distinct;
- mutation is prohibited;
- Kubernetes access is through MCP tools;
- tools should be preferred over speculation;
- current cluster is authoritative;
- the model must not attempt to change clusters itself.

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
pi-sre --cluster prod-us
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
resolve --cluster prod-us
   ↓
ActiveCluster = prod-us
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

cluster = prod-us
      ↓
Agent reasons about "billing"
      ↓
Agent selects MCP resource tool
      ↓
MCP bridge injects

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

The active cluster is captured in:

```text
incident.scope.cluster
```

so historical investigation state remains stable even if the user later changes `/cluster`.

---

# 42. Cluster Switching During an Investigation

Cluster changes create an important semantic boundary.

If an active investigation is already scoped to:

```text
prod-us
```

and the user runs:

```text
/cluster prod-eu
```

Pi SRE should not silently mutate the existing incident's scope.

V0.1 should treat this as establishing the default cluster for the next investigation.

If the user explicitly wants to continue the same incident against another cluster, that should require a deliberate future multi-cluster workflow.

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

Every evidence item records its originating cluster.

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
/cluster
/context
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

# 51. `/context`

`/context` should display operational context clearly.

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

Use /context for connection details.
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

V0.1 uses multiple safety boundaries.

```text
Human-selected active cluster
         ↓
InvestigationScope
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

The context layer itself requires evaluation.

Examples:

### Correct CLI context

```text
--cluster cluster-a

agent must only query cluster-a
```

### Invalid CLI context

```text
--cluster unknown

startup must report invalid context
```

### Config default

```text
defaultCluster = staging

active cluster must become staging
```

### MCP fallback

```text
no CLI
no config default
MCP default = kind-test

active cluster = kind-test
```

### Cluster switch

```text
/cluster prod-eu

new investigations use prod-eu
```

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
│   │   ├── client.ts
│   │   ├── server-process.ts
│   │   ├── tool-discovery.ts
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
│       ├── context-command.ts
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
Kubernetes MCP process/client
MCP tool discovery
read-only tool exposure
```

Success criterion:

```text
pi-sre
```

opens a Pi-based TUI and can invoke Kubernetes MCP tools.

---

# 64. Phase 2 — Cluster Context Management

Deliver:

```text
configuration_contexts_list integration
ClusterContextRegistry
ClusterContextManager
--cluster
config.defaultCluster
MCP default fallback
/cluster
/context
TUI cluster footer
context injection into MCP calls
```

Success criterion:

The cluster used by every Kubernetes operation is explicit, visible and deterministic.

This is part of **V0.1**, not a future feature.

---

# 65. Phase 3 — Investigation Domain

Deliver:

```text
Incident
InvestigationScope
Target
Evidence
Hypothesis
InvestigationState
EvidenceStore
```

Success criterion:

Operational investigation state exists independently from the Pi transcript.

---

# 66. Phase 4 — Kubernetes Diagnostic Skills

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

# 67. Phase 5 — Eval Framework

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

# 68. Phase 6 — TUI Refinement

Add:

```text
/cluster
/context
/incident
/evidence

cluster footer
namespace footer
READ ONLY state
incident status
MCP connection status
```

---

# 69. Future Integrations

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

# 70. Future Remediation

Remediation remains outside V0.1.

Future architecture:

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

A future write-capable MCP configuration must remain separate from the V0.1 read-only safety model.

---

# 71. Accepted Architectural Decisions

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
Pi SRE maintains a thin MCP integration/tool-bridge layer.

### ADR-7
MCP `config` and `core` toolsets form the initial Kubernetes capability surface.

### ADR-8
V0.1 is read-only.

### ADR-9
Generic shell access is disabled by default.

### ADR-10
Kubernetes cluster/context management is part of V0.1.

### ADR-11
Available contexts are discovered using MCP.

### ADR-12
The active cluster is Pi SRE application/session state.

### ADR-13
`/cluster` changes Pi SRE state, not kubeconfig.

### ADR-14
`--cluster` provides an explicit startup override.

### ADR-15
A configured default cluster may establish startup scope.

### ADR-16
MCP's default context may be used as a final startup fallback.

### ADR-17
Every Kubernetes MCP operation uses an explicit `context`.

### ADR-18
The agent does not silently infer or switch clusters.

### ADR-19
The active cluster is continuously visible in the TUI.

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

---

# 72. Open Questions

The following remain intentionally open.

## MCP lifecycle

Should Pi SRE always start its own MCP process, or optionally connect to an already-running server in V0.1?

The initial implementation should prefer managed stdio.

---

## MCP tool schema adaptation

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

# 73. Core Architectural Thesis

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

# 74. Final V0.1 Flow

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
          │ Active Cluster         │
          │                        │
          └───────────┬────────────┘
                      │
                      ▼
                MCP Tool Bridge
                      │
                 inject context
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

and every Kubernetes request executes against the context represented by that boundary.
