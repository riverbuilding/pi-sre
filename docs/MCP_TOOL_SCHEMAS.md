# MCP Tool Schema Contract

[tool-policy.ts](../src/runtime/tool-policy.ts) owns `McpToolContract` definitions and shared schema validation: input/output descriptor comparison, model/transport schema construction, call argument validation, and reviewed structured-output validation. [tool-call-preparation.ts](../src/runtime/tool-call-preparation.ts) owns argument copying, removal of model-supplied context, and application defaults. [tool-execution-policy.ts](../src/runtime/tool-execution-policy.ts) owns application retrieval limits. [tool-discovery.ts](../src/mcp/tool-discovery.ts) handles descriptor envelopes and duplicate names. Input and output declarations share the contract comparator; no generic schema-document validator is maintained.

## Design decision: per-tool contracts and one shared validator

Every supported tool has a complete application-owned input contract describing the reviewed MCP interface: exact arguments, types, required fields, selector patterns, and server numeric limits. The contract also records scope, safety annotations, and model-facing descriptions. Application defaults, argument rewriting, and execution limits are separate responsibilities; contracts have no `argumentOverrides`. For `pods_log`, the contract records the server tail minimum of 0; call preparation supplies 100 when omitted, and execution policy independently restricts calls to 1–1,000 lines without clamping explicit values.

Runtime descriptors provide compatibility evidence; they never supply executable constraints:

- Execution-relevant fields must match the reviewed contract. Added, removed, or changed arguments, required fields, patterns, formats, enums, bounds, and object openness reject the affected tool, including tighter changes.
- Titles, descriptions, examples, and server defaults are inert metadata. They are ignored rather than recursively inspected or imported into executable schemas. Only reviewed application defaults are applied.
- Property order is irrelevant. Omitted `required` means an empty list; omitted `additionalProperties` means true. Explicit malformed values such as null are rejected.
- The comparison walks only nodes declared in the trusted contract. Unknown keywords, unexpected properties, malformed fields, and nested schemas are rejected before traversing unreviewed branches. Input traversal depth is therefore bounded by the contract, without a separate generic schema-document grammar.
- `defineMcpToolContract` builds executable model and transport schemas once during module initialization, exclusively from the supplied application definition. `inputSchema` is the only handwritten input schema; `modelSchema` and `transportSchema` are derived fields. The factory copies the supplied definition and deeply freezes the contract and its schemas; the registry is frozen too. Both executable schemas forbid extra arguments. The model schema hides application-owned context; transport validation checks the final arguments after context injection.
- Enumeration follows the same contract path: declared properties must be empty, destructive metadata must be false, and calls accept only an empty object.

Adding or upgrading a tool requires reviewing its complete contract and independent descriptor fixture together. Runtime schema drift cannot silently change application behavior.

## Descriptor checks and call checks

There are two validation moments, implemented by the same contract module:

1. `validateMcpToolContract` checks approval metadata and compares input and any declared output schema with the reviewed contract. A mismatch yields a safe contract location and rejects only that tool.
2. The returned `ValidatedToolContract` reuses the contract's frozen schemas and exposes pure `validateModelArguments` and `validateTransportArguments` checks. Runtime descriptor validation does not reconstruct schemas. These checks never modify arguments or apply application defaults or retrieval limits. Transport validation checks complete arguments after the bridge injects selected scope. The bridge registers a deep copy of the model schema with Pi, so consumer changes cannot affect shared contract schemas.

The bridge composes call preparation, model-schema validation, and execution-policy checks for both Pi's preparation hook and direct execution. It then resolves and injects the selected context before final transport-schema validation and MCP dispatch. A policy rejection returns `invalid-arguments` and sends no request. The model schema retains reviewed server bounds (for example, tail minimum 0); tool descriptions communicate the stricter application log range. Scope, connection-generation, cancellation, and result-freshness guards remain independent. The bridge does not implement its own argument-schema validator. Input schemas are never adapted or compiled from runtime descriptors.

Envelope failures, such as a missing/non-object `inputSchema` or malformed annotations, are `invalid-descriptor`. Input schema objects that fail the reviewed contract are `incompatible-schema`, including malformed schema fields and unreviewed keywords. Discovery still rejects every duplicate name before exposure.

## Application output contracts and returned data

`McpToolContract.outputSchema` optionally defines an application-reviewed schema for a tool's `structuredContent`. The factory copies and deeply freezes it once at initialization, alongside input schemas, and supplies a pure `contract.validateOutput(value)` type guard. No runtime server schema is executed. Without an output contract, this method returns false; it does not imply that a response has been validated.

Only `configuration_contexts_list` currently has a reviewed output contract: `contexts` is a required array of objects with nonempty string `name`, string `server`, and boolean `default`; `defaultContext` is an optional string, including empty. Additional fields remain accepted but are discarded when the adapter constructs domain entries. Other tools have no invented output shape.

The context adapter validates the complete result envelope and handles tool failures and the exact text-only empty-success branch before invoking the contract on structured data. A present malformed `structuredContent` never falls back to text. UTF-8 byte limits, inventory size, identity controls, duplicate names, default consistency, endpoint sanitization, and domain mapping remain adapter responsibilities. This replaces the adapter's separate inventory-shape schema while preserving its accepted responses and failure behavior. Generic tool-bridge presentation continues through the result normalizer; tool-specific adapters select the applicable structured-success branch for output contracts.

