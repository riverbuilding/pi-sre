import type { ClusterContext } from "./cluster-context.js";
import type { ClusterContextRegistry } from "./context-registry.js";
import {
  resolveStartupContext,
  type StartupClusterIntent,
  type StartupSelectionSource,
} from "./context-resolver.js";

export type ClusterSelectionSource = StartupSelectionSource | "user";

export interface ClusterScopeSnapshot {
  readonly context: string;
  readonly namespace: "*";
  readonly readOnly: true;
  readonly source: ClusterSelectionSource;
  readonly connectionGeneration: number;
  readonly registryRevision: number;
}

interface StateRevision {
  readonly connectionGeneration: number;
  readonly registryRevision: number;
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
        readonly status: "not-configured" | "unbound";
        readonly registry: ClusterContextRegistry;
        readonly message: string;
      }
    | {
        readonly status: "selection-error";
        readonly registry: ClusterContextRegistry;
        readonly requestedName: string;
        readonly source: ClusterSelectionSource;
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

/** Session-owned authority; neither transcript text nor Pi conversation identity selects scope. */
export class ClusterContextManager {
  private readonly intent: StartupClusterIntent;
  private readonly listeners = new Set<(state: ClusterContextState) => void>();
  private readonly work = new Set<symbol>();
  private resolvedStartup = false;
  private selectionSource:
    { readonly name: string; readonly source: ClusterSelectionSource } | undefined;
  private currentContextState: ClusterContextState = Object.freeze({
    status: "unavailable",
    connectionGeneration: 0,
    registryRevision: 0,
    message: "Kubernetes MCP is unavailable. Use /mcp_restart to retry.",
  });

  constructor(intent: StartupClusterIntent = {}) {
    this.intent = Object.freeze({ ...intent });
  }

  get state(): ClusterContextState {
    return this.currentContextState;
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
    const connectionGeneration = this.currentContextState.connectionGeneration + 1;
    this.publishCurrentContextState({
      status: "connecting",
      connectionGeneration,
      registryRevision: this.currentContextState.registryRevision,
      message: "Kubernetes MCP connecting; cluster scope unavailable.",
    });
    return connectionGeneration;
  }

  markUnavailable(message: string): void {
    this.publishCurrentContextState({
      status: "unavailable",
      connectionGeneration: this.currentContextState.connectionGeneration,
      registryRevision: this.currentContextState.registryRevision,
      message,
    });
  }

  failEnumeration(
    generation: number,
    reason: "incompatible-tool" | "invalid-response" | "tool-error",
    message: string,
  ): void {
    if (
      generation !== this.currentContextState.connectionGeneration ||
      this.currentContextState.status !== "connecting"
    )
      return;
    this.publishCurrentContextState({
      ...this.currentContextState,
      status: "enumeration-failed",
      reason,
      message,
    });
  }

  acceptRegistry(
    generation: number,
    registry: ClusterContextRegistry,
    configuredDefault?: string,
  ): void {
    if (
      generation !== this.currentContextState.connectionGeneration ||
      this.currentContextState.status !== "connecting"
    )
      return;
    const revision: StateRevision = {
      connectionGeneration: generation,
      registryRevision: this.currentContextState.registryRevision + 1,
    };
    if (!this.resolvedStartup) {
      const resolution = resolveStartupContext(registry, this.intent, configuredDefault);
      this.resolvedStartup = true;
      if (resolution.status !== "unbound") {
        this.selectionSource = { name: resolution.requestedName, source: resolution.source };
      }
      if (resolution.status === "selection-error") {
        this.publishCurrentContextState({ ...revision, registry, ...resolution });
        return;
      }
    }
    if (this.selectionSource) {
      const context = registry.get(this.selectionSource.name);
      if (context) {
        const scope: ClusterScopeSnapshot = Object.freeze({
          context: context.name,
          namespace: "*",
          readOnly: true,
          source: this.selectionSource.source,
          connectionGeneration: generation,
          registryRevision: revision.registryRevision,
        });
        this.publishCurrentContextState({
          ...revision,
          registry,
          status: "bound",
          context,
          scope,
          message: "Cluster scope selected (authentication and authorization are not verified).",
        });
      } else {
        this.publishCurrentContextState({
          ...revision,
          registry,
          status: "selection-error",
          requestedName: this.selectionSource.name,
          source: this.selectionSource.source,
          message:
            "The selected context is unavailable. Use /cluster to select an exact context; no fallback was applied.",
        });
      }
      return;
    }
    this.publishCurrentContextState({
      ...revision,
      registry,
      status: registry.contexts.length ? "unbound" : "not-configured",
      message: registry.contexts.length
        ? "Cluster NOT SELECTED. Use /cluster or --cluster <name>."
        : "Cluster NOT CONFIGURED. Configure MCP Kubernetes access and use /mcp_restart.",
    });
  }

  /** Synchronous commit; optional revision prevents stale interactive selections. */
  select(name: string, expectedRevision = this.currentContextState.registryRevision): void {
    if (this.isAgentActive)
      throw new Error("Wait for or cancel the active agent turn before selecting a cluster.");
    const state = this.currentContextState;
    if (!("registry" in state)) {
      throw new Error(
        "A current MCP context registry is required. Use /mcp_restart and retry /cluster.",
      );
    }
    if (expectedRevision !== state.registryRevision) {
      throw new Error("Cluster context state changed during selection. Retry /cluster.");
    }
    const context = state.registry.get(name);
    if (!context)
      throw new Error("Unknown MCP context. Use /cluster to select an exact available name.");
    if (state.status === "bound" && state.context.name === name) return;
    this.selectionSource = { name, source: "user" };
    const registryRevision = state.registryRevision + 1;
    const scope: ClusterScopeSnapshot = Object.freeze({
      context: name,
      namespace: "*",
      readOnly: true,
      source: "user",
      connectionGeneration: state.connectionGeneration,
      registryRevision,
    });
    this.publishCurrentContextState({
      connectionGeneration: state.connectionGeneration,
      registry: state.registry,
      status: "bound",
      context,
      registryRevision,
      scope,
      message: "Cluster scope selected (authentication and authorization are not verified).",
    });
  }

  captureScope(): ClusterScopeSnapshot | undefined {
    return this.currentContextState.status === "bound" ? this.currentContextState.scope : undefined;
  }

  isCurrent(scope: ClusterScopeSnapshot): boolean {
    return this.currentContextState.status === "bound" && this.currentContextState.scope === scope;
  }

  /** Release is idempotent and owned by the calling runtime/extension instance. */
  beginAgentWork(): () => void {
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
