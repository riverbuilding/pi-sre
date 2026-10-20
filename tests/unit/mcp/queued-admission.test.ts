import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { createMcpToolBridge } from "../../../src/mcp/tool-bridge.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";

function setup(signal?: AbortSignal) {
  const manager = new ClusterContextManager({ rule: { kind: "all" } });
  const generation = manager.beginConnection();
  manager.acceptRegistry(
    generation,
    new ClusterContextRegistry(
      ["alpha", "beta"].map((name) => ({ name, server: "withheld", isDefault: false })),
    ),
  );
  const responses: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
  const callTool = vi.fn(
    (_name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const response = Promise.withResolvers<unknown>();
      responses.push(response);
      return response.promise.then(() => ({
        content: [{ type: "text", text: `${String(args.context)}/api` }],
      }));
    },
  );
  const binding = { manager, connectionGeneration: generation, ...(signal ? { signal } : {}) };
  const tool = createMcpToolBridge(scopedPodTool, { callTool }, undefined, binding);
  const enumeration = createMcpToolBridge(
    {
      name: "configuration_contexts_list",
      inputSchema: { type: "object", properties: {} },
    },
    { callTool },
    undefined,
    binding,
  );
  const capture = vi.spyOn(manager, "captureExecution");
  return { manager, generation, tool, enumeration, callTool, responses, capture };
}
function execute(tool: ToolDefinition, context?: string, signal?: AbortSignal) {
  return tool.execute(
    "call",
    context === undefined ? {} : { context },
    signal,
    undefined,
    {} as never,
  );
}
const success = { content: [] };

