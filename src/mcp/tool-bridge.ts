import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";
import { Format } from "typebox/format";
import { Value } from "typebox/value";
import { z } from "zod";

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

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
const CallResult = z.object({
  content: z.array(TextBlock),
  isError: z.boolean().optional(),
});
const MAX_TEXT_LENGTH = 8_000;

/** Slice 5 handles text results only. Other content requires Slice 6 normalization. */
export function createMcpToolBridge(
  descriptor: McpToolDescriptor,
  connection: Pick<McpConnection, "callTool">,
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
      if (!isRecord(params) || !Value.Check(parameters, params)) {
        throw new Error(`Invalid arguments for Kubernetes MCP tool ${mapping.piName}.`);
      }
      signal?.throwIfAborted();
      let raw: unknown;
      try {
        raw = await connection.callTool(mapping.mcpName, params, signal);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        throw new Error(`Kubernetes MCP operation ${mapping.mcpName} failed.`, { cause: error });
      }
      const parsed = CallResult.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text",
              text: "Kubernetes MCP returned an unsupported or invalid tool result.",
            },
          ],
          details: { tool: mapping, status: "invalid-result", truncated: false },
          isError: true,
        };
      }
      const isError = parsed.data.isError === true;
      // Do not relay untrusted error payloads (which can include credentials).
      const text = isError
        ? `Kubernetes MCP tool ${mapping.mcpName} reported an execution error.`
        : parsed.data.content.map((block) => block.text).join("\n") ||
          "Tool completed successfully with no content.";
      const truncated = text.length > MAX_TEXT_LENGTH;
      return {
        content: [
          {
            type: "text",
            text: truncated ? `${text.slice(0, MAX_TEXT_LENGTH)}\n[Result truncated]` : text,
          },
        ],
        details: { tool: mapping, status: isError ? "tool-error" : "success", truncated },
        isError,
      };
    },
  };
}
