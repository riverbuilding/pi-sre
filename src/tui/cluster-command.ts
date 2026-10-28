import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { InvestigationController } from "../app/investigation-controller.js";
import { createInvestigationScopeDescription } from "../runtime/investigation-guidance.js";
import type { ClusterContextManager } from "../cluster/context-manager.js";
import { createExactClusterRule, type ClusterScopeRule } from "../cluster/context-resolver.js";
import {
  createClusterScopeDescription,
  createClusterStatusLines,
  formatClusterRule,
} from "../runtime/cluster-guidance.js";
import { ClusterPickerError } from "./cluster-picker.js";
import { showClusterPicker } from "./cluster-picker-dialog.js";
import { showContextsDialog } from "./contexts-dialog.js";
import { CommandFeedback } from "./command-feedback.js";

/** The manager remains authoritative; staged drafts grant no execution permission. */
export function registerClustersCommand(
  pi: ExtensionAPI,
  manager: ClusterContextManager,
  feedback = new CommandFeedback(),
  investigation?: InvestigationController,
): void {
  let lifecycleRevision = 0;
  let attached = true;
  pi.on("session_start", () => {
    attached = true;
    lifecycleRevision++;
  });
  pi.on("session_shutdown", () => {
    attached = false;
    lifecycleRevision++;
  });
  pi.registerCommand("clusters", {
    description:
      "Select Kubernetes contexts (picker; --all selects live *; --status inspects scope)",
    handler: async (args, ctx) => {
      if (!attached) return;
      const report = feedback.begin(
        args === "--status" ? "/clusters --status" : "/clusters",
        ctx.ui,
      );
      if (args === "--status") {
        const effective = investigation?.currentScope();
        const scopeState =
          effective?.ok && investigation ? investigation.clusterState() : manager.state;
        report(
          [
            ...createClusterStatusLines(scopeState),
            effective?.ok && investigation
              ? createInvestigationScopeDescription(investigation)
              : createClusterScopeDescription(manager.state),
            "Namespace * means no application restriction; each tool uses its own namespace policy.",
            "Selection does not verify Kubernetes authentication or authorization.",
          ].join("\n"),
          "info",
        );
        if (ctx.hasUI) {
          const state = manager.state;
          const lifecycle = lifecycleRevision;
          try {
            await showContextsDialog(ctx.ui, scopeState, () => {
              const current = investigation?.currentScope();
              return (
                attached &&
                lifecycle === lifecycleRevision &&
                state === manager.state &&
                (effective?.ok
                  ? current?.ok === true && current.scope === effective.scope
                  : !current?.ok)
              );
            });
          } catch {
            report("Cluster status dialog unavailable; scope summary is shown above.", "warning");
          }
        }
        return;
      }
      if (args.startsWith("--") && args !== "--all") {
        report(
          "Usage: /clusters [<exact-name> | --all | --status]; no arguments opens the multi-selection picker.",
          "warning",
        );
        return;
      }
      if (!ctx.isIdle() || manager.isAgentActive) {
        report("Wait for or cancel the active agent turn before selecting clusters.", "warning");
        return;
      }
      const state = manager.state;
      if (!("registry" in state) || state.registry.contexts.length === 0) {
        report(`${state.message} A current nonempty MCP context registry is required.`, "warning");
        return;
      }
      const workEpoch = manager.workEpoch;
      const lifecycle = lifecycleRevision;
      const assertCurrent = (): void => {
        if (!attached || lifecycle !== lifecycleRevision) {
          throw new Error("Cluster context state changed during selection. Retry /clusters.");
        }
        if (!ctx.isIdle() || manager.isAgentActive) {
          throw new Error("Wait for or cancel the active agent turn before selecting clusters.");
        }
        if (state !== manager.state || workEpoch !== manager.workEpoch) {
          throw new Error("Cluster context state changed during selection. Retry /clusters.");
        }
      };
      let selectedRule: ClusterScopeRule | undefined;
      try {
        if (args === "") {
          report("Opening clusters picker…");
          selectedRule = await showClusterPicker(
            ctx.ui,
            state.registry.contexts.map((context) => context.name),
            state.selection.rule,
            assertCurrent,
          );
        } else {
          selectedRule = args === "--all" ? { kind: "all" } : createExactClusterRule([args]);
        }
        assertCurrent();
        if (!selectedRule) {
          report("Selection cancelled; clusters unchanged.");
          return;
        }
        manager.selectRule(
          selectedRule,
          state.inventoryRevision,
          state.selection.selectionRevision,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (error instanceof ClusterPickerError) report(error.message, "error");
        else report(`Selection refused: ${error.message}`, "warning");
        return;
      }
      const selected = manager.state.selection;
      report(
        `${state.selection.selectionRevision === selected.selectionRevision ? "Already selected" : "Selection changed"}. Clusters: ${formatClusterRule(selected.rule)} (${selected.source}) | Namespace: * | READ ONLY. Selection does not verify Kubernetes authentication or authorization.${investigation?.currentScope().ok ? " This is the next investigation selection; the current incident keeps its rule." : ""}`,
        "info",
      );
    },
  });
}