async function completeAll(state: ReturnType<typeof setup>, pending: readonly Promise<unknown>[]) {
  for (let index = 0; index < pending.length; index++) {
    state.responses[index]!.resolve(success);
    await pending[index];
  }
  return Promise.all(pending);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded application admission", () => {
  it("queues a fifth call without snapshot, preserves FIFO targets and blocks selection", async () => {
    const state = setup();
    const pending = ["alpha", "beta", "alpha", "beta", "beta", "alpha"].map((context) =>
      execute(state.tool, context),
    );
    expect(state.callTool).toHaveBeenCalledTimes(4);
    expect(state.capture).toHaveBeenCalledTimes(4);
    expect(() => state.manager.select("alpha")).toThrow(/active/);
    state.responses[1]!.resolve(success);
    await pending[1];
    await Promise.resolve();
    expect(state.callTool).toHaveBeenCalledTimes(5);
    expect(state.callTool.mock.calls[4]?.[1]).toEqual({ context: "beta" });
    state.responses[4]!.resolve(success);
    await pending[4];
    await Promise.resolve();
    expect(state.callTool.mock.calls[5]?.[1]).toEqual({ context: "alpha" });
    const results = await completeAll(state, pending);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            scope: expect.objectContaining({ context: "alpha" }),
          }),
        }),
        expect.objectContaining({
          details: expect.objectContaining({ scope: expect.objectContaining({ context: "beta" }) }),
        }),
      ]),
    );
    expect(state.manager.isAgentActive).toBe(false);
    state.manager.select("alpha");
  });

  it("shares four active and 32 waiting slots with enumeration and replacement handlers", async () => {
    const state = setup();
    const pending = Array.from({ length: 36 }, (_, i) =>
      execute(i % 2 ? state.enumeration : state.tool, i % 2 ? undefined : "alpha"),
    );
    expect(state.callTool).toHaveBeenCalledTimes(4);
    expect(await execute(state.tool, "beta")).toMatchObject({
      details: { failureCategory: "capacity-exceeded" },
    });
    expect(await execute(state.tool)).toMatchObject({
      details: { failureCategory: "invalid-arguments" },
    });
    const another = setup();
    const independent = execute(another.tool, "alpha");
    expect(another.callTool).toHaveBeenCalledTimes(1);
    another.responses[0]!.resolve(success);
    await independent;
    const results = await completeAll(state, pending);
    expect(results).toEqual(pending.map(() => expect.objectContaining({ isError: false })));
    expect(state.callTool).toHaveBeenCalledTimes(36);
    expect(state.manager.isAgentActive).toBe(false);
  });

  it.each([0, 15, 31])("removes cancelled waiter %s and reclaims its capacity", async (index) => {
    const state = setup();
    const active = Array.from({ length: 4 }, () => execute(state.tool, "alpha"));
    const aborts = Array.from({ length: 32 }, () => new AbortController());
    const queued = aborts.map((abort) => execute(state.tool, "beta", abort.signal));
    expect(await execute(state.tool, "beta")).toMatchObject({
      details: { failureCategory: "capacity-exceeded" },
    });
    const removeListener = vi.spyOn(aborts[index]!.signal, "removeEventListener");
    const cancelled = expect(queued[index]).rejects.toThrow(/abort/i);
    aborts[index]!.abort();
    await cancelled;
    expect(state.capture).toHaveBeenCalledTimes(4);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    const replacement = execute(state.tool, "alpha");
    const remaining = [...active, ...queued.filter((_, i) => i !== index), replacement];
    await completeAll(state, remaining);
    expect(state.callTool).toHaveBeenCalledTimes(36);
    expect(state.manager.isAgentActive).toBe(false);
  });

  it("expires queue residence independently of active calls and clears timers", async () => {
    vi.useFakeTimers();
    const state = setup();
    const active = Array.from({ length: 4 }, () => execute(state.tool, "alpha"));
    const queued = execute(state.tool, "beta");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(state.callTool).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    const result = await queued;
    expect(result).toMatchObject({ details: { failureCategory: "timeout" } });
    expect(JSON.stringify(result)).toContain("admission wait");
    expect(state.capture).toHaveBeenCalledTimes(4);
    await completeAll(state, active);
    expect(state.manager.isAgentActive).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["generation", "gate", "unavailable", "dispose"])(
    "settles waiters promptly on %s without active settlement",
    async (change) => {
      vi.useFakeTimers();
      const state = setup();
      const active = Array.from({ length: 4 }, () => execute(state.tool, "alpha"));
      const queued = [execute(state.tool, "beta"), execute(state.enumeration)];
      let reopen: (() => void) | undefined;
      if (change === "generation") state.manager.beginConnection();
      if (change === "gate") reopen = state.manager.blockDispatch();
      if (change === "unavailable") {
        state.manager.markUnavailable("transport unavailable");
      }
      if (change === "dispose") state.manager.dispose();
      expect(await Promise.all(queued)).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            failureCategory: change === "unavailable" ? "scope-unavailable" : "stale-scope",
          }),
        }),
        expect.objectContaining({
          details: expect.objectContaining({
            failureCategory: change === "unavailable" ? "transport-unavailable" : "stale-scope",
          }),
        }),
      ]);
      expect(state.callTool).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
      reopen?.();
      await completeAll(state, active);
      expect(state.manager.isAgentActive).toBe(false);
    },
  );

  it("settles waiters on application cancellation before controller teardown", async () => {
    const shutdown = new AbortController();
    const state = setup(shutdown.signal);
    const active = Array.from({ length: 4 }, () => execute(state.tool, "alpha"));
    const queued = [execute(state.tool, "beta"), execute(state.enumeration)];
    shutdown.abort();
    for (const result of await Promise.all(queued))
      expect(result).toMatchObject({
        isError: true,
        details: { failureCategory: "transport-unavailable" },
      });
    expect(state.callTool).toHaveBeenCalledTimes(4);
    expect(state.capture).toHaveBeenCalledTimes(4);
    await completeAll(state, active);
    expect(state.manager.isAgentActive).toBe(false);
  });

  it.each(["cancel", "generation", "revision", "availability"])(
    "rechecks %s after slot handoff before the waiter continuation runs",
    async (change) => {
      const state = setup();
      const slots = Array.from({ length: 4 }, () => state.manager.admitExecution(() => undefined));
      const cancellation = new AbortController();
      const queued = execute(state.tool, "beta", cancellation.signal);
      const observed = change === "cancel" ? expect(queued).rejects.toThrow(/abort/i) : undefined;
      const slot = slots[0];
      if (slot instanceof Promise || !slot?.ok) throw new Error("Expected immediate slot");
      slot.release();
      slot.release(); // A duplicate release must not create extra capacity.
      if (change === "cancel") cancellation.abort();
      if (change === "generation") state.manager.beginConnection();
      const current = state.manager.state;
      if (change === "revision")
        vi.spyOn(state.manager, "state", "get").mockReturnValue({
          ...current,
          inventoryRevision: current.inventoryRevision + 1,
        });
      if (change === "availability")
        vi.spyOn(state.manager, "state", "get").mockReturnValue({
          ...current,
          resolution: { status: "resolved", available: [], unavailable: ["beta"] },
        });
      if (observed) await observed;
      else
        expect(await queued).toMatchObject({
          details: {
            failureCategory: change === "availability" ? "scope-unavailable" : "stale-scope",
          },
        });
      expect(state.callTool).not.toHaveBeenCalled();
      expect(state.capture).not.toHaveBeenCalled();
      for (const held of slots) {
        if (!(held instanceof Promise) && held.ok) held.release();
      }
      expect(state.manager.isAgentActive).toBe(false);
      state.manager.dispose();
    },
  );

  it.each(["throw", "failure", "invalid", "cancel", "normalize"])(
    "releases active capacity and progresses waiters after %s",
    async (kind) => {
      const state = setup();
      const active = Array.from({ length: 4 }, () => execute(state.tool, "alpha"));
      const cancelled = new AbortController();
      state.callTool.mockImplementationOnce(() => {
        if (kind === "throw") throw new Error("transport failure");
        if (kind === "cancel") cancelled.abort();
        if (kind === "normalize")
          return Promise.resolve({
            get content() {
              throw new Error("normalizer failed");
            },
          });
        return Promise.resolve(kind === "failure" ? { content: [], isError: true } : {});
      });
      const first = execute(state.tool, "beta", cancelled.signal);
      const observed =
        kind === "cancel" || kind === "normalize"
          ? expect(first).rejects.toThrow()
          : expect(first).resolves.toMatchObject({ isError: true });
      const next = execute(state.tool, "beta");
      state.responses[0]!.resolve(success);
      await active[0];
      await observed;
      expect(state.callTool).toHaveBeenCalledTimes(6);
      state.responses[4]!.resolve(success);
      expect(await next).toMatchObject({ isError: false });
      await completeAll(state, active);
      expect(state.manager.isAgentActive).toBe(false);
    },
  );
});
