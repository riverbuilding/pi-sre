import { describe, expect, it, vi } from "vitest";

import { discoverMcpTools } from "../../../src/mcp/tool-discovery.js";
import { validateMcpToolContract } from "../../../src/runtime/tool-policy.js";
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";

const schema = { type: "object", properties: {} };
// Independent server-declaration fixture, not copied from the application contract.
const outputSchema = {
  type: "object",
  properties: {
    defaultContext: { type: "string" },
    contexts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          server: { type: "string" },
          default: { type: "boolean" },
        },
        required: ["name", "server", "default"],
        additionalProperties: true,
      },
    },
  },
  required: ["contexts"],
  additionalProperties: true,
};
const allowed = {
  name: "configuration_contexts_list",
  description: "List configured contexts",
  inputSchema: schema,
  annotations: { readOnlyHint: true, destructiveHint: false },
  outputSchema,
};

async function discover(tools: readonly unknown[]) {
  const listTools = vi.fn().mockResolvedValue(tools);
  const report = await discoverMcpTools({ listTools });
  expect(listTools).toHaveBeenCalledOnce();
  return report;
}

describe("MCP tool discovery", () => {
  it("compares output declarations with the contract while ignoring metadata and ordering", async () => {
    const declared = structuredClone(outputSchema);
    declared.properties.contexts.items.required.reverse();
    Reflect.deleteProperty(declared, "additionalProperties");
    Reflect.deleteProperty(declared.properties.contexts.items, "additionalProperties");
    Object.assign(declared, { title: "Context inventory", description: "server metadata" });
    Object.assign(declared.properties.contexts.items.properties.name, {
      description: "opaque name",
      examples: ["alpha"],
      default: "alpha",
    });
    const tool = { ...allowed, outputSchema: declared };
    expect((await discover([tool])).exposed).toEqual([tool]);
    expect(validateMcpToolContract(tool).contract.validateOutput({ contexts: [] })).toBe(true);
  });

  const changes: readonly {
    name: string;
    change: (schema: typeof outputSchema) => void;
    path: string;
  }[] = [
    {
      name: "root type",
      change: (s) => {
        s.type = "array";
      },
      path: "outputSchema.type",
    },
    {
      name: "required fields",
      change: (s) => {
        s.required.push("defaultContext");
      },
      path: "outputSchema.required",
    },
    {
      name: "openness",
      change: (s) => {
        s.additionalProperties = false;
      },
      path: "outputSchema.additionalProperties",
    },
    {
      name: "missing property",
      change: (s) => {
        Reflect.deleteProperty(s.properties, "defaultContext");
      },
      path: "outputSchema.properties.defaultContext",
    },
    {
      name: "array item type",
      change: (s) => {
        s.properties.contexts.items.type = "string";
      },
      path: "outputSchema.properties.contexts.items.type",
    },
    {
      name: "nested field type",
      change: (s) => {
        s.properties.contexts.items.properties.default.type = "string";
      },
      path: "outputSchema.properties.contexts.items.properties.default.type",
    },
    {
      name: "nested required fields",
      change: (s) => {
        s.properties.contexts.items.required.pop();
      },
      path: "outputSchema.properties.contexts.items.required",
    },
    {
      name: "nested bounds",
      change: (s) => {
        s.properties.contexts.items.properties.name.minLength = 2;
      },
      path: "outputSchema.properties.contexts.items.properties.name.minLength",
    },
    {
      name: "unknown property",
      change: (s) => {
        Object.assign(s.properties.contexts.items.properties, {
          "token=PRIVATE": { type: "string" },
        });
      },
      path: "outputSchema.properties.contexts.items.properties",
    },
    {
      name: "unreviewed keyword",
      change: (s) => {
        Object.assign(s.properties.contexts, { maxItems: 10 });
      },
      path: "outputSchema.properties.contexts",
    },
    {
      name: "malformed items",
      change: (s) => {
        Object.assign(s.properties.contexts, { items: null });
      },
      path: "outputSchema.properties.contexts.items",
    },
  ];
  it.each(changes)(
    "rejects output drift: $name at discovery and direct validation",
    async ({ change, path }) => {
      const declared = structuredClone(outputSchema);
      change(declared);
      const tool = { ...allowed, outputSchema: declared };
      const report = await discover([tool]);
      expect(report.exposed).toEqual([]);
      expect(report.decisions).toEqual([
        {
          name: allowed.name,
          status: "rejected",
          reason: "incompatible-schema",
          contractPath: path,
        },
      ]);
      expect(JSON.stringify(report)).not.toContain("PRIVATE");
      expect(() => validateMcpToolContract(tool)).toThrow(expect.objectContaining({ path }));
    },
  );

  it.each([null, [], "schema"])("rejects malformed output envelopes %j", async (outputSchema) => {
    expect((await discover([{ ...allowed, outputSchema }])).decisions).toEqual([
      { status: "rejected", reason: "invalid-descriptor" },
    ]);
  });

  it("requires review when a tool without an output contract declares an output schema", async () => {
    const pods = diagnosticTools.find((tool) => tool.name === "pods_list");
    if (!pods) throw new Error("Missing captured diagnostic tool");
    const report = await discover([allowed, { ...pods, outputSchema: { type: "object" } }]);
    expect(report.exposed).toEqual([allowed]);
    expect(report.decisions).toContainEqual({
      name: "pods_list",
      status: "rejected",
      reason: "incompatible-schema",
      contractPath: "outputSchema",
    });
  });

  it("requires inputSchema but permits outputSchema to be omitted", async () => {
    const withoutOutput = {
      name: allowed.name,
      inputSchema: allowed.inputSchema,
      annotations: allowed.annotations,
    };
    const withoutInput = { name: allowed.name, annotations: allowed.annotations };

    expect((await discover([withoutOutput])).exposed).toEqual([withoutOutput]);
    expect((await discover([withoutInput])).decisions).toEqual([
      { status: "rejected", reason: "invalid-descriptor" },
    ]);
  });

  it("rejects a declared output schema with a non-object root", async () => {
    const report = await discover([
      { ...allowed, outputSchema: { type: "array", items: { type: "string" } } },
    ]);
    expect(report.decisions).toEqual([
      {
        name: allowed.name,
        status: "rejected",
        reason: "incompatible-schema",
        contractPath: "outputSchema",
      },
    ]);
  });

  it("preserves validated metadata and exposes only the exact safe tool", async () => {
    const report = await discover([
      allowed,
      {
        name: "configuration_view",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ]);
    expect(report.exposed).toEqual([allowed]);
    expect(report.decisions).toEqual([
      { name: "configuration_contexts_list", status: "exposed" },
      { name: "configuration_view", status: "rejected", reason: "not-allowlisted" },
    ]);
  });

  it.each([
    [{ ...allowed, annotations: undefined }, "not-read-only"],
    [{ ...allowed, annotations: { readOnlyHint: false } }, "not-read-only"],
    [{ ...allowed, annotations: { readOnlyHint: true, destructiveHint: true } }, "destructive"],
    [{ ...allowed, inputSchema: { type: "string" } }, "incompatible-schema"],
    [
      { ...allowed, outputSchema: { type: "object", properties: { bad: { oneOf: [] } } } },
      "incompatible-schema",
    ],
    [
      { ...allowed, inputSchema: { type: "object", properties: { x: { $ref: "#/$defs/x" } } } },
      "incompatible-schema",
    ],
    [{ ...allowed, name: "bad name" }, "invalid-descriptor"],
    [{ ...allowed, annotations: { readOnlyHint: "true" } }, "invalid-descriptor"],
  ])("rejects unsafe or malformed descriptors", async (tool, reason) => {
    const report = await discover([tool]);
    expect(report.exposed).toEqual([]);
    expect(report.decisions[0]).toMatchObject({ status: "rejected", reason });
  });

  it("rejects every duplicate and incompatible cluster-dependent tools", async () => {
    const report = await discover([
      allowed,
      { ...allowed, description: "duplicate" },
      { name: "pods_list", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ]);
    expect(report.exposed).toEqual([]);
    expect(report.decisions).toEqual([
      { name: allowed.name, status: "rejected", reason: "duplicate-name" },
      { name: allowed.name, status: "rejected", reason: "duplicate-name" },
      {
        name: "pods_list",
        status: "rejected",
        reason: "incompatible-schema",
        contractPath: "inputSchema.properties",
      },
    ]);
  });

  it("does not expose a valid descriptor when a malformed entry shares its name", async () => {
    const report = await discover([allowed, { name: allowed.name, inputSchema: "invalid" }]);
    expect(report.exposed).toEqual([]);
    expect(report.decisions).toContainEqual({
      name: allowed.name,
      status: "rejected",
      reason: "duplicate-name",
    });
    expect(report.decisions).toContainEqual({ status: "rejected", reason: "invalid-descriptor" });
  });

  it("returns a deterministic ordered inventory", async () => {
    const unknown = {
      name: "z_unknown",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    };
    const deferred = {
      name: "events_list",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    };
    const a = await discover([unknown, allowed, deferred]);
    const b = await discover([deferred, unknown, allowed]);
    expect(a).toEqual(b);
  });

  it("rejects unreviewed argument shapes directly against the contract", async () => {
    const inputSchema = {
      type: "object",
      title: "Diagnostic input",
      description: "Supported schema subset",
      properties: {
        names: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
        name: {
          type: "string",
          minLength: 0,
          maxLength: 20,
          pattern: "^[a-z]+$",
          format: "hostname",
        },
        ratio: { type: "number", minimum: 0, maximum: 1, exclusiveMinimum: -1, multipleOf: 0.1 },
        count: { type: "integer", minimum: 0, exclusiveMaximum: 10 },
        enabled: { type: "boolean", default: false, examples: [true], enum: [true, false] },
        empty: { type: "null" },
        target: {
          type: "object",
          properties: { namespace: { type: "string" } },
          required: ["namespace"],
        },
      },
      required: ["name", "target"],
      additionalProperties: false,
    };

    const report = await discover([{ ...allowed, inputSchema }]);

    expect(report.exposed).toEqual([]);
    expect(report.decisions).toEqual([
      {
        name: allowed.name,
        status: "rejected",
        reason: "incompatible-schema",
        contractPath: "inputSchema.properties",
      },
    ]);
  });

  it.each([
    { type: "object", properties: {}, required: ["missing"] },
    { type: "object", properties: {}, required: ["toString"] },
    { type: "object", additionalProperties: { type: "string" } },
    { type: "object", properties: { x: { type: "array" } } },
    {
      type: "object",
      properties: { x: { type: "array", items: { type: "string" }, minItems: -1 } },
    },
    { type: "object", properties: { x: { type: "string", maxLength: 1.5 } } },
    { type: "object", properties: { x: { type: "number", maximum: Infinity } } },
    { type: "object", properties: { x: { type: "boolean", enum: [] } } },
    { type: "object", properties: { x: { type: "string", minimum: 0 } } },
    { type: "object", properties: { x: { type: "constructor" } } },
  ])("rejects schema constraints outside the supported contract", async (inputSchema) => {
    const report = await discover([{ ...allowed, inputSchema }]);

    expect(report.exposed).toEqual([]);
    expect(report.decisions).toMatchObject([
      { status: "rejected", reason: "incompatible-schema", name: allowed.name },
    ]);
  });

  it("rejects unexpected input nesting without traversing it", async () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 20_000; depth++)
      nested = { type: "object", properties: { child: nested } };
    const report = await discover([{ ...allowed, inputSchema: nested }]);
    expect(report.exposed).toEqual([]);
    expect(report.decisions).toEqual([
      {
        name: allowed.name,
        status: "rejected",
        reason: "incompatible-schema",
        contractPath: "inputSchema.properties",
      },
    ]);
  });

  it("rejects unexpected output nesting without traversing it", async () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 20_000; depth++)
      nested = { type: "object", properties: { child: nested } };
    expect(
      (await discover([{ ...allowed, outputSchema: { ...nested, required: ["contexts"] } }]))
        .decisions,
    ).toEqual([
      {
        name: allowed.name,
        status: "rejected",
        reason: "incompatible-schema",
        contractPath: "outputSchema.properties",
      },
    ]);
  });
});
