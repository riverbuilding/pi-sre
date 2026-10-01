import { describe, expect, it, vi } from "vitest";

import { discoverMcpTools } from "../../../src/mcp/tool-discovery.js";

const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
const allowed = {
  name: "configuration_contexts_list",
  description: "List configured contexts",
  inputSchema: schema,
  annotations: { readOnlyHint: true, destructiveHint: false },
  outputSchema: { type: "object" },
};

async function discover(tools: readonly unknown[]) {
  const listTools = vi.fn().mockResolvedValue(tools);
  const report = await discoverMcpTools({ listTools });
  expect(listTools).toHaveBeenCalledOnce();
  return report;
}

describe("MCP tool discovery", () => {
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
    expect(report.decisions).toEqual([{ status: "rejected", reason: "invalid-descriptor" }]);
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
    [{ ...allowed, inputSchema: { type: "string" } }, "invalid-descriptor"],
    [
      { ...allowed, outputSchema: { type: "object", properties: { bad: { oneOf: [] } } } },
      "invalid-descriptor",
    ],
    [
      { ...allowed, inputSchema: { type: "object", properties: { x: { $ref: "#/$defs/x" } } } },
      "invalid-descriptor",
    ],
    [{ ...allowed, name: "bad name" }, "invalid-descriptor"],
    [{ ...allowed, annotations: { readOnlyHint: "true" } }, "invalid-descriptor"],
  ])("rejects unsafe or malformed descriptors", async (tool, reason) => {
    const report = await discover([tool]);
    expect(report.exposed).toEqual([]);
    expect(report.decisions[0]).toMatchObject({ status: "rejected", reason });
  });

  it("rejects every duplicate and defers cluster-dependent tools", async () => {
    const report = await discover([
      allowed,
      { ...allowed, description: "duplicate" },
      { name: "pods_list", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ]);
    expect(report.exposed).toEqual([]);
    expect(report.decisions).toEqual([
      { name: allowed.name, status: "rejected", reason: "duplicate-name" },
      { name: allowed.name, status: "rejected", reason: "duplicate-name" },
      { name: "pods_list", status: "deferred", reason: "cluster-context-required" },
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

  it("accepts the supported nested schema types and preserves their constraints", async () => {
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

    expect(report.exposed).toEqual([{ ...allowed, inputSchema }]);
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
    expect(report.decisions).toEqual([{ status: "rejected", reason: "invalid-descriptor" }]);
  });

  it.each(["inputSchema", "outputSchema"] as const)(
    "bounds nested %s validation to depth 12",
    async (field) => {
      let nested: Record<string, unknown> = { type: "string" };
      for (let depth = 0; depth < 12; depth++) {
        nested = { type: "object", properties: { child: nested } };
      }
      expect((await discover([{ ...allowed, [field]: nested }])).exposed).toHaveLength(1);

      nested = { type: "object", properties: { child: nested } };
      expect((await discover([{ ...allowed, [field]: nested }])).decisions).toEqual([
        { status: "rejected", reason: "invalid-descriptor" },
      ]);
    },
  );
});
