import type { ClusterContextManager, ClusterContextState } from "../cluster/context-manager.js";
import type {
  ClusterResolution,
  ClusterScopeRule,
  ClusterSelection,
} from "../cluster/context-resolver.js";
import type { ExecutionAdmissionFailure } from "../cluster/execution-queue.js";
import { requireDomain } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { Conclusion } from "../domain/incident.js";
import {
  copyInvestigationScope,
  resolveInvestigationScope,
} from "../domain/investigation-scope.js";
import type { InvestigationState } from "../domain/investigation-state.js";
import { identity } from "../domain/validation.js";
import type {
  DiagnosticExecution,
  ExecutionOrigin,
  FailureCategory,
  InvestigationService,
  InvestigationArchive,
  SuccessfulObservation,
} from "../investigation/investigation-service.js";
import type { McpToolDescriptor } from "../mcp/tool-discovery.js";
import { acceptsToolContext, getMcpToolPolicy } from "../runtime/tool-policy.js";

export interface InvestigationBinding {
  readonly sessionId: string;
  readonly bindingEpoch: number;
}

export interface EffectiveInvestigationScope extends InvestigationBinding {
  readonly incidentId: string;
  readonly lifecycleEpoch: number;
  readonly scopeRevision: number;
  readonly selectionSource: ClusterSelection["source"];
  readonly selectionRevision: number;
  readonly rule: ClusterScopeRule;
  readonly resolution: ClusterResolution;
  readonly inventoryRevision: number;
  readonly connectionGeneration: number;
  readonly namespacePolicy: "unrestricted";
  readonly readOnly: true;
}

export type InvestigationScopeResult =
  | { readonly ok: true; readonly scope: EffectiveInvestigationScope }
  | {
      readonly ok: false;
      readonly reason: "stale-binding" | "no-open-incident";
    };

export interface InvestigationControllerSnapshot {
  readonly effective: InvestigationScopeResult;
  /** Session choice, never diagnostic authority while an incident is open. */
  readonly next: ClusterContextState;
}

export interface IncidentExecutionLease {
  readonly scope: EffectiveInvestigationScope;
  readonly context: string;
  readonly operation: string;
}

export type IncidentAdmission =
  | { readonly ok: true; readonly lease: IncidentExecutionLease }
  | { readonly ok: false; readonly reason: ExecutionAdmissionFailure };

interface PendingLease {
  readonly releaseSlot: () => void;
  readonly releaseWork: () => void;
  readonly removeAbort: () => void;
  readonly origin: Omit<ExecutionOrigin, "inventoryRevision" | "connectionGeneration">;
  execution?: DiagnosticExecution;
}

/**
 * Process-owned incident authority. Reuses the existing manager/queue/connection.
 */
export class InvestigationController {
  readonly #manager: ClusterContextManager;
  readonly #service: InvestigationService;
  readonly #sessions = new Map<string, string>();
  readonly #leases = new Map<IncidentExecutionLease, PendingLease>();
  readonly #listeners = new Set<(snapshot: InvestigationControllerSnapshot) => void>();
  readonly #unsubscribe: () => void;
  #binding: InvestigationBinding | undefined;
  #bindingEpoch = 0;
  #lifecycleEpoch = 0;
  #scope: EffectiveInvestigationScope | undefined;
  #scopeKey = "";
  #tools: readonly McpToolDescriptor[] = [];
  #toolsGeneration = 0;
  #disposed = false;

  constructor(manager: ClusterContextManager, service: InvestigationService) {
    this.#manager = manager;
    this.#service = service;
    this.#unsubscribe = manager.subscribe(() => this.#publish());
  }

  /** Call inside the existing MCP publication gate, before inventory publication. */
  installTools(generation: number, tools: readonly McpToolDescriptor[]): void {
    requireDomain(
      generation === this.#manager.state.connectionGeneration && !this.#disposed,
      "Cannot publish tools for an obsolete connection.",
    );
    const diagnostic = tools.filter((tool) => getMcpToolPolicy(tool.name)?.clusterDependent);
    this.#tools = structuredClone(diagnostic);
    this.#toolsGeneration = generation;
    this.#publish();
  }

