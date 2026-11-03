import { describe, expect, it, vi } from "vitest";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { CurrentClusterSelection } from "../../../src/cluster/current-selection.js";
import { createExactClusterRule } from "../../../src/cluster/context-resolver.js";
import {
  acceptMcpCall,
  type DiagnosticConnection,
} from "../../../src/execution/accept-mcp-call.js";
import { RequestExecution } from "../../../src/execution/request-execution.js";
import { McpToolSchemaError } from "../../../src/runtime/tool-policy.js";
import { pickCurrentClusters } from "../../../src/tui/current-cluster-picker.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";

const exact = createExactClusterRule;
const inventory = (...names: string[]) =>
  new ClusterContextRegistry(
    names.map((name) => ({ name, server: `https://${name}`, isDefault: false })),
  );
function fixture(rule = exact(["A"])) {
  const selection = new CurrentClusterSelection(inventory("A", "B"), { rule });
  const request = new RequestExecution({ maxToolCalls: 40, maxModelIterations: 80 });
  let tool = scopedPodTool;
  const connection = {
    ready: true as boolean,
    getTool: () => tool,
    callTool: vi.fn(async (_name: string, args: Record<string, unknown>): Promise<unknown> => args),
  } satisfies DiagnosticConnection;
  const call = (id: string, args: unknown = { context: "A" }) =>
    acceptMcpCall(request, selection, connection, id, "pods_list", args);
  return {
    selection,
    request,
    connection,
    call,
    changeTool: () => {
      tool = structuredClone(tool);
    },
  };
}

