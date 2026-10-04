import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { SreConfig } from "../config/config.js";
import { createSreResourceLoaderOptions } from "./resource-loader.js";

/** Pi uses this for TUI assets and managed helpers outside its session factory. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export async function createSreRuntime(
  config: SreConfig,
  customTools: readonly ToolDefinition[] = [],
): Promise<AgentSessionRuntime> {
  const appHome = config.paths.home;
  const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
    if (options.cwd !== appHome || options.agentDir !== appHome) {
      throw new Error("Pi SRE sessions must remain inside the Pi SRE application home.");
    }

    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      resourceLoaderOptions: {
        ...createSreResourceLoaderOptions(),
        extensionFactories: [
          {
            name: "pi-sre-read-only-shell-guard",
            hidden: true,
            factory: (pi) => {
              pi.on("user_bash", () => ({
                result: {
                  output: "Shell commands are unavailable in Pi SRE read-only mode.",
                  exitCode: 1,
                  cancelled: false,
                  truncated: false,
                },
              }));
            },
          },
        ],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
      noTools: "builtin",
      customTools: [...customTools],
      excludeTools: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  return createAgentSessionRuntime(createRuntime, {
    cwd: appHome,
    agentDir: appHome,
    sessionManager: SessionManager.create(appHome, config.paths.sessions),
  });
}
