import { randomUUID } from "node:crypto";

import { ExecutionQueue } from "../cluster/execution-queue.js";
import { executionLimitsSchema, type ExecutionLimits } from "../config/execution.js";

export interface CallIdentity {
  readonly toolCallId: string;
  readonly operation: string;
  readonly context?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly connection: object;
}

export type CallResult<T> =
  | {
      readonly status: "success";
      readonly value: T;
      readonly dispatchedAt: number;
      readonly settledAt: number;
    }
  | {
      readonly status: "error" | "cancelled";
      readonly error: unknown;
      readonly dispatchedAt?: number;
      readonly settledAt: number;
    };

/** Ephemeral execution ownership only. No transcript or diagnostic state. */
export class RequestExecution {
  readonly requestId = randomUUID();
  readonly #abort = new AbortController();
  readonly #queue: ExecutionQueue;
  readonly #limits: ExecutionLimits;
  readonly #calls = new Map<
    string,
    { readonly identity: CallIdentity; phase: "queued" | "active" }
  >();
  readonly #idle = new Set<() => void>();
  #dispatches = 0;
  #iterations = 0;
  #closed = false;

  constructor(limits: ExecutionLimits, queue = new ExecutionQueue()) {
    this.#limits = executionLimitsSchema.parse(limits);
    this.#queue = queue;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }
  get counts() {
    return {
      dispatches: this.#dispatches,
      modelIterations: this.#iterations,
      queued: [...this.#calls.values()].filter((c) => c.phase === "queued").length,
      active: [...this.#calls.values()].filter((c) => c.phase === "active").length,
    };
  }

  consumeModelIteration(): void {
    this.assertOpen();
    if (this.#iterations >= this.#limits.maxModelIterations)
      throw new Error("Request model iteration limit reached.");
    this.#iterations++;
  }

  /** Caller validates arguments/scope synchronously before admission. */
  accept<T>(
    identity: CallIdentity,
    check: () => void,
    dispatch: (signal: AbortSignal) => Promise<T>,
  ): Promise<CallResult<T>> {
    this.assertOpen();
    if (this.#calls.has(identity.toolCallId)) throw new Error("Duplicate active tool call ID.");
    const signal = this.signal;
    const call = { identity, phase: "queued" as "queued" | "active" };
    this.#calls.set(identity.toolCallId, call);
    return (async (): Promise<CallResult<T>> => {
      let dispatchedAt: number | undefined;
      let release: (() => void) | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const admission = await this.#queue.acquire(() => undefined, signal);
        if (!admission.ok) throw new Error(`Call not executed: ${admission.category}.`);
        release = admission.release;
        signal.throwIfAborted();
        check();
        signal.throwIfAborted();
        if (this.#dispatches >= this.#limits.maxToolCalls)
          throw new Error("Request tool dispatch limit reached.");
        // No await between runtime checks, charging and transport invocation.
        this.#dispatches++;
        call.phase = "active";
        dispatchedAt = Date.now();
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const value = await Promise.race([dispatch(signal), cancelled]);
        signal.throwIfAborted();
        return { status: "success", value, dispatchedAt, settledAt: Date.now() };
      } catch (error) {
        return {
          status: signal.aborted ? "cancelled" : "error",
          error,
          ...(dispatchedAt === undefined ? {} : { dispatchedAt }),
          settledAt: Date.now(),
        };
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        release?.();
        this.#calls.delete(identity.toolCallId);
        if (this.#calls.size === 0) {
          for (const resolve of this.#idle) resolve();
          this.#idle.clear();
        }
      }
    })();
  }

  cancel(): void {
    this.#closed = true;
    this.#abort.abort();
  }

  async finish(): Promise<void> {
    this.#closed = true;
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    if (this.#calls.size > 0) await new Promise<void>((resolve) => this.#idle.add(resolve));
  }

  private assertOpen(): void {
    this.signal.throwIfAborted();
    if (this.#closed) throw new Error("Request execution has closed.");
  }
}
