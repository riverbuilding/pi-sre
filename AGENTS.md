## Project Purpose

Pi SRE is an independent, read-only TypeScript application for Kubernetes incident diagnosis. It reuses Pi as its agent runtime and Kubernetes MCP Server as its Kubernetes access boundary.

The investigation/context simplification Slices 0–6 are implemented. Production uses Pi messages for diagnosis and request-scoped execution limits, one current exact/live-all context selection, one MCP connection, bounded redacted tool results and environment messages. There is no Incident, EvidenceStore, hypothesis store or investigation archive. Slice 7 offline, extracted-package/TTY, server-contract and disposable kind checks passed; visual terminal acceptance remains pending. See docs/INVESTIGATION_CONTEXT_SIMPLIFICATION_ACCEPTANCE.md. Phase 1–4 acceptance records remain historical; Phase 4 visual acceptance remains pending as recorded at the time. Phase 5 separately plans opt-in, human-approved controlled operations. Read-only remains the default; autonomous remediation is outside scope.

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

Pi owns the agent loop and terminal UI. Pi SRE owns current context selection, request budgets, cancellation, MCP lifecycle, result provenance, safety policy, and SRE-specific user experience. Diagnosis and interpretation live in Pi messages. Kubernetes MCP Server owns Kubernetes API access.

## Repository Map

- `src/app/` — application composition and MCP connection coordination
- `src/runtime/` — Pi runtime integration, prompts, resource loading, and tool policy
- `src/mcp/` — MCP process lifecycle, client, tool discovery, bridge, and result normalization
- `src/cluster/` — explicit cluster-context state and startup resolution
- `src/execution/` — request identity, budgets, synchronous call acceptance, cancellation and identity validation
- `src/config/` — configuration schema and loading
- `src/tui/` — Pi TUI commands, extension registration, and status widgets
- `skills/kubernetes/` — diagnostic knowledge, not Kubernetes tool implementations
- `tests/` and `evals/` — unit, integration, end-to-end, and kind-based evaluation suites

## Development Commands

Run `npm run verify` before committing or pushing changes, including documentation-only changes. This is the shared local and CI gate: formatting, lint, type checks, tests, and build. Use `npm run format` to fix formatting failures and review the resulting diff.

```bash
npm run verify
npm run format:check
npm run check
npm run lint
npm test
npm run build
```

## Architectural Invariants

- Use one AgentSession and initialize extensions once; do not restore session/incident binding or reload recovery. Pi entry-point restrictions remain a separate delivery gap; see docs/TUI_COMMAND_VISIBILITY_AND_RESTRICTIONS.md.
- Do not implement Kubernetes API tools in Pi SRE; use Kubernetes MCP Server through the MCP bridge.
- Distinguish observations from hypotheses in messages; do not create independent domain stores or conclusion tools.
- Do not make the repository working directory the application's operational context.
- Do not add generic shell or `kubectl` access as a path around MCP policy.

## Kubernetes Context Rules

- Discover contexts through MCP `configuration_contexts_list`. Startup precedence: CLI rule, explicit `kubernetes.contexts`, then live `*`. MCP default metadata never narrows the selection. Unknown explicit names fail without fallback. Configuration and CLI share exact-set/sole-wildcard validation.
- The user owns one current exact/all selection. All follows validated inventory; exact retains unavailable selected names and executes only the available intersection. New inventory names never expand exact intent. Availability does not imply authentication, health or inspection.
- Every cluster-dependent call requires one exact model-supplied `context`, including singleton selections. Preserve and validate it; never infer, inject or overwrite it. No mutable global current context.
- Acceptance synchronously validates and fixes request/call identity, context, arguments and original connection before queueing. Later selection changes affect only new calls. Dispatch checks original request/cancellation, connection, tool and target, without reauthorizing against a later selection.
- Reconnect blocks dispatch, withdraws tools, invalidates/settles old calls, discovers tools/schema/contexts, publishes matching tools/environment/notices, then opens dispatch. Old calls never migrate or replay; late invalidated results cannot publish success. Reconnect does not refresh request budgets or rebuild extensions.
- Never modify kubeconfig or run `kubectl config use-context`. Missing inventory or usable targets blocks affected calls without fallback.

