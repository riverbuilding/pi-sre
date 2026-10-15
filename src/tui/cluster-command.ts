import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ClusterContextManager } from "../cluster/context-manager.js";
import {
  createClusterScopeDescription,
  createClusterStatusLines,
} from "../runtime/cluster-guidance.js";

/** The manager remains authoritative, including after an awaited picker. */
export function registerClusterCommand(pi: ExtensionAPI, manager: ClusterContextManager): void {
  pi.registerCommand("cluster", {
    description:
      "Select an exact Kubernetes context (no arguments opens the picker; --status shows scope)",
    handler: async (args, ctx) => {
      if (args === "--status") {
        ctx.ui.notify(
          [
            ...createClusterStatusLines(manager.state),
            createClusterScopeDescription(manager.state),
            "Namespace * means no application restriction; each tool uses its own namespace policy.",
            "Selection does not verify Kubernetes authentication or authorization.",
          ].join("\n"),
          "info",
        );
        return;
      }
      if (!ctx.isIdle() || manager.isAgentActive) {
        ctx.ui.notify(
          "Wait for or cancel the active agent turn before selecting a cluster.",
          "warning",
        );
        return;
      }
      const state = manager.state;
      if (!("registry" in state)) {
        ctx.ui.notify(`${state.message} A current MCP context registry is required.`, "warning");
        return;
      }
      if (state.registry.contexts.length === 0) {
        ctx.ui.notify(state.message, "warning");
        return;
      }
      const name =
        args === ""
          ? await ctx.ui.select(
              `Cluster (current: ${state.status === "bound" ? JSON.stringify(state.context.name) : "NOT SELECTED"})`,
              state.registry.contexts.map((context) => context.name),
            )
          : args;
      if (name === undefined) return;
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for or cancel the active agent turn before selecting a cluster.",
          "warning",
        );
        return;
      }
      try {
        manager.select(name, state.registryRevision);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        ctx.ui.notify(error.message, "warning");
        return;
      }
      const selected = manager.captureScope();
      if (selected) {
        ctx.ui.notify(
          `Cluster: ${JSON.stringify(selected.context)} (${selected.source}) | Namespace: * | READ ONLY. Selection does not verify Kubernetes authentication or authorization.`,
          "info",
        );
      }
    },
  });
}