describe("current selection and synchronous MCP acceptance", () => {
  it("validates startup exact names strictly with CLI/config/default precedence", () => {
    expect(new CurrentClusterSelection(inventory("A"), {}, exact(["A"])).rule).toEqual(
      exact(["A"]),
    );
    expect(
      new CurrentClusterSelection(inventory("A", "B"), { rule: exact(["B"]) }, exact(["A"])).rule,
    ).toEqual(exact(["B"]));
    expect(
      new CurrentClusterSelection(inventory("A"), { rule: { kind: "all" } }, exact(["missing"]))
        .rule,
    ).toEqual({ kind: "all" });
    expect(new CurrentClusterSelection(inventory("A")).rule).toEqual({ kind: "all" });
    expect(() => new CurrentClusterSelection(inventory("A"), { rule: exact(["missing"]) })).toThrow(
      "startup",
    );
    expect(() => new CurrentClusterSelection(inventory("A"), {}, exact(["missing"]))).toThrow(
      "startup",
    );
  });

  it("retains unavailable exact intent, restores members and excludes new names", async () => {
    const f = fixture(exact(["A", "B"]));
    f.selection.updateInventory(inventory("A", "C"));
    expect(f.selection.rule).toEqual(exact(["A", "B"]));
    expect(f.selection.availability).toEqual({ available: ["A"], unavailable: ["B"] });
    expect(() => f.call("b", { context: "B" })).toThrow("unavailable");
    expect(() => f.call("c", { context: "C" })).toThrow("outside");
    expect((await f.call("a")).status).toBe("success");
    f.selection.updateInventory(inventory());
    expect(() => f.call("a2")).toThrow("unavailable");
    expect(f.selection.rule).toEqual(exact(["A", "B"]));
    f.selection.updateInventory(inventory("B", "C"));
    expect((await f.call("b2", { context: "B" })).status).toBe("success");
    expect(() => f.call("c2", { context: "C" })).toThrow("outside");
    expect(f.request.counts.dispatches).toBe(2);
  });

  it("registers before yielding; queued A keeps its parameters and source after selecting B", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<unknown>();
    f.connection.callTool
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(() => gate.promise);
    const active = Array.from({ length: 4 }, (_, i) => f.call(String(i)));
    const args = { context: "A", namespace: "original" };
    const queued = f.call("queued", args);
    expect(f.request.counts.queued).toBe(5);
    args.context = "B";
    args.namespace = "changed";
    f.selection.select(exact(["B"]));
    expect(() => f.call("late-a")).toThrow("outside");
    await Promise.resolve();
    expect(f.request.counts).toMatchObject({ active: 4, queued: 1 });
    gate.resolve("done");
    await Promise.all(active);
    expect(await queued).toMatchObject({
      status: "success",
      value: { context: "A", namespace: "original" },
    });
    expect((await f.call("new-b", { context: "B" })).status).toBe("success");
    expect(f.request.counts.dispatches).toBe(6);
  });

  it.each([exact(["A"]), exact(["A", "B"]), { kind: "all" } as const])(
    "requires exact explicit context under %j without dispatching invalid calls",
    async (rule) => {
      const f = fixture(rule);
      for (const args of [
        {},
        { context: "" },
        { context: 1 },
        { context: "unknown" },
        { context: ["A"] },
      ])
        expect(() => f.call("invalid", args)).toThrow();
      expect(f.connection.callTool).not.toHaveBeenCalled();
      expect(f.request.counts.dispatches).toBe(0);
      expect((await f.call("valid")).status).toBe("success");
    },
  );

  it("rejects a cluster-dependent tool whose schema does not declare context", () => {
    const f = fixture();
    const incompatible = { ...scopedPodTool, inputSchema: { type: "object", properties: {} } };
    const connection = { ...f.connection, getTool: () => incompatible };
    expect(() =>
      acceptMcpCall(f.request, f.selection, connection, "x", "pods_list", { context: "A" }),
    ).toThrow(
      expect.objectContaining(
        new McpToolSchemaError("incompatible-schema", {
          path: "inputSchema.properties.context",
          message: "Cluster-dependent tools must declare a context parameter.",
        }),
      ),
    );
    expect(f.connection.callTool).not.toHaveBeenCalled();
    expect(f.request.counts.dispatches).toBe(0);
  });

  it("rejects pods_delete because it is not allowlisted", () => {
    const f = fixture();
    expect(() =>
      acceptMcpCall(
        f.request,
        f.selection,
        { ...f.connection, getTool: () => ({ ...scopedPodTool, name: "pods_delete" }) },
        "x",
        "pods_delete",
        {},
      ),
    ).toThrow(
      expect.objectContaining(
        new McpToolSchemaError("not-allowlisted", {
          path: "name",
          message: "Tool is not approved for execution.",
        }),
      ),
    );
    expect(f.connection.callTool).not.toHaveBeenCalled();
    expect(f.request.counts.dispatches).toBe(0);
  });

  it("rejects labelSelector arguments that violate the discovered schema", () => {
    const f = fixture();
    expect(() => f.call("x", { context: "A", labelSelector: 123 })).toThrow(
      "Invalid Kubernetes MCP arguments; call not executed.",
    );
    expect(f.connection.callTool).not.toHaveBeenCalled();
    expect(f.request.counts.dispatches).toBe(0);
  });

  it("all follows inventory and unrelated inventory/default changes preserve active results", async () => {
    const f = fixture({ kind: "all" });
    const gate = Promise.withResolvers<unknown>();
    f.connection.callTool.mockImplementationOnce(() => gate.promise);
    const call = f.call("a");
    await Promise.resolve();
    f.selection.updateInventory(
      new ClusterContextRegistry([
        { name: "A", server: "https://A", isDefault: true },
        { name: "C", server: "https://C", isDefault: false },
      ]),
    );
    expect(f.selection.availability.available).toEqual(["A", "C"]);
    gate.resolve("A result");
    expect(await call).toMatchObject({ status: "success", value: "A result" });
    expect((await f.call("c", { context: "C" })).status).toBe("success");
  });

  it.each(["removed", "replaced", "reappeared", "tool", "connection"])(
    "never dispatches a queued call after its original %s changes",
    async (change) => {
      const f = fixture();
      const gate = Promise.withResolvers<unknown>();
      f.connection.callTool.mockImplementation(() => gate.promise);
      const calls = Array.from({ length: 5 }, (_, i) => f.call(String(i)));
      await Promise.resolve();
      if (change === "tool") f.changeTool();
      else if (change === "connection") f.connection.ready = false;
      else if (change === "replaced")
        f.selection.updateInventory(
          new ClusterContextRegistry([
            { name: "A", server: "https://replacement", isDefault: false },
          ]),
        );
      else {
        f.selection.updateInventory(inventory("B"));
        if (change === "reappeared") f.selection.updateInventory(inventory("A", "B"));
      }
      gate.resolve("late original result");
      const results = await Promise.all(calls);
      expect(results.every((result) => result.status === "error")).toBe(true);
      expect(results[4]).not.toHaveProperty("dispatchedAt");
      expect(f.connection.callTool).toHaveBeenCalledTimes(4);
      expect(f.request.counts.dispatches).toBe(4);
    },
  );

  it("picker retains unavailable rows and allows explicit removal while work is active", async () => {
    const f = fixture(exact(["A", "B"]));
    f.selection.updateInventory(inventory("A", "C"));
    const gate = Promise.withResolvers<unknown>();
    f.connection.callTool.mockImplementationOnce(() => gate.promise);
    const call = f.call("a");
    const select = vi
      .fn()
      .mockImplementationOnce(async (_title, rows: string[]) => {
        expect(rows).toContain('[x] "B" (unavailable)');
        return '[x] "B" (unavailable)';
      })
      .mockResolvedValueOnce("Apply selection");
    await pickCurrentClusters({ select }, f.selection);
    expect(f.selection.rule).toEqual(exact(["A"]));
    gate.resolve("ok");
    expect((await call).status).toBe("success");
  });

  it("per-call cancellation settles queued and active calls without cancelling the request", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<unknown>();
    f.connection.callTool.mockImplementation(() => gate.promise);
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const active = acceptMcpCall(
      f.request,
      f.selection,
      f.connection,
      "active",
      "pods_list",
      { context: "A" },
      activeAbort.signal,
    );
    const others = Array.from({ length: 3 }, (_, i) => f.call(String(i)));
    const queued = acceptMcpCall(
      f.request,
      f.selection,
      f.connection,
      "queued",
      "pods_list",
      { context: "A" },
      queuedAbort.signal,
    );
    await Promise.resolve();
    queuedAbort.abort();
    activeAbort.abort();
    expect(await queued).toMatchObject({ status: "cancelled" });
    expect(await queued).not.toHaveProperty("dispatchedAt");
    expect(await active).toMatchObject({ status: "cancelled", dispatchedAt: expect.any(Number) });
    expect(f.request.signal.aborted).toBe(false);
    gate.resolve("late");
    await Promise.all(others);
    f.connection.callTool.mockImplementation(async (_name, args) => args);
    expect((await f.call("next")).status).toBe("success");
    expect(f.request.counts).toMatchObject({ active: 0, queued: 0, dispatches: 5 });
    await f.request.finish();
  });

  it("picker UI failures preserve exact unavailable intent", async () => {
    const f = fixture(exact(["A", "B"]));
    f.selection.updateInventory(inventory());
    await expect(
      pickCurrentClusters(
        { select: vi.fn().mockRejectedValue(new Error("UI failure")) },
        f.selection,
      ),
    ).rejects.toThrow("picker failed");
    expect(f.selection.rule).toEqual(exact(["A", "B"]));
  });

  it("picker rejects stale drafts, permits identical/default refresh, and preserves intent on cancel", async () => {
    const f = fixture(exact(["A", "B"]));
    f.selection.updateInventory(inventory("A"));
    await pickCurrentClusters(
      { select: vi.fn().mockResolvedValue("Apply selection") },
      f.selection,
    );
    expect(f.selection.rule).toEqual(exact(["A", "B"]));
    const draft = f.selection.captureDraft();
    f.selection.updateInventory(
      new ClusterContextRegistry([{ name: "A", server: "https://A", isDefault: true }]),
    );
    expect(() => draft.assertCurrent()).not.toThrow();
    await pickCurrentClusters({ select: vi.fn().mockResolvedValue("Cancel") }, f.selection);
    expect(f.selection.rule).toEqual(exact(["A", "B"]));
    await expect(
      pickCurrentClusters(
        {
          select: vi.fn().mockImplementation(async () => {
            f.selection.select(exact(["A"]));
            return "Apply selection";
          }),
        },
        f.selection,
      ),
    ).rejects.toThrow("changed");
    const changedInventory = f.selection.captureDraft();
    f.selection.updateInventory(inventory("A", "C"));
    expect(() => changedInventory.assertCurrent()).toThrow("changed");
    expect(() => f.selection.select(exact(["missing"]))).toThrow("Unknown");
  });
});