## Optional server output declarations

A descriptor’s optional `outputSchema` is compared with `McpToolContract.outputSchema` by the same trusted-contract comparator used for inputs, including nested array items. Execution-relevant fields must match exactly; metadata and property/required ordering follow the input rules, and omitted `additionalProperties` means true. This is structural compatibility against a reviewed template, not general JSON Schema equivalence or subsumption. Unknown fields and constraints reject only that tool with an `outputSchema` contract path; untrusted field names are never echoed. Traversal follows only trusted contract nodes, so unexpected nesting is rejected without a generic schema grammar or fixed depth limit.

The pinned server’s six supported tools omit output declarations. Omission remains supported and does not disable application output validation. If a server declares an output schema for a tool without a reviewed application output contract, that tool is rejected pending review. Non-object declarations are malformed descriptor envelopes; object declarations that do not match are incompatible schemas. Runtime output schemas are never imported or executed. The same compatibility check runs for direct bridge/startup consumers, independently of discovery.

Actual MCP result envelopes are validated, classified, redacted, and bounded by [result-normalizer.ts](../src/mcp/result-normalizer.ts). [context-discovery.ts](../src/mcp/context-discovery.ts) composes the contract's output-shape validation with context-inventory semantics and limits.

## Code map

| Module                             | Responsibility                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `runtime/tool-policy.ts`           | Reviewed MCP contracts, approval rules, descriptor comparison, frozen schemas, argument/output-shape validation |
| `runtime/tool-call-preparation.ts` | Private argument copy, removal of model-supplied context, application defaults                                  |
| `runtime/tool-execution-policy.ts` | Application retrieval limits, including positive log tail capped at 1,000 lines                                 |
| `mcp/tool-discovery.ts`            | Descriptor envelopes, output declaration checks, duplicates, per-tool discovery decisions                       |
| `mcp/tool-bridge.ts`               | Scope and lifecycle guards, invocation of contract methods, MCP calls, normalized results                       |
| `mcp/context-discovery.ts`         | Context result envelope, output-contract invocation, inventory semantics, limits, sanitization, domain mapping  |
| `mcp/result-normalizer.ts`         | MCP result validation, failure classification, redaction, presentation budgets                                  |

## Reviewed diagnostic surface (Phase 2 Slice 7)

The exact approved operations are `configuration_contexts_list` and the five diagnostics below. The sanitized [0.0.67 descriptor capture](../tests/fixtures/phase2-server-0.0.67.json) supplies every diagnostic fixture. All diagnostics are cluster-dependent, require a declared `context: string`, and inject application-owned context. The model schema omits context and its required entry, uses the reviewed constraints, and rejects additional properties even when the transport schema is permissive. A changed descriptor with an unreviewed declared argument or incompatible argument type is excluded pending review; new operation names remain excluded. Discovery rejects duplicate names, malformed schemas, missing read-only metadata, and destructive annotations independently.

| Operation         | Reviewed model arguments                                                     | Required | Namespace behavior                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pods_list`       | `fieldSelector`, `labelSelector` strings                                     | None     | No namespace argument. Server attempts all namespaces but can fall back to its context/default namespace after an authorization check. Coverage is not asserted. |
| `pods_get`        | `name`, `namespace` strings                                                  | `name`   | Omitted namespace uses server/context default. Pod resource only.                                                                                                |
| `pods_log`        | `name`, `namespace`, `container` strings; `previous` boolean; `tail` integer | `name`   | Omitted namespace uses server/context default. Finite request, default 100 lines, allowed 1–1,000 lines.                                                         |
| `events_list`     | `namespace`, `fieldSelector` strings                                         | None     | Explicit namespace is forwarded; omitted namespace uses server policy. All-namespace coverage is not asserted.                                                   |
| `namespaces_list` | `fieldSelector` string                                                       | None     | Cluster-scoped namespace inventory.                                                                                                                              |

The source review of [server pod handlers](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/toolsets/core/pods.go), [pod operations](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/kubernetes/pods.go), and [resource listing](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/kubernetes/resources.go) confirms positive `tail` reaches Kubernetes `PodLogOptions.TailLines`, without follow enabled. Pi SRE rejects zero, negative, fractional, oversized, or nonnumeric tails before transport and always sends a positive explicit tail. The descriptor must match the reviewed tail schema; missing or changed support hides only the log tool. Existing timeout and cancellation apply. Line count does not bound bytes in one log line; this server has no reviewed byte-limit argument. Model result budgets remain a separate presentation limit, not a transport memory ceiling.

Runtime publication hides diagnostics when scope is unbound, unavailable, or incompatible with the reviewed context constraint, including from Pi's tool picker. Selecting an exact context updates visibility without restarting MCP. Captured handlers independently validate scope, connection generation, arguments, and final contract-owned transport schema; late stale payloads are withheld. Result details retain the originating context and any explicit namespace. An omitted namespace is described as server/context policy, never inferred from the application's `*` display.

`configuration_view`, exec/attach, writes, shell, generic resource/Secret access, and unreviewed arguments remain excluded. Server `read_only = true`, read-only Kubernetes RBAC, redaction, bounded model results, and disabled raw retention continue to apply. Pod specifications and log text may contain application data; pattern redaction cannot identify arbitrary sensitive values. No evidence store or raw-response persistence is introduced.
