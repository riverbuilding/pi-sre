import { ControlledApprovalService } from "../execution/controlled-approval.js";
import type { SreConfig } from "../config/config.js";
import {
  SafetyProfileChangeError,
  type ExecutionProfile,
} from "../config/controlled-operations.js";
import {
  DEFAULT_RESOURCE_READ_POLICY,
  resourceReadPolicySchema,
  type ResourceReadPolicy,
} from "../config/resource-policy.js";
import { ClusterContextRegistry } from "../cluster/context-registry.js";
import { CurrentClusterSelection } from "../cluster/current-selection.js";
import type { ClusterScopeRule, StartupClusterIntent } from "../cluster/context-resolver.js";
import { acceptMcpCall, type DiagnosticConnection } from "../execution/accept-mcp-call.js";
import type { CallResult, RequestExecution } from "../execution/request-execution.js";
import { ExecutionError } from "../execution/errors.js";
import type { McpConnection } from "../mcp/connection.js";
import { ContextDiscoveryError, discoverClusterContexts } from "../mcp/context-discovery.js";
import {
  discoverMcpTools,
  type McpToolDescriptor,
  type ToolDiscoveryReport,
} from "../mcp/tool-discovery.js";

export interface RequestMcpPublication {
  readonly profile?: ExecutionProfile;
  readonly resourceReadPolicy?: ResourceReadPolicy;
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

/** Owns the single MCP connection lifecycle.
 * Publication includes tool installation, environment and notices. Its completion is the
 * ready barrier, not model acknowledgement. The publisher must support empty withdrawals.
 */
export class RequestMcpController {
  readonly approvals: ControlledApprovalService;
  readonly #connect: (signal: AbortSignal) => Promise<McpConnection>;
  readonly #publish: (state: RequestMcpPublication) => void | Promise<void>;
  readonly #resourceReadPolicy: ResourceReadPolicy;
  readonly #safety: SreConfig["safety"];
  readonly #intent: StartupClusterIntent;
  readonly #configuredRule: ClusterScopeRule | undefined;
  readonly #shutdown = new AbortController();
  #selection: CurrentClusterSelection | undefined;
  #report: ToolDiscoveryReport | undefined;
  readonly #stopObservingShutdown: () => void;
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
    signal?: AbortSignal;
    resourceReadPolicy?: ResourceReadPolicy;
    safety?: SreConfig["safety"];
  }) {
    this.#resourceReadPolicy = resourceReadPolicySchema.parse(
      options.safety?.resources ?? options.resourceReadPolicy ?? DEFAULT_RESOURCE_READ_POLICY,
    );
    for (const pair of this.#resourceReadPolicy.allowedReadKinds) {
      Object.freeze(pair);
    }
    Object.freeze(this.#resourceReadPolicy.allowedReadKinds);
    Object.freeze(this.#resourceReadPolicy);
    this.#safety = structuredClone(
      options.safety ?? { mode: "read-only", resources: this.#resourceReadPolicy },
    );
    this.approvals = new ControlledApprovalService(
      this.#safety.mode,
      this.#safety.mode === "controlled-operations" ? this.#safety.controlledOperations : undefined,
    );
    this.#state = { ...this.#state, profile: this.#safety.mode };
    this.#connect = options.connect;
    this.#publish = options.publish;
    this.#intent = options.intent ?? {};
    this.#configuredRule = options.configuredRule;
    const abort = () => this.#shutdown.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.#stopObservingShutdown = () => options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) {
      abort();
    }
  }

  get discoveryReport(): ToolDiscoveryReport | undefined {
    return this.#report;
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
    this.#report = undefined;
    this.#selection?.updateInventory(new ClusterContextRegistry([]));
    this.#state = {
      status,
      message,
      tools: [],
      selection: this.#selection,
      profile: this.#safety.mode,
    };
  }

  private invalidate(): void {
    this.#owned?.abort.abort(
      new ExecutionError(
        "transport-unavailable",
        "MCP connection interrupted; no valid result obtained.",
      ),
    );
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
      const report = await discoverMcpTools(
        transport,
        signal,
        this.#safety.mode,
        this.#safety.mode === "controlled-operations"
          ? this.#safety.controlledOperations.enabledTools
          : [],
      );
      this.#report = report;
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
        resourceReadPolicy: this.#resourceReadPolicy,
        get ready() {
          return owned.ready && transport.state === "ready" && !signal.aborted;
        },
        signal,
        getTool: (name) => tools.find((tool) => tool.name === name),
        callTool: (name, args, caller) => transport.callTool(name, args, caller),
      };
      const selection = this.#selection;
      const publication: RequestMcpPublication = {
        profile: this.#safety.mode,
        resourceReadPolicy: this.#resourceReadPolicy,
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
      let message =
        "Kubernetes MCP connection, discovery or publication failed. Use /mcp_restart to retry.";
      if (error instanceof SafetyProfileChangeError) {
        message = error.message;
      } else if (error instanceof ContextDiscoveryError) {
        message = `${error.message} Use /mcp_restart to retry.`;
      }
      this.withdraw("unavailable", message);
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
    this.#stopObservingShutdown();
    this.approvals.close();
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
