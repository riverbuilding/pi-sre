import { isDeepStrictEqual } from "node:util";
import { Type, type Static, type TSchema, type TUnsafe } from "typebox";
import { Value } from "typebox/value";
import type { McpToolDescriptor } from "../mcp/tool-discovery.js";

/** Complete reviewed schemas. Runtime descriptors are compatibility evidence only. */
interface ArgumentTemplate {
  readonly type: "string" | "boolean" | "integer";
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface McpToolContractDefinition<Output extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly clusterDependent: boolean;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false | "not-true";
  };
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, ArgumentTemplate>>;
    readonly required: readonly string[];
    readonly additionalProperties: boolean;
  };
  /** Application-reviewed structuredContent shape; independent of server declarations. */
  readonly outputSchema?: Output;
}

export interface McpToolContract<
  Output extends TSchema = TSchema,
> extends McpToolContractDefinition<Output> {
  readonly modelSchema: TUnsafe<Record<string, unknown>>;
  readonly transportSchema: TUnsafe<Record<string, unknown>>;
  /** False when no output contract is defined; adapters select applicable success branches. */
  validateOutput(value: unknown): value is Static<Output>;
}

/** Used only for application-owned, acyclic contract data. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Derive executable schemas once, independently of runtime server descriptors. */
export function defineMcpToolContract<Output extends TSchema = TSchema>(
  definition: McpToolContractDefinition<Output>,
): McpToolContract<Output> {
  const reviewed = structuredClone(definition);
  const transportSchema = {
    ...reviewed.inputSchema,
    properties: { ...reviewed.inputSchema.properties },
    required: [...reviewed.inputSchema.required],
    additionalProperties: false,
  };
  const modelSchema = structuredClone(transportSchema);
  if (reviewed.clusterDependent) {
    delete modelSchema.properties.context;
    modelSchema.required = modelSchema.required.filter((name) => name !== "context");
  }
  return deepFreeze({
    ...reviewed,
    modelSchema: Type.Unsafe<Record<string, unknown>>(modelSchema),
    transportSchema: Type.Unsafe<Record<string, unknown>>(transportSchema),
    validateOutput(value: unknown): value is Static<Output> {
      return reviewed.outputSchema !== undefined && Value.Check(reviewed.outputSchema, value);
    },
  });
}

const stringArgument = { type: "string" } as const;
const fieldSelector = {
  type: "string",
  pattern: "^[.\\-A-Za-z0-9]+([=!,]{1,2}[./\\-A-Za-z0-9]+)+$",
} as const;
const labelSelector = { type: "string", pattern: "^([/_.\\-A-Za-z0-9=, ()!])+$" } as const;
const diagnosticAnnotations = { readOnlyHint: true, destructiveHint: "not-true" } as const;

export const CONFIGURATION_CONTEXTS_LIST_CONTRACT = defineMcpToolContract({
  name: "configuration_contexts_list",
  description: "List configured Kubernetes contexts without selecting or querying a cluster.",
  clusterDependent: false,
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
  outputSchema: Type.Object(
    {
      defaultContext: Type.Optional(Type.String()),
      contexts: Type.Array(
        Type.Object(
          { name: Type.String({ minLength: 1 }), server: Type.String(), default: Type.Boolean() },
          { additionalProperties: true },
        ),
      ),
    },
    { additionalProperties: true },
  ),
});

/** Exact reviewed surface. Adding a tool or argument requires editing its contract here. */
export const MCP_TOOL_CONTRACTS: readonly McpToolContract[] = Object.freeze([
  CONFIGURATION_CONTEXTS_LIST_CONTRACT,
  ...(
    [
      {
        name: "pods_list",
        description:
          "List pods in the selected cluster. Namespace coverage follows server/context and authorization policy; do not assume all namespaces.",
        clusterDependent: true,
        annotations: diagnosticAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            context: stringArgument,
            fieldSelector,
            labelSelector,
          },
          required: [],
          additionalProperties: true,
        },
      },
      {
        name: "pods_get",
        description:
          "Get a pod by name in the selected cluster. Omitted namespace uses server/context policy.",
        clusterDependent: true,
        annotations: diagnosticAnnotations,
        inputSchema: {
          type: "object",
          properties: { context: stringArgument, name: stringArgument, namespace: stringArgument },
          required: ["name"],
          additionalProperties: true,
        },
      },
      {
        name: "pods_log",
        description:
          "Read finite pod logs in the selected cluster. Tail defaults to 100 lines; allowed range 1–1000. Omitted namespace uses server/context policy.",
        clusterDependent: true,
        annotations: diagnosticAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            context: stringArgument,
            name: stringArgument,
            namespace: stringArgument,
            container: stringArgument,
            previous: { type: "boolean" },
            tail: { type: "integer", minimum: 0 },
          },
          required: ["name"],
          additionalProperties: true,
        },
      },
      {
        name: "events_list",
        description:
          "List events in the selected cluster, optionally filtered by namespace and fields. Omitted namespace follows server policy; do not assume all namespaces.",
        clusterDependent: true,
        annotations: diagnosticAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            context: stringArgument,
            namespace: stringArgument,
            fieldSelector,
          },
          required: [],
          additionalProperties: true,
        },
      },
      {
        name: "namespaces_list",
        description:
          "List cluster-scoped namespaces in the selected cluster, optionally filtered by fields.",
        clusterDependent: true,
        annotations: diagnosticAnnotations,
        inputSchema: {
          type: "object",
          properties: { context: stringArgument, fieldSelector },
          required: [],
          additionalProperties: true,
        },
      },
    ] satisfies readonly McpToolContractDefinition[]
  ).map(defineMcpToolContract),
]);

