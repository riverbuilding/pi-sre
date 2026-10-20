import type { ClusterScopeRule } from "../cluster/context-resolver.js";
import type { ClusterContextState } from "../cluster/context-manager.js";
import { redactDiagnosticText } from "../mcp/redaction.js";

/** Shared by the command, persistent display, and model snapshot. No endpoint data. */
export function createClusterStatusLines(state: ClusterContextState): string[] {
  const resolution = state.resolution;
  const [context] = resolution.status === "resolved" ? resolution.available : [];
  const cluster =
    state.status === "not-configured"
      ? "NOT CONFIGURED"
      : state.status === "resolved" && resolution.status === "resolved"
        ? context && resolution.available.length === 1
          ? `${JSON.stringify(context.name)}${state.selection.rule.kind === "all" ? " (live *)" : ""}`
          : `${state.selection.rule.kind === "all" ? "*" : "exact set"} (${resolution.available.length} available, ${resolution.unavailable.length} unavailable)`
        : state.status === "selection-error"
          ? "NOT SELECTED"
          : "UNAVAILABLE";
  const mcp =
    state.status === "connecting" || state.status === "unavailable" ? state.status : "ready";
  const registry =
    "registry" in state
      ? `validated (${state.registry.contexts.length} contexts)`
      : state.status === "enumeration-failed"
        ? `failed (${state.reason})`
        : "unavailable";
  return [
    "READ ONLY",
    `Cluster: ${cluster}`,
    "Namespace: *",
    `MCP: ${mcp} | Registry: ${registry}`,
  ];
}

/** Deterministic operational description; excludes request-time metadata and fixed policy. */
export function createClusterScopeDescription(state: ClusterContextState): string {
  const resolution = state.resolution;
  const [context] = resolution.status === "resolved" ? resolution.available : [];
  return [
    "Application Kubernetes scope update:",
    state.status === "resolved" && resolution.status === "resolved" && context
      ? resolution.available.length === 1
        ? `Cluster: ${JSON.stringify(context.name)}; selection source: ${state.selection.source}. Supply one exact context on every diagnostic call.`
        : `Cluster scope resolved: ${resolution.available.length} available contexts. Supply one exact context on every diagnostic call.`
      : `Cluster scope unavailable (${state.status}). Cluster-dependent calls are blocked. ${redactDiagnosticText(state.message).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")}`,
    "Namespace: *. READ ONLY.",
    ...createClusterStatusLines(state).filter((line) => line.startsWith("MCP:")),
    state.selection.rule.kind === "exact" && state.selection.rule.contexts.length === 1
      ? `Requested context: ${JSON.stringify(state.selection.rule.contexts[0])}; selection source: ${state.selection.source}.`
      : `Selection rule: ${state.selection.rule.kind === "all" ? "live *" : `exact set (${state.selection.rule.contexts.length} contexts)`}; selection source: ${state.selection.source}.`,
    ...(state.resolution.status === "resolved"
      ? [
          `Resolution: ${state.resolution.available.length} available, ${state.resolution.unavailable.length} unavailable; availability does not verify health or authentication.`,
        ]
      : []),
  ].join("\n");
}

/** Bounded identity preview; omit whole names rather than changing an identity. */
export function formatClusterRule(rule: ClusterScopeRule): string {
  if (rule.kind === "all") return "All (*)";
  const names: string[] = [];
  let length = 0;
  for (const name of rule.contexts.slice(0, 8)) {
    const rendered = JSON.stringify(name);
    if (length + rendered.length > 2_000) break;
    names.push(rendered);
    length += rendered.length + 2;
  }
  const omitted = rule.contexts.length - names.length;
  return `[${names.join(", ")}]${omitted ? ` (${omitted} more)` : ""}`;
}
