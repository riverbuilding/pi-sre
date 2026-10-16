import { describe, expect, it, vi } from "vitest";

import { createMcpToolBridge } from "../../../src/mcp/tool-bridge.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";
import type { McpToolDescriptor } from "../../../src/mcp/tool-discovery.js";

const descriptor: McpToolDescriptor = {
  name: "configuration_contexts_list",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

describe("MCP tool bridge", () => {
  it("keeps names reversible and forwards arguments and the exact caller signal", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "dev, prod" }] });
    const tool = createMcpToolBridge(descriptor, { callTool });
    const signal = new AbortController().signal;
    const args = {};
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
    const invalid = await tool.execute("bad", [], undefined, undefined, {} as never);
    expect(invalid).toMatchObject({
      isError: true,
      details: { failureCategory: "invalid-arguments" },
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(() => createMcpToolBridge(scopedPodTool, { callTool })).toThrow(
      "requires an application-owned scope binding",
    );
    for (const unsafe of ["configuration_view", "bash"]) {
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
