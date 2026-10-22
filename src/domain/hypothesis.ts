import { DomainError, requireDomain } from "./errors.js";
import type { Evidence } from "./evidence.js";
import { identity, positiveInteger, prose, timestamp, uniqueIds } from "./validation.js";

export interface Hypothesis {
  readonly id: string;
  readonly incidentId: string;
  readonly statement: string;
  readonly status: "candidate" | "supported" | "rejected";
  readonly supportingEvidence: readonly string[];
  readonly contradictingEvidence: readonly string[];
  readonly rationale: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export function requireEvidenceReferences(
  ids: readonly string[],
  incidentId: string,
  evidence: readonly Evidence[],
): void {
  for (const id of ids) {
    if (!evidence.some((item) => item.id === id && item.incidentId === incidentId)) {
      throw new DomainError(
        { kind: "missing-reference" },
        "Evidence reference must exist in the same incident.",
      );
    }
  }
}

export function createHypothesis(input: Hypothesis, evidence: readonly Evidence[]): Hypothesis {
  const incidentId = identity(input.incidentId, 128);
  const supportingEvidence = uniqueIds(input.supportingEvidence);
  const contradictingEvidence = uniqueIds(input.contradictingEvidence);
  requireDomain(
    ["candidate", "supported", "rejected"].includes(input.status),
    "Unknown hypothesis status.",
  );
  requireDomain(
    !supportingEvidence.some((id) => contradictingEvidence.includes(id)),
    "Evidence cannot both support and contradict one hypothesis.",
  );
  requireEvidenceReferences(
    [...supportingEvidence, ...contradictingEvidence],
    incidentId,
    evidence,
  );
  requireDomain(
    input.status !== "supported" || supportingEvidence.length > 0,
    "Supported hypotheses require supporting evidence.",
  );
  requireDomain(
    input.status !== "rejected" || contradictingEvidence.length > 0,
    "Rejected hypotheses require contradicting evidence.",
  );
  return Object.freeze({
    id: identity(input.id, 128),
    incidentId,
    statement: prose(input.statement, 2_000),
    status: input.status,
    supportingEvidence,
    contradictingEvidence,
    rationale: prose(input.rationale, 4_000),
    revision: positiveInteger(input.revision),
    updatedAt: timestamp(input.updatedAt),
  });
}
