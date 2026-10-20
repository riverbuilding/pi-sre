import { describe, expect, it, vi } from "vitest";
import { discoverClusterContexts } from "../../../src/mcp/context-discovery.js";
import {
  acceptsToolContext,
  prepareMcpToolSchema,
  MCP_TOOL_POLICIES,
} from "../../../src/runtime/tool-policy.js";
import type { McpToolDescriptor } from "../../../src/mcp/tool-discovery.js";
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";

const descriptor: McpToolDescriptor = {
  name: "pods_get",
  inputSchema: {
    type: "object",
    properties: {
      context: { type: "string", enum: ["alpha"] },
      name: { type: "string", minLength: 2 },
      detail: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    },
    required: ["context", "name"],
    additionalProperties: false,
  },
};

describe("discovered MCP argument schemas", () => {
  it("retains the diagnostic capability allowlist", () => {
    expect(MCP_TOOL_POLICIES.map((policy) => policy.name).sort()).toEqual(
      diagnosticTools.map((tool) => tool.name).sort(),
    );
  });

  it("uses discovered constraints and requires model context", () => {
    const prepared = prepareMcpToolSchema(descriptor);
    expect(prepared.parameters).toMatchObject({ required: ["context", "name"] });
    expect(prepared.parameters).toHaveProperty("properties.context");
    expect(prepared.validateArguments({ name: "api", context: "alpha", detail: null })).toBe(true);
    for (const args of [{}, { name: "x" }, { name: 1 }, { name: "api", extra: true }])
      expect(prepared.validateArguments(args)).toBe(false);
    expect(prepared.validateArguments({ name: "api", context: "beta" })).toBe(false);
    expect(prepared.validateArguments({ name: "api" })).toBe(false);
    expect(acceptsToolContext(descriptor, "alpha")).toBe(true);
    expect(acceptsToolContext(descriptor, "beta")).toBe(false);
    expect(descriptor.inputSchema.required).toEqual(["context", "name"]);
  });

  it("copies schemas so later descriptor changes cannot change execution", () => {
    const tool = structuredClone(descriptor);
    const prepared = prepareMcpToolSchema(tool);
    Object.assign(tool.inputSchema, { required: [] });
    expect(prepared.validateArguments({})).toBe(false);
  });

  it("honors server object openness instead of imposing a local argument list", () => {
    const tool = {
      ...descriptor,
      inputSchema: { ...descriptor.inputSchema, additionalProperties: true },
    };
    expect(
      prepareMcpToolSchema(tool).validateArguments({
        name: "api",
        context: "alpha",
        newArgument: 5,
      }),
    ).toBe(true);
  });

  it("keeps output declarations out of argument admission and validation", () => {
    const prepared = prepareMcpToolSchema({ ...descriptor, outputSchema: { type: "array" } });
    expect(prepared.validateArguments({ name: "api", context: "alpha" })).toBe(true);
  });

  it("does not dispatch when a server constraint cannot be evaluated", () => {
    const prepared = prepareMcpToolSchema({
      name: "configuration_contexts_list",
      inputSchema: { type: "object", properties: { name: { type: "string", pattern: "[" } } },
    });
    expect(prepared.validateArguments({ name: "api" })).toBe(false);
  });

  it("accepts optional enumeration arguments but requires startup enumeration to accept {}", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: [], structuredContent: { contexts: [] } });
    const optional = {
      name: "configuration_contexts_list",
      inputSchema: { type: "object", properties: { verbose: { type: "boolean" } } },
    };
    await expect(
      discoverClusterContexts({ state: "ready", callTool }, { exposed: [optional], decisions: [] }),
    ).resolves.toMatchObject({ contexts: [] });
    callTool.mockClear();
    const required = {
      ...optional,
      inputSchema: { ...optional.inputSchema, required: ["verbose"] },
    };
    await expect(
      discoverClusterContexts({ state: "ready", callTool }, { exposed: [required], decisions: [] }),
    ).rejects.toMatchObject({ kind: "incompatible-tool" });
    expect(callTool).not.toHaveBeenCalled();
  });
});
