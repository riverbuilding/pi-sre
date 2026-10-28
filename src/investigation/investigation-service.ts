import { randomUUID } from "node:crypto";
import type { ClusterContextRegistry } from "../cluster/context-registry.js";
import type { ClusterSelection } from "../cluster/context-resolver.js";
import { DomainError, requireDomain, requireRevision } from "../domain/errors.js";
import { createEvidence } from "../domain/evidence.js";
import type { Evidence } from "../domain/evidence.js";
import { createHypothesis } from "../domain/hypothesis.js";
import type { Hypothesis } from "../domain/hypothesis.js";
import {
  beginInvestigation,
  concludeIncident,
  createIncident,
  requireOpenIncident,
} from "../domain/incident.js";
import type { Conclusion, Incident } from "../domain/incident.js";
import {
  createInvestigationScope,
  permitsContext,
  resolveInvestigationScope,
  resolveTimeWindow,
} from "../domain/investigation-scope.js";
import { createInvestigationState } from "../domain/investigation-state.js";
import type { InvestigationState, OperationOutcome } from "../domain/investigation-state.js";
import { createTarget, targetIdentity } from "../domain/target.js";
import type { Target } from "../domain/target.js";
import { identity, positiveInteger, prose, timestamp } from "../domain/validation.js";
import { EvidenceStore } from "./evidence-store.js";
import { writeInvestigationArchive } from "./investigation-archive.js";
import type { EvidencePage, EvidenceStoreOptions } from "./evidence-store.js";

export const DEFAULT_INCIDENT_LIMIT = 20;

export interface InvestigationServiceOptions {
  readonly maxToolCalls: number;
  readonly maxExcerptChars: number;
  readonly defaultTimeRange: string;
  /** Resident investigations; a successful flush releases one slot. */
  readonly maxIncidents?: number;
  /** Evidence count and retained content bytes are independent for every incident. */
  readonly maxEvidence?: number;
  readonly maxBytes?: number;
  readonly clock?: () => Date;
  readonly createId?: (kind: "incident" | "hypothesis" | "execution" | "evidence") => string;
}

export interface StartInvestigation {
  readonly question: string;
  readonly selection: ClusterSelection;
  /** Validated, diagnostically usable inventory supplied by the application controller. */
  readonly inventory: ClusterContextRegistry;
}

export type HypothesisUpdate = Pick<
  Hypothesis,
  "statement" | "status" | "supportingEvidence" | "contradictingEvidence" | "rationale"
> &
  (
    | { readonly id?: never; readonly expectedRevision?: never }
    | { readonly id: string; readonly expectedRevision: number }
  );

export interface ExecutionOrigin {
  readonly context: string;
  readonly operation: string;
  readonly namespace?: string;
  readonly container?: string;
  readonly target?: Target;
  readonly inventoryRevision: number;
  readonly connectionGeneration: number;
}

/** Execution identity only; session, inventory and transport authority belong to the controller. */
export interface DiagnosticExecution {
  readonly incidentId: string;
  readonly executionId: string;
  readonly evidenceId: string;
}

export interface SuccessfulObservation {
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly completedAt: string;
}

export type FailureCategory =
  | "authentication"
  | "authorization"
  | "timeout"
  | "transport"
  | "tool"
  | "storage"
  | "malformed"
  | "cancelled"
  | "stale";

const FAILURE_EXPLANATIONS: Readonly<Record<FailureCategory, string>> = Object.freeze({
  authentication: "Kubernetes authentication failed.",
  authorization: "Kubernetes authorization refused the operation.",
  timeout: "The diagnostic operation timed out.",
  transport: "The MCP transport failed.",
  tool: "The diagnostic tool failed.",
  malformed: "The diagnostic response could not be presented.",
  storage: "The observation exceeded incident evidence storage capacity and was not retained.",
  cancelled: "The diagnostic operation was cancelled.",
  stale: "The diagnostic operation was invalidated.",
});

/** Private mutable aggregate; evidence remains exclusively owned by EvidenceStore. */
type RetainedState = {
  -readonly [Key in keyof Omit<InvestigationState, "evidence">]: InvestigationState[Key];
};
type StateChanges = Partial<Omit<RetainedState, "revision" | "updatedAt">>;
interface RetainedInvestigation {
  readonly state: RetainedState;
  readonly store: EvidenceStore;
  readonly settled: WeakMap<DiagnosticExecution, Evidence | OperationOutcome>;
}

