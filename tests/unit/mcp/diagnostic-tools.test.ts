import { describe, expect, it, vi } from "vitest";
import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { createMcpToolBridge } from "../../../src/mcp/tool-bridge.js";
import { discoverMcpTools, type McpToolDescriptor } from "../../../src/mcp/tool-discovery.js";
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";

function logDescriptor(): McpToolDescriptor {
  const tool = diagnosticTools.find((tool) => tool.name === "pods_log");
  if (!tool) throw new Error("Missing captured log tool");
  return tool;
}

function bridge(descriptor = logDescriptor()) {
  const manager = new ClusterContextManager({ rule: { kind: "exact", contexts: ["beta"] } });
  const generation = manager.beginConnection();
  manager.acceptRegistry(
    generation,
    new ClusterContextRegistry([
      { name: "beta", server: "https://example.invalid", isDefault: false },
    ]),
  );
  const callTool = vi.fn().mockResolvedValue({ content: [] });
  return {
    callTool,
    tool: createMcpToolBridge(descriptor, { callTool }, undefined, {
      manager,
      connectionGeneration: generation,
    }),
  };
}

describe("reviewed diagnostic contracts", () => {
  it.each([0, -1, 1001, 1.5, "100", null, Infinity])("rejects unsafe log tail %j", async (tail) => {
    const { tool, callTool } = bridge();
    expect(
      await tool.execute("log", { name: "api", tail }, undefined, undefined, {} as never),
    ).toMatchObject({ isError: true, details: { failureCategory: "invalid-arguments" } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([undefined, 1, 1000])("injects a finite log tail for %j", async (tail) => {
    const { tool, callTool } = bridge();
    await tool.execute(
      "log",
      { name: "api", ...(tail === undefined ? {} : { tail }) },
      undefined,
      undefined,
      {} as never,
    );
    expect(callTool).toHaveBeenCalledWith(
      "pods_log",
      {
        context: "beta",
        name: "api",
        tail: tail ?? 100,
      },
      undefined,
    );
    expect(tool.parameters).toMatchObject({
      properties: { tail: { type: "integer", minimum: 0 } },
    });
  });

  it.each([{ follow: true }, { stream: true }])(
    "rejects streaming log arguments %j even on permissive server schemas",
    async (args) => {
      const { tool, callTool } = bridge();
      expect(
        await tool.execute("log", { name: "api", ...args }, undefined, undefined, {} as never),
      ).toMatchObject({ isError: true, details: { failureCategory: "invalid-arguments" } });
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it("enforces execution limits in the Pi preparation hook as well as direct execution", () => {
    const { tool, callTool } = bridge();
    for (const tail of [0, 1001]) {
      expect(() => tool.prepareArguments?.({ name: "api", tail })).toThrow("Invalid arguments");
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it("keeps executable limits independent of descriptor and public schema mutation", async () => {
    const descriptor = structuredClone(logDescriptor());
    const { tool, callTool } = bridge(descriptor);
    Object.assign(descriptor.inputSchema, { properties: {} });
    Object.assign(tool.parameters, {
      properties: { name: { type: "string" }, tail: { type: "integer" } },
    });
    expect(
      await tool.execute("log", { name: "api", tail: 1001 }, undefined, undefined, {} as never),
    ).toMatchObject({ isError: true, details: { failureCategory: "invalid-arguments" } });
    expect(callTool).not.toHaveBeenCalled();
    expect(tool.prepareArguments?.({ name: "api", context: "alpha" })).toEqual({
      name: "api",
      tail: 100,
    });
  });

  it("rejects duplicates, writes, generic resource access, shell, and newly advertised operations", async () => {
    const forbidden = [
      "configuration_view",
      "pods_exec",
      "pods_attach",
      "pods_delete",
      "resources_get",
      "resources_list",
      "secrets_get",
      "bash",
      "pods_list_in_namespace",
      "new_diagnostic",
    ];
    const report = await discoverMcpTools({
      listTools: async () => [
        ...diagnosticTools,
        { ...logDescriptor(), inputSchema: { type: "string" } },
        ...forbidden.map((name) => ({ ...logDescriptor(), name })),
      ],
    });
    expect(report.exposed.map((tool) => tool.name)).toEqual(
      diagnosticTools.filter((tool) => tool.name !== "pods_log").map((tool) => tool.name),
    );
    for (const name of forbidden)
      expect(report.decisions).toContainEqual({
        name,
        status: "rejected",
        reason: "not-allowlisted",
      });
    expect(report.decisions).toContainEqual({
      name: "pods_log",
      status: "rejected",
      reason: "duplicate-name",
    });
  });
});
