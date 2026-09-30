import { McpClient, StdioTransport, type Tool } from "@earendil-works/pi-mcp";

import type { McpServerConfig } from "../config/config.js";

export type McpConnectionState = "starting" | "ready" | "failed" | "closed";
export type McpStartupFailure =
  | "command-not-found"
  | "process-exited"
  | "invalid-protocol"
  | "timeout"
  | "aborted"
  | "connection-failed";

export class McpStartupError extends Error {
  constructor(
    readonly kind: McpStartupFailure,
    readonly diagnostic: string,
    options?: ErrorOptions,
  ) {
    super(diagnostic, options);
    this.name = "McpStartupError";
  }
}

export interface McpConnection {
  readonly state: McpConnectionState;
  listTools(signal?: AbortSignal): Promise<readonly Tool[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}

const MAX_STDERR_BYTES = 4_096;

function safeStderr(value: string): string {
  return value
    .replace(
      /(authorization|token|password|secret|api[_-]?key|credential)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(-MAX_STDERR_BYTES);
}

function startupFailure(error: unknown, transportError: Error | undefined): McpStartupError {
  if (error instanceof McpStartupError) return error;
  const message = error instanceof Error ? error.message : "";
  const transportMessage = transportError?.message ?? "";
  if (/ENOENT|not found/i.test(message)) {
    return new McpStartupError("command-not-found", "Kubernetes MCP executable was not found.", {
      cause: error,
    });
  }
  if (/abort/i.test(message)) {
    return new McpStartupError("aborted", "Kubernetes MCP startup was cancelled.", {
      cause: error,
    });
  }
  if (/timeout|timed out/i.test(message)) {
    return new McpStartupError("timeout", "Kubernetes MCP startup timed out.", { cause: error });
  }
  if (/JSON|protocol|message|parse/i.test(`${transportMessage} ${message}`)) {
    return new McpStartupError(
      "invalid-protocol",
      "Kubernetes MCP sent an invalid protocol response.",
      { cause: error },
    );
  }
  if (/closed|exit|EPIPE/i.test(message)) {
    return new McpStartupError("process-exited", "Kubernetes MCP process exited during startup.", {
      cause: error,
    });
  }
  return new McpStartupError(
    "connection-failed",
    "Kubernetes MCP connection failed during startup.",
    { cause: error },
  );
}

export class ManagedMcpConnection implements McpConnection {
  state: McpConnectionState = "starting";
  private readonly client: McpClient;
  private readonly transport: StdioTransport;
  private closePromise: Promise<void> | undefined;
  private stderrTail = "";

  private constructor(private readonly config: McpServerConfig) {
    this.client = new McpClient({
      name: "pi-sre",
      version: "0.1.0",
      requestTimeoutMs: config.startupTimeoutMs,
    });
    this.client.onClose(() => {
      if (this.state === "ready") this.state = "failed";
    });
    this.transport = new StdioTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      stderr: "pipe",
      maxStderrBytes: MAX_STDERR_BYTES,
      onStderr: (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_BYTES);
      },
    });
  }

  get diagnosticStderr(): string {
    return safeStderr(this.stderrTail);
  }

  static async connect(
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<ManagedMcpConnection> {
    const connection = new ManagedMcpConnection(config);
    let transportError: Error | undefined;
    let rejectTransport: ((error: Error) => void) | undefined;
    const transportFailure = new Promise<never>((_resolve, reject) => {
      rejectTransport = reject;
    });
    const stopObserving = connection.client.onError((error) => {
      transportError = error;
      rejectTransport?.(error);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new McpStartupError("timeout", "Kubernetes MCP startup timed out.")),
        config.startupTimeoutMs,
      );
      onAbort = () =>
        reject(new McpStartupError("aborted", "Kubernetes MCP startup was cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      await Promise.race([
        connection.client.connect(connection.transport),
        interruption,
        transportFailure,
      ]);
      await Promise.race([
        connection.client.ping({
          timeoutMs: config.startupTimeoutMs,
          ...(signal ? { signal } : {}),
        }),
        interruption,
        transportFailure,
      ]);
      connection.state = "ready";
      return connection;
    } catch (error) {
      connection.state = "failed";
      const failure = startupFailure(error, transportError);
      await connection.client.close().catch(() => undefined);
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      stopObserving();
    }
  }

  async listTools(signal?: AbortSignal): Promise<readonly Tool[]> {
    this.requireReady();
    return this.client.listTools({
      ...(signal ? { signal } : {}),
      timeoutMs: this.config.toolCallTimeoutMs,
    });
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requireReady();
    return this.client.callTool(
      name,
      { ...args },
      { ...(signal ? { signal } : {}), timeoutMs: this.config.toolCallTimeoutMs },
    );
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.client.close().finally(() => {
        this.state = "closed";
      });
    }
    return this.closePromise;
  }

  private requireReady(): void {
    if (this.state !== "ready") throw new Error("Kubernetes MCP connection is unavailable.");
  }
}
