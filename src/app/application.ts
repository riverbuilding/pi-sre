import { mkdir } from "node:fs/promises";

import {
  InteractiveMode,
  type AgentSessionRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { SreConfig } from "../config/config.js";
import { ManagedMcpConnection, McpStartupError, type McpConnection } from "../mcp/connection.js";
import { discoverMcpTools, type ToolDiscoveryReport } from "../mcp/tool-discovery.js";
import { createMcpToolBridge, McpToolBridgeError } from "../mcp/tool-bridge.js";
import { createSreRuntime, PI_AGENT_DIR_ENV } from "../runtime/pi-runtime.js";

export class SreApplication {
  private runtime: AgentSessionRuntime | undefined;
  private mcp: McpConnection | undefined;
  private discoveryReport: ToolDiscoveryReport | undefined;
  private closePromise: Promise<void> | undefined;
  private started = false;
  private previousPiAgentDir: string | undefined;

  constructor(private readonly config: SreConfig) {}

  get toolDiscoveryReport(): ToolDiscoveryReport | undefined {
    return this.discoveryReport;
  }

  async run(): Promise<void> {
    if (this.started || this.closePromise) throw new Error("Pi SRE application has already run.");
    this.started = true;
    this.previousPiAgentDir = process.env[PI_AGENT_DIR_ENV];
    process.env[PI_AGENT_DIR_ENV] = this.config.paths.home;

    try {
      await mkdir(this.config.paths.home, { recursive: true, mode: 0o700 });
      let customTools: ToolDefinition[] = [];
      const startupDiagnostics: { type: "info" | "warning"; message: string }[] = [];
      try {
        const mcp = await ManagedMcpConnection.connect(this.config.kubernetes.mcp);
        this.mcp = mcp;
        this.discoveryReport = await discoverMcpTools(mcp);
        customTools = this.discoveryReport.exposed.map((tool) =>
          createMcpToolBridge(tool, mcp, this.config.results),
        );
        const counts = { exposed: 0, deferred: 0, rejected: 0 };
        for (const decision of this.discoveryReport.decisions) counts[decision.status]++;
        startupDiagnostics.push({
          type: "info",
          message: `Kubernetes MCP discovery: ${counts.exposed} approved, ${counts.deferred} deferred, ${counts.rejected} rejected. ${customTools.length} read-only tools registered.`,
        });
      } catch (error) {
        this.discoveryReport = undefined;
        customTools = [];
        const startupDiagnostic =
          error instanceof McpStartupError
            ? error.diagnostic
            : error instanceof McpToolBridgeError
              ? error.message
              : this.mcp
                ? "Kubernetes MCP tool discovery failed."
                : "Kubernetes MCP connection failed during startup.";
        startupDiagnostics.push({
          type: "warning",
          message: `${startupDiagnostic} Kubernetes tools are unavailable. Check the MCP configuration and restart pi-sre.`,
        });
      }
      this.runtime = await createSreRuntime(this.config, customTools);
      const mode = new InteractiveMode(this.runtime, {
        startupDiagnostics,
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
