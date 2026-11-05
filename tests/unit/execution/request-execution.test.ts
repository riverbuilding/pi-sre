import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { sreConfigSchema } from "../../../src/config/schema.js";
import { describe, expect, it } from "vitest";

import { executionLimitsSchema } from "../../../src/config/execution.js";
import { RequestExecution, type CallIdentity } from "../../../src/execution/request-execution.js";

const limits = { maxToolCalls: 2, maxModelIterations: 3 };
const identity = (id: number): CallIdentity => ({
  toolCallId: String(id),
  operation: "pods_list",
  context: "A",
  parameters: {},
  connection: {},
});

describe("request execution", () => {
  it("shares dispatch allowance concurrently; rejection is free, dispatch failure is charged", async () => {
    const request = new RequestExecution(limits);
    const rejected = await request.accept(
      identity(0),
      () => {
        throw new Error("unavailable");
      },
      async () => 0,
    );
    expect(rejected).toMatchObject({ status: "error" });
    expect(rejected).not.toHaveProperty("dispatchedAt");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request.accept(
          identity(i),
          () => {},
          async () => {
            throw new Error("MCP failure");
          },
        ),
      ),
    );
    expect(results.filter((r) => r.dispatchedAt !== undefined)).toHaveLength(2);
    expect(request.counts).toEqual({ dispatches: 2, modelIterations: 0, queued: 0, active: 0 });
    await request.finish();
  });

  it("cancels active and queued calls once even if transport ignores cancellation", async () => {
    const request = new RequestExecution({ ...limits, maxToolCalls: 10 });
    const late = Promise.withResolvers<string>();
    const signals: AbortSignal[] = [];
    const calls = Array.from({ length: 8 }, (_, i) =>
      request.accept(
        identity(i),
        () => {},
        (signal) => {
          signals.push(signal);
          return late.promise;
        },
      ),
    );
    await Promise.resolve();
    expect(request.counts).toMatchObject({ active: 4, queued: 4 });
    request.cancel();
    const results = await Promise.all(calls);
    expect(results.every((r) => r.status === "cancelled")).toBe(true);
    expect(results.filter((r) => r.dispatchedAt !== undefined)).toHaveLength(4);
    expect(signals.every((s) => s.aborted)).toBe(true);
    late.resolve("late success");
    await request.finish();
    expect(request.counts).toMatchObject({ dispatches: 4, active: 0, queued: 0 });
    const next = new RequestExecution(limits);
    expect(next.requestId).not.toBe(request.requestId);
    expect(
      (
        await next.accept(
          identity(0),
          () => {},
          async () => "new",
        )
      ).status,
    ).toBe("success");
  });

  it("waits for accepted calls on normal finish and closes admission", async () => {
    const request = new RequestExecution(limits);
    const value = Promise.withResolvers<number>();
    const call = request.accept(
      identity(1),
      () => {},
      () => value.promise,
    );
    let finished = false;
    const finish = request.finish().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(() =>
      request.accept(
        identity(2),
        () => {},
        async () => 2,
      ),
    ).toThrow("closed");
    value.resolve(1);
    expect((await call).status).toBe("success");
    await finish;
    expect(finished).toBe(true);
  });

  it("enforces independent model allowance", () => {
    const request = new RequestExecution(limits);
    for (let i = 0; i < 3; i++) request.consumeModelIteration();
    expect(() => request.consumeModelIteration()).toThrow("iteration limit");
    expect(request.counts.dispatches).toBe(0);
  });

  it("validates bounded independent limits without compatibility aliases", () => {
    expect(executionLimitsSchema.parse({})).toEqual({ maxToolCalls: 40, maxModelIterations: 80 });
    expect(executionLimitsSchema.parse({ maxToolCalls: 1000, maxModelIterations: 1 })).toEqual({
      maxToolCalls: 1000,
      maxModelIterations: 1,
    });
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(executionLimitsSchema.safeParse({ maxToolCalls: value }).success).toBe(false);
      expect(executionLimitsSchema.safeParse({ maxModelIterations: value }).success).toBe(false);
    }
    expect(executionLimitsSchema.safeParse({ maxModelIterations: 2001 }).success).toBe(false);
    expect(executionLimitsSchema.safeParse({ defaultTimeRange: "30m" }).success).toBe(false);
  });
});

it("validates the production template and rejects removed investigation settings", async () => {
  const raw: unknown = parse(await readFile("config/pi-sre.example.yaml", "utf8"));
  const config = sreConfigSchema.parse(raw);
  expect(config.execution).toEqual({ maxToolCalls: 40, maxModelIterations: 80 });
  const { execution: _limits, ...withoutLimits } = config;
  void _limits;
  // Parsed context rules differ from file input; this template omits contexts.
  expect(sreConfigSchema.parse(withoutLimits).execution).toEqual(config.execution);
  expect(
    sreConfigSchema.safeParse({
      ...config,
      investigation: { maxToolCalls: 40, defaultTimeRange: "30m" },
    }).success,
  ).toBe(false);
});
