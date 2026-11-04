import { ClusterContextRegistry } from "../cluster/context-registry.js";
import { CurrentClusterSelection } from "../cluster/current-selection.js";
import type { ClusterScopeRule, StartupClusterIntent } from "../cluster/context-resolver.js";
import { acceptMcpCall, type DiagnosticConnection } from "../execution/accept-mcp-call.js";
import type { CallResult, RequestExecution } from "../execution/request-execution.js";
import type { McpConnection } from "../mcp/connection.js";
import { ContextDiscoveryError, discoverClusterContexts } from "../mcp/context-discovery.js";
import { discoverMcpTools, type McpToolDescriptor } from "../mcp/tool-discovery.js";

export interface RequestMcpPublication {
  readonly status: "connecting" | "ready" | "unavailable";
  readonly message: string;
  readonly tools: readonly McpToolDescriptor[];
  readonly selection: CurrentClusterSelection | undefined;
  /** Captures this original connection. A retained handler cannot route to a replacement. */
  readonly accept?: (
    request: RequestExecution,
    toolCallId: string,
    operation: string,
    parameters: unknown,
    signal?: AbortSignal,
  ) => Promise<CallResult<unknown>>;
}

interface OwnedConnection {
  readonly transport: McpConnection;
  readonly abort: AbortController;
  readonly calls: Set<Promise<unknown>>;
  stopObserving: (() => void) | undefined;
  ready: boolean;
}

/** Staged Slice 3 composition; production switches in Slice 6.
 * Publication includes tool installation, environment and notices. Its completion is the
 * ready barrier, not model acknowledgement. The publisher must support empty withdrawals.
 */