  bind(sessionId: string): InvestigationBinding {
    requireDomain(!this.#disposed, "Investigation controller is closed.");
    identity(sessionId, 128);
    this.unbind();
    this.#binding = Object.freeze({ sessionId, bindingEpoch: ++this.#bindingEpoch });
    this.#publish();
    return this.#binding;
  }

  /** An old extension's shutdown cannot detach a newer binding after reload. */
  unbind(expected = this.#binding): void {
    if (!expected || expected !== this.#binding) return;
    this.#binding = undefined;
    this.#invalidate("stale");
    this.#publish();
  }

  isBound(binding: InvestigationBinding): boolean {
    return !this.#disposed && binding === this.#binding;
  }

  inspect(binding: InvestigationBinding): InvestigationState | undefined {
    this.#requireBinding(binding);
    const id = this.#sessions.get(binding.sessionId);
    return id ? this.#service.inspect(id) : undefined;
  }

  start(binding: InvestigationBinding, question: string): InvestigationState {
    this.#requireBinding(binding);
    requireDomain(
      !this.#manager.isAgentActive,
      "Wait for active work before starting an incident.",
    );
    const state = this.#manager.state;
    requireDomain(
      "registry" in state &&
        state.resolution.status === "resolved" &&
        state.resolution.available.some((entry) => this.#usable(entry.name)) &&
        this.#manager.isConnectionCurrent(state.connectionGeneration),
      "Starting an investigation requires current usable diagnostic scope.",
    );
    const input = { question, selection: state.selection, inventory: state.registry };
    const previous = this.inspect(binding);
    const next =
      previous &&
      (previous.incident.status === "new" || previous.incident.status === "investigating")
        ? this.#service.replace(previous.incident.id, previous.revision, input)
        : this.#service.start(input);
    this.#sessions.set(binding.sessionId, next.incident.id);
    this.#lifecycleEpoch++;
    this.#publish();
    return next;
  }

  /** Only an eligible lifecycle hook calls this; no diagnostic handler creates incidents. */
  continueOrStart(binding: InvestigationBinding, question: string): InvestigationState {
    const previous = this.inspect(binding);
    return previous &&
      (previous.incident.status === "new" || previous.incident.status === "investigating")
      ? previous
      : this.start(binding, question);
  }

  conclude(
    binding: InvestigationBinding,
    expectedRevision: number,
    status: "resolved" | "inconclusive",
    conclusion: Omit<Conclusion, "concludedAt">,
  ): InvestigationState {
    this.#requireBinding(binding);
    requireDomain(
      !this.#manager.isAgentActive,
      "Wait for active work before concluding an incident.",
    );
    const current = this.inspect(binding);
    requireDomain(current !== undefined, "No investigation is bound to this session.");
    const next = this.#service.conclude(current.incident.id, expectedRevision, status, conclusion);
    this.#lifecycleEpoch++;
    this.#publish();
    return next;
  }

  async flush(incidentId: string, path: string): Promise<InvestigationArchive> {
    const receipt = await this.#service.flush(incidentId, path);
    for (const [session, id] of this.#sessions) {
      if (id === incidentId) this.#sessions.delete(session);
    }
    this.#publish();
    return receipt;
  }

  currentScope(): InvestigationScopeResult {
    const binding = this.#binding;
    if (!binding || this.#disposed) return { ok: false, reason: "stale-binding" };
    const incidentId = this.#sessions.get(binding.sessionId);
    if (!incidentId) return { ok: false, reason: "no-open-incident" };
    const incident = this.#service.incident(incidentId);
    if (incident.status !== "new" && incident.status !== "investigating")
      return { ok: false, reason: "no-open-incident" };
    const state = this.#manager.state;
    const resolution = resolveInvestigationScope(
      incident.scope,
      "registry" in state ? state.registry : undefined,
    );
    const candidate: EffectiveInvestigationScope = {
      ...binding,
      incidentId,
      lifecycleEpoch: this.#lifecycleEpoch,
      scopeRevision: incident.scope.revision,
      selectionSource: incident.scope.selectionSource,
      selectionRevision: incident.scope.selectionRevision,
      rule: copyInvestigationScope(incident.scope).rule,
      resolution,
      inventoryRevision: state.inventoryRevision,
      connectionGeneration: state.connectionGeneration,
      namespacePolicy: "unrestricted",
      readOnly: true,
    };
    const key = JSON.stringify(candidate);
    if (key !== this.#scopeKey) {
      this.#scope = Object.freeze(candidate);
      this.#scopeKey = key;
    }
    // Keep the immutable view available for honest outage presentation, but no dispatch.
    if (!this.#scope) throw new Error("Investigation scope was not constructed.");
    return { ok: true, scope: this.#scope };
  }

  /** Feed this same effective view to bridge validation and MCP capability publication. */
  clusterState(): ClusterContextState {
    const next = this.#manager.state;
    const effective = this.currentScope();
    if (!effective.ok)
      return Object.freeze({
        ...next,
        resolution: Object.freeze({ status: "blocked", reason: "inventory-unavailable" }),
        message: "No open investigation is bound; diagnostics are blocked.",
      });
    const { scope } = effective;
    const selection = Object.freeze({
      rule: scope.rule,
      source: scope.selectionSource,
      selectionRevision: scope.selectionRevision,
    });
    if ("registry" in next)
      return Object.freeze({
        ...next,
        selection,
        resolution: scope.resolution,
        status: "resolved",
        message:
          "Incident rule resolved; availability does not establish health or authentication.",
      });
    return Object.freeze({ ...next, selection, resolution: scope.resolution });
  }

  get snapshot(): InvestigationControllerSnapshot {
    return Object.freeze({ effective: this.currentScope(), next: this.#manager.state });
  }

  /** The same view filters capability publication and validates per-call admission. */
  availableTools(): readonly McpToolDescriptor[] {
    const current = this.currentScope();
    if (!current.ok || current.scope.resolution.status !== "resolved") return [];
    const contexts = current.scope.resolution.available;
    return structuredClone(
      this.#tools.filter((tool) => contexts.some((entry) => this.#usable(entry.name, tool.name))),
    );
  }

  subscribe(listener: (snapshot: InvestigationControllerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener({ effective: this.currentScope(), next: this.#manager.state });
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Admission reserves the shared queue only; it never spends a diagnostic attempt. */
  async admitExecution(
    expected: EffectiveInvestigationScope,
    input: Omit<ExecutionOrigin, "inventoryRevision" | "connectionGeneration">,
    signal?: AbortSignal,
  ): Promise<IncidentAdmission> {
    const origin = {
      context: input.context,
      operation: input.operation,
      ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
      ...(input.container !== undefined ? { container: input.container } : {}),
      ...(input.target !== undefined ? { target: structuredClone(input.target) } : {}),
    };
    const check = (): ExecutionAdmissionFailure | undefined => {
      const current = this.currentScope();
      if (!current.ok || current.scope !== expected) return "stale-scope";
      if (!this.#manager.isConnectionCurrent(expected.connectionGeneration)) return "stale-scope";
      if (expected.resolution.status !== "resolved") return "scope-unavailable";
      if (expected.resolution.unavailable.includes(origin.context)) return "scope-unavailable";
      if (!expected.resolution.available.some((entry) => entry.name === origin.context))
        return "invalid-arguments";
      if (!this.#usable(origin.context, origin.operation)) return "invalid-arguments";
      return undefined;
    };
    signal?.throwIfAborted();
    const failure = check();
    if (failure) return { ok: false, reason: failure };
    const releaseWork = this.#manager.beginAgentWork();
    let retained = false;
    let releaseSlot: (() => void) | undefined;
    try {
      const admission = await this.#manager.admitExecution(check, signal);
      if (!admission.ok) return { ok: false, reason: admission.category };
      releaseSlot = admission.release;
      signal?.throwIfAborted();
      const invalid = check();
      if (invalid) return { ok: false, reason: invalid };
      const lease = Object.freeze({
        scope: expected,
        context: origin.context,
        operation: origin.operation,
      });
      const abort = () => this.release(lease, "cancelled");
      this.#leases.set(lease, {
        origin: structuredClone(origin),
        releaseSlot,
        releaseWork,
        removeAbort: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      retained = true;
      return { ok: true, lease };
    } finally {
      if (!retained) {
        releaseSlot?.();
        releaseWork();
      }
    }
  }

  /** Synchronous: invoke after admission, immediately before calling the transport. */
  dispatchExecution(lease: IncidentExecutionLease): DiagnosticExecution {
    requireDomain(this.isCurrent(lease), "Diagnostic execution authority is stale.");
    const pending = this.#leases.get(lease);
    requireDomain(
      pending !== undefined && pending.execution === undefined,
      "Diagnostic lease was already dispatched.",
    );
    const execution = this.#service.dispatchDiagnostic(lease.scope.incidentId, {
      ...pending.origin,
      inventoryRevision: lease.scope.inventoryRevision,
      connectionGeneration: lease.scope.connectionGeneration,
    });
    pending.execution = execution;
    return execution;
  }

  /** Synchronous publication boundary: tokens alone never authorize observation commits. */
  recordObservation(lease: IncidentExecutionLease, observation: SuccessfulObservation): Evidence {
    requireDomain(this.isCurrent(lease), "Diagnostic execution authority is stale.");
    const execution = this.#leases.get(lease)?.execution;
    requireDomain(execution !== undefined, "Diagnostic lease has not dispatched.");
    return this.#service.recordObservation(execution, observation);
  }

  isCurrent(lease: IncidentExecutionLease): boolean {
    const current = this.currentScope();
    return (
      this.#leases.has(lease) &&
      current.ok &&
      current.scope === lease.scope &&
      this.#manager.isConnectionCurrent(lease.scope.connectionGeneration) &&
      this.#usable(lease.context, lease.operation)
    );
  }

  /** After successful recording this only releases guards; unsettled work records a safe outcome. */
  release(lease: IncidentExecutionLease, category: FailureCategory = "cancelled"): void {
    const pending = this.#leases.get(lease);
    if (!pending) return;
    this.#leases.delete(lease);
    try {
      if (pending.execution) this.#service.releaseDiagnostic(pending.execution, category);
    } finally {
      pending.removeAbort();
      pending.releaseWork();
      pending.releaseSlot();
    }
  }

  beginAgentWork(binding: InvestigationBinding): () => void {
    this.#requireBinding(binding);
    return this.#manager.beginAgentWork();
  }

  cancel(binding: InvestigationBinding): void {
    this.#requireBinding(binding);
    this.#invalidate("cancelled");
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.unbind();
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #requireBinding(binding: InvestigationBinding): void {
    requireDomain(this.isBound(binding), "This investigation binding is stale.");
  }

  #usable(context: string, operation?: string): boolean {
    return (
      this.#toolsGeneration === this.#manager.state.connectionGeneration &&
      this.#tools.some(
        (tool) =>
          (operation === undefined || tool.name === operation) && acceptsToolContext(tool, context),
      )
    );
  }

  #invalidate(category: FailureCategory): void {
    this.#lifecycleEpoch++;
    for (const lease of [...this.#leases.keys()]) this.release(lease, category);
  }

  #publish(): void {
    for (const lease of [...this.#leases.keys()]) {
      if (!this.isCurrent(lease)) this.release(lease, "stale");
    }
    this.#manager.refreshExecutionAdmission();
    const snapshot = { effective: this.currentScope(), next: this.#manager.state };
    for (const listener of this.#listeners) listener(snapshot);
  }
}
