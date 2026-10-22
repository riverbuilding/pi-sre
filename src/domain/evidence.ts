import { requireDomain } from "./errors.js";
import { createTarget } from "./target.js";
import type { Target } from "./target.js";
import { identity, positiveInteger, prose, timestamp } from "./validation.js";

/** A safe observation supplied by the normalizer, never a raw response. */
export interface Evidence {
  readonly id: string;
  readonly incidentId: string;
  readonly source: "kubernetes";
  readonly executionId: string;
  readonly operation: string;
  readonly completedAt: string;
  readonly context: string;
  readonly namespace?: string;
  readonly container?: string;
  readonly target?: Target;
  readonly excerpt: string;
  readonly scopeRevision: number;
  readonly inventoryRevision: number;
  readonly connectionGeneration: number;
  readonly truncated: boolean;
}

export function createEvidence(input: Evidence, maxExcerptChars: number): Evidence {
  requireDomain(
    input.source === "kubernetes" && typeof input.truncated === "boolean",
    "Invalid observation source or truncation flag.",
  );
  const context = identity(input.context);
  const target = input.target === undefined ? undefined : createTarget(input.target);
  requireDomain(
    target === undefined ||
      (target.context === context &&
        (input.namespace === undefined ||
          target.namespace === undefined ||
          target.namespace === input.namespace)),
    "Observation target must match its originating scope.",
  );
  return Object.freeze({
    id: identity(input.id, 128),
    incidentId: identity(input.incidentId, 128),
    source: "kubernetes",
    executionId: identity(input.executionId, 128),
    operation: identity(input.operation),
    completedAt: timestamp(input.completedAt),
    context,
    ...(input.namespace !== undefined ? { namespace: identity(input.namespace) } : {}),
    ...(input.container !== undefined ? { container: identity(input.container) } : {}),
    ...(target !== undefined ? { target } : {}),
    excerpt: prose(input.excerpt, positiveInteger(maxExcerptChars), true),
    scopeRevision: positiveInteger(input.scopeRevision),
    inventoryRevision: positiveInteger(input.inventoryRevision),
    connectionGeneration: positiveInteger(input.connectionGeneration),
    truncated: input.truncated,
  });
}