## Request Execution

- Each user message actually beginning processing gets an independent identity and `execution.maxToolCalls`/`execution.maxModelIterations` limits. Steering and follow-up queues are fixed one-at-a-time. Environment custom messages, retries, compaction, continuation and MCP recovery do not reset limits.
- Charge dispatch synchronously immediately before MCP invocation; dispatched failures/timeouts/cancellation are not refunded. Pre-dispatch refusal is free. Model iterations have an independent enforced ceiling.
- Normal completion settles accepted calls. Explicit cancellation blocks queued dispatch and attempts active abort, returning matching outcomes once; old calls never transfer to a later request.
- Do not add investigation configuration aliases, evidence quotas, structured investigation archives or transcript-derived execution authority.

## Tool Usage Rules

- Expose only approved diagnostic MCP tools in the default read-only profile. The separately planned Phase 5 controlled profile requires its explicit capability and per-call approval boundary.
- Keep tool handling thin: validate input, resolve scope, call MCP, normalize the response, and return a compact result.
- Enforce read-only behavior in Pi SRE, the MCP server configuration, and Kubernetes RBAC.
- Return bounded, redacted summaries with exact provenance in model-visible content. Raw retention stays disabled; no raw files or truncated-content retrieval.

## Diagnosis vs. Remediation

Phases 1–4, including context selection and Investigation Domain, are diagnosis-only. The existing explicit controlled-operations design expansion, now Phase 5, separately plans opt-in, human-approved operations; wildcard diagnostic scope never grants blanket mutation authority. Do not add write-capable tools or mutation workflows outside that design. Autonomous remediation remains outside scope.

## Safety Rules

- Continuously display current exact/all selection, available targets, unavailable selected names, namespace policy and actual execution profile. Show exact context per call; no effective/next scope.
- Do not log credentials, tokens, kubeconfig contents, secrets, or raw sensitive resource data.
- Treat an unavailable MCP server, unavailable Kubernetes authentication, and a failed Kubernetes operation as distinct states.
- Do not claim access to infrastructure when MCP is unavailable.

## Testing

- Unit-test request execution, current selection and cluster-context resolution without a live cluster.
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
- `docs/INVESTIGATION_CONTEXT_SIMPLIFICATION_IMPLEMENTATION_SLICES.md` tracks the current migration and acceptance. Phase 3/4 plans are historical; Phase 5 owns future tool parity.
- `docs/MULTI_CLUSTER_INVESTIGATION_PLAN.md` records the accepted exact-set/live-wildcard target, reconnect contracts, and later extensions; it is not a claim of runtime implementation.
- `config/*.example.*` contains versioned, safe configuration templates.

## TypeScript Conventions

- Use TypeScript for all package, extension, MCP integration, and orchestration code.
- Prefer explicit types at module boundaries; allow inference inside small local scopes.
- Avoid `any`. Use `unknown` for untrusted external data, then validate or narrow it before use.
- Prefer discriminated unions for protocol messages, tool results, events, and state transitions.
- Prefer `type` for unions/compositions and `interface` for extensible object contracts.
- Use `readonly` where mutation is not intended.

### Control flow and spacing

Follow the Pi agent harness readability style:

- Always use braces for `if` and `else` bodies, even when the body contains only one statement. Put the statement on its own line inside the braces.
- Separate consecutive logical sections with a blank line when each section serves a distinct purpose, such as a guard clause, an external call, or result normalization. Keep closely related statements together.

```ts
async function inspectTarget(context: string): Promise<unknown> {
  if (!isAllowedContext(context)) {
    throw new Error(`Context is outside the allowed scope: ${context}`);
  }

  const result = await inspectContext(context);

  return normalizeResult(result);
}
```

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
