import {
  ExecutionQueue,
  type ExecutionAdmission,
  type ExecutionAdmissionFailure,
} from "./execution-queue.js";
import type { ClusterContextRegistry } from "./context-registry.js";
import {
  createExactClusterRule,
  createStartupSelection,
  resolveClusterSelection,
  type ClusterResolution,
  type ClusterScopeRule,
  type ClusterSelection,
  type StartupClusterIntent,
} from "./context-resolver.js";

export interface ClusterExecutionSnapshot {
  readonly rule: ClusterScopeRule;
  readonly selectionRevision: number;
  readonly inventoryRevision: number;
  readonly connectionGeneration: number;
  readonly context: string;
  readonly namespacePolicy: "unrestricted";
  readonly readOnly: true;
}

/** Scope authority seam; independent of Pi and MCP transport. */
export interface ClusterExecutionAuthority {
  readonly state: ClusterContextState;
  isConnectionCurrent(generation: number): boolean;
  captureExecution(generation: number, context: string): ClusterExecutionSnapshot | undefined;
  isExecutionCurrent(snapshot: ClusterExecutionSnapshot): boolean;
  releaseExecution(snapshot: ClusterExecutionSnapshot): void;
  beginAgentWork(): () => void;
  admitExecution(
    check: () => ExecutionAdmissionFailure | undefined,
    signal?: AbortSignal,
  ): ExecutionAdmission | Promise<ExecutionAdmission>;
}

export interface ClusterInventoryTransition {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

interface StateRevision {
  readonly inventoryTransition?: ClusterInventoryTransition | undefined;
  /** Last successful inventory, retained for inspection but never usable during outages. */
  readonly inventory: ClusterContextRegistry | undefined;
  readonly connectionGeneration: number;
  readonly inventoryRevision: number;
  readonly selection: ClusterSelection;
  readonly resolution: ClusterResolution;
}

export type ClusterContextState = StateRevision &
  (
    | { readonly status: "connecting" | "unavailable"; readonly message: string }
    | {
        readonly status: "enumeration-failed";
        readonly reason: "incompatible-tool" | "invalid-response" | "tool-error";
        readonly message: string;
      }
    | {
        readonly status: "not-configured" | "resolved" | "selection-error";
        readonly registry: ClusterContextRegistry;
        readonly message: string;
      }
  );

const inventoryUnavailable: ClusterResolution = Object.freeze({
  status: "blocked",
  reason: "inventory-unavailable",
});

/** Session-owned rule and resolution, independent of transcript and MCP default metadata. */
export class ClusterContextManager implements ClusterExecutionAuthority {
  private readonly executionQueue = new ExecutionQueue();
  private disposed = false;
  private publicationBlocks = 0;
  private readonly snapshots = new Set<ClusterExecutionSnapshot>();
  private readonly listeners = new Set<(state: ClusterContextState) => void>();
  private readonly work = new Set<symbol>();
  private validatedSelection = false;
  private currentWorkEpoch = 0;
  private currentContextState: ClusterContextState;

  constructor(intent: StartupClusterIntent = {}, configuredRule?: ClusterScopeRule) {
    this.currentContextState = Object.freeze({
      status: "unavailable",
      inventory: undefined,
      connectionGeneration: 0,
      inventoryRevision: 0,
      selection: createStartupSelection(intent, configuredRule),
      resolution: inventoryUnavailable,
      message: "Kubernetes MCP is unavailable. Use /mcp_restart to retry.",
    });
  }

  get state(): ClusterContextState {
    return this.currentContextState;
  }

  get workEpoch(): number {
    return this.currentWorkEpoch;
  }

  get isAgentActive(): boolean {
    return this.work.size > 0;
  }

