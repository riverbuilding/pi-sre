import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";
import { Format } from "typebox/format";
import { Value } from "typebox/value";
import { DEFAULT_RESULT_POLICY, type ResultPolicy } from "../config/schema.js";
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
import { evaluateToolPolicy } from "../runtime/tool-policy.js";

export interface ToolNameMapping {
  readonly piName: string;
  readonly mcpName: string;
}

export interface McpToolDetails {
  readonly tool: ToolNameMapping;
  readonly status: "success" | "tool-error" | "invalid-result";
  readonly truncated: boolean;
  readonly failureCategory?: ToolFailureCategory;
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

function bridgeResult(result: NormalizedMcpResult, mapping: ToolNameMapping) {
  return {
    content: [{ type: "text" as const, text: result.text }],
    details: {
      tool: mapping,
      status: result.status,
      truncated: result.truncated,
      ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
    } satisfies McpToolDetails,
    isError: result.isError,
  };
}

export function createMcpToolBridge(
  descriptor: McpToolDescriptor,
  connection: Pick<McpConnection, "callTool"> & Partial<Pick<McpConnection, "state">>,
  policy: ResultPolicy = DEFAULT_RESULT_POLICY,
): ToolDefinition {
  if (evaluateToolPolicy(descriptor).status !== "exposed") {
    throw new Error("Kubernetes MCP tool is not approved for Phase 1.");
  }
  const parameters = adaptMcpInputSchema(descriptor.inputSchema);
  const mapping: ToolNameMapping = { piName: descriptor.name, mcpName: descriptor.name };
  return {
    name: mapping.piName,
    label: mapping.piName,
    description: descriptor.description ?? "List configured Kubernetes contexts (read-only).",
    parameters,
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      if (!isRecord(params) || !Value.Check(parameters, params)) {
        return bridgeResult(normalizeToolFailure("invalid-arguments", policy), mapping);
      }
      let raw: unknown;
      try {
        raw = await connection.callTool(mapping.mcpName, params, signal);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        const category =
          connection.state && connection.state !== "ready"
            ? "transport-unavailable"
            : classifyToolFailure(error);
        return bridgeResult(normalizeToolFailure(category, policy), mapping);
      }
      return bridgeResult(normalizeMcpResult(raw, policy), mapping);
    },
  };
}
