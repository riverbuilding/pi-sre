## Project Purpose

Pi SRE is an independent, read-only TypeScript application for Kubernetes incident diagnosis. It reuses Pi as its agent runtime and Kubernetes MCP Server as its Kubernetes access boundary.

Phases 1–2 are implemented and accepted with read-only, single-context diagnosis. New Phase 3 upgrades context selection/routing directly from that baseline: exact sets, default live `*`, unified `/clusters`, and required model-supplied context through one agent/one MCP server. Phase 4 then adds Investigation Domain and evidence; Phase 5 separately plans opt-in, human-approved controlled operations. These future phases are not implemented. Read-only remains the default; autonomous remediation is outside scope.

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
- Target startup precedence is explicit CLI rule, explicitly configured `kubernetes.contexts` exact/all rule, then live `*`. With no user choice, default to live `*`; MCP default metadata never narrows it. Invalid explicit names fail without wildcard fallback. Configuration and CLI share exact-set/sole-wildcard validation; the old `defaultCluster` field is removed. Slice 1 implements rule state/startup/CLI; the unified /clusters command and staged exact/all picker have been brought forward. Multi-target routing and full scope presentation remain later slices.
- The user owns the scope rule: exact context set or live `*`, session-owned in Phase 3 and incident-owned in Phase 4. The application resolves it against validated inventory; the model can explore only within that resolution. Patterns and active-incident rule amendment are later extensions.
- Phase 3 owns a session rule: idle `/clusters` selection changes subsequent calls immediately; no incident model is required. Phase 4 captures an immutable incident rule and makes selection apply to the next incident while one is active. Inventory refresh can change live `*` resolution without amending its rule; it never expands an exact set. Replace the singular command without an alias.
- Every cluster-dependent operation requires one exact model-supplied `context` for all rules, including singleton sets. Preserve and validate it; never hide, infer, inject, or overwrite it. Reject missing/out-of-scope values before dispatch. Never route through a mutable global current context.
- Reconnect blocks dispatch, invalidates old generations, rediscovers tools and contexts, re-resolves the unchanged rule, and publishes state/tools and added/removed notices before dispatch resumes. Late invalidated results cannot return fresh success; Phase 4 additionally rejects stale evidence commits.
- Inventory availability, incident permission, and investigation coverage are distinct. Keep per-context failures and evidence origin explicit; new wildcard members start as not checked.
- Never modify kubeconfig or run `kubectl config use-context`. If inventory/rule resolution is unavailable or has no usable target, block affected calls without implicit fallback.

## Tool Usage Rules

- Expose only approved diagnostic MCP tools in the default read-only profile. The separately planned Phase 5 controlled profile requires its explicit capability and per-call approval boundary.
- Keep tool handling thin: validate input, resolve scope, call MCP, normalize the response, and return a compact result.
- Enforce read-only behavior in Pi SRE, the MCP server configuration, and Kubernetes RBAC.
- Preserve large raw responses outside the model context and return concise, relevant summaries.

## Diagnosis vs. Remediation

Phases 1–4, including context selection and Investigation Domain, are diagnosis-only. The existing explicit controlled-operations design expansion, now Phase 5, separately plans opt-in, human-approved operations; wildcard diagnostic scope never grants blanket mutation authority. Do not add write-capable tools or mutation workflows outside that design. Autonomous remediation remains outside scope.

## Safety Rules

- Display the effective session/incident scope rule, resolved contexts/availability, namespace policy, and actual execution profile continuously. Show the exact context on each call; Phase 4 adds next selection separately when different.
- Do not log credentials, tokens, kubeconfig contents, secrets, or raw sensitive resource data.
- Treat an unavailable MCP server, unavailable Kubernetes authentication, and a failed Kubernetes operation as distinct states.
- Do not claim access to infrastructure when MCP is unavailable.

## Testing

- Unit-test domain logic and cluster-context resolution without a live cluster.
- Integration-test MCP protocol and tool-bridge behavior with deterministic fixtures.
- Keep real-cluster tests in explicit end-to-end or evaluation suites.

## SRE Evals

Use kind-based evaluation for end-to-end scenarios. Cover cluster selection and fault diagnosis, including CrashLoopBackOff, OOMKilled, ImagePullBackOff, missing ConfigMaps or Secrets, failed readiness probes, pending Pods, service-selector mismatches, and DNS failures.

For the planned multi-cluster surface, cover exact versus live-`*` resolution after reconnect, added/removed contexts, stale results, independent parallel targets, same-named resources, per-context failures, bounded budgets, and coverage attribution. Keep current Phase 1/2 acceptance records historical.

## Definition of Done

A change is complete when it preserves the read-only safety model, keeps cluster scope explicit, has proportionate tests, and passes the relevant commands in `package.json`.

## Documentation Map

- `docs/DESIGN.md` is the authoritative V0.1 scope and architecture.
- `README.md` documents local setup and currently available project commands.
- `docs/PHASE3_IMPLEMENTATION_SLICES.md` migrates completed Phase 2 context selection without requiring incidents/evidence. Phase 4 owns Investigation Domain; Phase 5 owns tool parity.
- `docs/MULTI_CLUSTER_INVESTIGATION_PLAN.md` records the accepted exact-set/live-wildcard target, reconnect contracts, and later extensions; it is not a claim of runtime implementation.
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

Trust the configured MCP server to execute tools and supply diagnostic results. Pi SRE owns the operation allowlist, model-argument validation, explicit cluster selection, and application limits. Consume discovered input schemas; do not add exact per-tool schema matching, mandatory read-only/destructive annotation checks, or diagnostic response schemas.

Validate configuration, environment variables, and model-generated arguments at their boundaries. When converting MCP responses into application/domain state, parse only the fields needed for that state and check its consistency. Accept additional server fields. Diagnostic content passed to the model needs presentation, redaction, limits, and error handling rather than Kubernetes resource-shape validation.

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

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