  subscribe(listener: (state: ClusterContextState) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentContextState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publishCurrentContextState(state: ClusterContextState): void {
    this.currentContextState = Object.freeze(state);
    this.executionQueue.refresh();
    for (const listener of this.listeners) listener(this.currentContextState);
  }

  beginConnection(): number {
    const connectionGeneration = this.state.connectionGeneration + 1;
    this.publishCurrentContextState({
      status: "connecting",
      inventory: this.state.inventory,
      inventoryTransition: this.state.inventoryTransition,
      connectionGeneration,
      inventoryRevision: this.state.inventoryRevision,
      selection: this.state.selection,
      resolution: inventoryUnavailable,
      message: "Kubernetes MCP connecting; cluster scope unavailable.",
    });
    return connectionGeneration;
  }

  markUnavailable(message: string): void {
    this.publishCurrentContextState({
      status: "unavailable",
      inventory: this.state.inventory,
      inventoryTransition: this.state.inventoryTransition,
      connectionGeneration: this.state.connectionGeneration,
      inventoryRevision: this.state.inventoryRevision,
      selection: this.state.selection,
      resolution: inventoryUnavailable,
      message,
    });
  }

  failEnumeration(
    generation: number,
    reason: "incompatible-tool" | "invalid-response" | "tool-error",
    message: string,
  ): void {
    if (generation !== this.state.connectionGeneration || this.state.status !== "connecting")
      return;
    this.publishCurrentContextState({
      ...this.state,
      status: "enumeration-failed",
      reason,
      message,
    });
  }

  acceptRegistry(generation: number, registry: ClusterContextRegistry): void {
    if (generation !== this.state.connectionGeneration || this.state.status !== "connecting")
      return;
    const previous = this.state.inventory;
    const transition = previous
      ? Object.freeze({
          added: Object.freeze(
            registry.contexts
              .filter((entry) => !previous.get(entry.name))
              .map((entry) => entry.name),
          ),
          removed: Object.freeze(
            previous.contexts
              .filter((entry) => !registry.get(entry.name))
              .map((entry) => entry.name),
          ),
          changed: Object.freeze(
            registry.contexts
              .filter((entry) => {
                const old = previous.get(entry.name);
                return old && (old.server !== entry.server || old.isDefault !== entry.isDefault);
              })
              .map((entry) => entry.name),
          ),
        })
      : undefined;
    this.installResolution(
      registry,
      this.state.selection,
      this.state.inventoryRevision + 1,
      transition,
    );
  }

  private installResolution(
    registry: ClusterContextRegistry,
    selection: ClusterSelection,
    inventoryRevision: number,
    inventoryTransition = this.state.inventoryTransition,
  ): void {
    const resolution = resolveClusterSelection(registry, selection.rule, this.validatedSelection);
    if (resolution.status === "resolved") this.validatedSelection = true;
    const common = {
      inventory: registry,
      inventoryTransition,
      connectionGeneration: this.state.connectionGeneration,
      inventoryRevision,
      selection,
      resolution,
      registry,
    };
    if (resolution.status === "blocked") {
      this.publishCurrentContextState({
        ...common,
        status: "selection-error",
        message: "The exact selection is not available in MCP inventory; no fallback was applied.",
      });
      return;
    }
    this.publishCurrentContextState({
      ...common,
      status: registry.contexts.length === 0 ? "not-configured" : "resolved",
      message:
        resolution.available.length > 0
          ? "Cluster rule resolved (authentication and authorization are not verified)."
          : "No selected contexts are available. Configure MCP Kubernetes access and use /mcp_restart.",
    });
  }

  /** Atomic idle replacement; a failed replacement preserves all current authority. */
  selectRule(
    rule: ClusterScopeRule,
    expectedInventoryRevision = this.state.inventoryRevision,
    expectedSelectionRevision = this.state.selection.selectionRevision,
  ): void {
    if (this.isAgentActive)
      throw new Error("Wait for or cancel the active agent turn before selecting a cluster.");
    const state = this.state;
    if (this.publicationBlocks > 0 && "registry" in state)
      throw new Error("Cluster context publication is in progress. Retry /clusters.");
    if (!("registry" in state) || state.registry.contexts.length === 0) {
      throw new Error(
        "A current MCP context registry is required. Use /mcp_restart and retry /clusters.",
      );
    }
    if (
      expectedInventoryRevision !== state.inventoryRevision ||
      expectedSelectionRevision !== state.selection.selectionRevision
    ) {
      throw new Error("Cluster context state changed during selection. Retry /clusters.");
    }
    const candidate = createStartupSelection({ rule }).rule;
    if (JSON.stringify(candidate) === JSON.stringify(state.selection.rule)) return;
    if (resolveClusterSelection(state.registry, candidate).status === "blocked") {
      throw new Error("Unknown MCP context. Use /clusters to select an exact available name.");
    }
    const selection: ClusterSelection = Object.freeze({
      rule: candidate,
      source: "user",
      selectionRevision: state.selection.selectionRevision + 1,
    });
    this.validatedSelection = true;
    this.installResolution(state.registry, selection, state.inventoryRevision);
  }

  select(
    name: string,
    expectedInventoryRevision = this.state.inventoryRevision,
    expectedSelectionRevision = this.state.selection.selectionRevision,
  ): void {
    this.selectRule(
      createExactClusterRule([name]),
      expectedInventoryRevision,
      expectedSelectionRevision,
    );
  }

  /** Keep all handlers closed until matching tools and scope notices have been published. */
  blockDispatch(): () => void {
    this.publicationBlocks++;
    this.executionQueue.refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.publicationBlocks--;
    };
  }

