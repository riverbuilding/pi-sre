import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { createMcpToolBridge } from "../../../src/mcp/tool-bridge.js";
import { evaluateToolPolicy } from "../../../src/runtime/tool-policy.js";
import * as toolPolicy from "../../../src/runtime/tool-policy.js";
import capture from "../../fixtures/phase2-server-0.0.67.json" with { type: "json" };
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";

const registry = new ClusterContextRegistry(
  ["alpha", "beta"].map((name) => ({
    name,
    server: "https://shared.example.invalid",
    isDefault: false,
  })),
);

function setup(cluster: string | undefined = "alpha", descriptor = scopedPodTool) {
  const manager = new ClusterContextManager(cluster ? { cluster } : {});
  const generation = manager.beginConnection();
  manager.acceptRegistry(generation, registry);
  const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: { pods: [] } });
  const tool = createMcpToolBridge(
    descriptor,
    { callTool, state: "ready" },
    DEFAULT_RESULT_POLICY,
    { manager, connectionGeneration: generation },
  );
  return { manager, generation, callTool, tool };
}

describe("scoped MCP bridge", () => {
  it("accepts the frozen server descriptor and preserves selector constraints", async () => {
    const captured = capture.cases["multiple-default"].descriptors.find(
      (tool) => tool.name === "pods_list",
    );
    if (!captured) throw new Error("Invalid captured descriptor");
    const { tool, callTool } = setup("beta", {
      name: captured.name,
      inputSchema: captured.inputSchema,
      annotations: captured.annotations,
    });
    expect(
      await tool.execute(
        "valid",
        { labelSelector: "app=api", fieldSelector: "status.phase=Running" },
        undefined,
        undefined,
        {} as never,
      ),
    ).toMatchObject({ isError: false });
    expect(callTool).toHaveBeenCalledWith(
      "pods_list",
      {
        context: "beta",
        labelSelector: "app=api",
        fieldSelector: "status.phase=Running",
      },
      undefined,
    );
    callTool.mockClear();
    expect(
      await tool.execute("invalid", { fieldSelector: "bad" }, undefined, undefined, {} as never),
    ).toMatchObject({ isError: true, details: { failureCategory: "invalid-arguments" } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rechecks execution approval after registration", async () => {
    const { tool, callTool } = setup();
    const policy = vi
      .spyOn(toolPolicy, "evaluateToolPolicy")
      .mockReturnValue({ status: "rejected", reason: "not-allowlisted" });
    try {
      expect(await tool.execute("call", {}, undefined, undefined, {} as never)).toMatchObject({
        isError: true,
        details: { failureCategory: "tool-not-approved" },
      });
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      policy.mockRestore();
    }
  });

  it("keeps scoped presentation within configured budgets and redacts raw data", async () => {
    const manager = new ClusterContextManager({ cluster: "alpha" });
    const generation = manager.beginConnection();
    manager.acceptRegistry(generation, registry);
    const tool = createMcpToolBridge(
      scopedPodTool,
      {
        callTool: vi.fn().mockResolvedValue({
          content: [],
          structuredContent: {
            token: "PRIVATE_FIXTURE",
            pods: Array.from({ length: 100 }, (_, i) => `pod-${i}`),
          },
        }),
      },
      { ...DEFAULT_RESULT_POLICY, maxTextChars: 256, maxItems: 5 },
      { manager, connectionGeneration: generation },
    );
    const result = await tool.execute("call", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ truncated: true, scope: { context: "alpha" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
    expect(JSON.stringify(result)).not.toContain("pod-99");
    for (const content of result.content)
      if (content.type === "text") expect(content.text.length).toBeLessThanOrEqual(256);
  });

  it("blocks a disconnected transport before dispatch", async () => {
    const { manager, generation } = setup();
    const callTool = vi.fn();
    const tool = createMcpToolBridge(
      scopedPodTool,
      { callTool, state: "failed" },
      DEFAULT_RESULT_POLICY,
      { manager, connectionGeneration: generation },
    );
    expect(await tool.execute("call", {}, undefined, undefined, {} as never)).toMatchObject({
      details: { failureCategory: "transport-unavailable" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("approves reviewed diagnostics and rejects unsafe tools", () => {
    expect(evaluateToolPolicy(scopedPodTool).status).toBe("exposed");
    for (const descriptor of [{ ...scopedPodTool, name: "configuration_view" }])
      expect(() => setup("alpha", descriptor)).toThrow("not approved");
    expect(() => createMcpToolBridge(scopedPodTool, { callTool: vi.fn() })).toThrow(
      "requires an application-owned scope binding",
    );
  });

  it.each([{}, { context: "beta" }, { context: { malicious: true } }])(
    "injects scope after removing untrusted context %j without mutating the contract or caller",
    async (args) => {
      const { tool, callTool } = setup();
      const original = structuredClone(args);
      expect(tool.parameters).toMatchObject({
        required: [],
        properties: {
          labelSelector: { type: "string", pattern: expect.any(String) },
        },
      });
      expect(JSON.stringify(tool.parameters)).not.toContain('"context"');
      expect(Value.Check(tool.parameters, {})).toBe(true);
      const signal = new AbortController().signal;
      const result = await tool.execute("call", args, signal, undefined, {} as never);
      expect(callTool).toHaveBeenCalledWith("pods_list", { context: "alpha" }, signal);
      expect(args).toEqual(original);
      expect(scopedPodTool.inputSchema.required).toBeUndefined();
      expect(result).toMatchObject({
        isError: false,
        details: { scope: { context: "alpha", readOnly: true } },
      });
      expect(JSON.stringify(result.content)).toContain("server/context policy");
    },
  );

  it("preserves namespace independently on events_list", async () => {
    const descriptor = diagnosticTools.find((tool) => tool.name === "events_list");
    if (!descriptor) throw new Error("Missing captured event tool");
    const { tool, callTool } = setup("beta", descriptor);
    const result = await tool.execute(
      "call",
      { context: "alpha", namespace: "payments" },
      undefined,
      undefined,
      {} as never,
    );
    expect(callTool).toHaveBeenCalledWith(
      "events_list",
      { context: "beta", namespace: "payments" },
      undefined,
    );
    expect(result.details).toMatchObject({ scope: { context: "beta", namespace: "payments" } });
  });

  it.each([{ type: "object" as const, additionalProperties: true }])(
    "rejects undeclared or incompatible context schema %j",
    (inputSchema) => {
      expect(() => setup("alpha", { ...scopedPodTool, inputSchema })).toThrow(
        "requires an object input schema",
      );
    },
  );

  it("accepts discovered context restrictions and blocks incompatible selected scope", async () => {
    const { tool, callTool } = setup("beta", {
      ...scopedPodTool,
      inputSchema: {
        type: "object",
        properties: { context: { type: "string", enum: ["alpha"] } },
      },
    });
    expect(await tool.execute("call", {}, undefined, undefined, {} as never)).toMatchObject({
      isError: true,
      details: { failureCategory: "incompatible-schema" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(["unbound", "missing", "unavailable", "stale", "invalid"])(
    "blocks %s with zero requests",
    async (kind) => {
      const { tool, manager, callTool } = setup(
        kind === "unbound" ? "" : kind === "missing" ? "missing" : "alpha",
      );
      if (kind === "unavailable") manager.markUnavailable("MCP unavailable");
      if (kind === "stale") manager.beginConnection();
      const result = await tool.execute(
        "call",
        kind === "invalid" ? { labelSelector: "?" } : {},
        undefined,
        undefined,
        {} as never,
      );
      expect(result).toMatchObject({
        isError: true,
        details: {
          failureCategory:
            kind === "unbound"
              ? "scope-unbound"
              : kind === "stale"
                ? "stale-scope"
                : kind === "invalid"
                  ? "invalid-arguments"
                  : "scope-unavailable",
        },
      });
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it.each(["restart", "loss", "cancel"])(
    "withholds late payloads after %s and guards direct callers",
    async (kind) => {
      const { tool, manager, callTool } = setup();
      let finish: ((value: unknown) => void) | undefined;
      callTool.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const cancellation = new AbortController();
      const pending = tool.execute("call", {}, cancellation.signal, undefined, {} as never);
      expect(() => manager.select("beta")).toThrow("active agent turn");
      if (kind === "restart") {
        const generation = manager.beginConnection();
        manager.acceptRegistry(generation, registry);
      } else if (kind === "loss") manager.markUnavailable("Disconnected");
      else cancellation.abort();
      finish?.({ content: [{ type: "text", text: "LATE_PAYLOAD" }] });
      if (kind === "cancel") await expect(pending).rejects.toThrow();
      else {
        const result = await pending;
        expect(result).toMatchObject({
          details: { failureCategory: "stale-scope", scope: { context: "alpha" } },
        });
        expect(JSON.stringify(result)).not.toContain("LATE_PAYLOAD");
      }
      expect(manager.isAgentActive).toBe(false);
    },
  );

  it("uses the new exact context on subsequent idle calls", async () => {
    const { tool, manager, callTool } = setup();
    await tool.execute("alpha", {}, undefined, undefined, {} as never);
    manager.select("beta");
    await tool.execute("beta", {}, undefined, undefined, {} as never);
    expect(callTool.mock.calls.map((call) => call[1])).toEqual([
      { context: "alpha" },
      { context: "beta" },
    ]);
  });
});
