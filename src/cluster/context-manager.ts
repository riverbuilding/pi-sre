import type { ClusterContext } from "./cluster-context.js";
import type { ClusterContextRegistry } from "./context-registry.js";
import {
  createExactClusterRule,
  createStartupSelection,
  resolveClusterSelection,
  type ClusterResolution,
  type ClusterScopeRule,
  type ClusterSelection,
  type ClusterSelectionSource,
  type StartupClusterIntent,
} from "./context-resolver.js";

export interface ClusterScopeSnapshot {
  readonly context: string;
  readonly namespace: "*";
  readonly readOnly: true;
  readonly source: ClusterSelectionSource;
  readonly connectionGeneration: number;
  readonly inventoryRevision: number;
  readonly selectionRevision: number;
}

interface StateRevision {
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
    | {
        readonly status: "bound";
        readonly registry: ClusterContextRegistry;
        readonly context: ClusterContext;
        readonly scope: ClusterScopeSnapshot;
        readonly message: string;
      }
  );

const inventoryUnavailable: ClusterResolution = Object.freeze({
  status: "blocked",
  reason: "inventory-unavailable",
});

/** Session-owned rule and resolution, independent of transcript and MCP default metadata. */
export class ClusterContextManager {
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
    for (const listener of this.listeners) listener(this.currentContextState);
  }

  beginConnection(): number {
    const connectionGeneration = this.state.connectionGeneration + 1;
    this.publishCurrentContextState({
      status: "connecting",
      inventory: this.state.inventory,
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
    this.installResolution(registry, this.state.selection, this.state.inventoryRevision + 1);
  }

  private installResolution(
    registry: ClusterContextRegistry,
    selection: ClusterSelection,
    inventoryRevision: number,
  ): void {
    const resolution = resolveClusterSelection(registry, selection.rule, this.validatedSelection);
    if (resolution.status === "resolved") this.validatedSelection = true;
    const common = {
      inventory: registry,
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
    const [context] = resolution.available;
    if (context && resolution.available.length === 1) {
      // Singleton projection for the existing bridge; multi-target routing lands in Slice 2.
      const scope: ClusterScopeSnapshot = Object.freeze({
        context: context.name,
        namespace: "*",
        readOnly: true,
        source: selection.source,
        connectionGeneration: common.connectionGeneration,
        inventoryRevision,
        selectionRevision: selection.selectionRevision,
      });
      this.publishCurrentContextState({
        ...common,
        status: "bound",
        context,
        scope,
        message: "Cluster scope selected (authentication and authorization are not verified).",
      });
      return;
    }
    this.publishCurrentContextState({
      ...common,
      status: registry.contexts.length === 0 ? "not-configured" : "resolved",
      message: context
        ? "Cluster rule resolved; multi-target diagnostic routing awaits Phase 3 Slice 2."
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

  captureScope(): ClusterScopeSnapshot | undefined {
    return this.state.status === "bound" ? this.state.scope : undefined;
  }

  isCurrent(scope: ClusterScopeSnapshot): boolean {
    return this.state.status === "bound" && this.state.scope === scope;
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
    this.markUnavailable("Kubernetes MCP closed; cluster scope unavailable.");
    this.listeners.clear();
    this.work.clear();
  }
}
