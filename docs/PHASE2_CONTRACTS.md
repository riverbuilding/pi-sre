# Phase 2 Slice 0 — Frozen Contracts

Verified on 2026-10-07: Kubernetes MCP Server **0.0.67**, installed at `/opt/homebrew/bin/kubernetes-mcp-server`; Pi runtime and MCP client **0.99.0** from the lockfile; Node **26.0.0**, macOS arm64. This record completes contract discovery, not Phase 2 implementation or live cluster acceptance.

## Server evidence and compatibility

[Captured descriptors and responses](../tests/fixtures/phase2-server-0.0.67.json) came from the installed executable through Pi's public MCP client. Static server configuration, synthetic kubeconfigs, and mock responses are checked in under [tests/fixtures/phase2-server](../tests/fixtures/phase2-server/), with no users or credentials and only synthetic names and endpoints. Pi SRE runtime does not read or generate kubeconfig. An explicit [contract unit test](../tests/unit/mcp/capture-phase2-server.test.ts) generates the actual results in memory and compares them with the captured JSON; it never overwrites the expected file.

| Synthetic setup                                            | Observed behavior                                                                                                             | Phase 2 consequence                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Two contexts, current context `alpha`, kubeconfig provider | Enumeration present; structured result identifies `alpha` as default; diagnostic candidates declare optional string `context` | Supported explicit-context setup                                              |
| Two contexts, no current context                           | Server fails before MCP initialization                                                                                        | Transport/startup failure, not empty enumeration or a usable unbound registry |
| One context, with or without a current context             | Server starts but omits enumeration and all candidate `context` properties                                                    | Incompatible with Phase 2; no implicit-context fallback                       |
| Empty kubeconfig                                           | Server fails before MCP initialization                                                                                        | Startup failure, not a successful empty list                                  |
| Two contexts, disabled provider                            | Enumeration and explicit context properties absent                                                                            | Incompatible; keep diagnostic tools unavailable                               |

`--cluster-provider kubeconfig` alone does **not** force explicit-context support with one context. Keep multi-cluster support enabled and use a kubeconfig with at least two contexts and a valid current context for this server version. Do not use `--disable-multi-cluster` or `cluster_provider_strategy = "disabled"`. Two namespace contexts can enable the contract, but do not prove different cluster routing. Never alter the user's kubeconfig to bypass an incompatibility.

The explicit routing probe used the real server and two loopback mock Kubernetes endpoints. `pods_list({context: "alpha"})` reached only alpha; `pods_list({context: "beta"})` reached only beta despite alpha remaining the kubeconfig default. Both returned their distinct synthetic Pod marker and only GET requests were observed. Recorded request paths are in the capture. This verifies the server's context parameter; it does not establish live Kubernetes authentication, RBAC, or the later Pi SRE scope-enforcement path.

Run the comparison explicitly (requires server 0.0.67 on PATH and permission to bind loopback sockets):

```bash
npm run test:contracts
```

For a different executable location, set `PI_SRE_CONTRACT_SERVER=/absolute/path/to/kubernetes-mcp-server` and run `npx vitest run tests/unit/mcp/capture-phase2-server.test.ts`. The seven tests compare all six inventory/startup scenarios and explicit routing against the pre-generated file. Static inputs are read directly; only the routing template's ephemeral loopback ports are substituted into a temporary file. Helpers close every client, stop mock endpoints, and remove that temporary file. Normal CI remains offline: this test suite is skipped unless `PI_SRE_CONTRACT_SERVER` is set, while the existing offline integration tests continue using the checked-in capture. Review changes to the expected JSON explicitly when accepting a new contract; the tests do not update it automatically.

## Enumeration wire format

`configuration_contexts_list` declares an object input schema with empty properties, read-only true, destructive false, and no output schema. Call with `{}`. A nonempty success supplies `structuredContent`:

```json
{
  "defaultContext": "alpha",
  "contexts": [
    { "name": "alpha", "server": "https://alpha.example.invalid", "default": true },
    { "name": "beta", "server": "https://beta.example.invalid", "default": false }
  ]
}
```

