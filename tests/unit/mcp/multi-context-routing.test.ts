import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import type { ClusterScopeRule } from "../../../src/cluster/context-resolver.js";
import { createMcpToolBridge } from "../../../src/mcp/tool-bridge.js";
import { prepareMcpToolSchema } from "../../../src/runtime/tool-policy.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";

const inventory = new ClusterContextRegistry(
  ["alpha", "beta", "outside"].map((name) => ({ name, server: "withheld", isDefault: false })),
);

function setup(rule: ClusterScopeRule = { kind: "exact", contexts: ["alpha", "beta"] }) {
  const manager = new ClusterContextManager({ rule });
  const generation = manager.beginConnection();
  manager.acceptRegistry(generation, inventory);
  const capture = vi.spyOn(manager, "captureExecution");
  const callTool = vi.fn().mockResolvedValue({ content: [] });
  const binding = { manager, connectionGeneration: generation };
  const tool = createMcpToolBridge(scopedPodTool, { callTool }, undefined, binding);
  return { manager, generation, callTool, binding, tool, capture };
}

function execute(tool: ToolDefinition, args: unknown, signal?: AbortSignal) {
  return tool.execute("call", args, signal, undefined, {} as never);
}

describe("Phase 3 exact target execution", () => {
  it.each<ClusterScopeRule>([{ kind: "all" }, { kind: "exact", contexts: ["alpha", "beta"] }])(
    "routes sequential same-named resources under %j",
    async (rule) => {
      const { tool, manager, callTool, generation, capture } = setup(rule);
      expect(tool.executionMode).toBe("parallel");
      for (const context of ["alpha", "beta"]) {
        callTool.mockResolvedValue({ content: [{ type: "text", text: `${context}/api` }] });
        const result = await execute(tool, { context, labelSelector: "app=api" });
        expect(result).toMatchObject({
          isError: false,
          details: {
            scope: {
              context,
              connectionGeneration: generation,
              inventoryRevision: 1,
              selectionRevision: 1,
              namespacePolicy: "unrestricted",
              readOnly: true,
            },
          },
        });
        expect(JSON.stringify(result)).toContain(`${context}/api`);
        const snapshot = capture.mock.results.at(-1)?.value;
        expect(snapshot && manager.isExecutionCurrent(snapshot)).toBe(false);
        expect(manager.isAgentActive).toBe(false);
      }
      expect(callTool.mock.calls.map((call) => call[1])).toEqual([
        { context: "alpha", labelSelector: "app=api" },
        { context: "beta", labelSelector: "app=api" },
      ]);
      expect(manager.state.selection.rule).toEqual(rule);
    },
  );

  it.each(["throw", "failure", "invalid", "cancel"])(
    "releases work guard and snapshot on %s",
    async (kind) => {
      const { tool, callTool, manager, capture } = setup();
      const cancellation = new AbortController();
      callTool.mockImplementation(() => {
        if (kind === "throw") throw new Error("operation failed");
        if (kind === "cancel") cancellation.abort();
        return Promise.resolve(kind === "invalid" ? {} : { content: [], isError: true });
      });
      if (kind === "cancel")
        await expect(execute(tool, { context: "alpha" }, cancellation.signal)).rejects.toThrow();
      else expect(await execute(tool, { context: "alpha" })).toMatchObject({ isError: true });
      expect(manager.isAgentActive).toBe(false);
      const snapshot = capture.mock.results[0]?.value;
      expect(snapshot).toBeDefined();
      expect(snapshot && manager.isExecutionCurrent(snapshot)).toBe(false);
      callTool.mockResolvedValue({ content: [] });
      expect(await execute(tool, { context: "beta" })).toMatchObject({ isError: false });
    },
  );

  it("uses current permission after an idle selection expands", async () => {
    const { tool, manager, capture, callTool } = setup({ kind: "exact", contexts: ["alpha"] });
    manager.selectRule({ kind: "exact", contexts: ["alpha", "beta"] });
    expect(tool.prepareArguments?.({ context: "beta" })).toEqual({ context: "beta" });
    expect(await execute(tool, { context: "beta" })).toMatchObject({
      isError: false,
      details: { scope: { context: "beta" } },
    });
    const snapshot = capture.mock.results[0]?.value;
    expect(snapshot).toBeDefined();
    expect(snapshot && manager.isExecutionCurrent(snapshot)).toBe(false);
    expect(callTool).toHaveBeenCalledWith("pods_list", { context: "beta" }, undefined);
  });

  it("keeps schema validation independent of current scope permission", async () => {
    const { tool, manager, callTool } = setup({ kind: "exact", contexts: ["alpha"] });
    expect(Value.Check(tool.parameters, { context: "beta" })).toBe(true);
    expect(tool.prepareArguments?.({ context: "beta" })).toEqual({ context: "beta" });
    expect(await execute(tool, { context: "beta" })).toMatchObject({
      details: { failureCategory: "invalid-arguments" },
    });
    expect(callTool).not.toHaveBeenCalled();
    manager.selectRule({ kind: "all" });
    expect(await execute(tool, { context: "beta" })).toMatchObject({
      isError: false,
      details: { scope: { context: "beta" } },
    });
  });

  it("explicitly releases snapshots independently and clears them on disposal", () => {
    const { manager, generation } = setup();
    const alpha = manager.captureExecution(generation, "alpha")!;
    const beta = manager.captureExecution(generation, "beta")!;
    manager.releaseExecution(alpha);
    manager.releaseExecution(alpha);
    expect(manager.isExecutionCurrent(alpha)).toBe(false);
    expect(manager.isExecutionCurrent(beta)).toBe(true);
    manager.dispose();
    expect(manager.isExecutionCurrent(beta)).toBe(false);
    manager.releaseExecution(beta);
  });

  it("withholds late results and rejects old handlers after reconnect", async () => {
    const { manager, tool, callTool } = setup();
    const response = Promise.withResolvers<unknown>();
    callTool.mockReturnValue(response.promise); // Simulates a server ignoring cancellation.
    const pending = execute(tool, { context: "alpha" });
    const generation = manager.beginConnection();
    manager.acceptRegistry(generation, inventory);
    expect(await execute(tool, { context: "beta" })).toMatchObject({
      details: { failureCategory: "stale-scope" },
    });
    response.resolve({ content: [{ type: "text", text: "LATE_PRIVATE_PAYLOAD" }] });
    const stale = await pending;
    expect(stale).toMatchObject({
      details: { failureCategory: "stale-scope", scope: { context: "alpha" } },
    });
    expect(JSON.stringify(stale)).not.toContain("LATE_PRIVATE_PAYLOAD");
    const current = createMcpToolBridge(scopedPodTool, { callTool }, undefined, {
      manager,
      connectionGeneration: generation,
    });
    callTool.mockResolvedValue({ content: [] });
    expect(await execute(current, { context: "beta" })).toMatchObject({ isError: false });
    expect(manager.isAgentActive).toBe(false);
    manager.dispose();
    expect(await execute(current, { context: "alpha" })).toMatchObject({
      details: { failureCategory: "stale-scope" },
    });
  });

  it("keeps per-context failure distinct from empty success on another target", async () => {
    const { tool, callTool, manager } = setup();
    callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "401 unauthorized" }],
      isError: true,
    });
    expect(await execute(tool, { context: "alpha" })).toMatchObject({
      isError: true,
      details: { failureCategory: "authentication-failed", scope: { context: "alpha" } },
    });
    expect(await execute(tool, { context: "beta" })).toMatchObject({
      isError: false,
      details: { status: "success", scope: { context: "beta" } },
    });
    expect(manager.state.resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }, { name: "beta" }],
    });
  });

  it("freezes snapshots, rejects foreign copies, and invalidates inventory and selection revisions", () => {
    const { manager, generation } = setup();
    const snapshot = manager.captureExecution(generation, "alpha")!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rule)).toBe(true);
    expect(manager.isExecutionCurrent({ ...snapshot })).toBe(false);
    expect(setup().manager.isExecutionCurrent(snapshot)).toBe(false);
    expect(manager.captureExecution(generation, "outside")).toBeUndefined();
    manager.select("alpha");
    expect(manager.isExecutionCurrent(snapshot)).toBe(false);
    const next = manager.captureExecution(generation, "alpha")!;
    const replacement = manager.beginConnection();
    manager.acceptRegistry(replacement, inventory);
    expect(manager.isExecutionCurrent(next)).toBe(false);
  });

  it("old broad handlers and public schema mutations cannot expand current exact permission", async () => {
    const { manager, tool, callTool } = setup({ kind: "all" });
    manager.select("alpha");
    Object.assign(tool.parameters, { properties: {}, required: [] });
    expect(await execute(tool, { context: "beta" })).toMatchObject({
      details: { failureCategory: "invalid-arguments" },
    });
    expect(await execute(tool, {})).toMatchObject({
      details: { failureCategory: "invalid-arguments" },
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(await execute(tool, { context: "alpha" })).toMatchObject({ isError: false });
  });

  it("preserves discovered constraints without embedding session permission in the schema", () => {
    const descriptor = {
      ...scopedPodTool,
      inputSchema: {
        type: "object",
        properties: { context: { type: "string", enum: ["alpha", "outside"], pattern: "^a" } },
      },
    };
    const prepared = prepareMcpToolSchema(descriptor);
    expect(Value.Check(prepared.parameters, { context: "alpha" })).toBe(true);
    for (const context of [undefined, "beta", "outside", 1, ""])
      expect(prepared.validateArguments({ context })).toBe(false);
    expect(descriptor.inputSchema).not.toHaveProperty("required");
  });

  it("retains attribution for a removed permitted member and blocks unrelated additions", async () => {
    const { manager, tool, callTool } = setup();
    const generation = manager.beginConnection();
    manager.acceptRegistry(
      generation,
      new ClusterContextRegistry([
        { name: "alpha", server: "withheld", isDefault: false },
        { name: "outside", server: "withheld", isDefault: false },
      ]),
    );
    expect(await execute(tool, { context: "alpha" })).toMatchObject({
      details: { failureCategory: "stale-scope" },
    });
    // A handler with the current generation still cannot grant unavailable targets.
    const current = createMcpToolBridge(scopedPodTool, { callTool }, undefined, {
      manager,
      connectionGeneration: generation,
    });
    expect(await execute(current, { context: "beta" })).toMatchObject({
      details: { failureCategory: "scope-unavailable" },
    });
    expect(await execute(current, { context: "outside" })).toMatchObject({
      details: { failureCategory: "invalid-arguments" },
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(await execute(current, { context: "alpha" })).toMatchObject({ isError: false });
  });
});
