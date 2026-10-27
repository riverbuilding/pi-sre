import type { InvestigationController } from "../app/investigation-controller.js";
import { createClusterScopeDescription, formatClusterRule } from "./cluster-guidance.js";

/** Slice 4 scope presentation; Slice 6 adds bounded evidence/interpretation summaries. */
export function createInvestigationScopeDescription(controller: InvestigationController): string {
  const effective = controller.currentScope();
  const state = controller.clusterState();
  const nextState = controller.snapshot.next;
  const next = nextState.selection;
  return [
    effective.ok
      ? `Investigation ${JSON.stringify(effective.scope.incidentId)}; scope revision ${effective.scope.scopeRevision}.`
      : `Investigation unavailable: ${effective.reason}.`,
    createClusterScopeDescription(state),
    ...(effective.ok && JSON.stringify(effective.scope.rule) !== JSON.stringify(next.rule)
      ? [
          `Next investigation selection: ${formatClusterRule(next.rule)} (source: ${next.source}). Next resolution: ${nextState.resolution.status === "resolved" ? `${nextState.resolution.available.length} available, ${nextState.resolution.unavailable.length} unavailable` : "blocked"}. This does not amend the current incident.`,
        ]
      : []),
  ].join("\n");
}
