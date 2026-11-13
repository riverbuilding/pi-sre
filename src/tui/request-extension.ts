import { createTerminalApprovalChannel } from "./controlled-approval-channel.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { RequestMcpController, RequestMcpPublication } from "../app/request-mcp-controller.js";
import type { RequestExecution } from "../execution/request-execution.js";
import { createRequestMcpToolBridge } from "../mcp/request-tool-bridge.js";
import type { ResultPolicy } from "../config/schema.js";
import { registerMcpRecovery } from "./mcp-restart-command.js";
import { registerRequestEnvironment } from "./request-environment-extension.js";

/** One startup registration. MCP publications replace tools, never this extension. */
export function registerRequestExtension(
  pi: ExtensionAPI,
  options: {
    controller: RequestMcpController | undefined;
    currentRequest: () => RequestExecution | undefined;
    resultPolicy: ResultPolicy;
    setNotifier: (notify: (message: string) => void) => void;
  },
) {
  const environment = registerRequestEnvironment(pi);
  const registered = new Map<string, ToolDefinition>();
  let disposed = false;
  let started = false;
  const installTools = (state: RequestMcpPublication) => {
    const names = new Set(state.tools.map((tool) => tool.name));
    for (const [name, tool] of registered) {
      if (!names.has(name)) {
        pi.registerTool({ ...tool, exposure: "hidden" });
      }
    }
    for (const descriptor of state.tools) {
      const tool = createRequestMcpToolBridge(
        descriptor,
        state,
        options.currentRequest,
        options.resultPolicy,
      );
      pi.registerTool(tool);
      registered.set(tool.name, tool);
    }
  };
  const publish = (state: RequestMcpPublication) => {
    if (disposed) {
      return;
    }

    installTools(state);
    // Both complete before the controller's ready barrier opens dispatch.
    environment.publish(state);
  };
  if (options.controller) {
    // Initial tools precede Pi binding; environment messages require its live runner.
    installTools(options.controller.snapshot);
    registerMcpRecovery(pi, options.controller);
  }
  const removers = [
    pi.on("session_start", (_event, ctx) => {
      if (started || disposed) {
        return;
      }

      started = true;
      options.controller?.approvals.setChannel(createTerminalApprovalChannel(ctx));
      options.setNotifier((message) => ctx.ui.notify(message, "warning"));
      if (options.controller) {
        publish(options.controller.snapshot);
      }
    }),
    pi.on("user_bash", () => ({
      result: {
        output: "Shell commands are unavailable in Pi SRE.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    })),
  ];
  return {
    publish,
    dispose(): void {
      disposed = true;
      options.controller?.approvals.setChannel(undefined);
      environment.dispose();
      for (const remove of removers) {
        remove();
      }
      registered.clear();
    },
  };
}
