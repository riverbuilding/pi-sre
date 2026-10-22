import { DomainError, requireDomain } from "./errors.js";
import type { Evidence } from "./evidence.js";
import { createHypothesis, requireEvidenceReferences } from "./hypothesis.js";
import type { Hypothesis } from "./hypothesis.js";
import { copyInvestigationScope } from "./investigation-scope.js";
import type { InvestigationScope } from "./investigation-scope.js";
import { identity, prose, timestamp, uniqueIds } from "./validation.js";

export interface Conclusion {
  readonly explanation: string;
  readonly hypothesisIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly concludedAt: string;
}

interface IncidentBase {
  readonly id: string;
  readonly question: string;
  readonly createdAt: string;
  readonly scope: InvestigationScope;
}

export type Incident = IncidentBase &
  (
    | { readonly status: "new" | "investigating"; readonly conclusion?: never }
    | { readonly status: "resolved" | "inconclusive"; readonly conclusion: Conclusion }
  );

export function createIncident(
  input: IncidentBase,
): IncidentBase & { readonly status: "new"; readonly conclusion?: never } {
  return Object.freeze({
    id: identity(input.id, 128),
    question: prose(input.question, 4_000),
    createdAt: timestamp(input.createdAt),
    scope: copyInvestigationScope(input.scope),
    status: "new",
  });
}

export function requireOpenIncident(incident: Incident): void {
  requireDomain(
    incident.status === "new" || incident.status === "investigating",
    "Terminal incidents are immutable; start another incident.",
  );
}

export function beginInvestigation(incident: Incident): Incident {
  requireOpenIncident(incident);
  return Object.freeze({ ...createIncident(incident), status: "investigating" });
}

export function concludeIncident(
  incident: Incident,
  status: "resolved" | "inconclusive",
  input: Conclusion,
  hypotheses: readonly Hypothesis[],
  evidence: readonly Evidence[],
): Incident {
  requireOpenIncident(incident);
  requireDomain(status === "resolved" || status === "inconclusive", "Unknown conclusion status.");
  const hypothesisIds = uniqueIds(input.hypothesisIds);
  const evidenceIds = uniqueIds(input.evidenceIds);
  const cited = hypothesisIds.map((id) => {
    const hypothesis = hypotheses.find((item) => item.id === id && item.incidentId === incident.id);
    if (!hypothesis)
      throw new DomainError(
        { kind: "missing-reference" },
        "Conclusion hypothesis must exist in the same incident.",
      );
    return createHypothesis(hypothesis, evidence);
  });
  requireEvidenceReferences(evidenceIds, incident.id, evidence);
  for (const hypothesis of cited)
    requireEvidenceReferences(
      [...hypothesis.supportingEvidence, ...hypothesis.contradictingEvidence],
      incident.id,
      evidence,
    );
  requireDomain(
    status !== "resolved" ||
      cited.some((item) => item.status === "supported" && item.supportingEvidence.length > 0),
    "Resolved requires a cited supported hypothesis with evidence.",
  );
  const concludedAt = timestamp(input.concludedAt);
  requireDomain(concludedAt >= incident.createdAt, "Conclusion cannot precede incident creation.");
  return Object.freeze({
    ...createIncident(incident),
    status,
    conclusion: Object.freeze({
      explanation: prose(input.explanation, 4_000),
      hypothesisIds,
      evidenceIds,
      concludedAt,
    }),
  });
}
