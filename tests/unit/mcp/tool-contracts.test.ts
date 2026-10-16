import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { discoverClusterContexts } from "../../../src/mcp/context-discovery.js";
import { discoverMcpTools, type McpToolDescriptor } from "../../../src/mcp/tool-discovery.js";
import {
  acceptsToolContext,
  defineMcpToolContract,
  validateMcpToolContract,
  MCP_TOOL_CONTRACTS,
  CONFIGURATION_CONTEXTS_LIST_CONTRACT,
} from "../../../src/runtime/tool-policy.js";
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";

function descriptor(name: string): McpToolDescriptor {
  const tool = diagnosticTools.find((tool) => tool.name === name);
  if (!tool) throw new Error("Missing captured descriptor");
  return structuredClone(tool);
}

function withArgument(
  name: string,
  argument: string,
  changes: Readonly<Record<string, unknown>>,
  remove?: string,
): McpToolDescriptor {
  const tool = descriptor(name);
  const properties = tool.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties))
    throw new Error("Invalid fixture");
  const original: unknown = Object.getOwnPropertyDescriptor(properties, argument)?.value;
  if (!original || typeof original !== "object" || Array.isArray(original))
    throw new Error("Invalid fixture argument");
  const next: Record<string, unknown> = { ...original, ...changes };
  if (remove) delete next[remove];
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { ...properties, [argument]: next } },
  };
}

