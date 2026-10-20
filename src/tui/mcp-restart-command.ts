import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CommandFeedback } from "./command-feedback.js";
import { createClusterScopeDescription } from "../runtime/cluster-guidance.js";
import type { McpController } from "../app/mcp-controller.js";

/** Pi's public registerTool refreshes the registry; hidden tools are unreachable. */
export function registerMcpRecovery(
  pi: ExtensionAPI,
  controller: McpController,
  feedback = new CommandFeedback(),
): void {
  const registered = new Map<string, ToolDefinition>();
  const unsubscribe = controller.subscribe(({ tools }) => {
    const names = new Set(tools.map((tool) => tool.name));
    for (const [name, tool] of registered) {
      if (!names.has(name)) pi.registerTool({ ...tool, exposure: "hidden" });
    }
    for (const tool of tools) {
      registered.set(tool.name, tool);
      pi.registerTool(tool);
    }
  });
  pi.on("session_shutdown", () => {
    unsubscribe();
  });
  pi.registerCommand("mcp_restart", {
    description: "Retry Kubernetes MCP access (--force replaces a healthy connection)",
    handler: async (args, ctx) => {
      const argument = args.trim();
      const report = feedback.begin(
        argument === "--force" ? "/mcp_restart --force" : "/mcp_restart",
        ctx.ui,
      );
      if (argument !== "" && argument !== "--force") {
        report("Usage: /mcp_restart [--force]", "warning");
        return;
      }
      const disposition = controller.restartDisposition(argument === "--force");
      if (disposition === "closed") {
        report("Restart refused; MCP controller is shutting down or closed.", "warning");
        return;
      }
      if (disposition !== "retained") {
        report(
          disposition === "shared"
            ? "Joining MCP restart already in progress…"
            : disposition === "forced"
              ? "Replacing MCP connection (--force)…"
              : "Attempting MCP recovery…",
        );
      }
      try {
        const state = await controller.restart(argument === "--force");
        const scope = controller.clusterContext.state;
        const prefix =
          state.status !== "ready"
            ? "Restart failed or interrupted; MCP unavailable."
            : disposition === "retained"
              ? "MCP already healthy; existing connection retained."
              : "Restart completed; MCP transport ready.";
        report(
          `${prefix} ${state.message}\n${createClusterScopeDescription(scope)}`,
          state.status === "ready" &&
            scope.status === "resolved" &&
            scope.resolution.status === "resolved" &&
            scope.resolution.available.length > 0
            ? "info"
            : "warning",
        );
      } catch {
        // Unexpected failures must be acknowledged without exposing transport diagnostics.
        report(
          "Restart failed unexpectedly. Check MCP configuration and retry /mcp_restart.",
          "error",
        );
      }
    },
  });
}
