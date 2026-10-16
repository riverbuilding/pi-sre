import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RESULT_POLICY, type ResultPolicy } from "../config/schema.js";
import type { ClusterContextManager, ClusterScopeSnapshot } from "../cluster/context-manager.js";
import {
  classifyToolFailure,
  normalizeMcpResult,
  normalizeToolFailure,
  type NormalizedMcpResult,
  type ToolFailureCategory,
} from "./result-normalizer.js";

import type { McpConnection } from "./connection.js";
import type { McpToolDescriptor } from "./tool-discovery.js";
import { evaluateToolPolicy, validateMcpToolContract } from "../runtime/tool-policy.js";
import { prepareMcpToolArguments } from "../runtime/tool-call-preparation.js";
import { allowsMcpToolExecution } from "../runtime/tool-execution-policy.js";
import { redactDiagnosticText } from "./redaction.js";

export interface ToolScopeBinding {
  readonly manager: ClusterContextManager;
  readonly connectionGeneration: number;
}

export interface McpToolScope {
  readonly context: string;
  /** Omission means server/context policy, not an all-namespace query. */
  readonly namespace?: string;
  readonly readOnly: true;
  readonly connectionGeneration: number;
  readonly registryRevision: number;
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
  const validated = validateMcpToolContract(descriptor);
  // Capture only approval metadata; executable input schemas belong to the contract.
  const tool = {
    name: descriptor.name,
    ...(descriptor.annotations ? { annotations: { ...descriptor.annotations } } : {}),
  };
  const { contract, modelParameters } = validated;
  const clusterDependent = contract.clusterDependent;
  if (clusterDependent && !binding) {
    throw new Error(
      "Cluster-dependent Kubernetes MCP tool requires an application-owned scope binding.",
    );
  }

  const mapping: ToolNameMapping = { piName: tool.name, mcpName: tool.name };
  function prepareArguments(value: unknown): Record<string, unknown> | undefined {
    const args = prepareMcpToolArguments(contract, value);
    if (!args || !validated.validateModelArguments(args)) return undefined;
    return allowsMcpToolExecution(tool.name, args) ? args : undefined;
  }
  return {
    name: mapping.piName,
    label: mapping.piName,
    description: contract.description,
    parameters: structuredClone(modelParameters),
    prepareArguments(args: unknown) {
      const prepared = prepareArguments(args);
      if (!prepared) throw new Error("Invalid arguments for the Kubernetes MCP tool.");
      return prepared;
    },
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      if (evaluateToolPolicy(tool).status !== "exposed") {
        return bridgeResult(normalizeToolFailure("tool-not-approved", policy), mapping);
      }
      if (binding && binding.manager.state.connectionGeneration !== binding.connectionGeneration) {
        return bridgeResult(normalizeToolFailure("stale-scope", policy), mapping);
      }
      if (connection.state && connection.state !== "ready") {
        return bridgeResult(normalizeToolFailure("transport-unavailable", policy), mapping);
      }
      const args = prepareArguments(params);
      if (!args) {
        return bridgeResult(normalizeToolFailure("invalid-arguments", policy), mapping);
      }
      let snapshot: ClusterScopeSnapshot | undefined;
      let scope: McpToolScope | undefined;
      if (clusterDependent && binding) {
        snapshot = binding.manager.captureScope();
        if (!snapshot) {
          const status = binding.manager.state.status;
          return bridgeResult(
            normalizeToolFailure(
              status === "unbound" || status === "not-configured"
                ? "scope-unbound"
                : "scope-unavailable",
              policy,
            ),
            mapping,
          );
        }
        args.context = snapshot.context;
        scope = {
          context: snapshot.context,
          ...(typeof args.namespace === "string"
            ? { namespace: redactDiagnosticText(args.namespace).slice(0, 253) }
            : {}),
          readOnly: true,
          connectionGeneration: snapshot.connectionGeneration,
          registryRevision: snapshot.registryRevision,
        };
      }
      if (!validated.validateTransportArguments(args)) {
        return bridgeResult(
          normalizeToolFailure("incompatible-schema", policy),
          mapping,
          scope,
          policy,
        );
      }
      // Also protect direct bridge callers, independently of Pi's agent lifecycle hooks.
      const release = snapshot ? binding?.manager.beginAgentWork() : undefined;
      let raw: unknown;
      try {
        raw = await connection.callTool(mapping.mcpName, args, signal);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (snapshot && binding && !binding.manager.isCurrent(snapshot)) {
          return bridgeResult(normalizeToolFailure("stale-scope", policy), mapping, scope, policy);
        }
        const category =
          connection.state && connection.state !== "ready"
            ? "transport-unavailable"
            : classifyToolFailure(error);
        return bridgeResult(normalizeToolFailure(category, policy), mapping, scope, policy);
      } finally {
        release?.();
      }
      signal?.throwIfAborted();
      if (
        binding &&
        (binding.manager.state.connectionGeneration !== binding.connectionGeneration ||
          (snapshot && !binding.manager.isCurrent(snapshot)))
      ) {
        return bridgeResult(normalizeToolFailure("stale-scope", policy), mapping, scope, policy);
      }
      if (connection.state && connection.state !== "ready") {
        return bridgeResult(
          normalizeToolFailure("transport-unavailable", policy),
          mapping,
          scope,
          policy,
        );
      }
      return bridgeResult(normalizeMcpResult(raw, policy), mapping, scope, policy);
    },
  };
}