describe("application-owned MCP contracts", () => {
  it("has independent captured evidence for every supported contract", () => {
    expect(MCP_TOOL_CONTRACTS.map((contract) => contract.name).sort()).toEqual(
      diagnosticTools.map((tool) => tool.name).sort(),
    );
  });

  it.each(diagnosticTools)(
    "reuses $name executable schemas prebuilt from the reviewed contract",
    (tool) => {
      const before = structuredClone(tool);
      const validated = validateMcpToolContract(tool);
      const again = validateMcpToolContract(structuredClone(tool));
      expect(validated.contract.name).toBe(tool.name);
      expect(validated.modelParameters).toBe(validated.contract.modelSchema);
      expect(validated.transportParameters).toBe(validated.contract.transportSchema);
      expect(again.modelParameters).toBe(validated.modelParameters);
      expect(again.transportParameters).toBe(validated.transportParameters);
      expect(validated.transportParameters).toMatchObject({ additionalProperties: false });
      expect(JSON.stringify(validated.modelParameters)).not.toContain("Defaults to alpha");
      expect(tool).toEqual(before);
      if (validated.contract.clusterDependent) {
        expect(JSON.stringify(validated.modelParameters)).not.toContain('"context"');
        expect(acceptsToolContext(tool, "beta")).toBe(true);
      }
    },
  );

  it("freezes every contract and nested schema node", () => {
    function expectDeeplyFrozen(value: unknown): void {
      if (typeof value !== "object" || value === null) return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) expectDeeplyFrozen(child);
    }
    expectDeeplyFrozen(MCP_TOOL_CONTRACTS);
    const validated = validateMcpToolContract(descriptor("pods_log"));
    const properties = validated.contract.inputSchema.properties;
    const tail = properties.tail;
    if (!tail) throw new Error("Missing reviewed log tail");
    expect(() => Object.assign(tail, { minimum: 999 })).toThrow(TypeError);
    expect(() => Object.assign(validated.modelParameters, { additionalProperties: true })).toThrow(
      TypeError,
    );
    expect(() => Object.assign(validated.transportParameters, { required: [] })).toThrow(TypeError);
    expect(validated.validateModelArguments({ name: "api", tail: 1 })).toBe(true);
    expect(validated.validateTransportArguments({ tail: 1 })).toBe(false);
  });

  it("derives context visibility and required fields without mutating the supplied definition", () => {
    const definition = {
      name: "example",
      description: "Example contract",
      clusterDependent: true,
      annotations: { readOnlyHint: true, destructiveHint: false } as const,
      inputSchema: {
        type: "object" as const,
        properties: { context: { type: "string" as const }, name: { type: "string" as const } },
        required: ["context", "name"],
        additionalProperties: true,
      },
      outputSchema: Type.Object({ status: Type.String() }),
    };
    const contract = defineMcpToolContract(definition);
    expect(contract.modelSchema).toMatchObject({
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(Value.Check(contract.modelSchema, { name: "api", context: "beta" })).toBe(false);
    expect(Value.Check(contract.transportSchema, { name: "api" })).toBe(false);
    expect(Value.Check(contract.transportSchema, { name: "api", context: "beta" })).toBe(true);
    expect(definition.inputSchema.required).toEqual(["context", "name"]);
    expect(Object.isFrozen(definition.inputSchema)).toBe(false);
    definition.inputSchema.required.length = 0;
    definition.inputSchema.additionalProperties = false;
    expect(contract.inputSchema.required).toEqual(["context", "name"]);
    expect(contract.inputSchema.additionalProperties).toBe(true);
    expect(contract.validateOutput({ status: "ready" })).toBe(true);
    Object.assign(definition.outputSchema.properties.status, { type: "integer" });
    expect(contract.validateOutput({ status: "ready" })).toBe(true);
    expect(contract.validateOutput({ status: 1 })).toBe(false);
  });

  it("validates application output contracts even without a server output declaration", () => {
    const tool = descriptor("configuration_contexts_list");
    expect(tool.outputSchema).toBeUndefined();
    const { contract } = validateMcpToolContract(tool);
    expect(contract).toBe(CONFIGURATION_CONTEXTS_LIST_CONTRACT);
    expect(contract.outputSchema).toBeDefined();
    expect(contract.validateOutput({ contexts: [] })).toBe(true);
    expect(contract.validateOutput({ defaultContext: "", contexts: [] })).toBe(true);
    expect(
      contract.validateOutput({
        defaultContext: "alpha",
        contexts: [{ name: "alpha", server: "https://example.invalid", default: true }],
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { contexts: null },
    { contexts: ["alpha"] },
    { contexts: [{ name: "alpha", server: "https://example.invalid" }] },
    { contexts: [{ name: "alpha", server: 42, default: false }] },
    { contexts: [{ name: "alpha", server: "", default: "false" }] },
    { contexts: [{ name: "", server: "", default: false }] },
    { defaultContext: null, contexts: [] },
  ])("rejects malformed structured output %# through the shared contract", (value) => {
    expect(CONFIGURATION_CONTEXTS_LIST_CONTRACT.validateOutput(value)).toBe(false);
  });

  it("leaves inventory consistency and failure/empty-result branches to the adapter", () => {
    const duplicate = { name: "alpha", server: "", default: false };
    expect(
      CONFIGURATION_CONTEXTS_LIST_CONTRACT.validateOutput({ contexts: [duplicate, duplicate] }),
    ).toBe(true);
    expect(
      CONFIGURATION_CONTEXTS_LIST_CONTRACT.validateOutput({
        defaultContext: "missing",
        contexts: [],
      }),
    ).toBe(true);
    const logs = validateMcpToolContract(descriptor("pods_log")).contract;
    expect(logs.outputSchema).toBeUndefined();
    expect(logs.validateOutput({ arbitrary: true })).toBe(false);
  });

  it("ignores metadata and object ordering without importing server defaults or descriptions", () => {
    const tool = withArgument("pods_log", "tail", {
      default: 9000,
      description: "untrusted server advice",
      title: "new title",
      examples: [9999],
    });
    const ordered = descriptor("pods_log");
    const metadata = {
      ...tool,
      description: "changed tool prose",
      inputSchema: {
        ...tool.inputSchema,
        properties: Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).reverse()),
      },
    };
    const validated = validateMcpToolContract(metadata);
    const baseline = validateMcpToolContract(ordered);
    expect(validated.modelParameters).toEqual(baseline.modelParameters);
    expect(validated.transportParameters).toEqual(baseline.transportParameters);
    expect(validated.modelParameters).toMatchObject({
      properties: { tail: { type: "integer", minimum: 0 } },
    });
    expect(JSON.stringify(validated.modelParameters)).not.toContain('"default"');
  });

  it("normalizes omitted JSON Schema defaults for required and additionalProperties", () => {
    const tool = descriptor("pods_list");
    expect(
      validateMcpToolContract({
        ...tool,
        inputSchema: { ...tool.inputSchema, required: [], additionalProperties: true },
      }).modelParameters,
    ).toEqual(validateMcpToolContract(tool).modelParameters);
  });

  it.each([
    ["pods_list", "labelSelector", { pattern: "^different$" }, undefined],
    ["pods_list", "labelSelector", {}, "pattern"],
    ["pods_list", "labelSelector", { pattern: "[" }, undefined],
    ["pods_list", "context", { enum: ["alpha"] }, undefined],
    ["pods_get", "name", { minLength: 1 }, undefined],
    ["pods_get", "name", { maxLength: 50 }, undefined],
    ["pods_get", "name", { format: "hostname" }, undefined],
    ["pods_get", "name", { format: "unreviewed-format" }, undefined],
    ["pods_log", "tail", { minimum: 1 }, undefined],
    ["pods_log", "tail", {}, "minimum"],
    ["pods_log", "tail", { maximum: 200 }, undefined],
    ["pods_log", "tail", { maximum: 2000 }, undefined],
    ["pods_log", "tail", { type: "number" }, undefined],
    ["pods_log", "tail", { exclusiveMaximum: 100 }, undefined],
    ["pods_log", "tail", { multipleOf: 3 }, undefined],
  ] as const)(
    "rejects unreviewed constraints for %s.%s: %j",
    async (name, argument, changes, remove) => {
      const changed = withArgument(name, argument, changes, remove);
      const others = diagnosticTools.filter((tool) => tool.name !== name);
      const report = await discoverMcpTools({ listTools: async () => [...others, changed] });
      expect(report.exposed.map((tool) => tool.name)).toEqual(others.map((tool) => tool.name));
      expect(report.decisions).toContainEqual(
        expect.objectContaining({
          name,
          status: "rejected",
          reason: "incompatible-schema",
        }),
      );
      expect(() => validateMcpToolContract(changed)).toThrow(
        "does not match the reviewed contract",
      );
    },
  );

  it.each([
    { required: [] },
    { required: ["name", "namespace"] },
    { additionalProperties: false },
    { properties: { context: { type: "string" }, name: { type: "string" } } },
  ])(
    "rejects changed required fields, openness, or missing optional declarations: %j",
    (change) => {
      const tool = descriptor("pods_get");
      expect(() =>
        validateMcpToolContract({ ...tool, inputSchema: { ...tool.inputSchema, ...change } }),
      ).toThrow("does not match the reviewed contract");
    },
  );

  it("enforces reviewed selector patterns and server log constraints in both call schemas", () => {
    const pods = validateMcpToolContract(descriptor("pods_list"));
    expect(Value.Check(pods.modelParameters, { fieldSelector: "status.phase=Running" })).toBe(true);
    expect(Value.Check(pods.modelParameters, { fieldSelector: "bad" })).toBe(false);
    const logs = validateMcpToolContract(descriptor("pods_log"));
    for (const tail of [-1, 1.5, "100", null]) {
      expect(Value.Check(logs.modelParameters, { name: "api", tail })).toBe(false);
      expect(Value.Check(logs.transportParameters, { name: "api", context: "beta", tail })).toBe(
        false,
      );
    }
    for (const tail of [0, 1, 100, 1000, 1001])
      expect(Value.Check(logs.transportParameters, { name: "api", context: "beta", tail })).toBe(
        true,
      );
    for (const raw of [null, [], "api", 42]) expect(logs.validateModelArguments(raw)).toBe(false);
  });

  it("reports safe contract paths without echoing unreviewed names", async () => {
    const tool = descriptor("pods_list");
    const properties = tool.inputSchema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      throw new Error("Invalid fixture");
    const report = await discoverMcpTools({
      listTools: async () => [
        {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...properties,
              "token=PRIVATE_FIXTURE": { type: "string" },
            },
          },
        },
      ],
    });
    expect(report.decisions).toEqual([
      {
        name: "pods_list",
        status: "rejected",
        reason: "incompatible-schema",
        contractPath: "inputSchema.properties",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_FIXTURE");
  });

  it.each([
    { properties: null },
    { properties: [] },
    { required: null },
    { required: "name" },
    { required: [{}] },
    { additionalProperties: null },
    { additionalProperties: {} },
  ])("rejects malformed schema fields without a separate schema grammar: %j", (change) => {
    const tool = descriptor("pods_get");
    expect(() =>
      validateMcpToolContract({
        ...tool,
        inputSchema: { ...tool.inputSchema, ...change },
      }),
    ).toThrow("does not match the reviewed contract");
  });

  it("validates without rewriting arguments or imposing application execution limits", () => {
    const contract = validateMcpToolContract(descriptor("pods_log"));
    const args = { name: "api" };
    expect(contract.validateModelArguments(args)).toBe(true);
    expect(args).toEqual({ name: "api" });
    for (const invalid of [
      {},
      { name: 1 },
      { name: "api", context: "alpha" },
      { name: "api", follow: true },
    ])
      expect(contract.validateModelArguments(invalid)).toBe(false);
    expect(contract.validateTransportArguments({ name: "api", context: "beta", tail: 100 })).toBe(
      true,
    );
    expect(contract.validateTransportArguments({ name: "api", context: 1, tail: 100 })).toBe(false);
    expect(contract.validateTransportArguments({ name: "api", context: "beta", tail: 0 })).toBe(
      true,
    );
    expect(contract.validateModelArguments({ name: "api", tail: 1001 })).toBe(true);
  });

  it.each([
    {
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    { inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    {
      inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      inputSchema: { type: "object", properties: {}, enum: [{ forbidden: true }] },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ] satisfies readonly Partial<McpToolDescriptor>[])(
    "enforces enumeration's contract at both boundaries: %j",
    async (change) => {
      const tool: McpToolDescriptor = { ...descriptor("configuration_contexts_list"), ...change };
      expect((await discoverMcpTools({ listTools: async () => [tool] })).exposed).toEqual([]);
      const callTool = vi.fn();
      await expect(
        discoverClusterContexts({ state: "ready", callTool }, { exposed: [tool], decisions: [] }),
      ).rejects.toMatchObject({ kind: "incompatible-tool" });
      expect(callTool).not.toHaveBeenCalled();
    },
  );
});
