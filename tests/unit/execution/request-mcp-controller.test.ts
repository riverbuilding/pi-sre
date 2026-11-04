import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@earendil-works/pi-mcp";
import {
  RequestMcpController,
  type RequestMcpPublication,
} from "../../../src/app/request-mcp-controller.js";
import { createExactClusterRule } from "../../../src/cluster/context-resolver.js";
import { RequestExecution } from "../../../src/execution/request-execution.js";
import type { McpConnection, McpConnectionState } from "../../../src/mcp/connection.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";

const contextsTool: Tool = { name: "configuration_contexts_list", inputSchema: { type: "object" } };
const limits = { maxToolCalls: 8, maxModelIterations: 12 };
function server(names = ["A", "B"], endpoint = "https://original") {
  let state: McpConnectionState = "ready";
  const listeners = new Set<() => void>();
  const diagnostic = vi.fn(
    async (
      _name: string,
      args: Readonly<Record<string, unknown>>,
      _signal?: AbortSignal,
    ): Promise<unknown> => {
      void _signal;
      return args;
    },
  );
  const listTools = vi.fn(async (): Promise<readonly Tool[]> => [contextsTool, scopedPodTool]);
  const enumerate = vi.fn(async (): Promise<unknown> => ({
    content: [],
    structuredContent: {
      contexts: names.map((name) => ({ name, server: endpoint, default: false })),
    },
  }));
  const connection: McpConnection = {
    get state() {
      return state;
    },
    listTools,
    callTool: (name, args, signal) =>
      name === contextsTool.name ? enumerate() : diagnostic(name, args, signal),
    onClose: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: vi.fn(async () => {
      state = "closed";
    }),
  };
  return {
    connection,
    diagnostic,
    listTools,
    enumerate,
    disconnect: () => {
      state = "failed";
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}
function fixture(servers = [server(), server()]) {
  const publications: RequestMcpPublication[] = [];
  const publish = vi.fn(async (state: RequestMcpPublication) => {
    publications.push(state);
  });
  const connect = vi.fn(async () => {
    const next = servers.shift();
    if (!next) throw new Error("No fixture server");
    return next.connection;
  });
  const controller = new RequestMcpController({
    connect,
    publish,
    intent: { rule: createExactClusterRule(["A", "B"]) },
  });
  return { controller, publications, publish, connect };
}
function call(
  publication: RequestMcpPublication,
  request: RequestExecution,
  id: string,
  args: unknown = { context: "A" },
) {
  if (!publication.accept) throw new Error("Missing ready handler");
  return publication.accept(request, id, "pods_list", args);
}

// Composes the real discovery/schema, current selection, acceptance and request queue.
describe("request MCP replacement and publication barrier", () => {
  it.each(["force", "disconnect"])(
    "interrupts active/queued calls on %s without refund, replay or request cancellation",
    async (mode) => {
      const old = server();
      const next = server(["A", "C"], "https://replacement");
      const f = fixture([old, next]);
      const request = new RequestExecution(limits);
      request.consumeModelIteration();
      await f.controller.restart();
      const handler = f.controller.snapshot;
      const success = await call(handler, request, "completed");
      const late = Promise.withResolvers<unknown>();
      old.diagnostic.mockImplementation(() => late.promise); // transport deliberately ignores abort
      const active = Array.from({ length: 4 }, (_, i) => call(handler, request, String(i)));
      const queued = call(handler, request, "queued");
      await Promise.resolve();
      expect(request.counts).toMatchObject({ dispatches: 5, active: 4, queued: 1 });
      if (mode === "force") await f.controller.restart(true);
      else {
        old.disconnect();
        expect(() => call(handler, request, "after-disconnect")).toThrow("unavailable");
        await f.controller.restart(); // share disconnect cleanup
        expect(f.connect).toHaveBeenCalledTimes(1); // no automatic reconnect
        await f.controller.restart();
      }
      expect(await Promise.all(active)).toEqual(
        Array.from({ length: 4 }, () =>
          expect.objectContaining({
            status: "error",
            error: expect.objectContaining({
              message: expect.stringContaining("connection interrupted"),
            }),
            dispatchedAt: expect.any(Number),
            settledAt: expect.any(Number),
          }),
        ),
      );
      expect(await queued).toMatchObject({ status: "error", settledAt: expect.any(Number) });
      expect(await queued).not.toHaveProperty("dispatchedAt");
      expect(success.status).toBe("success");
      expect(request.signal.aborted).toBe(false);
      expect(request.counts).toEqual({ dispatches: 5, modelIterations: 1, active: 0, queued: 0 });
      expect(f.controller.selection?.rule).toEqual(createExactClusterRule(["A", "B"]));
      expect(f.controller.selection?.availability).toEqual({
        available: ["A"],
        unavailable: ["B"],
      });
      expect(() => call(handler, request, "captured")).toThrow("unavailable");
      late.resolve("late old success");
      await Promise.resolve();
      expect(next.diagnostic).not.toHaveBeenCalled();
      expect((await call(f.controller.snapshot, request, "continued")).status).toBe("success");
      expect(request.counts.dispatches).toBe(6);
      expect(old.diagnostic).toHaveBeenCalledTimes(5);
      expect(old.diagnostic.mock.calls[1]?.[2]?.aborted).toBe(true);
      await request.finish();
      const counts = request.counts;
      await f.controller.restart(); // healthy ordinary restart is a no-op
      expect(request.counts).toEqual(counts);
      expect(f.connect).toHaveBeenCalledTimes(2);
      const newRequest = new RequestExecution(limits);
      expect((await call(f.controller.snapshot, newRequest, "new")).status).toBe("success");
      expect(newRequest.counts.dispatches).toBe(1);
      await f.controller.close();
      expect(old.listenerCount()).toBe(0);
      expect(next.listenerCount()).toBe(0);
    },
  );

  it("keeps captured and newly installed handlers blocked through asynchronous publication", async () => {
    const f = fixture();
    await f.controller.restart();
    const old = f.controller.snapshot;
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<RequestMcpPublication>();
    f.publish.mockImplementation(async (state) => {
      f.publications.push(state);
      if (state.status === "ready") {
        entered.resolve(state);
        await gate.promise;
      }
    });
    const replacing = f.controller.restart(true);
    const installed = await entered.promise;
    expect(f.controller.snapshot.status).toBe("connecting");
    const request = new RequestExecution(limits);
    expect(() => call(old, request, "old")).toThrow("unavailable");
    expect(() => call(installed, request, "during-publish")).toThrow("unavailable");
    expect(f.controller.restart(true)).toBe(replacing);
    expect(request.counts.dispatches).toBe(0);
    gate.resolve();
    await replacing;
    expect((await call(installed, request, "after-publish")).status).toBe("success");
    await f.controller.close();
  });

  it.each(["tools", "schema", "inventory", "publication"])(
    "fails closed after %s failure with no old inventory/schema fallback",
    async (stage) => {
      const old = server();
      const next = server();
      const f = fixture([old, next]);
      await f.controller.restart();
      const captured = f.controller.snapshot;
      let attempted: RequestMcpPublication | undefined;
      if (stage === "tools") next.listTools.mockRejectedValue(new Error("list failed"));
      if (stage === "schema")
        next.listTools.mockResolvedValue([
          { ...contextsTool, inputSchema: { type: "string" } },
          scopedPodTool,
        ]);
      if (stage === "inventory")
        next.enumerate.mockResolvedValue({ content: [], structuredContent: { contexts: "bad" } });
      if (stage === "publication")
        f.publish.mockImplementation(async (state) => {
          f.publications.push(state);
          if (state.status === "ready") {
            attempted = state;
            throw new Error("publish failed");
          }
        });
      await f.controller.restart(true);
      expect(f.controller.snapshot).toMatchObject({ status: "unavailable", tools: [] });
      expect(f.controller.selection?.availability).toEqual({
        available: [],
        unavailable: ["A", "B"],
      });
      const request = new RequestExecution(limits);
      expect(() => call(captured, request, "old")).toThrow("unavailable");
      const partial = attempted;
      if (partial) expect(() => call(partial, request, "partial-publish")).toThrow("unavailable");
      expect(request.counts.dispatches).toBe(0);
      expect(next.diagnostic).not.toHaveBeenCalled();
      expect(next.connection.close).toHaveBeenCalled();
      expect(f.publications.at(-1)?.status).toBe("unavailable");
      await f.controller.close();
    },
  );

  it("validates new calls against replacement schema and keeps all following inventory", async () => {
    const old = server(["A"]);
    const next = server(["A", "C"]);
    next.listTools.mockResolvedValue([
      contextsTool,
      {
        ...scopedPodTool,
        inputSchema: {
          type: "object",
          properties: { context: { type: "string" }, namespace: { type: "string" } },
          required: ["namespace"],
        },
      },
    ]);
    const servers = [old, next];
    const controller = new RequestMcpController({
      connect: async () => {
        const s = servers.shift();
        if (!s) throw new Error("missing server");
        return s.connection;
      },
      publish: () => undefined,
    });
    await controller.restart();
    await controller.restart(true);
    expect(controller.selection?.availability.available).toEqual(["A", "C"]);
    const request = new RequestExecution(limits);
    expect(() => call(controller.snapshot, request, "old-shape")).toThrow("Invalid");
    expect(
      (
        await call(controller.snapshot, request, "new-shape", {
          context: "C",
          namespace: "default",
        })
      ).status,
    ).toBe("success");
    expect(request.counts.dispatches).toBe(1); // discovery is lifecycle-only, not charged
    await controller.close();
  });

  it("does not turn authentication or Kubernetes operation failures into transport loss", async () => {
    const s = server();
    const f = fixture([s]);
    await f.controller.restart();
    const request = new RequestExecution(limits);
    const auth = { isError: true, content: [{ type: "text", text: "Unauthorized" }] };
    s.diagnostic
      .mockResolvedValueOnce(auth)
      .mockRejectedValueOnce(new Error("Kubernetes operation failed"));
    expect(await call(f.controller.snapshot, request, "auth")).toMatchObject({ value: auth });
    expect(await call(f.controller.snapshot, request, "operation")).toMatchObject({
      status: "error",
    });
    expect(f.controller.snapshot.status).toBe("ready");
    expect(f.controller.snapshot.message).toContain("does not imply authentication");
    expect(request.counts.dispatches).toBe(2);
    await f.controller.close();
  });

  it("closes the barrier if transport drops while ready publication is in progress", async () => {
    const s = server();
    const f = fixture([s]);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<RequestMcpPublication>();
    f.publish.mockImplementation(async (state) => {
      f.publications.push(state);
      if (state.status === "ready") {
        entered.resolve(state);
        await gate.promise;
      }
    });
    const start = f.controller.restart();
    const candidate = await entered.promise;
    s.disconnect();
    gate.resolve();
    await start;
    expect(f.controller.snapshot.status).toBe("unavailable");
    expect(f.publications.map((state) => state.status)).toEqual([
      "connecting",
      "ready",
      "unavailable",
    ]);
    expect(() => call(candidate, new RequestExecution(limits), "late")).toThrow("unavailable");
    expect(f.connect).toHaveBeenCalledTimes(1);
    await f.controller.close();
  });

  it("withdrawal publication failure still interrupts accepted calls and closes transport", async () => {
    const s = server();
    const f = fixture([s]);
    await f.controller.restart();
    const old = f.controller.snapshot;
    s.diagnostic.mockImplementation(() => new Promise(() => undefined));
    const request = new RequestExecution(limits);
    const active = call(old, request, "active");
    await Promise.resolve();
    f.publish.mockImplementation(async (state) => {
      if (state.status === "connecting") throw new Error("withdrawal failed");
    });
    await f.controller.restart(true);
    expect(await active).toMatchObject({ status: "error", dispatchedAt: expect.any(Number) });
    expect(request.counts).toMatchObject({ active: 0, queued: 0, dispatches: 1 });
    expect(f.controller.snapshot.status).toBe("unavailable");
    expect(s.connection.close).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    await f.controller.close();
  });

  it("does not recover unknown startup exact names by falling back to all", async () => {
    const s = server(["A"]);
    const f = fixture([s]);
    await f.controller.restart();
    expect(f.controller.snapshot.status).toBe("unavailable");
    expect(f.controller.selection).toBeUndefined();
    expect(s.diagnostic).not.toHaveBeenCalled();
    expect(s.connection.close).toHaveBeenCalledTimes(1);
    await f.controller.close();
  });

  it("closes during publication without opening dispatch and tolerates late transport completion", async () => {
    const s = server();
    const f = fixture([s]);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<RequestMcpPublication>();
    f.publish.mockImplementation(async (state) => {
      if (state.status === "ready") {
        entered.resolve(state);
        await gate.promise;
      }
    });
    const start = f.controller.restart();
    const candidate = await entered.promise;
    const closing = f.controller.close();
    expect(() => call(candidate, new RequestExecution(limits), "closed")).toThrow("unavailable");
    gate.resolve();
    await Promise.all([start, closing]);
    expect(f.controller.snapshot.status).toBe("unavailable");
    expect(s.connection.close).toHaveBeenCalledTimes(1);
  });
});
