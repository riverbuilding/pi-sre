import type { ClusterContext } from "./cluster-context.js";
import type { ClusterContextRegistry } from "./context-registry.js";

export interface StartupClusterIntent {
  readonly cluster?: string;
}

export type StartupSelectionSource = "cli" | "config" | "mcp-default";

export type StartupContextResolution =
  | {
      readonly status: "bound";
      readonly context: ClusterContext;
      readonly source: StartupSelectionSource;
      readonly requestedName: string;
    }
  | {
      readonly status: "selection-error";
      readonly source: "cli" | "config";
      readonly requestedName: string;
      readonly message: string;
    }
  | {
      readonly status: "unbound";
      readonly reason: "not-selected" | "not-configured";
    };

/** Resolve only a complete validated inventory; unavailable MCP is not an empty registry. */
export function resolveStartupContext(
  registry: ClusterContextRegistry,
  intent: StartupClusterIntent = {},
  configuredDefault?: string,
): StartupContextResolution {
  const requestedName = intent.cluster ?? configuredDefault;
  if (requestedName !== undefined) {
    const source = intent.cluster !== undefined ? "cli" : "config";
    const context = registry.get(requestedName);
    if (context) return { status: "bound", context, source, requestedName };
    return {
      status: "selection-error",
      source,
      requestedName,
      message:
        source === "cli"
          ? "The --cluster selection is not an available MCP context. Use /cluster to select an exact context or restart with --cluster <name>."
          : "kubernetes.defaultCluster is not an available MCP context. Correct the configuration or use /cluster to select an exact context.",
    };
  }
  if (registry.defaultContext) {
    return {
      status: "bound",
      context: registry.defaultContext,
      source: "mcp-default",
      requestedName: registry.defaultContext.name,
    };
  }
  return {
    status: "unbound",
    reason: registry.contexts.length === 0 ? "not-configured" : "not-selected",
  };
}
