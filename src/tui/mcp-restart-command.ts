import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpController } from "../app/mcp-controller.js";

/** Pi's public registerTool refreshes the registry; hidden tools are unreachable. */
export function registerMcpRecovery(pi: ExtensionAPI, controller: McpController): void {
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
  pi.on("session_shutdown", unsubscribe);
  pi.registerCommand("mcp_restart", {
    description: "Retry Kubernetes MCP access (--force replaces a healthy connection)",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument !== "" && argument !== "--force") {
        ctx.ui.notify("Usage: /mcp_restart [--force]", "warning");
        return;
      }
      if (controller.snapshot.status !== "ready" || argument === "--force") {
        ctx.ui.notify("Kubernetes MCP connecting…", "info");
      }
      const state = await controller.restart(argument === "--force");
      ctx.ui.notify(state.message, state.status === "ready" ? "info" : "warning");
    },
  });
}
