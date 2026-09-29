## Project Purpose

Pi SRE is an independent, read-only TypeScript application for Kubernetes incident diagnosis. It reuses Pi as its agent runtime and Kubernetes MCP Server as its Kubernetes access boundary.

V0.1 supports observing, diagnosing, and explaining incidents. It does not remediate them.

## Core Architecture

```text
Pi Agent Runtime
        ↓
Pi SRE Application
        ↓
MCP Tool Bridge
        ↓
Kubernetes MCP Server
        ↓
Kubernetes API
```

Pi owns the agent loop and terminal UI. Pi SRE owns operational scope, investigation state, evidence, hypotheses, safety policy, and SRE-specific user experience. Kubernetes MCP Server owns Kubernetes API access.

## Repository Map

- `src/app/` — application composition and investigation control
- `src/runtime/` — Pi runtime integration, prompts, resource loading, and tool policy
- `src/mcp/` — MCP process lifecycle, client, tool discovery, bridge, and result normalization
- `src/cluster/` — explicit cluster-context state and startup resolution
- `src/domain/` — Pi-independent incident, scope, evidence, target, and hypothesis models
- `src/investigation/` — evidence and hypothesis services
- `src/config/` — configuration schema and loading
- `src/tui/` — Pi TUI commands, extension registration, and status widgets
- `skills/kubernetes/` — diagnostic knowledge, not Kubernetes tool implementations
- `tests/` and `evals/` — unit, integration, end-to-end, and kind-based evaluation suites

## Development Commands

```bash
npm run check
npm run lint
npm test
npm run build
```

## Architectural Invariants

- Keep `AgentSession` and `Incident` as separate abstractions.
- Do not implement Kubernetes API tools in Pi SRE; use Kubernetes MCP Server through the MCP bridge.
- Keep evidence (observed facts) distinct from hypotheses (interpretation).
- Do not make the repository working directory the application's operational context.
- Do not add generic shell or `kubectl` access as a path around MCP policy.

## Kubernetes Context Rules

- Discover available contexts through the MCP `configuration_contexts_list` tool.
- Resolve startup scope in this order: `--cluster`, configured default cluster, MCP default context, then unbound.
- Treat the active cluster as application/session state; never modify kubeconfig or run `kubectl config use-context`.
- Inject the selected context explicitly into every cluster-dependent MCP operation.
- Never allow the model to silently infer or switch clusters.
- If no cluster is selected, block cluster-dependent calls and guide the user to `/cluster` or `--cluster`.

## Tool Usage Rules

- Expose only approved diagnostic MCP tools.
- Keep tool handling thin: validate input, resolve scope, call MCP, normalize the response, and return a compact result.
- Enforce read-only behavior in Pi SRE, the MCP server configuration, and Kubernetes RBAC.
- Preserve large raw responses outside the model context and return concise, relevant summaries.

## Diagnosis vs. Remediation

Diagnosis is in scope. Automatic or manual remediation is not part of V0.1. Do not add write-capable tools, mutation workflows, or remediation logic without an explicit design change.

## Safety Rules

- Display the active cluster, namespace, and read-only state continuously in the TUI.
- Do not log credentials, tokens, kubeconfig contents, secrets, or raw sensitive resource data.
- Treat an unavailable MCP server, unavailable Kubernetes authentication, and a failed Kubernetes operation as distinct states.
- Do not claim access to infrastructure when MCP is unavailable.

## Testing

- Unit-test domain logic and cluster-context resolution without a live cluster.
- Integration-test MCP protocol and tool-bridge behavior with deterministic fixtures.
- Keep real-cluster tests in explicit end-to-end or evaluation suites.

## SRE Evals

Use kind-based evaluation for end-to-end scenarios. Cover cluster selection and fault diagnosis, including CrashLoopBackOff, OOMKilled, ImagePullBackOff, missing ConfigMaps or Secrets, failed readiness probes, pending Pods, service-selector mismatches, and DNS failures.

## Definition of Done

A change is complete when it preserves the read-only safety model, keeps cluster scope explicit, has proportionate tests, and passes the relevant commands in `package.json`.

## Documentation Map

- `docs/DESIGN.md` is the authoritative V0.1 scope and architecture.
- `README.md` documents local setup and available project commands.
- `config/*.example.*` contains versioned, safe configuration templates.

## TypeScript Conventions

- Use TypeScript for all package, extension, MCP integration, and orchestration code.
- Prefer explicit types at module boundaries; allow inference inside small local scopes.
- Avoid `any`. Use `unknown` for untrusted external data, then validate or narrow it before use.
- Prefer discriminated unions for protocol messages, tool results, events, and state transitions.
- Prefer `type` for unions/compositions and `interface` for extensible object contracts.
- Use `readonly` where mutation is not intended.

### ESM and imports

This project uses ESM.

- Use `import` / `export`; do not introduce CommonJS `require`.
- Follow the repository's existing import-extension convention.
- Prefer named exports for reusable helpers.
- Avoid barrel files when they introduce circular dependencies or hide ownership.
- Use `import type` for type-only imports when practical.

```ts
interface SreExtensionApi {
  registerTool(): void;
}

export type SreExtension = (pi: SreExtensionApi) => void;
```

### Async code

- Prefer `async` / `await` over explicit Promise chains for orchestration code.
- Do not create floating promises. Every promise must be awaited, returned, or intentionally handled.
- Run independent operations concurrently with `Promise.all`.
- Do not parallelize operations when ordering affects Kubernetes state or remediation safety.
- Propagate cancellation/abort signals through long-running MCP and Kubernetes operations where supported.

