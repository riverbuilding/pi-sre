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
        ? context && resolution.available.length === 1 && JSON.stringify(context.name).length <= 600
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
    `Rule: ${formatClusterRule(state.selection.rule)} | Source: ${state.selection.source}`,
    ...createMembershipLines(state),
    "Namespace: * (tool/server policy when omitted)",
    `MCP: ${mcp} | Registry: ${registry}`,
    `Revisions: selection ${state.selection.selectionRevision} | inventory ${state.inventoryRevision} | connection ${state.connectionGeneration}`,
    ...createInventoryTransitionLines(state),
  ];
}

/** Deterministic operational description; excludes request-time metadata and fixed policy. */
export function createClusterScopeDescription(state: ClusterContextState): string {
  const resolution = state.resolution;
  const [context] = resolution.status === "resolved" ? resolution.available : [];
  return [
    "Application Kubernetes scope update:",
    state.status === "resolved" && resolution.status === "resolved" && context
      ? resolution.available.length === 1 && JSON.stringify(context.name).length <= 600
        ? `Cluster: ${JSON.stringify(context.name)}; selection source: ${state.selection.source}. Supply one exact context on every diagnostic call.`
        : `Cluster scope resolved: ${resolution.available.length} available contexts. Supply one exact context on every diagnostic call.`
      : `Cluster scope unavailable (${state.status}). Cluster-dependent calls are blocked. ${redactDiagnosticText(
          state.message,
        )
          .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
          .slice(0, 400)}`,
    "Namespace: *. READ ONLY. Omission uses server/context policy, not all-namespace coverage.",
    `Rule: ${formatClusterRule(state.selection.rule)}.`,
    ...createMembershipLines(state),
    `Revisions: selection ${state.selection.selectionRevision}; inventory ${state.inventoryRevision}; connection ${state.connectionGeneration}.`,
    ...createInventoryTransitionLines(state),
    ...createClusterStatusLines(state).filter((line) => line.startsWith("MCP:")),
    state.selection.rule.kind === "exact" &&
    state.selection.rule.contexts.length === 1 &&
    JSON.stringify(state.selection.rule.contexts[0]).length <= 600
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
  return formatContextNames(rule.contexts);
}

/** Complete names only; bounded categories keep the entire automatic snapshot below 8,000 chars. */
function formatContextNames(names: readonly string[]): string {
  const preview: string[] = [];
  let length = 0;
  for (const name of names.slice(0, 8)) {
    const rendered = JSON.stringify(name);
    if (length + rendered.length > 600) break;
    preview.push(rendered);
    length += rendered.length + 2;
  }
  return `[${preview.join(", ")}]${names.length > preview.length ? ` (${names.length - preview.length} more)` : ""}`;
}

function createMembershipLines(state: ClusterContextState): string[] {
  if (state.resolution.status !== "resolved") {
    return [
      `Resolution: blocked (${state.resolution.reason}); no diagnostic targets.`,
      `Last successful inventory: ${state.inventory?.contexts.length ?? 0} contexts; retained names are not dispatch authority.`,
    ];
  }
  const { available, unavailable } = state.resolution;
  return [
    `Availability: ${available.length === 0 ? "unavailable" : unavailable.length > 0 ? "partial" : "available"}`,
    `Available: ${available.length} ${formatContextNames(available.map((entry) => entry.name))}`,
    `Unavailable selected: ${unavailable.length} ${formatContextNames(unavailable)}`,
  ];
}

/** Reconnect notices contain only bounded names/counts, never endpoint metadata. */
export function createInventoryTransitionLines(state: ClusterContextState): string[] {
  const transition = state.inventoryTransition;
  if (!transition || !("registry" in state)) return [];
  return [
    `Inventory reconciliation (revision ${state.inventoryRevision}):`,
    ...(["added", "removed", "changed"] as const).map((kind) => {
      const names = transition[kind];
      return `${kind}: ${names.length} ${formatContextNames(names)}.`;
    }),
    state.selection.rule.kind === "all"
      ? "Live * follows this inventory. Added contexts are not checked; availability does not establish health."
      : "Inventory changes never expand exact permission. Unselected additions remain outside permission; missing selected contexts are unavailable. Reappearing contexts are not checked.",
    "Changed context metadata does not establish health or preserve prior observations as current. Interrupted calls are not replayed.",
  ];
}