export interface InvestigationArchive {
  readonly incidentId: string;
  readonly path: string;
  readonly evidenceCount: number;
}

interface PendingExecution {
  readonly origin: ExecutionOrigin;
}

function canonical(state: InvestigationState): RetainedState {
  const { evidence, ...retained } = state;
  void evidence;
  return retained;
}

/** Process-owned domain service. Session binding, usable inventory and leases belong to the controller. */
export class InvestigationService {
  readonly #storeOptions: Omit<EvidenceStoreOptions, "incidentId">;
  readonly #investigations = new Map<string, RetainedInvestigation>();
  readonly #flushing = new Set<string>();
  readonly #pending = new Map<DiagnosticExecution, PendingExecution>();
  readonly #clock: () => Date;
  readonly #createId: NonNullable<InvestigationServiceOptions["createId"]>;
  readonly #maxToolCalls: number;
  readonly #maxExcerptChars: number;
  readonly #maxIncidents: number;
  readonly #timeRange: string;

  constructor(options: InvestigationServiceOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => randomUUID());
    this.#maxToolCalls = positiveInteger(options.maxToolCalls);
    this.#maxExcerptChars = positiveInteger(options.maxExcerptChars);
    this.#maxIncidents = positiveInteger(options.maxIncidents ?? DEFAULT_INCIDENT_LIMIT);
    this.#timeRange = options.defaultTimeRange;
    this.#storeOptions = Object.freeze({
      maxExcerptChars: this.#maxExcerptChars,
      ...(options.maxEvidence !== undefined
        ? { maxEvidence: positiveInteger(options.maxEvidence) }
        : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: positiveInteger(options.maxBytes) } : {}),
      createId: () => this.#createId("evidence"),
    });
  }

  capacity(incidentId: string): ReturnType<EvidenceStore["capacity"]> {
    return this.#get(incidentId).store.capacity();
  }

  /** Small authority read; never copies the evidence collection on the dispatch path. */
  incident(incidentId: string): Incident {
    return structuredClone(this.#get(incidentId).state.incident);
  }

  /** Detached deep copy: caller edits and later service updates cannot affect one another. */
  inspect(incidentId: string): InvestigationState {
    const { state, store } = this.#get(incidentId);
    return structuredClone({ ...state, evidence: store.snapshot() });
  }

  evidenceGet(incidentId: string, evidenceId: string): Evidence {
    return this.#get(incidentId).store.get(evidenceId);
  }

  evidenceList(
    incidentId: string,
    options: Parameters<EvidenceStore["list"]>[0] = {},
  ): EvidencePage {
    return this.#get(incidentId).store.list(options);
  }

  start(input: StartInvestigation): InvestigationState {
    const state = this.#prepareStart(input);
    this.#registerInvestigation(state);
    return this.inspect(state.incident.id);
  }

  /** The controller supplies the incident bound to its session; no implicit global active incident. */
  replace(
    incidentId: string,
    expectedRevision: number,
    input: StartInvestigation,
  ): InvestigationState {
    const previous = this.#mutable(incidentId, expectedRevision);
    this.#requireIdle(incidentId);
    const next = this.#prepareStart(input);
    const closed = this.#prepareUpdate(
      previous,
      {
        incident: concludeIncident(
          previous.incident,
          "inconclusive",
          {
            explanation: "Investigation replaced by an explicit new question; uncertainty remains.",
            hypothesisIds: [],
            evidenceIds: [],
            concludedAt: next.startedAt,
          },
          previous.hypotheses,
          this.#get(incidentId).store.evidence,
        ),
      },
      next.startedAt,
    );
    this.#registerInvestigation(next);
    Object.assign(previous, closed);
    return this.inspect(next.incident.id);
  }

  setFocus(incidentId: string, expectedRevision: number, focus?: string): InvestigationState {
    const previous = this.#mutable(incidentId, expectedRevision);
    const safeFocus = focus === undefined ? undefined : prose(focus, 1_000);
    const update = this.#prepareUpdate(previous, {});
    if (safeFocus === undefined) delete previous.focus;
    else previous.focus = safeFocus;
    Object.assign(previous, update);
    return this.inspect(incidentId);
  }

  setTargets(
    incidentId: string,
    expectedRevision: number,
    targets: readonly Target[],
  ): InvestigationState {
    const previous = this.#mutable(incidentId, expectedRevision);
    const validated = targets.map(createTarget);
    this.#checkTargets(previous, validated);
    Object.assign(previous, this.#prepareUpdate(previous, { targets: validated }));
    return this.inspect(incidentId);
  }

  upsertHypothesis(incidentId: string, input: HypothesisUpdate): Hypothesis {
    const previous = this.#mutable(incidentId);
    const old =
      input.id === undefined ? undefined : previous.hypotheses.find((item) => item.id === input.id);
    if (input.id !== undefined) {
      if (!old)
        throw new DomainError(
          { kind: "missing-reference" },
          "Hypothesis must exist in this incident.",
        );
      requireRevision(old.revision, input.expectedRevision);
    }
    const id = old?.id ?? identity(this.#createId("hypothesis"), 128);
    if (!old)
      requireDomain(
        ![...this.#investigations.values()].some(({ state }) =>
          state.hypotheses.some((item) => item.id === id),
        ),
        "Hypothesis ID must be unique.",
      );
    const now = this.#now(previous);
    const hypothesis = createHypothesis(
      {
        ...input,
        id,
        incidentId,
        revision: (old?.revision ?? 0) + 1,
        updatedAt: now,
      },
      this.#get(incidentId).store.evidence,
    );
    const hypotheses = old
      ? previous.hypotheses.map((item) => (item.id === id ? hypothesis : item))
      : [...previous.hypotheses, hypothesis];
    Object.assign(
      previous,
      this.#prepareUpdate(
        previous,
        {
          incident: beginInvestigation(previous.incident),
          hypotheses,
        },
        now,
      ),
    );
    return hypothesis;
  }

  conclude(
    incidentId: string,
    expectedRevision: number,
    status: "resolved" | "inconclusive",
    conclusion: Omit<Conclusion, "concludedAt">,
  ): InvestigationState {
    const previous = this.#mutable(incidentId, expectedRevision);
    this.#requireIdle(incidentId);
    const now = this.#now(previous);
    const incident = concludeIncident(
      previous.incident,
      status,
      { ...conclusion, concludedAt: now },
      previous.hypotheses,
      this.#get(incidentId).store.evidence,
    );
    Object.assign(previous, this.#prepareUpdate(previous, { incident }, now));
    return this.inspect(incidentId);
  }

  /** Invoke immediately before transport, after controller/queue admission. Spends one attempt. */
  dispatchDiagnostic(incidentId: string, input: ExecutionOrigin): DiagnosticExecution {
    const state = this.#mutable(incidentId);
    const origin = Object.freeze({
      context: identity(input.context),
      operation: identity(input.operation),
      ...(input.namespace !== undefined ? { namespace: identity(input.namespace) } : {}),
      ...(input.container !== undefined ? { container: identity(input.container) } : {}),
      ...(input.target !== undefined ? { target: createTarget(input.target) } : {}),
      inventoryRevision: positiveInteger(input.inventoryRevision),
      connectionGeneration: positiveInteger(input.connectionGeneration),
    });
    if (!permitsContext(state.incident.scope, origin.context))
      throw new DomainError(
        { kind: "scope-mismatch" },
        "Diagnostic context is outside the incident rule.",
      );
    if (state.dispatchedAttempts >= this.#maxToolCalls)
      throw new DomainError(
        { kind: "budget-refused" },
        "Incident diagnostic budget exhausted; explain findings or conclude inconclusive.",
      );
    const executionId = identity(this.#createId("execution"), 128);
    requireDomain(
      ![...this.#pending.keys()].some((item) => item.executionId === executionId) &&
        ![...this.#investigations.values()].some(({ state }) =>
          state.outcomes.some((outcome) => outcome.executionId === executionId),
        ),
      "Execution ID must be unique.",
    );
    // Validate origin consistency without preallocating storage for a future result.
    if (origin.target)
      requireDomain(
        origin.target.context === origin.context &&
          (origin.namespace === undefined ||
            origin.target.namespace === undefined ||
            origin.target.namespace === origin.namespace),
        "Diagnostic target must match its execution origin.",
      );
    const token = Object.freeze({
      incidentId,
      executionId,
      evidenceId: identity(this.#createId("evidence"), 128),
    });
    Object.assign(
      state,
      this.#prepareUpdate(state, {
        incident: beginInvestigation(state.incident),
        dispatchedAttempts: state.dispatchedAttempts + 1,
      }),
    );
    this.#pending.set(token, { origin });
    return token;
  }

  recordObservation(token: DiagnosticExecution, input: SuccessfulObservation): Evidence {
    const investigation = this.#get(token.incidentId);
    const settled = investigation.settled.get(token);
    if (settled && "excerpt" in settled) {
      const repeated = createEvidence({ ...settled, ...input }, this.#maxExcerptChars);
      requireDomain(
        JSON.stringify(repeated) === JSON.stringify(settled),
        "Execution already has a different observation.",
      );
      return settled;
    }
    const pendingExecution = this.#getPendingExecution(token);
    const previousState = this.#mutable(token.incidentId);
    const evidence = createEvidence(
      {
        ...pendingExecution.origin,
        excerpt: input.excerpt,
        truncated: input.truncated,
        completedAt: input.completedAt,
        id: token.evidenceId,
        incidentId: token.incidentId,
        executionId: token.executionId,
        source: "kubernetes",
        scopeRevision: previousState.incident.scope.revision,
      },
      this.#maxExcerptChars,
    );
    const operationOutcome = this.#buildOperationOutcome(
      token,
      pendingExecution,
      evidence.completedAt,
      evidence.truncated ? "partial" : "successful",
    );
    const target = evidence.target;
    const targets =
      target &&
      !previousState.targets.some((item) => targetIdentity(item) === targetIdentity(target))
        ? [...previousState.targets, target]
        : previousState.targets;
    this.#checkTargets(previousState, targets);
    const update = this.#prepareUpdate(
      previousState,
      {
        targets,
        outcomes: [...previousState.outcomes, operationOutcome],
      },
      this.#completionTime(previousState, evidence.completedAt),
    );
    const committed = investigation.store.append(evidence).evidence;
    Object.assign(previousState, update);
    this.#pending.delete(token);
    investigation.settled.set(token, committed);
    return committed;
  }

  /** Settle dispatched work with a safe failure or interruption; attempts stay spent. */
  releaseDiagnostic(token: DiagnosticExecution, category: FailureCategory = "cancelled"): void {
    const work = this.#pending.get(token);
    if (!work) return;
    try {
      requireDomain(
        Object.hasOwn(FAILURE_EXPLANATIONS, category),
        "Unknown diagnostic failure category.",
      );
      const previous = this.#mutable(token.incidentId);
      const now = this.#now(previous);
      const outcome = this.#buildOperationOutcome(
        token,
        work,
        now,
        category === "cancelled" || category === "stale" ? "interrupted" : "failed",
        FAILURE_EXPLANATIONS[category],
      );
      Object.assign(
        previous,
        this.#prepareUpdate(
          previous,
          {
            outcomes: [...previous.outcomes, outcome],
          },
          now,
        ),
      );
      this.#get(token.incidentId).settled.set(token, outcome);
    } finally {
      this.#pending.delete(token);
    }
  }

  /** Explicit archive only: a session switch never concludes or flushes an incident. */
  async flush(incidentId: string, path: string): Promise<InvestigationArchive> {
    const state = this.inspect(incidentId);
    requireDomain(
      state.incident.status === "resolved" || state.incident.status === "inconclusive",
      "Conclude the investigation before flushing it.",
    );
    this.#requireIdle(incidentId);
    requireDomain(!this.#flushing.has(incidentId), "Investigation is already being flushed.");
    this.#flushing.add(incidentId);
    try {
      await writeInvestigationArchive(path, state);
      this.#investigations.delete(incidentId);
      return Object.freeze({ incidentId, path, evidenceCount: state.evidence.length });
    } finally {
      this.#flushing.delete(incidentId);
    }
  }

  #buildOperationOutcome(
    token: DiagnosticExecution,
    pendingExecution: PendingExecution,
    completedAt: string,
    status: OperationOutcome["status"],
    explanation?: string,
  ): OperationOutcome {
    return {
      executionId: token.executionId,
      context: pendingExecution.origin.context,
      operation: pendingExecution.origin.operation,
      scopeRevision: this.#get(token.incidentId).state.incident.scope.revision,
      inventoryRevision: pendingExecution.origin.inventoryRevision,
      connectionGeneration: pendingExecution.origin.connectionGeneration,
      ...(pendingExecution.origin.namespace !== undefined
        ? { namespace: pendingExecution.origin.namespace }
        : {}),
      ...(pendingExecution.origin.target !== undefined
        ? { target: pendingExecution.origin.target }
        : {}),
      completedAt,
      status,
      ...(explanation !== undefined ? { explanation } : {}),
    };
  }

  #prepareStart(input: StartInvestigation): InvestigationState {
    if (this.#investigations.size >= this.#maxIncidents)
      throw new DomainError(
        { kind: "capacity-refused", resource: "incidents" },
        "Incident memory capacity is full; flush a concluded investigation before starting another.",
      );
    const now = timestamp(this.#clock().toISOString());
    const scope = createInvestigationScope(
      input.selection,
      resolveTimeWindow(this.#timeRange, () => new Date(now)),
    );
    const resolution = resolveInvestigationScope(scope, input.inventory);
    if (resolution.status !== "resolved" || resolution.available.length === 0)
      throw new DomainError(
        { kind: "scope-mismatch" },
        "Starting an investigation requires usable scope inventory.",
      );
    const id = identity(this.#createId("incident"), 128);
    requireDomain(!this.#investigations.has(id), "Incident ID must be unique.");
    return createInvestigationState(
      {
        incident: createIncident({ id, question: input.question, createdAt: now, scope }),
        targets: [],
        evidence: [],
        hypotheses: [],
        outcomes: [],
        dispatchedAttempts: 0,
        startedAt: now,
        updatedAt: now,
        revision: 1,
      },
      this.#maxExcerptChars,
    );
  }

  #registerInvestigation(state: InvestigationState): void {
    const store = new EvidenceStore({ ...this.#storeOptions, incidentId: state.incident.id });
    this.#investigations.set(state.incident.id, {
      state: canonical(state),
      store,
      settled: new WeakMap(),
    });
  }

  #get(incidentId: string): RetainedInvestigation {
    identity(incidentId, 128);
    const state = this.#investigations.get(incidentId);
    if (!state)
      throw new DomainError(
        { kind: "missing-reference" },
        "Unknown or archived investigation; no in-memory state is available.",
      );
    return state;
  }

  #mutable(incidentId: string, revision?: number): RetainedState {
    const { state } = this.#get(incidentId);
    requireOpenIncident(state.incident);
    if (revision !== undefined) requireRevision(state.revision, revision);
    return state;
  }

  #now(previous: RetainedState): string {
    const now = timestamp(this.#clock().toISOString());
    requireDomain(now >= previous.updatedAt, "Investigation clock moved backwards.");
    return now;
  }

  #completionTime(previous: RetainedState, completedAt: string): string {
    timestamp(completedAt);
    const now = this.#now(previous);
    requireDomain(
      completedAt >= previous.startedAt && completedAt <= now,
      "Observation completion time is outside the investigation clock.",
    );
    return now;
  }

  /** Validate metadata before any mutation, including an EvidenceStore append. No awaits during commit. */
  #prepareUpdate(
    previous: RetainedState,
    changes: StateChanges,
    updatedAt = this.#now(previous),
  ): StateChanges & Pick<RetainedState, "revision" | "updatedAt"> {
    requireDomain(updatedAt >= previous.updatedAt, "Investigation clock moved backwards.");
    return { ...changes, updatedAt, revision: positiveInteger(previous.revision + 1) };
  }

  #getPendingExecution(token: DiagnosticExecution): PendingExecution {
    const work = this.#pending.get(token);
    requireDomain(work !== undefined, "Unknown, foreign or settled diagnostic execution.");
    return work;
  }

  #requireIdle(incidentId: string): void {
    requireDomain(
      ![...this.#pending.keys()].some((item) => item.incidentId === incidentId),
      "Settle active diagnostic work before concluding or replacing an investigation.",
    );
  }

  #checkTargets(state: RetainedState, targets: readonly Target[]): void {
    requireDomain(
      new Set(targets.map(targetIdentity)).size === targets.length,
      "Targets must be unique.",
    );
    for (const target of targets)
      if (!permitsContext(state.incident.scope, target.context))
        throw new DomainError(
          { kind: "scope-mismatch" },
          "Target context is outside the incident rule.",
        );
  }
}