export class RequestMcpController {
  readonly #connect: (signal: AbortSignal) => Promise<McpConnection>;
  readonly #publish: (state: RequestMcpPublication) => void | Promise<void>;
  readonly #intent: StartupClusterIntent;
  readonly #configuredRule: ClusterScopeRule | undefined;
  readonly #shutdown = new AbortController();
  #selection: CurrentClusterSelection | undefined;
  #owned: OwnedConnection | undefined;
  #pending: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #state: RequestMcpPublication = {
    status: "unavailable",
    message: "Kubernetes MCP unavailable. Use /mcp_restart to retry.",
    tools: [],
    selection: undefined,
  };

  constructor(options: {
    connect: (signal: AbortSignal) => Promise<McpConnection>;
    publish: (state: RequestMcpPublication) => void | Promise<void>;
    intent?: StartupClusterIntent;
    configuredRule?: ClusterScopeRule;
  }) {
    this.#connect = options.connect;
    this.#publish = options.publish;
    this.#intent = options.intent ?? {};
    this.#configuredRule = options.configuredRule;
  }

  get snapshot(): RequestMcpPublication {
    return this.#state;
  }
  get selection(): CurrentClusterSelection | undefined {
    return this.#selection;
  }

  restart(force = false): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#pending) return this.#pending;
    if (!force && this.#state.status === "ready" && this.#owned?.transport.state === "ready")
      return Promise.resolve();
    return this.run(() => this.replace());
  }

  /** Reserve before invoking any synchronous publisher/reentrant command. */
  private run(work: () => Promise<void>): Promise<void> {
    const pending = Promise.withResolvers<void>();
    this.#pending = pending.promise;
    void work().then(
      () => {
        this.#pending = undefined;
        pending.resolve();
      },
      (error: unknown) => {
        this.#pending = undefined;
        pending.reject(error);
      },
    );
    return pending.promise;
  }

  private withdraw(status: "connecting" | "unavailable", message: string): void {
    if (this.#owned) this.#owned.ready = false;
    this.#selection?.updateInventory(new ClusterContextRegistry([]));
    this.#state = { status, message, tools: [], selection: this.#selection };
  }

  private invalidate(): void {
    this.#owned?.abort.abort(new Error("MCP connection interrupted; no valid result obtained."));
  }

  private async retire(): Promise<void> {
    const owned = this.#owned;
    if (!owned) return;
    owned.stopObserving?.();
    owned.stopObserving = undefined;
    this.invalidate();
    await Promise.allSettled([...owned.calls]);
    await owned.transport.close();
    if (this.#owned === owned) this.#owned = undefined;
  }

  private async replace(): Promise<void> {
    try {
      this.withdraw("connecting", "Kubernetes MCP connecting…");
      // Invoke withdrawal before aborting old calls; never wait on a publisher to invalidate.
      let withdrawal: void | Promise<void>;
      try {
        withdrawal = this.#publish(this.#state);
      } finally {
        this.invalidate();
      }
      await withdrawal;
      await this.retire();
      this.#shutdown.signal.throwIfAborted();
      const transport = await this.#connect(this.#shutdown.signal);
      const owned: OwnedConnection = {
        transport,
        abort: new AbortController(),
        calls: new Set(),
        ready: false,
        stopObserving: undefined,
      };
      this.#owned = owned;
      const signal = AbortSignal.any([this.#shutdown.signal, owned.abort.signal]);
      owned.stopObserving = transport.onClose?.(() => {
        this.withdraw(
          "unavailable",
          "Kubernetes MCP transport unavailable. Use /mcp_restart to retry.",
        );
        this.invalidate();
        // Discovery/publication already has a catch path; no concurrent publisher.
        if (!this.#pending && !this.#closing) {
          void this.run(async () => {
            try {
              await this.#publish(this.#state);
            } finally {
              await this.retire();
            }
          }).catch(() => {
            this.withdraw(
              "unavailable",
              "Kubernetes MCP unavailable; withdrawal publication or connection cleanup failed. Use /mcp_restart to retry.",
            );
          });
        }
      });
      const report = await discoverMcpTools(transport, signal);
      const registry = await discoverClusterContexts(transport, report, signal);
      signal.throwIfAborted();
      if (transport.state !== "ready") throw new Error("MCP transport unavailable.");
      if (this.#selection) this.#selection.updateInventory(registry);
      else
        this.#selection = new CurrentClusterSelection(registry, this.#intent, this.#configuredRule);
      // Descriptors are stable for the lifetime of this connection, including nested schemas.
      const tools = structuredClone(report.exposed);
      const freeze = (value: unknown): void => {
        if (value && typeof value === "object") {
          for (const child of Object.values(value)) freeze(child);
          Object.freeze(value);
        }
      };
      freeze(tools);
      const connection: DiagnosticConnection = {
        get ready() {
          return owned.ready && transport.state === "ready" && !signal.aborted;
        },
        signal,
        getTool: (name) => tools.find((tool) => tool.name === name),
        callTool: (name, args, caller) => transport.callTool(name, args, caller),
      };
      const selection = this.#selection;
      const publication: RequestMcpPublication = {
        status: "ready",
        message: "Kubernetes MCP ready; inventory does not imply authentication or cluster health.",
        tools,
        selection,
        accept: (request, id, operation, args, caller) => {
          const call = acceptMcpCall(request, selection, connection, id, operation, args, caller);
          owned.calls.add(call);
          void call.then(
            () => owned.calls.delete(call),
            () => owned.calls.delete(call),
          );
          return call;
        },
      };
      await this.#publish(publication);
      signal.throwIfAborted();
      if (transport.state !== "ready") throw new Error("MCP transport unavailable.");
      this.#state = publication;
      owned.ready = true;
    } catch (error) {
      this.withdraw(
        "unavailable",
        error instanceof ContextDiscoveryError
          ? `${error.message} Use /mcp_restart to retry.`
          : "Kubernetes MCP connection, discovery or publication failed. Use /mcp_restart to retry.",
      );
      this.invalidate();
      try {
        await this.retire();
      } finally {
        await this.#publish(this.#state);
      }
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const closing = Promise.withResolvers<void>();
    this.#closing = closing.promise;
    this.#shutdown.abort();
    this.withdraw("unavailable", "Kubernetes MCP closed.");
    this.invalidate();
    void (async () => {
      try {
        await this.#pending;
      } finally {
        try {
          await this.retire();
        } finally {
          await this.#publish(this.#state);
        }
      }
    })().then(closing.resolve, closing.reject);
    return closing.promise;
  }
}
