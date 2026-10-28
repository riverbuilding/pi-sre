import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { InvestigationController } from "../app/investigation-controller.js";
import { createInvestigationScopeDescription } from "../runtime/investigation-guidance.js";
import { formatClusterRule } from "../runtime/cluster-guidance.js";
import type { ClusterContextManager } from "../cluster/context-manager.js";
import {
  createClusterScopeDescription,
  createClusterStatusLines,
} from "../runtime/cluster-guidance.js";
import { CommandFeedback } from "./command-feedback.js";
import { registerClustersCommand } from "./cluster-command.js";

/** Each Pi extension instance owns its agent-work guard and lifecycle. */
export function registerClusterScope(
  pi: ExtensionAPI,
  manager: ClusterContextManager,
  feedback = new CommandFeedback(),
  investigation?: InvestigationController,
): void {
  let releaseWork: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastDescription: string | undefined;
  let clearDisplay: (() => void) | undefined;
  const description = () =>
    investigation?.currentScope().ok
      ? createInvestigationScopeDescription(investigation)
      : createClusterScopeDescription(manager.state);
  const customType = "pi-sre-cluster-scope";

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    clearDisplay?.();
    clearDisplay = () => ctx.ui.setWidget("pi-sre-scope", undefined);
    const previous = ctx.sessionManager
      .buildSessionProjection()
      .messages.findLast(
        (message) => message.role === "custom" && message.customType === customType,
      );
    lastDescription =
      previous?.role === "custom" && typeof previous.content === "string"
        ? previous.content
        : undefined;
    const update = () => {
      const effective = investigation?.currentScope();
      const state = effective?.ok && investigation ? investigation.clusterState() : manager.state;
      // Pi's footer truncates a single status line. A wrapping public widget
      // keeps READ ONLY on its own line while preserving Pi's model/session UI.
      ctx.ui.setWidget(
        "pi-sre-scope",
        [
          ...createClusterStatusLines(state),
          ...(effective?.ok
            ? [
                `Investigation: ${JSON.stringify(effective.scope.incidentId)} | scope ${effective.scope.scopeRevision}`,
                ...(JSON.stringify(effective.scope.rule) !==
                JSON.stringify(manager.state.selection.rule)
                  ? [
                      `Next investigation: ${formatClusterRule(manager.state.selection.rule)} (${manager.state.resolution.status === "resolved" ? `${manager.state.resolution.available.length} available, ${manager.state.resolution.unavailable.length} unavailable` : "blocked"})`,
                    ]
                  : []),
              ]
            : []),
        ],
        {
          placement: "belowEditor",
        },
      );
      const content = description();
      if (content === lastDescription) return;
      lastDescription = content;
      // Persist idle updates without starting a turn. During active work Pi queues
      // this as steering, after tool results, preserving request/history ordering.
      pi.sendMessage({ customType, content, display: false }, { deliverAs: "steer" });
    };
    unsubscribe = investigation ? investigation.subscribe(update) : manager.subscribe(update);
  });
  // Restore the current snapshot only if compaction/navigation removed it or a
  // resumed branch carries a different scope. Pi persists the returned message.
  pi.on("before_agent_start", (_event, ctx) => {
    const content = description();
    const previous = ctx.sessionManager
      .buildSessionProjection()
      .messages.findLast(
        (message) => message.role === "custom" && message.customType === customType,
      );
    if (previous?.role === "custom" && previous.content === content) return;
    lastDescription = content;
    return { message: { customType, content, display: false } };
  });
  pi.on("agent_start", () => {
    releaseWork ??= manager.beginAgentWork();
  });
  pi.on("agent_end", () => {
    releaseWork?.();
    releaseWork = undefined;
  });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    clearDisplay?.();
    clearDisplay = undefined;
    releaseWork?.();
    releaseWork = undefined;
  });
  registerClustersCommand(pi, manager, feedback, investigation);
}
