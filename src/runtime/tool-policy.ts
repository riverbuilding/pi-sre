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
    { name: "configuration_view", clusterDependent: false },
    { name: "pods_list", clusterDependent: true },
    { name: "pods_list_in_namespace", clusterDependent: true },
    { name: "pods_top", clusterDependent: true },
    { name: "nodes_log", clusterDependent: true },
    { name: "nodes_stats_summary", clusterDependent: true },
    { name: "nodes_top", clusterDependent: true },
    { name: "resources_list", clusterDependent: true },
    { name: "resources_get", clusterDependent: true },
    { name: "projects_list", clusterDependent: true },
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
  readonly info: { readonly path: string; readonly message: string };

  constructor(
    reason: "not-allowlisted" | "incompatible-schema",
    info: { readonly path: string; readonly message: string },
  ) {
    super(`Kubernetes MCP tool rejected at ${info.path}: ${info.message}`);
    this.name = "McpToolSchemaError";
    this.reason = reason;
    this.info = info;
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
  if (!policy)
    throw new McpToolSchemaError("not-allowlisted", {
      path: "name",
      message: "Tool is not approved for execution.",
    });
  const schema = tool.inputSchema;
  if (schema.type !== "object")
    throw new McpToolSchemaError("incompatible-schema", {
      path: "inputSchema.type",
      message: 'Expected "object".',
    });
  if (schema.properties !== undefined && !isRecord(schema.properties))
    throw new McpToolSchemaError("incompatible-schema", {
      path: "inputSchema.properties",
      message: "Expected an object of property schemas.",
    });
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required))
      throw new McpToolSchemaError("incompatible-schema", {
        path: "inputSchema.required",
        message: "Expected an array of property names.",
      });
    const invalidIndex = schema.required.findIndex((name) => typeof name !== "string");
    if (invalidIndex !== -1)
      throw new McpToolSchemaError("incompatible-schema", {
        path: `inputSchema.required[${invalidIndex}]`,
        message: "Expected a string property name.",
      });
  }
  if (
    policy.clusterDependent &&
    (!isRecord(schema.properties) || !Object.hasOwn(schema.properties, "context"))
  )
    throw new McpToolSchemaError("incompatible-schema", {
      path: "inputSchema.properties.context",
      message: "Cluster-dependent tools must declare a context parameter.",
    });

  const modelSchema: Record<string, unknown> = structuredClone(schema);
  if (policy.clusterDependent) {
    if (!isRecord(modelSchema.properties))
      throw new McpToolSchemaError("incompatible-schema", {
        path: "inputSchema.properties",
        message: "Copied schema must contain an object of property schemas.",
      });
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
