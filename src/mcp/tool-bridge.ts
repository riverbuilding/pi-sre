import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ExecutionQueue,
  type ExecutionAdmission,
  type ExecutionAdmissionFailure,
} from "../cluster/execution-queue.js";
import { DEFAULT_RESULT_POLICY, type ResultPolicy } from "../config/schema.js";
import type {
  ClusterExecutionAuthority,
  ClusterExecutionSnapshot,
} from "../cluster/context-manager.js";
import {
  classifyToolFailure,
  normalizeMcpResult,
  normalizeToolFailure,
  type NormalizedMcpResult,
  type ToolFailureCategory,
} from "./result-normalizer.js";

import type { McpConnection } from "./connection.js";
import type { McpToolDescriptor } from "./tool-discovery.js";
import { evaluateToolPolicy, prepareMcpToolSchema } from "../runtime/tool-policy.js";
import { prepareMcpToolArguments } from "../runtime/tool-call-preparation.js";
import {
  allowsMcpToolExecution,
  validateMcpToolExecution,
} from "../runtime/tool-execution-policy.js";
import type { InvestigationController } from "../app/investigation-controller.js";
import { executeIncidentDiagnostic } from "./incident-diagnostic.js";
import { redactDiagnosticText } from "./redaction.js";

export interface ToolScopeBinding {
  readonly manager: ClusterExecutionAuthority;
  readonly investigation?: InvestigationController;
  readonly connectionGeneration: number;
  readonly signal?: AbortSignal;
}

export interface McpToolScope {
  readonly context: string;
  readonly namespacePolicy: "unrestricted";
  /** Omission means server/context policy, not an all-namespace query. */
  readonly namespace?: string;
  readonly readOnly: true;
  readonly connectionGeneration: number;
  readonly inventoryRevision: number;
  readonly selectionRevision: number;
  readonly scopeRevision?: number;
}

export interface ToolNameMapping {
  readonly piName: string;
  readonly mcpName: string;
}

export interface McpToolDetails {
  readonly tool: ToolNameMapping;
  readonly status: "success" | "tool-error" | "invalid-result";
  readonly truncated: boolean;
  readonly failureCategory?: ToolFailureCategory;
  readonly scope?: McpToolScope;
  readonly evidenceId?: string;
  readonly executionId?: string;
  readonly incidentId?: string;
  readonly completedAt?: string;
}

function bridgeResult(
  result: NormalizedMcpResult,
  mapping: ToolNameMapping,
  scope?: McpToolScope,
  policy: ResultPolicy = DEFAULT_RESULT_POLICY,
) {
  const presentation = scope
    ? normalizeMcpResult(
        {
          content: [
            {
              type: "text",
              text: `Scope: context=${JSON.stringify(scope.context)}, namespace=${
                scope.namespace === undefined
                  ? "server/context policy (not asserted)"
                  : JSON.stringify(scope.namespace)
              }; READ ONLY\n${result.text}`,
            },
          ],
        },
        policy,
      )
    : result;
  return {
    content: [{ type: "text" as const, text: presentation.text }],
    details: {
      tool: mapping,
      status: result.status,
      truncated: result.truncated || presentation.truncated,
      ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
      ...(scope ? { scope } : {}),
    } satisfies McpToolDetails,
    isError: result.isError,
  };
}

