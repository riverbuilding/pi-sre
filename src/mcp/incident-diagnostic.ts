import type {
  IncidentExecutionLease,
  InvestigationController,
} from "../app/investigation-controller.js";
import type { ResultPolicy } from "../config/schema.js";
import { DomainError } from "../domain/errors.js";
import { identity } from "../domain/validation.js";
import type { FailureCategory } from "../investigation/investigation-service.js";
import { validateMcpToolExecution } from "../runtime/tool-execution-policy.js";
import type { McpConnection } from "./connection.js";
import { observationProvenance, presentObservation } from "./observation-adapter.js";
import {
  classifyToolFailure,
  normalizeMcpResult,
  normalizeToolFailure,
  type ToolFailureCategory,
} from "./result-normalizer.js";
import type { ToolNameMapping } from "./tool-bridge.js";

interface IncidentDiagnosticInput {
  readonly controller: InvestigationController;
  readonly connection: Pick<McpConnection, "callTool"> & Partial<Pick<McpConnection, "state">>;
  readonly generation: number;
  readonly mapping: ToolNameMapping;
  readonly args: Record<string, unknown>;
  readonly policy: ResultPolicy;
  readonly signal?: AbortSignal;
  readonly connectionSignal?: AbortSignal;
}

function outcomeCategory(category: ToolFailureCategory): FailureCategory {
  switch (category) {
    case "authentication-failed":
      return "authentication";
    case "authorization-failed":
      return "authorization";
    case "timeout":
      return "timeout";
    case "transport-unavailable":
      return "transport";
    case "storage-refused":
      return "storage";
    case "stale-scope":
      return "stale";
    default:
      return "tool";
  }
}

/** The bridge's incident path: one admitted lease, one transport, one synchronous commit. */
export async function executeIncidentDiagnostic(input: IncidentDiagnosticInput) {
  const { controller, connection, generation, mapping, args, policy, signal, connectionSignal } =
    input;
  let lease: IncidentExecutionLease | undefined;
  let category: FailureCategory = "cancelled";
  const fail = (failureCategory: ToolFailureCategory) => {
    category = outcomeCategory(failureCategory);
    const normalized = normalizeToolFailure(failureCategory, policy);
    const result = {
      content: [{ type: "text" as const, text: normalized.text }],
      details: {
        tool: mapping,
        status:
          failureCategory === "invalid-result" ? ("invalid-result" as const) : normalized.status,
        truncated: normalized.truncated,
        failureCategory,
        ...(lease
          ? {
              scope: {
                context: lease.context,
                ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
                namespacePolicy: "unrestricted" as const,
                readOnly: true as const,
                scopeRevision: lease.scope.scopeRevision,
                selectionRevision: lease.scope.selectionRevision,
                inventoryRevision: lease.scope.inventoryRevision,
                connectionGeneration: lease.scope.connectionGeneration,
              },
            }
          : {}),
      },
      isError: true,
    };
    if (JSON.stringify(result).length > policy.maxTextChars) {
      result.details.truncated = true;
      let text = normalized.text;
      while (text.length && JSON.stringify(result).length > policy.maxTextChars) {
        text = text.slice(
          0,
          Math.max(0, text.length - (JSON.stringify(result).length - policy.maxTextChars)),
        );
        result.content[0]!.text = text;
      }
    }
    return result;
  };
  try {
    const effective = controller.currentScope();
    if (!effective.ok) return fail("scope-unavailable");
    if (effective.scope.connectionGeneration !== generation) return fail("stale-scope");
    const validation = validateMcpToolExecution(
      { name: mapping.mcpName, clusterDependent: true },
      args,
      controller.clusterState(),
    );
    if (!validation.ok) return fail(validation.category);
    if (typeof args.context !== "string") return fail("invalid-arguments");
    const context = identity(args.context);
    const namespace =
      args.namespace === undefined
        ? undefined
        : identity(typeof args.namespace === "string" ? args.namespace : "");
    const container =
      args.container === undefined
        ? undefined
        : identity(typeof args.container === "string" ? args.container : "");
    // Reserve presentation space only, never storage. Refuse an unrepresentable identity before transport.
    const preview = observationProvenance(
      effective.scope,
      {
        incidentId: effective.scope.incidentId,
        executionId: "x".repeat(128),
        evidenceId: "x".repeat(128),
      },
      context,
      namespace,
      new Date().toISOString(),
    );
    if (
      !presentObservation(
        { text: "\n[Result truncated]", status: "success", isError: false, truncated: true },
        preview,
        mapping,
        policy.maxTextChars,
      )
    )
      return fail("presentation-refused");
    const combined = connectionSignal
      ? signal
        ? AbortSignal.any([signal, connectionSignal])
        : connectionSignal
      : signal;
    const admission = await controller.admitExecution(
      effective.scope,
      {
        context,
        operation: mapping.mcpName,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(container !== undefined ? { container } : {}),
      },
      combined,
    );
    if (!admission.ok) return fail(admission.reason);
    lease = admission.lease;
    signal?.throwIfAborted();
    if (connectionSignal?.aborted || !controller.isCurrent(lease)) return fail("stale-scope");
    const execution = controller.dispatchExecution(lease);
    let raw: unknown;
    try {
      raw = await connection.callTool(mapping.mcpName, args, combined);
    } catch (error) {
      signal?.throwIfAborted();
      if (!controller.isCurrent(lease) || connectionSignal?.aborted) return fail("stale-scope");
      return fail(
        connection.state && connection.state !== "ready"
          ? "transport-unavailable"
          : classifyToolFailure(error),
      );
    }
    const completedAt = new Date().toISOString();
    signal?.throwIfAborted();
    if (!controller.isCurrent(lease) || connectionSignal?.aborted) return fail("stale-scope");
    if (connection.state && connection.state !== "ready") return fail("transport-unavailable");
    const normalized = normalizeMcpResult(raw, policy);
    if (normalized.status !== "success") {
      const failure = fail(normalized.failureCategory ?? "invalid-result");
      if (normalized.status === "invalid-result") category = "malformed";
      return failure;
    }
    const presented = presentObservation(
      normalized,
      observationProvenance(lease.scope, execution, context, namespace, completedAt),
      mapping,
      policy.maxTextChars,
    );
    if (!presented) return fail("presentation-refused");
    signal?.throwIfAborted();
    if (!controller.isCurrent(lease) || connectionSignal?.aborted) return fail("stale-scope");
    // No await between final authority/cancellation check, commit and publication.
    controller.recordObservation(lease, {
      excerpt: presented.excerpt,
      truncated: presented.result.details.truncated,
      completedAt,
    });
    return presented.result;
  } catch (error) {
    signal?.throwIfAborted();
    if (connectionSignal?.aborted) return fail("stale-scope");
    if (!(error instanceof DomainError)) throw error;
    return fail(
      error.failure.kind === "budget-refused"
        ? "budget-refused"
        : error.failure.kind === "capacity-refused"
          ? "storage-refused"
          : lease
            ? "stale-scope"
            : "invalid-arguments",
    );
  } finally {
    if (lease) controller.release(lease, category);
  }
}