```ts
async function collectPodAndEventData(): Promise<void> {
  const [pods, events] = await Promise.all([Promise.resolve([]), Promise.resolve([])]);

  void pods;
  void events;
}
```

### Error handling

- Do not swallow exceptions.
- Preserve the original error as `cause` when adding context.
- Errors crossing module boundaries should contain actionable operational context such as cluster, namespace, resource kind, and operation.
- Never include credentials, tokens, kubeconfig contents, or secrets in errors or logs.

```ts
interface ToolClient {
  callTool(request: unknown): Promise<unknown>;
}

async function inspectPods(
  client: ToolClient,
  request: unknown,
  namespace: string,
): Promise<unknown> {
  try {
    return await client.callTool(request);
  } catch (error) {
    throw new Error(`Failed to inspect pods in ${namespace}`, { cause: error });
  }
}
```

Avoid:

```ts
interface ToolClient {
  callTool(request: unknown): Promise<unknown>;
}

async function loadResources(client: ToolClient, request: unknown): Promise<unknown> {
  try {
    return await client.callTool(request);
  } catch {
    return [];
  }
}
```

A failure to query Kubernetes is different from an empty Kubernetes result.

### External data validation

Treat all external data as untrusted, including:

- MCP tool responses
- Kubernetes API responses passed through generic adapters
- configuration files
- environment variables
- model-generated structured arguments

Validate at the boundary before converting the value into an internal domain type.

```ts
const ToolResultSchema = {
  parse(value: unknown): unknown {
    return value;
  },
};

const rawResult: unknown = {};
const result = ToolResultSchema.parse(rawResult);
void result;
```

Do not use type assertions merely to silence the compiler:

```ts
// Avoid
interface KubernetesToolResult {
  items: unknown[];
}

const raw: unknown = {};
const result = raw as KubernetesToolResult;
void result;
```

A type assertion does not validate runtime data.

### Domain types

Prefer domain-specific types over passing generic strings everywhere.

```ts
interface ClusterTarget {
  context: string;
  namespace?: string;
}

interface ResourceRef {
  apiVersion?: string;
  kind: string;
  namespace?: string;
  name: string;
}
```

Keep these distinct from MCP transport types.

The preferred dependency direction is:

```text
MCP transport types
        ↓
adapter / validation
        ↓
SRE domain types
        ↓
diagnostic workflows
```

Diagnostic logic should not depend directly on raw MCP response shapes.

### Tool definitions

Tool input and output schemas are public contracts.

- Keep tool schemas small and explicit.
- Prefer enums/unions over free-form strings where the allowed values are known.
- Separate user-facing descriptions from implementation details.
- Validate tool arguments before executing external operations.
- Never trust model-generated arguments solely because TypeScript says they have the correct type.

Tool handlers should remain thin:

```text
validate input
    ↓
resolve target/context
    ↓
invoke domain service
    ↓
normalize result
    ↓
return tool result
```

Do not place substantial diagnostic reasoning inside Pi extension registration code.

### Pi extensions

Extension entrypoints should primarily perform registration and lifecycle wiring.

Prefer:

```ts
interface SreExtensionApi {
  registerTool(): void;
}

export default function sreExtension(pi: SreExtensionApi): void {
  // Register Pi lifecycle hooks and SRE-owned tools here.
  void pi;
}
```

Move implementation into focused modules such as:

```text
src/
  extension/
  tools/
  mcp/
  cluster/
  diagnostics/
  remediation/
  config/
```

Avoid putting MCP transport, Kubernetes logic, context resolution, and Pi registration into one large extension file.

### State

Minimize module-global mutable state.

Prefer session-scoped objects passed explicitly to tools and services.

```ts
interface ClusterTarget {
  context: string;
  namespace?: string;
}

interface KubernetesMcpClient {
  close(): Promise<void>;
}

interface SreSessionState {
  target?: ClusterTarget;
  mcpClient: KubernetesMcpClient;
}
```

State that belongs to a Pi session must not accidentally leak between sessions or tests.

### Testing

Use Vitest for TypeScript unit tests unless the repository establishes another standard.

- Keep tests close to the behavior they verify.
- Test public behavior rather than private implementation details.
- Mock the MCP boundary rather than mocking every internal function.
- Use deterministic fixtures for Kubernetes resources and tool responses.
- Avoid tests that require a real production cluster.
- Put real-cluster testing in explicit integration/eval suites.

Example:

```text
src/cluster/context.ts
src/cluster/context.test.ts
```

For MCP integrations, test at least:

1. valid response
2. malformed response
3. MCP/tool failure
4. timeout/cancellation
5. empty Kubernetes result
6. multiple-cluster/context behavior

### Dependency boundaries

Keep these layers separate:

```text
Pi Extension
     ↓
SRE Application / Workflows
     ↓
Kubernetes Domain Services
     ↓
MCP Adapter
     ↓
MCP Client
```

Dependencies should generally point downward.

In particular:

- diagnostic workflows should not import Pi APIs;
- domain code should not know about tool-call UI;
- MCP adapters should not decide SRE policy;
- Pi extension code should not contain Kubernetes business logic.

### Commands

Before considering a TypeScript change complete, run the narrowest applicable checks first, then the full project checks.

Typical commands:

```bash
npm test
npx vitest run path/to/file.test.ts
npx vitest run -t "test name"
npx tsc --noEmit
npm run lint
```

Use the commands defined by this repository's `package.json`; do not invent alternate build/test flows when canonical scripts already exist.
