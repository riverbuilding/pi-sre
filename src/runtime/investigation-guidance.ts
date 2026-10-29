import type { InvestigationController } from "../app/investigation-controller.js";
import { resolveInvestigationScope } from "../domain/investigation-scope.js";
import { createClusterScopeDescription, formatClusterRule } from "./cluster-guidance.js";

export const INVESTIGATION_SUMMARY_CHARS = 8_000;

function preview(text: string): string {
  return (
    JSON.stringify(text.slice(0, 240)).replace(
      /[\p{Cf}\p{Zl}\p{Zp}]/gu,
      (character) => `\\u{${character.codePointAt(0)?.toString(16)}}`,
    ) + (text.length > 240 ? " (preview)" : "")
  );
}

/** Whole identities/lines only; deterministic snapshots are persisted by the scope extension. */
export function createInvestigationScopeDescription(controller: InvestigationController): string {
  const investigation = controller.currentInvestigation();
  const nextState = controller.snapshot.next;
  if (!investigation)
    return `No in-memory investigation is bound to this session.\n${createClusterScopeDescription(nextState)}`;
  const { incident } = investigation;
  const base = "registry" in nextState ? { ...nextState, status: "resolved" as const } : nextState;
  const state = {
    ...base,
    selection: {
      rule: incident.scope.rule,
      source: incident.scope.selectionSource,
      selectionRevision: incident.scope.selectionRevision,
    },
    resolution: resolveInvestigationScope(
      incident.scope,
      "registry" in nextState ? nextState.registry : undefined,
    ),
  };
  const lines = [
    `Investigation ${JSON.stringify(incident.id)}; status ${incident.status}; revision ${investigation.revision}; scope revision ${incident.scope.revision}. READ ONLY.`,
    `Counts: ${investigation.evidence.length} evidence; ${investigation.hypotheses.length} hypotheses; ${investigation.targets.length} targets; ${investigation.outcomes.length} outcomes; ${investigation.dispatchedAttempts} diagnostic attempts.`,
    `Question: ${preview(incident.question)}`,
    `Focus: ${preview(investigation.focus ?? "unset")}.`,
    ...(incident.conclusion
      ? [`Conclusion: ${preview(incident.conclusion.explanation)} (inspect for full explanation).`]
      : []),
    ...createClusterScopeDescription(state).split("\n"),
    ...(JSON.stringify(incident.scope.rule) !== JSON.stringify(nextState.selection.rule)
      ? [
          `Next investigation selection: ${formatClusterRule(nextState.selection.rule)} (source: ${nextState.selection.source}). Next resolution: ${nextState.resolution.status === "resolved" ? `${nextState.resolution.available.length} available, ${nextState.resolution.unavailable.length} unavailable` : "blocked"}. This does not amend the current incident.`,
        ]
      : []),
    "Coverage is timestamped observation history, not health or complete namespace/fleet coverage. Added wildcard members are not checked.",
    `Outcomes: ${["successful", "partial", "failed", "interrupted"].map((status) => `${status} ${investigation.outcomes.filter((item) => item.status === status).length}`).join(", ")}.`,
    ...(state.resolution.status === "resolved"
      ? [
          `Not checked: ${state.resolution.available.filter((entry) => !investigation.outcomes.some((item) => item.context === entry.name)).length} currently available contexts have no observations.`,
        ]
      : []),
    ...(incident.conclusion
      ? [
          "Terminal incident: historical inspection only; diagnostics require another open incident.",
        ]
      : []),
  ];
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > INVESTIGATION_SUMMARY_CHARS - 400) continue;
    kept.push(line);
    length += line.length + 1;
  }
  if (kept.length !== lines.length)
    kept.push(
      `Summary lines omitted: ${lines.length - kept.length}; use inspection tools for details.`,
    );
  let shownHypotheses = 0;
  let shownEvidence = 0;
  for (const item of investigation.hypotheses.slice(0, 8)) {
    const line = `Hypothesis ${JSON.stringify(item.id)}: ${item.status}; revision ${item.revision}.`;
    if (length + line.length + 1 > INVESTIGATION_SUMMARY_CHARS - 300) continue;
    kept.push(line);
    length += line.length + 1;
    shownHypotheses++;
  }
  for (const item of investigation.evidence.slice(-8)) {
    const line = `Evidence ${JSON.stringify(item.id)}: ${JSON.stringify(item.context)}; ${JSON.stringify(item.operation)}; ${item.completedAt}; generation ${item.connectionGeneration}; ${item.truncated ? "partial" : "successful"}.`;
    if (length + line.length + 1 > INVESTIGATION_SUMMARY_CHARS - 300) continue;
    kept.push(line);
    length += line.length + 1;
    shownEvidence++;
  }
  kept.push(
    `Hypotheses omitted: ${investigation.hypotheses.length - shownHypotheses}.`,
    `Evidence references omitted: ${investigation.evidence.length - shownEvidence}.`,
  );
  return kept.join("\n");
}
