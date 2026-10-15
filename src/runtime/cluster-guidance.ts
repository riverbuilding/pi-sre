import type { ClusterContextState } from "../cluster/context-manager.js";
import { redactDiagnosticText } from "../mcp/redaction.js";

/** Shared by the command, persistent display, and model snapshot. No endpoint data. */
export function createClusterStatusLines(state: ClusterContextState): string[] {
  const cluster =
    state.status === "bound"
      ? JSON.stringify(state.context.name)
      : state.status === "not-configured"
        ? "NOT CONFIGURED"
        : state.status === "unbound" || state.status === "selection-error"
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
  return [
    "Application Kubernetes scope update:",
    state.status === "bound"
      ? `Cluster: ${JSON.stringify(state.context.name)}; selection source: ${state.scope.source}.`
      : `Cluster scope unavailable (${state.status}). Cluster-dependent calls are blocked. ${redactDiagnosticText(state.message).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")}`,
    "Namespace: *. READ ONLY.",
    ...createClusterStatusLines(state).filter((line) => line.startsWith("MCP:")),
    ...(state.status === "selection-error"
      ? [
          `Requested context: ${JSON.stringify(state.requestedName)}; selection source: ${state.source}.`,
        ]
      : state.status === "bound"
        ? []
        : ["Selection source: none (no active scope)."]),
  ].join("\n");
}