  admitExecution(
    check: () => ExecutionAdmissionFailure | undefined,
    signal?: AbortSignal,
  ): ExecutionAdmission | Promise<ExecutionAdmission> {
    return this.executionQueue.acquire(check, signal);
  }

  /** Additional application authority changed (for example, a Pi session binding). */
  refreshExecutionAdmission(): void {
    this.executionQueue.refresh();
  }

  isConnectionCurrent(generation: number): boolean {
    return (
      !this.disposed &&
      this.publicationBlocks === 0 &&
      generation === this.state.connectionGeneration
    );
  }

  captureExecution(generation: number, context: string): ClusterExecutionSnapshot | undefined {
    const state = this.state;
    if (
      !this.isConnectionCurrent(generation) ||
      state.resolution.status !== "resolved" ||
      !state.resolution.available.some((entry) => entry.name === context)
    )
      return undefined;
    const snapshot: ClusterExecutionSnapshot = Object.freeze({
      rule: state.selection.rule,
      selectionRevision: state.selection.selectionRevision,
      inventoryRevision: state.inventoryRevision,
      connectionGeneration: generation,
      context,
      namespacePolicy: "unrestricted",
      readOnly: true,
    });
    this.snapshots.add(snapshot);
    return snapshot;
  }

  isExecutionCurrent(snapshot: ClusterExecutionSnapshot): boolean {
    return (
      this.snapshots.has(snapshot) &&
      this.isConnectionCurrent(snapshot.connectionGeneration) &&
      snapshot.selectionRevision === this.state.selection.selectionRevision &&
      snapshot.inventoryRevision === this.state.inventoryRevision &&
      this.state.resolution.status === "resolved" &&
      this.state.resolution.available.some((entry) => entry.name === snapshot.context)
    );
  }

  releaseExecution(snapshot: ClusterExecutionSnapshot): void {
    this.snapshots.delete(snapshot);
  }

  /** Release is idempotent and owned by the calling runtime/extension instance. */
  beginAgentWork(): () => void {
    this.currentWorkEpoch++;
    const token = Symbol();
    this.work.add(token);
    return () => {
      this.work.delete(token);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.snapshots.clear();
    this.markUnavailable("Kubernetes MCP closed; cluster scope unavailable.");
    this.listeners.clear();
    this.work.clear();
  }
}
