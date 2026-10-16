import { describe, expect, it, vi } from "vitest";
import { discoverMcpTools } from "../../../src/mcp/tool-discovery.js";
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";

const allowed = {
  name: "configuration_contexts_list",
  inputSchema: { type: "object", properties: {} },
};
async function discover(tools: readonly unknown[]) {
  const listTools = vi.fn().mockResolvedValue(tools);
  const report = await discoverMcpTools({ listTools });
  expect(listTools).toHaveBeenCalledOnce();
  return report;
}

describe("MCP tool discovery", () => {
  it.each([undefined, {}, { readOnlyHint: false, destructiveHint: true }])(
    "admits allowlisted tools independently of annotations %j",
    async (annotations) => {
      const tool = { ...allowed, annotations };
      expect((await discover([tool])).exposed).toEqual([tool]);
    },
  );

  it("accepts new input arguments and output declarations without local schema review", async () => {
    const tools = diagnosticTools.map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...Object(tool.inputSchema.properties), verbose: { type: "boolean" } },
      },
      outputSchema: { type: "object", properties: { newServerField: { type: "array" } } },
    }));
    const report = await discover(tools);
    expect(report.exposed).toEqual(tools);
    expect(report.decisions.every((decision) => decision.status === "exposed")).toBe(true);
  });

  it("excludes unknown operations even when they advertise read-only behavior", async () => {
    const report = await discover([
      allowed,
      { ...allowed, name: "configuration_view", annotations: { readOnlyHint: true } },
    ]);
    expect(report.exposed).toEqual([allowed]);
    expect(report.decisions).toContainEqual({
      name: "configuration_view",
      status: "rejected",
      reason: "not-allowlisted",
    });
  });

  it.each([
    null,
    {},
    { ...allowed, inputSchema: undefined },
    { ...allowed, inputSchema: [] },
    { ...allowed, name: "bad name" },
  ])("reports unusable descriptor envelopes %j", async (tool) => {
    expect((await discover([tool])).decisions).toEqual([
      { status: "rejected", reason: "invalid-descriptor" },
    ]);
  });

  it("rejects every duplicate and cluster tools without a declared context", async () => {
    const report = await discover([
      allowed,
      { ...allowed, description: "duplicate" },
      { name: "pods_list", inputSchema: { type: "object" } },
    ]);
    expect(report.exposed).toEqual([]);
    expect(report.decisions).toEqual([
      { name: allowed.name, status: "rejected", reason: "duplicate-name" },
      { name: allowed.name, status: "rejected", reason: "duplicate-name" },
      { name: "pods_list", status: "rejected", reason: "incompatible-schema" },
    ]);
  });

  it("also rejects a duplicate with a malformed envelope", async () => {
    expect((await discover([allowed, { name: allowed.name }])).exposed).toEqual([]);
  });

  it("returns deterministic decisions regardless of advertisement order", async () => {
    const tools = [
      allowed,
      ...diagnosticTools.filter((tool) => tool.name !== allowed.name),
      { ...allowed, name: "unknown" },
    ];
    expect(await discover(tools)).toEqual(await discover([...tools].reverse()));
  });
});
