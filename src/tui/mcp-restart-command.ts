import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RequestMcpController } from "../app/request-mcp-controller.js";
import { captureEnvironment, environmentDescription } from "../runtime/request-environment.js";
import { CommandFeedback } from "./command-feedback.js";

export function registerMcpRecovery(
  pi: ExtensionAPI,
  controller: RequestMcpController,
  feedback = new CommandFeedback(),
): void {
  pi.registerCommand("mcp_restart", {
    description: "Retry Kubernetes MCP access (--force replaces a healthy connection)",
    handler: async (args, ctx) => {
      const argument = args.trim();
      const report = feedback.begin("/mcp_restart", ctx.ui);
      if (argument !== "" && argument !== "--force") {
        report("Usage: /mcp_restart [--force]", "warning");
        return;
      }
      report(argument === "--force" ? "Replacing MCP connection…" : "Checking MCP access…");
      try {
        await controller.restart(argument === "--force");
        const state = controller.snapshot;
        report(
          `${state.message}\n${environmentDescription(captureEnvironment(state))}`,
          state.status === "ready" ? "info" : "warning",
        );
      } catch {
        report("MCP recovery failed. Check configuration and retry /mcp_restart.", "error");
      }
    },
  });
}
