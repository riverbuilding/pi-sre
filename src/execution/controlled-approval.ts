import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { CurrentClusterSelection } from "../cluster/current-selection.js";
import {
  controlledOperationsSchema,
  isControlledOperation,
  type ControlledOperation,
  type ControlledOperationsConfig,
  type ExecutionProfile,
} from "../config/controlled-operations.js";
import { acceptsToolContext } from "../runtime/tool-policy.js";
import { redactDiagnosticText } from "../shared/redaction.js";
import type { DiagnosticConnection } from "./accept-mcp-call.js";
import { ExecutionError } from "./errors.js";
import { isPresentableIdentity } from "./identity.js";
import type { RequestExecution } from "./request-execution.js";

export const APPROVE_CALL = "Approve this exact call once";
export const DENY_CALL = "Deny";

export interface ApprovalChannel {
  requestApproval(
    preview: string,
    signal: AbortSignal,
    timeout: number,
  ): Promise<string | undefined>;
}

export interface ControlledResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
}

/** Application-owned Slice 5 policy, never a model callback or an MCP annotation.
 * Must reject sensitive/authority-expanding arguments and return explicit identity.
 * Absent policy means no proposal, dialog or dispatch, including direct callers.
 */
export type ControlledCallReview = (
  operation: ControlledOperation,
  args: Readonly<Record<string, unknown>>,
) => ControlledResource;

type Reason = "refused" | "denied" | "expired" | "invalidated" | "budget-refused" | "completed";

export interface ControlledReceipt {
  readonly operationId: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly operation: ControlledOperation;
  readonly profile: ExecutionProfile;
  readonly context?: string;
  readonly resource?: ControlledResource;
  readonly proposedAt: number;
  readonly approvedAt?: number;
  readonly approvedSummary?: string;
  readonly dispatchedAt?: number;
  readonly settledAt: number;
  readonly outcome:
    "not-executed" | "server-reported-success" | "server-reported-failure" | "outcome-unknown";
  readonly reason: Reason;
  readonly notice?: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  throw new Error("Unreviewable call.");
}

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
}

/** Session-wide approval and operation slot. No production controlled policy is installed
 * in Slice 4; capability publication and direct MCP admission remain read-only.
 */
export class ControlledApprovalService {
  readonly #config: ControlledOperationsConfig;
  readonly #profile: ExecutionProfile;
  readonly #review: ControlledCallReview | undefined;
  readonly #receipts: ControlledReceipt[] = [];
  #tail: Promise<void> = Promise.resolve();
  #channel: ApprovalChannel | undefined;
  #channelLifetime = new AbortController();
  #interactive = false;
  readonly #closed = new AbortController();

  constructor(
    profile: ExecutionProfile,
    config: ControlledOperationsConfig = controlledOperationsSchema.parse({}),
    review?: ControlledCallReview,
  ) {
    this.#profile = profile;
    this.#config = controlledOperationsSchema.parse(config);
    this.#review = review;
  }

