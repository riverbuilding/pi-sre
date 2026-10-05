import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import { adaptMcpInputSchema, createMcpToolBridge } from "../../../src/mcp/tool-bridge.js";
import type { McpToolDescriptor } from "../../../src/mcp/tool-discovery.js";

const descriptor: McpToolDescriptor = {
  name: "configuration_contexts_list",
  inputSchema: { type: "object", additionalProperties: false },
  annotations: { readOnlyHint: true },
};

describe("MCP tool bridge", () => {
  it("adapts the supported JSON Schema subset without changing argument semantics", () => {
    const schema = adaptMcpInputSchema({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, enum: ["dev", "prod"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        ratio: { type: "number", exclusiveMinimum: 0, multipleOf: 0.5 },
        enabled: { type: "boolean", default: true },
        names: { type: "array", items: { type: "string" }, minItems: 1 },
        target: {
          type: "object",
          properties: { namespace: { type: "string", pattern: "^[a-z]+$" } },
          required: ["namespace"],
          additionalProperties: false,
        },
        empty: { type: "null" },
      },
      required: ["name", "target"],
      additionalProperties: false,
    });
    const valid = {
      name: "dev",
      count: 2,
      ratio: 1.5,
      enabled: false,
      names: ["a"],
      target: { namespace: "demo" },
      empty: null,
    };
    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, { name: "dev", target: { namespace: "demo" } })).toBe(true);
    for (const invalid of [
      { ...valid, name: "other" },
      { ...valid, count: 2.5 },
      { ...valid, count: 4 },
      { ...valid, ratio: 0 },
      { ...valid, ratio: 0.7 },
      { ...valid, enabled: "false" },
      { ...valid, names: [] },
      { ...valid, target: {} },
      { ...valid, target: { namespace: "123" } },
      { ...valid, extra: 1 },
    ])
      expect(Value.Check(schema, invalid)).toBe(false);
  });

  it.each([
    { type: "object", properties: { name: { $ref: "#/$defs/name" } } },
    { type: "object", properties: { name: { type: "string", pattern: "[" } } },
    { type: "object", properties: { name: { type: "string", format: "unknown-format" } } },
    { type: "object", properties: { count: { type: "number", multipleOf: 0 } } },
    { type: "object", properties: { count: { type: "number", minimum: 5, maximum: 1 } } },
  ])("fails closed for non-executable schema %j", (schema) => {
    expect(() => adaptMcpInputSchema(schema)).toThrow("cannot be adapted safely");
  });

  it("keeps names reversible and forwards arguments and the exact caller signal", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "dev, prod" }] });
    const tool = createMcpToolBridge(
      {
        ...descriptor,
        inputSchema: { type: "object", properties: { detailed: { type: "boolean" } } },
      },
      { callTool },
    );
    const signal = new AbortController().signal;
    const args = { detailed: false };
    const result = await tool.execute("call-1", args, signal, undefined, {} as never);
    expect(callTool).toHaveBeenCalledWith("configuration_contexts_list", args, signal);
    expect(result).toEqual({
      content: [{ type: "text", text: "dev, prod" }],
      details: {
        tool: { piName: tool.name, mcpName: descriptor.name },
        status: "success",
        truncated: false,
      },
      isError: false,
    });
  });

  it("blocks invalid arguments and unsafe tools before transport", async () => {
    const callTool = vi.fn();
    const tool = createMcpToolBridge(descriptor, { callTool });
    const invalid = await tool.execute("bad", { extra: true }, undefined, undefined, {} as never);
    expect(invalid).toMatchObject({
      isError: true,
      details: { failureCategory: "invalid-arguments" },
    });
    expect(callTool).not.toHaveBeenCalled();
    for (const unsafe of ["pods_list", "configuration_view", "bash"]) {
      expect(() => createMcpToolBridge({ ...descriptor, name: unsafe }, { callTool })).toThrow(
        "not approved",
      );
    }
  });

  it.each([
    [{ content: [], isError: true }, "tool-error"],
    [{ content: [{ type: "text", text: "token=private" }], isError: true }, "tool-error"],
    [{ content: [{ type: "text", text: 1 }] }, "invalid-result"],
    [{}, "invalid-result"],
  ])("preserves failure state without exposing raw payloads", async (raw, status) => {
    const tool = createMcpToolBridge(descriptor, { callTool: vi.fn().mockResolvedValue(raw) });
    const result = await tool.execute("error", {}, undefined, undefined, {} as never);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("handles empty success and marks bounded text truncation", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "x".repeat(20_000) }] });
    const tool = createMcpToolBridge(descriptor, { callTool });
    const empty = await tool.execute("empty", {}, undefined, undefined, {} as never);
    expect(empty.isError).toBe(false);
    expect(empty.content).toEqual([
      { type: "text", text: "Tool completed successfully with no content." },
    ]);
    const large = await tool.execute("large", {}, undefined, undefined, {} as never);
    expect(large.details).toMatchObject({ truncated: true });
    expect(JSON.stringify(large)).toContain("[Result truncated]");
    expect(JSON.stringify(large).length).toBeLessThan(9_000);
  });

  it("does not transport an already cancelled request", async () => {
    const callTool = vi.fn();
    const signal = AbortSignal.abort();
    const tool = createMcpToolBridge(descriptor, { callTool });
    await expect(tool.execute("abort", {}, signal, undefined, {} as never)).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("normalizes transport failures without retaining sensitive causes", async () => {
    const cause = new Error("token=private");
    const tool = createMcpToolBridge(descriptor, { callTool: vi.fn().mockRejectedValue(cause) });
    const result = await tool.execute("fail", {}, undefined, undefined, {} as never);
    expect(result).toMatchObject({
      isError: true,
      details: { failureCategory: "tool-execution-failed" },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
