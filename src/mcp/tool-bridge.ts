import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";
import { Format } from "typebox/format";
import { Value } from "typebox/value";
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
import { isSupportedInputSchema } from "./tool-schema.js";
import { redactDiagnosticText } from "./redaction.js";
import { evaluateToolExecutionPolicy } from "../runtime/tool-policy.js";

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

export class McpToolBridgeError extends Error {
  constructor(options?: ErrorOptions) {
    super("Kubernetes MCP tool schema cannot be adapted safely.", options);
    this.name = "McpToolBridgeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkExecutableSchema(schema: Readonly<Record<string, unknown>>): void {
  if (typeof schema.pattern === "string") new RegExp(schema.pattern);
  if (typeof schema.format === "string" && !Format.Has(schema.format)) {
    throw new McpToolBridgeError();
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) {
    throw new McpToolBridgeError();
  }
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ] as const) {
    const lower = schema[min];
    const upper = schema[max];
    if (typeof lower === "number" && typeof upper === "number" && lower > upper) {
      throw new McpToolBridgeError();
    }
  }
  // The structural gate has already validated these children; narrow again at
  // this dynamic boundary rather than asserting their types.
  if (isRecord(schema.properties)) {
    for (const child of Object.values(schema.properties)) {
      if (isRecord(child)) checkExecutableSchema(child);
    }
  }
  if (isRecord(schema.items)) checkExecutableSchema(schema.items);
}

/** TypeBox 1 supports JSON Schema directly; no general schema conversion is needed. */
export function adaptMcpInputSchema(value: unknown): TUnsafe<Record<string, unknown>> {
  if (!isSupportedInputSchema(value)) throw new McpToolBridgeError();
  try {
    const schema = structuredClone(value);
    checkExecutableSchema(schema);
    // Unsafe supplies the static type only, after runtime schema validation.
    // Value.Check still enforces every JSON Schema constraint on actual arguments.
    return Type.Unsafe<Record<string, unknown>>(schema);
  } catch (error) {
    if (error instanceof McpToolBridgeError) throw error;
    throw new McpToolBridgeError({ cause: error });
  }
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
  // Capture the validated descriptor: external mutation cannot change a registered contract.
  const tool = structuredClone(descriptor);
  const clusterDependent = tool.name === "pods_list";
  if (evaluateToolExecutionPolicy(tool).status !== "exposed") {
    throw new Error("Kubernetes MCP tool is not approved for execution.");
  }
  if (clusterDependent && !binding) {
    throw new Error(
      "Cluster-dependent Kubernetes MCP tool requires an application-owned scope binding.",
    );
  }

  const modelParameters = adaptMcpInputSchema(tool.inputSchema);
  if (clusterDependent) {
    if (!isRecord(modelParameters)) throw new McpToolBridgeError();
    const properties = modelParameters.properties;
    if (
      !isRecord(properties) ||
      !Object.hasOwn(properties, "context") ||
      !isRecord(properties.context) ||
      properties.context.type !== "string"
    ) {
      throw new McpToolBridgeError();
    }
    delete properties.context;
    if (Array.isArray(modelParameters.required)) {
      modelParameters.required = modelParameters.required.filter((name) => name !== "context");
    }
  }
  const mapping: ToolNameMapping = { piName: tool.name, mcpName: tool.name };
  return {
    name: mapping.piName,
    label: mapping.piName,
    description: tool.description ?? "Query Kubernetes through an approved read-only MCP tool.",
    parameters: modelParameters,
    ...(clusterDependent
      ? {
          prepareArguments(args: unknown) {
            if (!isRecord(args)) throw new Error("Invalid arguments for the Kubernetes MCP tool.");
            const prepared = { ...args };
            delete prepared.context;
            return prepared;
          },
        }
      : {}),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      if (evaluateToolExecutionPolicy(tool).status !== "exposed") {
        return bridgeResult(normalizeToolFailure("tool-not-approved", policy), mapping);
      }
      if (binding && binding.manager.state.connectionGeneration !== binding.connectionGeneration) {
        return bridgeResult(normalizeToolFailure("stale-scope", policy), mapping);
      }
      if (connection.state && connection.state !== "ready") {
        return bridgeResult(normalizeToolFailure("transport-unavailable", policy), mapping);
      }
      if (!isRecord(params)) {
        return bridgeResult(normalizeToolFailure("invalid-arguments", policy), mapping);
      }
      const args = structuredClone(params);
      if (clusterDependent) delete args.context;
      if (!Value.Check(modelParameters, args)) {
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
      const serverParameters = adaptMcpInputSchema(tool.inputSchema);
      if (!Value.Check(serverParameters, args)) {
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