  get receipts(): readonly ControlledReceipt[] {
    return Object.freeze([...this.#receipts]);
  }

  /** Only application-owned InteractiveMode startup may enable this channel. */
  enableInteractiveTerminal(): void {
    this.#interactive = true;
  }

  setChannel(channel: ApprovalChannel | undefined): void {
    this.#channelLifetime.abort();
    this.#channelLifetime = new AbortController();
    this.#channel = channel;
  }

  close(): void {
    this.#closed.abort();
    this.#channel = undefined;
  }

  async execute(input: {
    request: RequestExecution;
    selection: CurrentClusterSelection;
    connection: DiagnosticConnection;
    toolCallId: string;
    operation: string;
    parameters: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
    /** Sticky invalidation for any application-owned descriptor/policy changes. */
    authoritySignal: AbortSignal;
  }): Promise<ControlledReceipt | undefined> {
    const {
      request,
      selection,
      connection,
      toolCallId,
      operation,
      signal: callerSignal,
      authoritySignal,
    } = input;

    if (!isControlledOperation(operation) || !isPresentableIdentity(toolCallId)) {
      return undefined; // Exec and unknown operations cannot obtain permits or receipts.
    }
    const proposedAt = Date.now();
    const base = {
      operationId: randomUUID(),
      requestId: request.requestId,
      toolCallId,
      operation,
      profile: this.#profile,
      proposedAt,
    };
    let reason: Reason = "refused";
    let approvedAt: number | undefined;
    let context: string | undefined;
    let resource: ControlledResource | undefined;
    let dispatchedAt: number | undefined;
    let outcome: ControlledReceipt["outcome"] = "not-executed";
    const invalidation = new AbortController();
    const expiry = new AbortController();
    const deadline = proposedAt + Math.min(60_000, this.#config.approvalTimeoutMs);
    const timer = setTimeout(() => expiry.abort(), Math.max(0, deadline - Date.now()));
    let stopObserving: (() => void) | undefined;
    let release: (() => void) | undefined;
    let callTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const channel = this.#channel;
      const review = this.#review;
      if (
        this.#profile !== "controlled-operations" ||
        !this.#config.enabledTools.includes(operation) ||
        !review ||
        !channel ||
        !this.#interactive ||
        !connection.signal
      ) {
        throw new Error("Controlled capability unavailable.");
      }
      const args = structuredClone(input.parameters);
      const fingerprint = canonical(args);
      freeze(args);
      const descriptor = connection.getTool(operation);
      if (!descriptor || descriptor.name !== operation) {
        throw new Error("Unavailable descriptor.");
      }
      // Runtime narrowing, never infer or inject a missing context.
      if (!isPresentableIdentity(args.context)) {
        throw new Error("Explicit context required.");
      }
      const exactContext = args.context;
      context = exactContext;
      const target = selection.target(context);
      const rule = canonical(selection.rule);
      const validate = (): ControlledResource => {
        if (
          input.request !== request ||
          input.selection !== selection ||
          input.connection !== connection ||
          input.operation !== operation ||
          input.toolCallId !== toolCallId ||
          !connection.ready ||
          connection.getTool(operation) !== descriptor ||
          !selection.permits(exactContext) ||
          !target ||
          selection.target(exactContext) !== target ||
          canonical(selection.rule) !== rule ||
          canonical(input.parameters) !== fingerprint ||
          !acceptsToolContext(descriptor, exactContext) ||
          !Value.Check(Type.Unsafe(descriptor.inputSchema), args)
        ) {
          throw new Error("Invalidated proposal.");
        }
        const identity = review(operation, args);
        if (
          ![identity.apiVersion, identity.kind, identity.namespace, identity.name].every(
            isPresentableIdentity,
          )
        ) {
          throw new Error("Unreviewable identity.");
        }
        // Copy only the reviewed receipt fields, never arbitrary policy output.
        return {
          apiVersion: identity.apiVersion,
          kind: identity.kind,
          namespace: identity.namespace,
          name: identity.name,
        };
      };
      const checked = validate();
      resource = Object.freeze(checked);
      // A useful exact preview must fit in full and survive redaction unchanged.
      const preview = `${operation}\nContext: ${JSON.stringify(context)}\nFinal arguments: ${fingerprint}`;
      if (
        preview.length > 8_000 ||
        redactDiagnosticText(preview) !== preview ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(fingerprint)
      ) {
        throw new Error("Unreviewable preview.");
      }
      const check = () => {
        if (invalidation.signal.aborted || canonical(validate()) !== canonical(checked)) {
          throw new Error("Invalidated proposal.");
        }
      };
      stopObserving = selection.observeChanges(() => {
        try {
          check();
        } catch {
          invalidation.abort();
        }
      });
      const signal = AbortSignal.any([
        this.#closed.signal,
        this.#channelLifetime.signal,
        request.closingSignal,
        request.signal,
        connection.signal,
        authoritySignal,
        invalidation.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      const approvalSignal = AbortSignal.any([signal, expiry.signal]);
      // Reserve the session slot synchronously; cancellation while waiting never renews expiry.
      const previous = this.#tail;
      const slot = Promise.withResolvers<void>();
      this.#tail = slot.promise;
      let ownsSlot = false;
      release = () => {
        if (ownsSlot) {
          slot.resolve();
        } else {
          void previous.then(() => slot.resolve());
        }
      };
      reason = "invalidated";
      const callAbort = new AbortController();
      const callSignal = AbortSignal.any([signal, callAbort.signal, expiry.signal]);
      const result = await request.accept(
        {
          toolCallId,
          operation,
          context,
          parameters: args,
          connection,
        },
        check,
        (dispatchSignal) => {
          callTimer = setTimeout(() => callAbort.abort(), this.#config.callTimeoutMs);
          return connection.callTool(operation, args, dispatchSignal);
        },
        callSignal,
        async () => {
          await abortable(previous, approvalSignal);
          ownsSlot = true;
          check();
          approvalSignal.throwIfAborted();
          const answer = await abortable(
            channel.requestApproval(preview, approvalSignal, Math.max(1, deadline - Date.now())),
            approvalSignal,
          );
          approvalSignal.throwIfAborted();
          check();
          if (answer !== APPROVE_CALL) {
            reason = "denied";
            throw new Error("Approval denied.");
          }
          approvedAt = Date.now();
          let consumed = false;
          return () => {
            check();
            approvalSignal.throwIfAborted();
            if (consumed || Date.now() >= deadline) {
              throw new Error("Permit unavailable.");
            }
            reason = "budget-refused";
            request.chargeControlledDispatch(this.#config.maxOperationsPerRequest);
            consumed = true;
            reason = "completed";
            // Expiry limits approval consumption, not the dispatched operation lifetime.
            clearTimeout(timer);
          };
        },
      );
      dispatchedAt = result.dispatchedAt;
      if (dispatchedAt !== undefined) {
        outcome = "outcome-unknown";
        if (result.status === "success" && result.value && typeof result.value === "object") {
          if ("isError" in result.value && result.value.isError === true) {
            outcome = "server-reported-failure";
          } else if (
            (!("isError" in result.value) || result.value.isError === false) &&
            "content" in result.value &&
            Array.isArray(result.value.content)
          ) {
            outcome = "server-reported-success";
          }
        }
      } else if (
        result.status !== "success" &&
        result.error instanceof ExecutionError &&
        result.error.category === "budget-refused"
      ) {
        reason = "budget-refused";
      } else if (expiry.signal.aborted || Date.now() >= deadline) {
        reason = "expired";
      }
    } catch {
      // Never retain caller, policy, transport or dialog error payloads.
      if (expiry.signal.aborted || Date.now() >= deadline) {
        reason = "expired";
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(callTimer);
      stopObserving?.();
      release?.();
    }
    let notice: string | undefined;
    if (dispatchedAt !== undefined) {
      if (outcome === "outcome-unknown") {
        notice =
          "The operation may have taken effect and remote execution may continue. No automatic retry was made.";
      } else if (outcome === "server-reported-failure") {
        notice =
          "The server reported failure; partial effects remain possible. No rollback is established.";
      } else {
        notice =
          "Server acknowledgement does not establish recovery or health. Verification requires a fresh read.";
      }
    }
    const receipt: ControlledReceipt = Object.freeze({
      ...base,
      ...(context ? { context } : {}),
      ...(resource ? { resource } : {}),
      ...(approvedAt === undefined
        ? {}
        : { approvedAt, approvedSummary: `${operation}: one exact call` }),
      ...(dispatchedAt === undefined ? {} : { dispatchedAt }),
      settledAt: Date.now(),
      ...(notice === undefined ? {} : { notice }),
      outcome,
      reason,
    });
    this.#receipts.push(receipt);
    if (this.#receipts.length > 100) {
      this.#receipts.shift();
    }
    return receipt;
  }
}

/** Observe late UI rejection without allowing an uncooperative dialog to block cancellation. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Approval unavailable."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      }),
    ]);
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}
