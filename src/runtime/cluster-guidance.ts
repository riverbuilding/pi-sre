import type { ClusterContextState } from "../cluster/context-manager.js";

/** Deterministic operational description; excludes request-time metadata and fixed policy. */
export function createClusterScopeDescription(state: ClusterContextState): string {
  return [
    "Application Kubernetes scope update:",
    state.status === "bound"
      ? `Cluster: ${JSON.stringify(state.context.name)}; selection source: ${state.scope.source}.`
      : `Cluster scope unavailable (${state.status}). Cluster-dependent calls are blocked. ${state.message}`,
    "Namespace: *. READ ONLY.",
  ].join("\n");
}
