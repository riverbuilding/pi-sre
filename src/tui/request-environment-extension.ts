import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RequestMcpPublication } from "../app/request-mcp-controller.js";
import { createExactClusterRule } from "../cluster/context-resolver.js";
import {
  captureEnvironment,
  environmentChanges,
  environmentDescription,
  environmentLines,
  type EnvironmentFacts,
} from "../runtime/request-environment.js";
import { pickCurrentClusters } from "./current-cluster-picker.js";

export const requestEnvironmentType = "pi-sre-environment";

/** Current environment publisher. Install once; publish after tools, before the MCP ready barrier.
 * Owns only the latest comparison snapshot, never an event list or transcript-derived authority.
 */
export function registerRequestEnvironment(pi: ExtensionAPI) {
  let publication: RequestMcpPublication | undefined;
  let facts: EnvironmentFacts | undefined;
  let render: ((lines: string[] | undefined) => void) | undefined;
  let disposed = false;
  const refresh = () => {
    if (disposed || !publication) return;
    const captured = captureEnvironment(publication);
    // Keep only the last validated inventory for recovery comparison, never dispatch authority.
    const next =
      captured.status !== "ready" && facts ? { ...captured, inventory: facts.inventory } : captured;
    const changes = facts ? environmentChanges(facts, next) : [];
    const content = environmentDescription(next);
    const changed = !facts || changes.length > 0;
    render?.(environmentLines(next));
    if (changed)
      pi.sendMessage(
        {
          customType: requestEnvironmentType,
          content: [content, ...changes].join("\n"),
          display: false,
        },
        { deliverAs: "steer" },
      );
    facts = next;
  };
  const removers = [
    pi.on("session_start", (_event, ctx) => {
      if (disposed || render) return;
      render = (lines) => ctx.ui.setWidget("pi-sre-scope", lines, { placement: "belowEditor" });
      if (facts) render(environmentLines(facts));
    }),
    pi.on("context", (event) => {
      if (disposed || !facts) return;
      const content = environmentDescription(facts);
      const latest = event.messages.findLast(
        (message) => message.role === "custom" && message.customType === requestEnvironmentType,
      );
      if (
        latest?.role === "custom" &&
        typeof latest.content === "string" &&
        (latest.content === content || latest.content.startsWith(content + "\n"))
      )
        return;
      return {
        messages: [
          ...event.messages,
          {
            role: "custom",
            customType: requestEnvironmentType,
            content,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    }),
    pi.on("session_shutdown", () => dispose()),
  ];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const remove of removers) remove();
    render?.(undefined);
    render = undefined;
  };
  pi.registerCommand("clusters", {
    description:
      "Select current Kubernetes contexts; --all selects live *; --status shows membership",
    handler: async (args, ctx) => {
      if (disposed) return;
      if (args === "--status") {
        if (facts) ctx.ui.notify(environmentLines(facts, true).join("\n"), "info");
        else ctx.ui.notify("MCP unavailable; selection not initialized.", "warning");
        return;
      }
      const selection = publication?.selection;
      if (!selection) {
        ctx.ui.notify("MCP inventory not initialized; use /mcp_restart.", "warning");
        return;
      }
      try {
        if (!args)
          await pickCurrentClusters(ctx.ui, selection, () => {
            if (disposed || publication?.selection !== selection)
              throw new Error("Selection closed.");
          });
        else if (args === "--all") selection.select({ kind: "all" });
        else if (args.startsWith("--")) {
          ctx.ui.notify("Usage: /clusters [<exact-name> | --all | --status]", "warning");
          return;
        } else selection.select(createExactClusterRule([args]));
        if (disposed) return;
        refresh();
      } catch (error) {
        // Picker and selection errors may contain external identities; do not forward them.
        ctx.ui.notify("Selection refused or picker unavailable; reopen /clusters.", "warning");
        if (!(error instanceof Error)) throw error;
      }
    },
  });
  return {
    publish(state: RequestMcpPublication): void {
      if (disposed) throw new Error("Environment publisher is closed.");
      publication = state;
      refresh();
    },
    refresh,
    dispose,
  };
}
