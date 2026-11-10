import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import type { RequestMcpController } from "../app/request-mcp-controller.js";
import type { SreConfig } from "../config/config.js";
import { registerRequestExtension } from "../tui/request-extension.js";
import { createSreResourceLoaderOptions } from "./resource-loader.js";
import { installRequestExecution } from "./request-execution-adapter.js";
import { SreRuntime } from "./sre-runtime.js";

/** Pi uses this for TUI assets and managed helpers outside its session factory. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export async function createSreRuntime(
  config: SreConfig,
  mcpController?: RequestMcpController,
  requestApplicationShutdown?: () => Promise<void>,
): Promise<SreRuntime> {
  const appHome = config.paths.home;
  let extension: ReturnType<typeof registerRequestExtension> | undefined;
  let notify: ((message: string) => void) | undefined;
  let initialized = false;
  const services = await createAgentSessionServices({
    cwd: appHome,
    agentDir: appHome,
    resourceLoaderOptions: {
      ...createSreResourceLoaderOptions(),
      extensionFactories: [
        {
          name: "pi-sre",
          hidden: true,
          factory: (pi) => {
            if (initialized) {
              throw new Error("Pi SRE extensions initialize once; restart the application.");
            }

            initialized = true;
            extension = registerRequestExtension(pi, {
              controller: mcpController,
              currentRequest: () => execution.current,
              resultPolicy: config.results,
              setNotifier: (callback) => {
                notify = callback;
              },
            });
          },
        },
      ],
    },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(appHome, config.paths.sessions),
    noTools: "builtin",
    excludeTools: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
  });
  const execution = installRequestExecution(result.session, config.execution, (message) =>
    notify?.(message),
  );
  // No application factory/recovery path for replacing this session. Pi entry-point
  // visibility/restrictions remain a separately tracked product gap.
  const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
    throw new Error("Pi SRE uses one session; restart the application to start another.");
  };
  return new SreRuntime(
    { ...result, services, diagnostics: services.diagnostics },
    createRuntime,
    (state) => extension?.publish(state),
    async () => {
      extension?.dispose();
      await execution.dispose();
    },
    requestApplicationShutdown,
  );
}
