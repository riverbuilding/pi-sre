import { Type, type TUnsafe } from "typebox";
import { Value } from "typebox/value";
import type { McpToolDescriptor } from "../mcp/tool-discovery.js";

export interface McpToolPolicy {
  readonly name: string;
  readonly clusterDependent: boolean;
}

/** Pi SRE owns capabilities and scope; the trusted server owns their schemas. */
export const MCP_TOOL_POLICIES: readonly McpToolPolicy[] = Object.freeze(
  [
    { name: "configuration_contexts_list", clusterDependent: false },
    { name: "pods_list", clusterDependent: true },
    { name: "pods_get", clusterDependent: true },
    { name: "pods_log", clusterDependent: true },
    { name: "events_list", clusterDependent: true },
    { name: "namespaces_list", clusterDependent: true },
  ].map((policy) => Object.freeze(policy)),
);

export function getMcpToolPolicy(name: string): McpToolPolicy | undefined {
  return MCP_TOOL_POLICIES.find((policy) => policy.name === name);
}

export type ToolPolicyDecision =
  | { readonly status: "exposed" }
  | { readonly status: "rejected"; readonly reason: "not-allowlisted" };

export function evaluateToolPolicy(tool: { readonly name: string }): ToolPolicyDecision {
  return getMcpToolPolicy(tool.name)
    ? { status: "exposed" }
    : { status: "rejected", reason: "not-allowlisted" };
}

export class McpToolSchemaError extends Error {
  readonly reason: "not-allowlisted" | "incompatible-schema";

  constructor(reason: "not-allowlisted" | "incompatible-schema" = "incompatible-schema") {
    super(
      reason === "not-allowlisted"
        ? "Kubernetes MCP tool is not approved for execution."
        : "Kubernetes MCP tool requires an object input schema and a declared context parameter for cluster-dependent operations.",
    );
    this.name = "McpToolSchemaError";
    this.reason = reason;
  }
}

export interface PreparedToolSchema {
  readonly policy: McpToolPolicy;
  readonly parameters: TUnsafe<Record<string, unknown>>;
  validateArguments(value: unknown): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(schema: TUnsafe<Record<string, unknown>>, value: unknown): boolean {
  // Unsupported server constraints must not turn invalid model arguments into a call.
  try {
    return Value.Check(schema, value);
  } catch {
    return false;
  }
}

/** Copy discovered schemas; require exact model context while retaining discovered constraints. */
export function prepareMcpToolSchema(tool: McpToolDescriptor): PreparedToolSchema {
  const policy = getMcpToolPolicy(tool.name);
  if (!policy) throw new McpToolSchemaError("not-allowlisted");
  const schema = tool.inputSchema;
  if (
    schema.type !== "object" ||
    (schema.properties !== undefined && !isRecord(schema.properties)) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every((name) => typeof name === "string")))
  )
    throw new McpToolSchemaError();
  if (
    policy.clusterDependent &&
    (!isRecord(schema.properties) || !Object.hasOwn(schema.properties, "context"))
  )
    throw new McpToolSchemaError();

  const modelSchema: Record<string, unknown> = structuredClone(schema);
  if (policy.clusterDependent) {
    if (!isRecord(modelSchema.properties)) throw new McpToolSchemaError();
    const original = modelSchema.properties.context;
    modelSchema.properties.context = {
      allOf: [original, { type: "string", minLength: 1 }],
    };
    modelSchema.required = [
      ...new Set([...(Array.isArray(modelSchema.required) ? modelSchema.required : []), "context"]),
    ];
  }
  const parameters = Type.Unsafe<Record<string, unknown>>(modelSchema);
  return {
    policy,
    parameters,
    validateArguments: (value) => matches(parameters, value),
  };
}

export function acceptsToolContext(tool: McpToolDescriptor, context: string): boolean {
  const parameters = tool.inputSchema.properties;
  if (
    !isRecord(parameters) ||
    (!isRecord(parameters.context) && typeof parameters.context !== "boolean")
  )
    return false;
  return matches(Type.Unsafe<Record<string, unknown>>(parameters.context), context);
}
