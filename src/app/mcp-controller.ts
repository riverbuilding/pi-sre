import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { SreConfig } from "../config/config.js";
import { loadSreConfig, SreConfigError } from "../config/loader.js";
import { ManagedMcpConnection, McpStartupError, type McpConnection } from "../mcp/connection.js";
import { discoverMcpTools, type ToolDiscoveryReport } from "../mcp/tool-discovery.js";
import { createMcpToolBridge, McpToolBridgeError } from "../mcp/tool-bridge.js";

export interface McpControllerSnapshot {
  readonly status: "connecting" | "ready" | "unavailable";
  readonly message: string;
  readonly tools: readonly ToolDefinition[];
}

/** Owns connection generations; a captured tool can never cross to a replacement process. */
export class McpController {
  private readonly initialConfig: SreConfig;
  private readonly shutdown: AbortSignal;
  private readonly reloadConfig: () => Promise<SreConfig>;
  private connection: McpConnection | undefined;
  private connectionCancellation = new AbortController();
  private readonly calls = new Set<Promise<unknown>>();
  private readonly listeners = new Set<(state: McpControllerSnapshot) => void>();
  private pending: Promise<McpControllerSnapshot> | undefined;
  private controllerClosePromise: Promise<void> | undefined;
  private stopObserving: (() => void) | undefined;
  private report: ToolDiscoveryReport | undefined;
  private current: McpControllerSnapshot = {
    status: "unavailable",
    message: "Kubernetes MCP is unavailable. Use /mcp_restart to retry.",
    tools: [],
  };

  constructor(
    initialConfig: SreConfig,
    shutdown: AbortSignal,
    reloadConfig: () => Promise<SreConfig> = () =>
      loadSreConfig({
        env: { ...process.env, PI_SRE_CONFIG: initialConfig.paths.config },
      }),
  ) {
    this.initialConfig = initialConfig;
    this.shutdown = shutdown;
    this.reloadConfig = reloadConfig;
  }

  get snapshot(): McpControllerSnapshot {
    return this.current;
  }
  get discoveryReport(): ToolDiscoveryReport | undefined {
    return this.report;
  }

  subscribe(listener: (state: McpControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(state: McpControllerSnapshot): McpControllerSnapshot {
    this.current = state;
    for (const listener of this.listeners) listener(state);
    return state;
  }

  restart(force = false, initial = false): Promise<McpControllerSnapshot> {
    if (this.controllerClosePromise || this.shutdown.aborted) return Promise.resolve(this.current);
    if (this.pending) return this.pending;
    if (!force && this.connection?.state === "ready") return Promise.resolve(this.current);
    this.pending = this.replace(initial).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async retire(): Promise<void> {
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.connectionCancellation.abort();
    await Promise.allSettled([...this.calls]);
    const old = this.connection;
    await old?.close();
    this.connection = undefined;
  }

  private async replace(initial: boolean): Promise<McpControllerSnapshot> {
    this.publish({ status: "connecting", message: "Kubernetes MCP connecting…", tools: [] });
    this.report = undefined;
    let discoveryStarted = false;
    try {
      await this.retire();
      const config = initial ? this.initialConfig : await this.reloadConfig();
      for (const key of ["home", "auth", "models", "settings", "sessions", "logs"] as const) {
        if (config.paths[key] !== this.initialConfig.paths[key]) {
          throw new SreConfigError(
            "Session paths changed. Restart pi-sre to use a new application home.",
          );
        }
      }
      this.shutdown.throwIfAborted();
      if (this.controllerClosePromise)
        throw new Error("MCP controller is shutting down or closed.");
      this.connectionCancellation = new AbortController();
      const signal = AbortSignal.any([this.shutdown, this.connectionCancellation.signal]);
      const connection = await ManagedMcpConnection.connect(config.kubernetes.mcp, signal);
      this.connection = connection;
      discoveryStarted = true;
      const report = await discoverMcpTools(connection, signal);
      const scoped: McpConnection = {
        get state() {
          return connection.state;
        },
        listTools: (caller) =>
          connection.listTools(caller ? AbortSignal.any([caller, signal]) : signal),
        callTool: (name, args, caller) => {
          signal.throwIfAborted();
          const call = connection.callTool(
            name,
            args,
            caller ? AbortSignal.any([caller, signal]) : signal,
          );
          this.calls.add(call);
          return call.finally(() => {
            this.calls.delete(call);
          });
        },
        close: () => connection.close(),
      };
      const tools = report.exposed.map((tool) => createMcpToolBridge(tool, scoped, config.results));
      signal.throwIfAborted();
      if (connection.state !== "ready") throw new Error("Connection dropped during discovery.");
      this.stopObserving = connection.onClose?.(() => {
        this.connectionCancellation.abort();
        this.report = undefined;
        this.publish({
          status: "unavailable",
          message: "Kubernetes MCP transport unavailable. Use /mcp_restart to retry.",
          tools: [],
        });
      });
      this.report = report;
      return this.publish({
        status: "ready",
        message: `Kubernetes MCP ready: ${tools.length} approved read-only tools.`,
        tools,
      });
    } catch (error) {
      await this.retire();
      const message =
        error instanceof SreConfigError
          ? "Kubernetes MCP configuration invalid or session paths changed. Check YAML and read-only TOML; restart pi-sre if application home changed."
          : error instanceof McpStartupError
            ? error.diagnostic
            : error instanceof McpToolBridgeError
              ? error.message
              : discoveryStarted
                ? "Kubernetes MCP tool discovery failed."
                : "Kubernetes MCP connection failed during startup.";
      return this.publish({
        status: "unavailable",
        message: `${message} Kubernetes tools are unavailable. Check the MCP configuration and use /mcp_restart to retry.`,
        tools: [],
      });
    }
  }

  close(): Promise<void> {
    this.controllerClosePromise ??= (async () => {
      this.connectionCancellation.abort();
      await this.pending;
      await this.retire();
      this.publish({ status: "unavailable", message: "Kubernetes MCP closed.", tools: [] });
      this.listeners.clear();
    })();
    return this.controllerClosePromise;
  }
}
