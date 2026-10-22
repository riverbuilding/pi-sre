import { DomainError, requireDomain } from "./errors.js";
import { createEvidence } from "./evidence.js";
import type { Evidence } from "./evidence.js";
import { createHypothesis } from "./hypothesis.js";
import type { Hypothesis } from "./hypothesis.js";
import { beginInvestigation, concludeIncident, createIncident } from "./incident.js";
import type { Incident } from "./incident.js";
import { permitsContext } from "./investigation-scope.js";
import { createTarget, targetIdentity } from "./target.js";
import type { Target } from "./target.js";
import { identity, positiveInteger, prose, timestamp } from "./validation.js";

export interface OperationOutcome {
  readonly executionId: string;
  readonly context: string;
  readonly operation: string;
  readonly namespace?: string;
  readonly target?: Target;
  readonly completedAt: string;
  readonly status: "successful" | "partial" | "failed" | "interrupted";
  readonly explanation?: string;
}

export interface InvestigationSnapshotLimits {
  readonly targets: number;
  readonly hypotheses: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: InvestigationSnapshotLimits = Object.freeze({
  targets: 100,
  hypotheses: 50,
});

export interface InvestigationState {
  readonly incident: Incident;
  readonly targets: readonly Target[];
  /** Read snapshot supplied by EvidenceStore; never an independent writable store. */
  readonly evidence: readonly Evidence[];
  readonly hypotheses: readonly Hypothesis[];
  readonly focus?: string;
  readonly outcomes: readonly OperationOutcome[];
  readonly dispatchedAttempts: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

/** Validate a complete value and privately freeze it; no service, storage or authority. */
export function createInvestigationState(
  input: InvestigationState,
  maxExcerptChars: number,
  limits: InvestigationSnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): InvestigationState {
  positiveInteger(limits.targets);
  positiveInteger(limits.hypotheses);
  for (const resource of ["targets", "hypotheses"] as const) {
    if (input[resource].length > limits[resource]) {
      throw new DomainError(
        { kind: "capacity-refused", resource },
        "Incident collection capacity exceeded.",
      );
    }
  }
  const initial = createIncident(input.incident);
  const targets = input.targets.map(createTarget);
  requireDomain(
    new Set(targets.map(targetIdentity)).size === targets.length,
    "Targets must be unique and within the incident limit.",
  );
  const evidence = input.evidence.map((item) => createEvidence(item, maxExcerptChars));
  requireDomain(
    evidence.length <= input.dispatchedAttempts,
    "Evidence cannot exceed dispatched attempts.",
  );
  requireDomain(
    new Set(evidence.map((item) => item.id)).size === evidence.length &&
      new Set(evidence.map((item) => item.executionId)).size === evidence.length,
    "Duplicate evidence or execution identity.",
  );
  const hypotheses = input.hypotheses.map((item) => createHypothesis(item, evidence));
  requireDomain(
    new Set(hypotheses.map((item) => item.id)).size === hypotheses.length,
    "Hypotheses must be unique and within the incident limit.",
  );
  for (const item of [...evidence, ...hypotheses])
    requireDomain(item.incidentId === initial.id, "Records must belong to the same incident.");
  const outcomes = input.outcomes.map((item): OperationOutcome => {
    requireDomain(
      ["successful", "partial", "failed", "interrupted"].includes(item.status),
      "Unknown operation outcome.",
    );
    const target = item.target === undefined ? undefined : createTarget(item.target);
    requireDomain(
      target === undefined ||
        (target.context === item.context &&
          (item.namespace === undefined ||
            target.namespace === undefined ||
            target.namespace === item.namespace)),
      "Outcome target must match its origin.",
    );
    return Object.freeze({
      executionId: identity(item.executionId, 128),
      context: identity(item.context),
      operation: identity(item.operation),
      completedAt: timestamp(item.completedAt),
      status: item.status,
      ...(item.namespace !== undefined ? { namespace: identity(item.namespace) } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(item.explanation !== undefined ? { explanation: prose(item.explanation, 512) } : {}),
    });
  });
  requireDomain(
    Number.isSafeInteger(input.dispatchedAttempts) &&
      input.dispatchedAttempts >= outcomes.length &&
      new Set(outcomes.map((item) => item.executionId)).size === outcomes.length,
    "Outcomes must be unique and bounded by dispatched attempts.",
  );
  for (const item of [...targets, ...evidence, ...outcomes]) {
    if (!permitsContext(initial.scope, item.context))
      throw new DomainError(
        { kind: "scope-mismatch" },
        "Record context is outside the immutable incident rule.",
      );
  }
  requireDomain(
    evidence.every((item) => item.scopeRevision === initial.scope.revision),
    "Evidence scope revision must match its incident.",
  );
  const startedAt = timestamp(input.startedAt);
  const updatedAt = timestamp(input.updatedAt);
  requireDomain(
    startedAt === initial.createdAt &&
      updatedAt >= startedAt &&
      evidence.every((item) => item.completedAt >= startedAt && item.completedAt <= updatedAt) &&
      hypotheses.every((item) => item.updatedAt >= startedAt && item.updatedAt <= updatedAt) &&
      outcomes.every((item) => item.completedAt >= startedAt && item.completedAt <= updatedAt),
    "Aggregate timestamps must contain retained observations and updates.",
  );
  requireDomain(
    input.incident.status === "new" ||
      input.incident.status === "investigating" ||
      ((input.incident.status === "resolved" || input.incident.status === "inconclusive") &&
        input.incident.conclusion !== undefined),
    "Invalid incident lifecycle state.",
  );
  let incident: Incident;
  if (input.incident.status === "new") incident = initial;
  else if (input.incident.status === "investigating") incident = beginInvestigation(initial);
  else {
    const conclusion = input.incident.conclusion;
    requireDomain(conclusion !== undefined, "Terminal incident requires a conclusion.");
    incident = concludeIncident(initial, input.incident.status, conclusion, hypotheses, evidence);
  }
  requireDomain(
    incident.status !== "new" ||
      (input.dispatchedAttempts === 0 && hypotheses.length === 0 && evidence.length === 0),
    "Diagnostic work or hypotheses require investigating status.",
  );
  requireDomain(
    incident.conclusion === undefined || incident.conclusion.concludedAt <= updatedAt,
    "Conclusion must precede aggregate update.",
  );
  return Object.freeze({
    incident,
    targets: Object.freeze(targets),
    evidence: Object.freeze(evidence),
    hypotheses: Object.freeze(hypotheses),
    outcomes: Object.freeze(outcomes),
    dispatchedAttempts: input.dispatchedAttempts,
    ...(input.focus !== undefined ? { focus: prose(input.focus, 1_000) } : {}),
    startedAt,
    updatedAt,
    revision: positiveInteger(input.revision),
  });
}
