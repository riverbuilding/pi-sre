import {
  getMcpToolPolicy,
  acceptsToolContext,
  McpToolSchemaError,
} from "../runtime/tool-policy.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ClusterContextManager } from "../cluster/context-manager.js";
import type { StartupClusterIntent } from "../cluster/context-resolver.js";
import { discoverClusterContexts, ContextDiscoveryError } from "../mcp/context-discovery.js";

import type { SreConfig } from "../config/config.js";
import { loadSreConfig, SreConfigError } from "../config/loader.js";
import { ManagedMcpConnection, McpStartupError, type McpConnection } from "../mcp/connection.js";
import { discoverMcpTools, type ToolDiscoveryReport } from "../mcp/tool-discovery.js";
import { createMcpToolBridge } from "../mcp/tool-bridge.js";

export interface McpControllerSnapshot {
  readonly status: "connecting" | "ready" | "unavailable";
  readonly message: string;
  readonly tools: readonly ToolDefinition[];
}

/** Owns connection generations; a captured tool can never cross to a replacement process. */
export class McpController {
  readonly clusterContext: ClusterContextManager;
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
  private availableTools: readonly ToolDefinition[] = [];
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
    intent: StartupClusterIntent = {},
  ) {
    this.clusterContext = new ClusterContextManager(intent);
    this.initialConfig = initialConfig;
    this.shutdown = shutdown;
    this.reloadConfig = reloadConfig;
    this.clusterContext.subscribe(() => {
      if (this.current.status === "ready") this.publishReady();
    });
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

  private publishReady(): McpControllerSnapshot {
    const scope = this.clusterContext.captureScope();
    const tools = this.availableTools.filter((tool) => {
      if (!getMcpToolPolicy(tool.name)?.clusterDependent) return true;
      const descriptor = this.report?.exposed.find((entry) => entry.name === tool.name);
      return (
        scope !== undefined &&
        descriptor !== undefined &&
        acceptsToolContext(descriptor, scope.context)
      );
    });
    const message =
      this.clusterContext.state.status === "enumeration-failed"
        ? this.clusterContext.state.message
        : `Kubernetes MCP ready: ${tools.length} approved read-only tools.`;
    if (
      this.current.status === "ready" &&
      this.current.message === message &&
      tools.length === this.current.tools.length &&
      tools.every((tool, index) => tool === this.current.tools[index])
    )
      return this.current;
    return this.publish({ status: "ready", message, tools });
  }

  /** Uses the same authority as restart; callers can describe shared/no-op work honestly. */
  restartDisposition(force = false): "closed" | "shared" | "retained" | "forced" | "recovery" {
    if (this.controllerClosePromise || this.shutdown.aborted) return "closed";
    if (this.pending) return "shared";
    if (
      !force &&
      this.connection?.state === "ready" &&
      this.clusterContext.state.status !== "enumeration-failed"
    )
      return "retained";
    return force ? "forced" : "recovery";
  }

  restart(force = false, initial = false): Promise<McpControllerSnapshot> {
    const disposition = this.restartDisposition(force);
    if (disposition === "closed" || disposition === "retained")
      return Promise.resolve(this.current);
    if (this.pending) return this.pending;
    // Reserve the restart before synchronous scope/status listeners can request another one.
    const pending = Promise.withResolvers<McpControllerSnapshot>();
    this.pending = pending.promise;
    void this.replace(initial).then(
      (snapshot) => {
        this.pending = undefined;
        pending.resolve(snapshot);
      },
      (error: unknown) => {
        this.pending = undefined;
        pending.reject(error);
      },
    );
    return pending.promise;
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
    this.report = undefined;
    this.availableTools = [];
    // Scope subscribers must already see tools withdrawn and transport transitioning.
    this.current = { status: "connecting", message: "Kubernetes MCP connecting…", tools: [] };
    const generation = this.clusterContext.beginConnection();
    this.publish(this.current);
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
      let enumerationError: ContextDiscoveryError | undefined;
      try {
        const registry = await discoverClusterContexts(scoped, report, signal);
        signal.throwIfAborted();
        if (connection.state !== "ready") throw new Error("Connection dropped during enumeration.");
        this.clusterContext.acceptRegistry(generation, registry, config.kubernetes.defaultCluster);
      } catch (error) {
        if (!(error instanceof ContextDiscoveryError)) throw error;
        signal.throwIfAborted();
        enumerationError = error;
        this.clusterContext.failEnumeration(
          generation,
          error.kind,
          `${error.message} Check MCP configuration and use /mcp_restart to retry.`,
        );
      }
      const tools = enumerationError
        ? []
        : report.exposed.map((tool) =>
            createMcpToolBridge(tool, scoped, config.results, {
              manager: this.clusterContext,
              connectionGeneration: generation,
            }),
          );
      signal.throwIfAborted();
      if (connection.state !== "ready") throw new Error("Connection dropped during discovery.");
      this.stopObserving = connection.onClose?.(() => {
        this.connectionCancellation.abort();
        this.report = undefined;
        this.availableTools = [];
        this.current = {
          status: "unavailable",
          message: "Kubernetes MCP transport unavailable. Use /mcp_restart to retry.",
          tools: [],
        };
        this.clusterContext.markUnavailable(this.current.message);
        this.publish(this.current);
      });
      this.report = report;
      this.availableTools = tools;
      return this.publishReady();
    } catch (error) {
      await this.retire();
      const message =
        error instanceof SreConfigError
          ? "Kubernetes MCP configuration invalid or session paths changed. Check YAML and read-only TOML; restart pi-sre if application home changed."
          : error instanceof McpStartupError
            ? error.diagnostic
            : error instanceof McpToolSchemaError
              ? error.message
              : discoveryStarted
                ? "Kubernetes MCP tool discovery failed."
                : "Kubernetes MCP connection failed during startup.";
      this.clusterContext.markUnavailable(`${message} Use /mcp_restart to retry.`);
      return this.publish({
        status: "unavailable",
        message: `${message} Kubernetes tools are unavailable. Check the MCP configuration and use /mcp_restart to retry.`,
        tools: [],
      });
    }
  }

  close(): Promise<void> {
    this.controllerClosePromise ??= (async () => {
      this.availableTools = [];
      this.current = { status: "unavailable", message: "Kubernetes MCP closing.", tools: [] };
      this.clusterContext.markUnavailable("Kubernetes MCP closing; cluster scope unavailable.");
      this.publish(this.current);
      this.connectionCancellation.abort();
      await this.pending;
      await this.retire();
      this.publish({ status: "unavailable", message: "Kubernetes MCP closed.", tools: [] });
      this.clusterContext.dispose();
      this.listeners.clear();
    })();
    return this.controllerClosePromise;
  }
}
