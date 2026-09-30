import { mkdir } from "node:fs/promises";

import { InteractiveMode, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import type { SreConfig } from "../config/config.js";
import { ManagedMcpConnection, McpStartupError, type McpConnection } from "../mcp/connection.js";
import { createSreRuntime, PI_AGENT_DIR_ENV } from "../runtime/pi-runtime.js";

export class SreApplication {
  private runtime: AgentSessionRuntime | undefined;
  private mcp: McpConnection | undefined;
  private closePromise: Promise<void> | undefined;
  private started = false;
  private previousPiAgentDir: string | undefined;

  constructor(private readonly config: SreConfig) {}

  async run(): Promise<void> {
    if (this.started || this.closePromise) throw new Error("Pi SRE application has already run.");
    this.started = true;
    this.previousPiAgentDir = process.env[PI_AGENT_DIR_ENV];
    process.env[PI_AGENT_DIR_ENV] = this.config.paths.home;

    try {
      await mkdir(this.config.paths.home, { recursive: true, mode: 0o700 });
      this.runtime = await createSreRuntime(this.config);
      let startupDiagnostic: string | undefined;
      try {
        this.mcp = await ManagedMcpConnection.connect(this.config.kubernetes.mcp);
      } catch (error) {
        startupDiagnostic =
          error instanceof McpStartupError
            ? error.diagnostic
            : "Kubernetes MCP connection failed during startup.";
      }
      const mode = new InteractiveMode(this.runtime, {
        ...(startupDiagnostic
          ? {
              startupDiagnostics: [
                {
                  type: "warning",
                  message: `${startupDiagnostic} Kubernetes tools are unavailable. Check the MCP configuration and restart pi-sre.`,
                },
              ],
            }
          : {}),
      });
      await mode.run();
    } finally {
      await this.close();
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        try {
          await this.mcp?.close();
        } finally {
          try {
            await this.runtime?.dispose();
          } finally {
            if (this.started) {
              if (this.previousPiAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
              else process.env[PI_AGENT_DIR_ENV] = this.previousPiAgentDir;
            }
          }
        }
      })();
    }
    return this.closePromise;
  }
}
