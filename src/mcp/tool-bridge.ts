import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
import { redactDiagnosticText } from "./redaction.js";

export interface ToolScopeBinding {
  readonly manager: ClusterExecutionAuthority;
  readonly connectionGeneration: number;
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
  const generation = binding?.connectionGeneration;
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
    executionMode: "sequential",
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
      const execution = validateMcpToolExecution(toolPolicy, args, authority?.state);
      if (!execution.ok) return fail(execution.category);
      let snapshot: ClusterExecutionSnapshot | undefined;
      let scope: McpToolScope | undefined;
      let release: (() => void) | undefined;
      try {
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
        release = authority?.beginAgentWork();
        const current = () =>
          connectionCurrent() && (!snapshot || authority?.isExecutionCurrent(snapshot));
        signal?.throwIfAborted();
        if (!current()) return fail("stale-scope", scope);
        let raw: unknown;
        try {
          raw = await connection.callTool(mapping.mcpName, args, signal);
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
        release?.();
      }
    },
  };
}