The accompanying text is a presentation table. It is not JSON and must not be parsed for authoritative context membership. The context entry has no namespace field; two contexts can share a server URL and remain distinct exact identifiers. Server schema descriptions mentioning a default are not registry authority.

The pinned [server implementation](https://github.com/containers/kubernetes-mcp-server/blob/v0.0.67/pkg/toolsets/config/configuration.go) defines these JSON tags and an empty-success branch with a single text block exactly `No contexts found in kubeconfig` and no structured content. That branch is source-verified; it was not reachable with the empty startup kubeconfig in this probe. Its fixture is synthetic. Tool failures use `isError: true`; they never mean an empty registry.

Freeze the Slice 1 adapter contract as follows:

- Prefer structured content. A present but invalid structured payload fails; never recover authority from its accompanying text. Reject `isError: true` before considering data. Validate the envelope and content blocks.
- Support only the object shape above, plus the exact empty-success text sentinel when structured content is absent. Nonempty prose, tables, JSON encoded in text, and the Phase 1 illustrative string-array payload are unsupported.
- Require `contexts` to be an array of objects with nonempty string `name`, string `server`, and boolean `default`. Names remain opaque and exact. Reject control characters in names rather than changing identity. Metadata must be safe for display; discard unnecessary fields after validation and never render endpoint credentials.
- `defaultContext` may be omitted or empty only when all entry flags are false. That means no default and therefore unbound startup without CLI/config selection, even with one entry. A nonempty default must refer to exactly one present entry, that entry must be flagged true, and all others false. Missing flags, duplicates, contradictory defaults, or a default absent from the inventory fail the entire enumeration. Do not select from a partial registry.
- A valid empty structured array with no default is an empty success. Unknown fields do not confer authority and are discarded. Default metadata must not be inferred from ordering, names, descriptions, endpoints, or the text table.

Application-side enumeration limits, separate from model result budgets:

| Limit                                       | Frozen value           |
| ------------------------------------------- | ---------------------- |
| Complete serialized MCP result, UTF-8 bytes | 1,048,576 (1 MiB)      |
| Context entries                             | 1,024                  |
| Context name and default name               | 1,024 UTF-8 bytes each |
| Server field                                | 4,096 UTF-8 bytes      |

Apply limits before registry publication; an excess is a visible enumeration failure. Never truncate and then validate. These are adapter acceptance limits after the MCP client receives a response, not a transport-level memory ceiling. Cancellation and timeout propagate through the existing managed connection.

[Synthetic acceptance fixtures](../tests/fixtures/phase2-context-responses.ts) cover default, absent default, single/no-default, structured/text empty success, malformed shape, duplicates, contradictory/missing defaults, failure with and without structured data, prose, and invalid structured content with a tempting empty text fallback. Their declared outcomes are requirements for Slice 1; Slice 0 does not implement or claim to test the future adapter/resolver.

## Diagnostic descriptors

Every candidate below is present in the two-context capture, declares optional `context: string`, and has `readOnlyHint: true` and `destructiveHint: false`. None declares an output schema or an enum restricting context names. None is newly enabled by Slice 0.

| Candidate         | Other arguments                                                              | Required fields | Namespace/bounds notes                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pods_list`       | `fieldSelector`, `labelSelector` strings with patterns                       | None            | No namespace argument; descriptor says all namespaces, but the local routing probe observed `/api/v1/namespaces/default/pods`. Do not promise all-namespace coverage from the description alone; review provider namespace behavior in Slice 7. |
| `pods_get`        | `name`, `namespace` strings                                                  | `name`          | Omitted namespace uses server/context policy.                                                                                                                                                                                                   |
| `pods_log`        | `name`, `namespace`, `container` strings; `previous` boolean; `tail` integer | `name`          | `tail` default 100, minimum 0, no maximum; no follow/stream option. Slice 7 must enforce a finite positive cap; a bounded model result alone does not bound server retrieval.                                                                   |
| `events_list`     | `namespace`, `fieldSelector` strings                                         | None            | Namespace optional; field selector has a pattern.                                                                                                                                                                                               |
| `namespaces_list` | `fieldSelector` string with pattern                                          | None            | Cluster-scoped resource listing.                                                                                                                                                                                                                |

The actual descriptors, including RBAC metadata and exact patterns, are retained in the JSON capture. Schema compatibility is covered by existing discovery validators. Read-only annotations are necessary but do not replace per-tool policy review, read-only server configuration, or Kubernetes RBAC. `configuration_view`, generic Secret-capable access, exec/attach, mutations, and shell access remain excluded.

## Public Pi 0.99.0 APIs

Verified against installed declaration files and implementation, with an offline [integration contract test](../tests/integration/phase2-contracts.test.ts):

| Requirement                 | Public API and behavior                                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact-name command dispatch | `pi.registerCommand(name, {description, handler})`; handler receives arguments and command context. `session.prompt("/context ...")` dispatches without a model call or transcript entry.                                                                                                       |
| Cluster selector            | `ctx.ui.select(title, options)` returns a string or `undefined` on cancellation. Revalidate state after awaiting it.                                                                                                                                                                            |
| Continuous status           | `ctx.ui.setStatus(key, text)` updates extension footer status; `undefined` clears it. `setWidget` and `setFooter` are available if narrow-terminal verification requires a dedicated display.                                                                                                   |
| Agent idle state            | `ctx.isIdle()` and `session.isIdle`; use `agent_start` / `agent_end` for application coordination and keep the application-level guard authoritative. Commands execute immediately during streaming, so dispatch does not imply idleness.                                                       |
| Per-model-request scope     | `pi.on("context", handler)` runs before each LLM call and can add current scope to conversation messages while Pi restores prompt/tools. `context_with_system` also runs per call but transfers responsibility for prompt/tool declarations to the handler. Prefer `context` for scope refresh. |
| Turn-start prompt policy    | `before_agent_start` exposes mutable `systemPromptOptions`; its `systemPrompt` string is readonly. A turn-start hook alone cannot refresh scope between tool-loop requests.                                                                                                                     |
| Subscription lifecycle      | `pi.on` returns an unsubscribe function; `session_shutdown` is available for session-scoped cleanup.                                                                                                                                                                                            |

There is **no built-in `/context` command** in Pi 0.99.0's installed slash-command inventory or interactive interception table. The test registers `/context` and `/cluster` through an isolated inline extension and dispatches both via the real public session API. It verifies arguments, selection/cancellation, status calls, idle reporting, refreshed context-hook output, and no model transcript. Interactive source inspection checks `/context` is not intercepted. Physical terminal layout and active-turn application switching enforcement remain later-slice acceptance work.

No private fields, runtime method reassignment, or production command registration are needed for these contracts. Historical conversation text remains nonauthoritative.

## Frozen application behavior

Section 4 of [the slice plan](./PHASE2_IMPLEMENTATION_SLICES.md) is the implementation contract: CLI > config > MCP default > unbound, unknown high-priority selection never falls back, user-only switching with idle/generation checks, context omitted from model schema and overwritten before final server-schema validation, immutable dispatch scope, and exact selection intent retained through recovery. A completed unbound startup stays unbound through recovery; only unresolved initial startup may apply pending defaults.

Server compatibility is an additional capability gate: missing enumeration or a declared explicit context parameter is a visible incompatibility. It does not permit reading kubeconfig, changing current context, choosing the only context, or injecting an undeclared parameter into a permissive schema. Single-context support on server 0.0.67 is blocked by the observed descriptor contract. The supported two-context setup can proceed to Slice 1.

## Validation record

On 2026-10-07, the targeted contract tests passed, followed by `npm run format:check`, `npm run lint`, `npm run check`, `npm test` (212 tests across 16 files), and `npm run build`. The explicit server probe passed context routing against both synthetic loopback endpoints. Live cross-cluster acceptance remains Slice 9 work. Runtime tool exposure and the read-only policy are unchanged.