export function createMcpToolBridge(
  descriptor: McpToolDescriptor,
  connection: Pick<McpConnection, "callTool"> & Partial<Pick<McpConnection, "state">>,
  policy: ResultPolicy = DEFAULT_RESULT_POLICY,
  binding?: ToolScopeBinding,
): ToolDefinition {
  const schema = prepareMcpToolSchema(descriptor);
  // Capture the approved name; descriptor and public schema mutations cannot change calls.
  const tool = { name: descriptor.name };
  const { policy: toolPolicy } = schema;
  const clusterDependent = toolPolicy.clusterDependent;
  if (clusterDependent && !binding) {
    throw new Error(
      "Cluster-dependent Kubernetes MCP tool requires an application-owned scope binding.",
    );
  }

  const authority = binding?.manager;
  const unboundQueue = authority ? undefined : new ExecutionQueue();
  const generation = binding?.connectionGeneration;
  const connectionSignal = binding?.signal;
  const mapping: ToolNameMapping = { piName: tool.name, mcpName: tool.name };
  function prepareArguments(value: unknown): Record<string, unknown> | undefined {
    const args = prepareMcpToolArguments(toolPolicy, value);
    if (!args || !schema.validateArguments(args)) return undefined;
    return allowsMcpToolExecution(tool.name, args) ? args : undefined;
  }
  return {
    name: mapping.piName,
    label: mapping.piName,
    description: `${descriptor.description ?? descriptor.name}${tool.name === "pods_log" ? " Pi SRE limits: tail defaults to 100 lines; allowed range 1–1000; streaming is disabled." : ""}`,
    parameters: structuredClone(schema.parameters),
    executionMode: "parallel",
    prepareArguments(args: unknown) {
      const prepared = prepareArguments(args);
      if (!prepared) throw new Error("Invalid arguments for the Kubernetes MCP tool.");
      return prepared;
    },
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const fail = (category: ToolFailureCategory, scope?: McpToolScope) =>
        bridgeResult(normalizeToolFailure(category, policy), mapping, scope, policy);
      const connectionCurrent = () =>
        !authority || (generation !== undefined && authority.isConnectionCurrent(generation));
      if (evaluateToolPolicy(tool).status !== "exposed") return fail("tool-not-approved");
      if (!connectionCurrent()) return fail("stale-scope");
      if (connection.state && connection.state !== "ready") return fail("transport-unavailable");
      const args = prepareMcpToolArguments(toolPolicy, params);
      if (!args || !schema.validateArguments(args)) return fail("invalid-arguments");
      if (clusterDependent && binding?.investigation) {
        return executeIncidentDiagnostic({
          controller: binding.investigation,
          connection,
          generation: binding.connectionGeneration,
          mapping,
          args,
          policy,
          ...(signal ? { signal } : {}),
          ...(connectionSignal ? { connectionSignal } : {}),
        });
      }
      const execution = validateMcpToolExecution(toolPolicy, args, authority?.state);
      if (!execution.ok) return fail(execution.category);
      const selectionRevision = authority?.state.selection.selectionRevision;
      const inventoryRevision = authority?.state.inventoryRevision;
      const checkAdmission = (): ExecutionAdmissionFailure | undefined => {
        if (!connectionCurrent()) return "stale-scope";
        if (connectionSignal?.aborted) return "transport-unavailable";
        if (connection.state && connection.state !== "ready") return "transport-unavailable";
        if (
          authority &&
          (authority.state.selection.selectionRevision !== selectionRevision ||
            authority.state.inventoryRevision !== inventoryRevision)
        )
          return "stale-scope";
        if (
          authority &&
          (authority.state.status === "unavailable" ||
            authority.state.status === "connecting" ||
            authority.state.status === "enumeration-failed")
        )
          return clusterDependent ? "scope-unavailable" : "transport-unavailable";
        const validation = validateMcpToolExecution(toolPolicy, args, authority?.state);
        return validation.ok ? undefined : validation.category;
      };
      let releaseSlot: (() => void) | undefined;
      let snapshot: ClusterExecutionSnapshot | undefined;
      let scope: McpToolScope | undefined;
      let release: (() => void) | undefined;
      try {
        release = authority?.beginAgentWork();
        const admissionSignal = connectionSignal
          ? signal
            ? AbortSignal.any([signal, connectionSignal])
            : connectionSignal
          : signal;
        let admission: ExecutionAdmission;
        try {
          const pending = authority
            ? authority.admitExecution(checkAdmission, admissionSignal)
            : unboundQueue!.acquire(checkAdmission, admissionSignal);
          admission = pending instanceof Promise ? await pending : pending;
        } catch (error) {
          signal?.throwIfAborted();
          if (connectionSignal?.aborted) return fail(checkAdmission() ?? "transport-unavailable");
          throw error;
        }
        if (admission.ok) releaseSlot = admission.release;
        signal?.throwIfAborted();
        if (!admission.ok) {
          const failure = normalizeToolFailure(admission.category, policy);
          return bridgeResult(
            admission.category === "timeout"
              ? { ...failure, text: "Kubernetes MCP admission wait timed out before dispatch." }
              : failure,
            mapping,
            undefined,
            policy,
          );
        }
        const invalid = checkAdmission();
        if (invalid) return fail(invalid);
        if (execution.context !== undefined && authority && generation !== undefined) {
          snapshot = authority.captureExecution(generation, execution.context);
          if (!snapshot) return fail("scope-unavailable");
          scope = {
            context: snapshot.context,
            namespacePolicy: snapshot.namespacePolicy,
            ...(typeof args.namespace === "string"
              ? { namespace: redactDiagnosticText(args.namespace).slice(0, 253) }
              : {}),
            readOnly: true,
            connectionGeneration: snapshot.connectionGeneration,
            inventoryRevision: snapshot.inventoryRevision,
            selectionRevision: snapshot.selectionRevision,
          };
        }
        const current = () =>
          !connectionSignal?.aborted &&
          connectionCurrent() &&
          (!snapshot || authority?.isExecutionCurrent(snapshot));
        signal?.throwIfAborted();
        if (!current()) return fail("stale-scope", scope);
        let raw: unknown;
        try {
          raw = await connection.callTool(mapping.mcpName, args, admissionSignal);
        } catch (error) {
          signal?.throwIfAborted();
          if (!current()) return fail("stale-scope", scope);
          return fail(
            connection.state && connection.state !== "ready"
              ? "transport-unavailable"
              : classifyToolFailure(error),
            scope,
          );
        }
        signal?.throwIfAborted();
        if (!current()) return fail("stale-scope", scope);
        if (connection.state && connection.state !== "ready")
          return fail("transport-unavailable", scope);
        const result = bridgeResult(normalizeMcpResult(raw, policy), mapping, scope, policy);
        signal?.throwIfAborted();
        if (!current()) return fail("stale-scope", scope);
        return result;
      } finally {
        if (snapshot) authority?.releaseExecution(snapshot);
        releaseSlot?.();
        release?.();
      }
    },
  };
}
