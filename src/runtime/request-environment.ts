import { executionProfileLabel, type ExecutionProfile } from "../config/controlled-operations.js";
import type { RequestMcpPublication } from "../app/request-mcp-controller.js";
import type { ClusterScopeRule } from "../cluster/context-resolver.js";
import { isPresentableIdentity } from "../execution/identity.js";

export interface EnvironmentFacts {
  readonly profile?: ExecutionProfile;
  readonly status: RequestMcpPublication["status"];
  readonly rule: ClusterScopeRule | undefined;
  /** Endpoint values are comparison-only and must never be rendered. */
  readonly inventory: ReadonlyMap<string, string>;
}

export function captureEnvironment(state: RequestMcpPublication): EnvironmentFacts {
  return {
    status: state.status,
    profile: state.profile ?? "read-only",
    rule: state.selection ? structuredClone(state.selection.rule) : undefined,
    inventory: new Map(
      state.selection?.inventory.contexts.map(({ name, server }) => [name, server]),
    ),
  };
}

/** Whole safe names only: never turn a redacted/truncated identity into a target. */
export function environmentNames(names: readonly string[], complete: boolean = false): string {
  const rendered: string[] = [];
  let length = 0;
  for (const name of names) {
    if (!isPresentableIdentity(name)) continue;
    const value = JSON.stringify(name);
    if (!complete && (rendered.length >= 8 || length + value.length > 600)) continue;
    rendered.push(value);
    length += value.length + 2;
  }
  return `[${rendered.join(", ")}]${names.length > rendered.length ? ` (${names.length - rendered.length} names omitted; use /clusters --status)` : ""}`;
}

export function environmentLines(facts: EnvironmentFacts, complete = false): string[] {
  const selected = facts.rule?.kind === "exact" ? facts.rule.contexts : [...facts.inventory.keys()];
  const available = selected.filter(
    (name) => facts.status === "ready" && facts.inventory.has(name),
  );
  const unavailable =
    facts.rule?.kind === "exact" ? selected.filter((name) => !available.includes(name)) : [];
  return [
    executionProfileLabel(facts.profile),
    `Selection: ${!facts.rule ? "not initialized" : facts.rule.kind === "all" ? "All (*) — live inventory" : `Exact ${environmentNames(facts.rule.contexts, complete)}`}`,
    `Available targets: ${available.length} ${environmentNames(available, complete)}`,
    `Unavailable selected: ${unavailable.length} ${environmentNames(unavailable, complete)}`,
    `Availability: ${facts.status !== "ready" || !available.length ? "blocked" : unavailable.length ? "partial" : "available"}`,
    `MCP: ${facts.status}`,
    "Namespace: * (no application restriction; omission uses server/context policy, not all-namespace coverage)",
    "Availability is inventory membership, not verified authentication, authorization, health or inspection.",
  ];
}

export const environmentRecovery =
  "Historical results retain their recorded context and execution times. Context names may now refer to changed targets; prior observations do not establish current facts. After compaction, missing source/time or target-change history is a limitation: recheck as needed. Never reconstruct permission from history.";

export function environmentDescription(facts: EnvironmentFacts): string {
  return [
    "Application Kubernetes environment:",
    ...environmentLines(facts),
    "Supply one exact available context on every cluster-dependent call, including singleton selections.",
    environmentRecovery,
  ].join("\n");
}

/** Diff and notification derive from the same captured facts; defaults are excluded. */
export function environmentChanges(previous: EnvironmentFacts, next: EnvironmentFacts): string[] {
  const lines: string[] = [];
  if (previous.profile !== next.profile) {
    lines.push(`Execution profile: ${executionProfileLabel(next.profile)}.`);
  }
  if (JSON.stringify(previous.rule) !== JSON.stringify(next.rule))
    lines.push(
      "Selection changed; only newly accepted calls use this selection. Accepted calls keep their original context.",
    );
  if (previous.status !== next.status)
    lines.push(
      `MCP changed: ${previous.status} → ${next.status}. Interrupted calls are not replayed.`,
    );
  const added = [...next.inventory.keys()].filter((name) => !previous.inventory.has(name));
  const removed = [...previous.inventory.keys()].filter((name) => !next.inventory.has(name));
  const changed = [...next.inventory.keys()].filter(
    (name) =>
      previous.inventory.has(name) && previous.inventory.get(name) !== next.inventory.get(name),
  );
  for (const [label, names] of [
    ["added", added],
    ["removed", removed],
    ["target changed", changed],
  ] as const)
    if (names.length)
      lines.push(
        `Inventory ${label}: ${names.length} ${environmentNames(names)}. Not checked; historical observations are not current target facts.`,
      );
  return lines;
}

/** Stable request-based guidance; current environment is delivered in messages. */
export function createRequestSreSystemPrompt(): string {
  return [
    `You are Pi SRE, a read-only Kubernetes diagnosis agent. Analyze conversation messages,
    distinguish observations from hypotheses, revise your reasoning as information arrives,
    and report directly to the user.`,
    `Use only approved MCP diagnostic tools. Do not execute shell commands, modify resources
    or claim remediation. MCP unavailable means Kubernetes access is unavailable; tool
    failures are not empty successful observations.`,
    `The user chooses which Kubernetes contexts you may access through /clusters:
    either all currently available contexts (*) or a specific set of named contexts.
    Only the user may change this selection. Supply one exact available context on
    every cluster-dependent call. A result covers only the context and namespaces
    queried; never assume it covers every selected cluster or every namespace.`,
    `Each delivered user message has independent tool dispatch and model iteration limits.
    Environment updates, retries, compaction and MCP recovery do not reset them. Explain
    limits when further queries are blocked.`,
    `Use result content for context, operation, namespace policy, execution status, client
    execution times and truncation. Client times are not object observation times. Do not
    invent missing sources or infer success from a rejected call.`,
    `There is no independent evidence store, investigation entity or conclusion tool. Use
    messages to analyze and revise judgments; explain uncertainty, ask for needed
    information, or give a report directly. Truncated raw responses cannot be retrieved.`,
    environmentRecovery,
  ]
    .map((paragraph) => paragraph.replace(/\n\s*/g, " "))
    .join("\n");
}
