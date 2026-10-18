import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ClusterContextManager } from "../cluster/context-manager.js";
import {
  createClusterScopeDescription,
  createClusterStatusLines,
} from "../runtime/cluster-guidance.js";

import { CommandFeedback } from "./command-feedback.js";

/** The manager remains authoritative, including after an awaited picker. */
export function registerClusterCommand(
  pi: ExtensionAPI,
  manager: ClusterContextManager,
  feedback = new CommandFeedback(),
): void {
  pi.registerCommand("cluster", {
    description:
      "Select an exact Kubernetes context (no arguments opens the picker; --status shows scope)",
    handler: async (args, ctx) => {
      const report = feedback.begin(args === "--status" ? "/cluster --status" : "/cluster", ctx.ui);
      if (args === "--status") {
        report(
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
        report("Wait for or cancel the active agent turn before selecting a cluster.", "warning");
        return;
      }
      const state = manager.state;
      if (!("registry" in state)) {
        report(`${state.message} A current MCP context registry is required.`, "warning");
        return;
      }
      if (state.registry.contexts.length === 0) {
        report(state.message, "warning");
        return;
      }
      if (args === "") report("Opening cluster picker…");
      let name: string | undefined;
      try {
        name =
          args === ""
            ? await ctx.ui.select(
                `Cluster (current: ${state.status === "bound" ? JSON.stringify(state.context.name) : "NOT SELECTED"})`,
                state.registry.contexts.map((context) => context.name),
              )
            : args;
      } catch {
        report("Cluster picker failed; no selection applied. Retry /cluster.", "error");
        return;
      }
      if (name === undefined) {
        report("Selection cancelled; cluster unchanged.");
        return;
      }
      if (!ctx.isIdle()) {
        report("Wait for or cancel the active agent turn before selecting a cluster.", "warning");
        return;
      }
      try {
        manager.select(name, state.registryRevision);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        report(`Selection refused: ${error.message}`, "warning");
        return;
      }
      const selected = manager.captureScope();
      if (selected) {
        report(
          `${state.status === "bound" && state.context.name === selected.context ? "Already selected" : "Selection changed"}. Cluster: ${JSON.stringify(selected.context)} (${selected.source}) | Namespace: * | READ ONLY. Selection does not verify Kubernetes authentication or authorization.`,
          "info",
        );
      }
    },
  });
}