export function getMcpToolContract(name: string): McpToolContract | undefined {
  return MCP_TOOL_CONTRACTS.find((contract) => contract.name === name);
}

export type ToolPolicyRejection = "not-allowlisted" | "not-read-only" | "destructive";
export type ToolPolicyDecision =
  | { readonly status: "exposed" }
  | { readonly status: "rejected"; readonly reason: ToolPolicyRejection };

/** Rechecked at execution; descriptor compatibility is handled by the shared validator. */
export function evaluateToolPolicy(tool: {
  readonly name: string;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}): ToolPolicyDecision {
  const contract = getMcpToolContract(tool.name);
  if (!contract) return { status: "rejected", reason: "not-allowlisted" };
  if (tool.annotations?.readOnlyHint !== contract.annotations.readOnlyHint)
    return { status: "rejected", reason: "not-read-only" };
  if (
    tool.annotations.destructiveHint === true ||
    (contract.annotations.destructiveHint === false && tool.annotations.destructiveHint !== false)
  )
    return { status: "rejected", reason: "destructive" };
  return { status: "exposed" };
}

export class McpToolContractError extends Error {
  readonly reason: ToolPolicyRejection | "incompatible-schema";
  readonly path: string;

  constructor(
    options?: ErrorOptions & {
      readonly reason?: ToolPolicyRejection | "incompatible-schema";
      readonly path?: string;
    },
  ) {
    const reason = options?.reason ?? "incompatible-schema";
    const path = options?.path ?? "inputSchema";
    super(
      reason === "incompatible-schema"
        ? `Kubernetes MCP tool schema does not match the reviewed contract (${path}).`
        : "Kubernetes MCP tool is not approved for execution.",
      options,
    );
    this.name = "McpToolContractError";
    this.reason = reason;
    this.path = path;
  }
}

export interface ValidatedToolContract {
  readonly contract: McpToolContract;
  readonly modelParameters: TUnsafe<Record<string, unknown>>;
  readonly transportParameters: TUnsafe<Record<string, unknown>>;
  validateModelArguments(value: unknown): boolean;
  validateTransportArguments(value: unknown): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEMA_METADATA = new Set(["title", "description", "examples", "default"]);

/** Follow only trusted contract nodes; unexpected schema branches are rejected without recursion. */
function findSchemaMismatch(
  actual: unknown,
  expected: Readonly<Record<string, unknown>>,
  path: string,
): string | undefined {
  if (!isRecord(actual)) return path;
  if (Object.keys(actual).some((key) => !Object.hasOwn(expected, key) && !SCHEMA_METADATA.has(key)))
    return path;
  for (const [key, value] of Object.entries(expected)) {
    const candidate = actual[key];
    const location = `${path}.${key}`;
    if (key === "properties" && isRecord(value)) {
      if (!isRecord(candidate)) return location;
      if (Object.keys(candidate).some((name) => !Object.hasOwn(value, name))) return location;
      for (const [name, schema] of Object.entries(value)) {
        if (!isRecord(schema)) throw new Error("Invalid application-owned tool contract.");
        const mismatch = findSchemaMismatch(candidate[name], schema, `${location}.${name}`);
        if (mismatch) return mismatch;
      }
    } else if (key === "items" && isRecord(value)) {
      const mismatch = findSchemaMismatch(candidate, value, location);
      if (mismatch) return mismatch;
    } else if (key === "required" && Array.isArray(value)) {
      if (
        candidate !== undefined &&
        (!Array.isArray(candidate) || !candidate.every((name) => typeof name === "string"))
      )
        return location;
      const required = Array.isArray(candidate) ? [...candidate].sort() : [];
      if (!isDeepStrictEqual(required, [...value].sort())) return location;
    } else if (key === "additionalProperties") {
      if (!isDeepStrictEqual(candidate === undefined ? true : candidate, value)) return location;
    } else if (!isDeepStrictEqual(candidate, value)) {
      return location;
    }
  }
  return undefined;
}

/** Compare one descriptor with its reviewed template; no operation-specific branches. */
export function validateMcpToolContract(tool: McpToolDescriptor): ValidatedToolContract {
  const decision = evaluateToolPolicy(tool);
  if (decision.status === "rejected") {
    throw new McpToolContractError({
      reason: decision.reason,
      path: decision.reason === "not-allowlisted" ? "name" : "annotations",
    });
  }
  const contract = getMcpToolContract(tool.name);
  if (!contract) throw new McpToolContractError({ reason: "not-allowlisted", path: "name" });
  const mismatch = findSchemaMismatch(tool.inputSchema, contract.inputSchema, "inputSchema");
  if (mismatch) throw new McpToolContractError({ path: mismatch });
  if (tool.outputSchema !== undefined) {
    if (!isRecord(contract.outputSchema)) throw new McpToolContractError({ path: "outputSchema" });
    const outputMismatch = findSchemaMismatch(
      tool.outputSchema,
      contract.outputSchema,
      "outputSchema",
    );
    if (outputMismatch) throw new McpToolContractError({ path: outputMismatch });
  }

  const { modelSchema: modelParameters, transportSchema: transportParameters } = contract;
  return {
    contract,
    modelParameters,
    transportParameters,
    validateModelArguments: (value) => Value.Check(modelParameters, value),
    validateTransportArguments: (value) => Value.Check(transportParameters, value),
  };
}

/** Uses the same validated transport schema as calls; required model args are irrelevant here. */
export function acceptsToolContext(tool: McpToolDescriptor, context: string): boolean {
  const { transportParameters } = validateMcpToolContract(tool);
  if (
    !isRecord(transportParameters) ||
    !isRecord(transportParameters.properties) ||
    !isRecord(transportParameters.properties.context)
  )
    return false;
  return Value.Check(Type.Unsafe(transportParameters.properties.context), context);
}
