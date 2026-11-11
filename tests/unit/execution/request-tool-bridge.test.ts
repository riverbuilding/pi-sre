import { describe, expect, it, vi } from "vitest";

import { RequestMcpController } from "../../../src/app/request-mcp-controller.js";
import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { RequestExecution } from "../../../src/execution/request-execution.js";
import type { McpConnection } from "../../../src/mcp/connection.js";
import { createRequestMcpToolBridge } from "../../../src/mcp/request-tool-bridge.js";
import { scopedPodTool } from "../../fixtures/scoped-tool.js";

const contextsTool = { name: "configuration_contexts_list", inputSchema: { type: "object" } };
const textResult = (text: string) => ({ content: [{ type: "text", text }] });

async function fixture(names = ["A", "B"], maxTextChars = 8000, maxToolCalls = 40) {
  const diagnostic = vi.fn(
    async (
      _name: string,
      _args: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<unknown> => {
      void _name;
      void _args;
      void _signal;
      return textResult("pod web");
    },
  );
  const connection: McpConnection = {
    state: "ready",
    listTools: async () => [contextsTool, scopedPodTool],
    callTool: async (name, args, signal) =>
      name === contextsTool.name
        ? {
            content: [],
            structuredContent: {
              contexts: names.map((name) => ({
                name,
                server: "https://private-endpoint",
                default: false,
              })),
            },
          }
        : diagnostic(name, args, signal),
    close: vi.fn(async () => {}),
  };
  const controller = new RequestMcpController({
    connect: async () => connection,
    publish: () => {},
  });
  await controller.restart();
  expect(controller.snapshot.status).toBe("ready");
  const request = new RequestExecution({ maxToolCalls, maxModelIterations: 80 });
  const policy = { ...DEFAULT_RESULT_POLICY, maxTextChars };
  const tool = createRequestMcpToolBridge(
    scopedPodTool,
    controller.snapshot,
    () => request,
    policy,
  );
  const execute = (
    id: string,
    args: Record<string, unknown> = { context: names[0] },
    signal?: AbortSignal,
  ) => tool.execute(id, args, signal, undefined, {} as never);
  return { controller, request, diagnostic, tool, execute, policy };
}

describe("Slice 4 unified request tool results", () => {
  it("puts exact concurrent A/B origins in content; later selection cannot rewrite history", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<unknown>();
    f.diagnostic.mockImplementation(() => gate.promise);
    const a = f.execute("a", { context: "A", namespace: "payments" });
    const b = f.execute("b", { context: "B", namespace: "payments" });
    expect(f.request.counts.queued).toBe(2); // accepted synchronously
    f.controller.selection!.select({ kind: "exact", contexts: ["B"] });
    gate.resolve(textResult("pod web"));
    const results = await Promise.all([a, b]);
    for (const [index, context] of ["A", "B"].entries()) {
      const result = results[index]!;
      expect(result.isError).toBe(false);
      const content = JSON.stringify(result.content);
      expect(content).toContain(`\\"context\\":\\"${context}\\"`);
      expect(content).toContain("payments");
      expect(content).toContain("pods_list");
      expect(content).toContain("dispatchedAt");
      expect(content).toContain("settledAt");
      expect(content).toContain("not object observation time");
      expect(content).toContain("READ ONLY");
      expect(content).toContain("pod web");
      expect(JSON.stringify(result)).not.toMatch(
        /evidenceId|incidentId|executionId|private-endpoint/,
      );
    }
    const saved = JSON.stringify(results[0]);
    const rejected = await f.execute("late", { context: "A" });
    expect(rejected).toMatchObject({
      isError: true,
      details: { status: "not-executed", failureCategory: "scope-unavailable" },
    });
    expect(JSON.stringify(rejected.content)).not.toMatch(/dispatchedAt|settledAt/);
    expect(JSON.stringify(results[0])).toBe(saved);
    expect(f.request.counts.dispatches).toBe(2);
    await f.controller.close();
  });

  it.each([
    [{ content: [] }, "success", undefined, "no content"],
    [textResult(""), "success", undefined, "no content"],
    [{ content: [], isError: true }, "error", "tool-execution-failed", "execution error"],
    [
      { content: [{ type: "text", text: "Unauthorized token=private" }], isError: true },
      "error",
      "authentication-failed",
      "authentication failed",
    ],
    [
      { content: [{ type: "text", text: "Forbidden password=private" }], isError: true },
      "error",
      "authorization-failed",
      "authorization failed",
    ],
    [
      { content: [{ type: "text", text: 42 }] },
      "invalid-result",
      "invalid-result",
      "invalid tool result",
    ],
    [{ items: [] }, "invalid-result", "invalid-result", "invalid tool result"],
  ])("presents empty and MCP outcomes accurately: %j", async (raw, status, category, message) => {
    const f = await fixture();
    f.diagnostic.mockResolvedValue(raw);
    const result = await f.execute("call");
    expect(result.details).toMatchObject({
      status,
      ...(category ? { failureCategory: category } : {}),
    });
    expect(JSON.stringify(result.content)).toContain(message);
    expect(JSON.stringify(result.content)).toContain("server/context policy (not all namespaces)");
    expect(JSON.stringify(result.content)).toContain("dispatchedAt");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(f.controller.snapshot.status).toBe("ready");
    await f.controller.close();
  });

  it.each([
    ["request timed out token=private", "timeout"],
    ["connection closed password=private", "transport-unavailable"],
    ["Kubernetes query failed secret=private", "tool-execution-failed"],
  ])(
    "sanitizes thrown %s without confusing failure with empty success",
    async (message, category) => {
      const f = await fixture();
      f.diagnostic.mockRejectedValue(new Error(message));
      const result = await f.execute("failure");
      expect(result).toMatchObject({
        isError: true,
        details: { status: "error", failureCategory: category },
      });
      expect(JSON.stringify(result.content)).toContain(category);
      expect(JSON.stringify(result.content)).toContain("settledAt");
      expect(JSON.stringify(result)).not.toContain("private");
      expect(f.request.counts.dispatches).toBe(1);
      await f.controller.close();
    },
  );

  it("settles active/queued cancellation once with correct execution times and no late success", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<unknown>();
    f.diagnostic.mockImplementation(() => gate.promise);
    const calls = Array.from({ length: 5 }, (_, i) => f.execute(String(i)));
    await Promise.resolve();
    f.request.cancel();
    const results = await Promise.all(calls);
    for (const result of results.slice(0, 4)) {
      expect(result).toMatchObject({ isError: true, details: { status: "cancelled" } });
      expect(JSON.stringify(result.content)).toContain("dispatchedAt");
    }
    expect(results[4]).toMatchObject({
      isError: true,
      details: { status: "not-executed", failureCategory: "cancelled" },
    });
    expect(JSON.stringify(results[4]!.content)).not.toMatch(/dispatchedAt|settledAt/);
    const saved = JSON.stringify(results);
    gate.resolve(textResult("late success token=private"));
    await f.request.waitForIdle();
    expect(JSON.stringify(results)).toBe(saved);
    expect(f.request.counts).toMatchObject({ dispatches: 4, queued: 0, active: 0 });
    await f.controller.close();
  });

  it("presents connection replacement interruption without cancelling the request or refunding dispatch", async () => {
    const f = await fixture();
    f.diagnostic.mockImplementation(() => new Promise(() => {}));
    const calls = Array.from({ length: 5 }, (_, i) => f.execute(String(i)));
    await Promise.resolve();
    await f.controller.restart(true);
    const results = await Promise.all(calls);
    expect(results.slice(0, 4).every((r) => r.isError)).toBe(true);
    expect(results[0]!.details).toMatchObject({
      status: "error",
      failureCategory: "transport-unavailable",
    });
    expect(results[4]!.details).toMatchObject({
      status: "not-executed",
      failureCategory: "transport-unavailable",
    });
    expect(f.request.signal.aborted).toBe(false);
    expect(f.request.counts.dispatches).toBe(4);
    const captured = await f.execute("old-handler");
    expect(captured.details).toMatchObject({
      status: "not-executed",
      failureCategory: "transport-unavailable",
    });
    await f.controller.close();
  });

  it("keeps budget refusal free and request-specific without domain IDs or evidence writes", async () => {
    const f = await fixture(["A"], 8000, 1);
    await f.execute("first");
    const refused = await f.execute("over-budget");
    expect(refused.details).toMatchObject({
      status: "not-executed",
      failureCategory: "budget-refused",
    });
    expect(JSON.stringify(refused.content)).toContain("Request tool dispatch limit");
    expect(JSON.stringify(refused)).not.toMatch(
      /Incident|evidence|conclude|dispatchedAt|settledAt/,
    );
    expect(f.diagnostic).toHaveBeenCalledTimes(1);
    await f.controller.close();
  });

  it.each([255, 256, 257, 10_000])(
    "limits only the normalized body and preserves complete provenance for %i input chars",
    async (length) => {
      const maxChars = 256;
      const context = 'A"\\😀'.repeat(60);
      const f = await fixture([context], maxChars);
      const text = '"\\😀\n'.repeat(2000).slice(0, length);
      f.diagnostic.mockResolvedValue(textResult(text));
      const result = await f.execute("long");
      expect(f.diagnostic).toHaveBeenCalledTimes(1);
      expect(f.request.counts.dispatches).toBe(1);
      expect(result.isError).toBe(false);
      const truncated = length > maxChars;
      expect(result.details).toEqual({ status: "success", truncated });
      expect(JSON.stringify(result).length).toBeGreaterThan(maxChars);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type !== "text") {
        throw new Error("Missing text");
      }
      const boundary = content.text.indexOf("\n");
      const source: unknown = JSON.parse(content.text.slice("Source: ".length, boundary));
      expect(source).toMatchObject({
        context,
        truncated,
        status: "success",
        execution: "dispatched",
        dispatchedAt: expect.any(String),
        settledAt: expect.any(String),
      });
      const body = content.text.slice(boundary + 1);
      expect(body.length).toBeLessThanOrEqual(maxChars);
      if (truncated) {
        expect(body).toMatch(/\n\[Result truncated\]$/);
        expect(body).not.toMatch(/[\uD800-\uDBFF]\n/u);
      } else {
        expect(body).toBe(text);
      }
      await f.controller.close();
    },
  );

  it("applies the full body allowance independently to concurrent calls", async () => {
    const f = await fixture(["A", "B"], 256);
    f.diagnostic.mockResolvedValue(textResult("x".repeat(256)));
    const results = await Promise.all([
      f.execute("a", { context: "A" }),
      f.execute("b", { context: "B" }),
    ]);
    for (const result of results) {
      expect(result.details).toEqual({ status: "success", truncated: false });
      const content = result.content[0];
      if (content?.type !== "text") {
        throw new Error("Missing text");
      }
      expect(content.text.slice(content.text.indexOf("\n") + 1)).toBe("x".repeat(256));
    }
    expect(f.request.counts.dispatches).toBe(2);
    await f.controller.close();
  });

  it("redacts structured/text data and omits binary with no raw payload in details", async () => {
    const f = await fixture();
    f.diagnostic
      .mockResolvedValueOnce({
        content: [],
        extraServerField: true,
        structuredContent: {
          password: "private-password",
          nested: { token: "private-token" },
          arbitraryServerField: "accepted",
          items: [1, 2],
        },
      })
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "Authorization: Bearer private-token\npassword=private-password" },
          { type: "image", mimeType: "image/png", data: "private-binary" },
          { type: "resource", resource: { uri: "https://resource", blob: "private-blob" } },
        ],
      });
    for (const id of ["structured", "text-binary"]) {
      const result = await f.execute(id);
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(
        /private-password|private-token|private-binary|private-blob/,
      );
      expect(JSON.stringify(result.content)).toContain("REDACTED");
      expect(Object.keys(result.details ?? {})).toEqual(["status", "truncated"]);
    }
    await f.controller.close();
  });

  it("bounds shared item counts and blocks unsafe identities", async () => {
    const f = await fixture();
    f.diagnostic.mockResolvedValue({
      content: [],
      structuredContent: { items: Array.from({ length: 100 }, (_, i) => i) },
    });
    const result = await f.execute("items");
    expect(result.details).toMatchObject({ status: "success", truncated: true });
    expect(JSON.stringify(result.content)).toContain("[Result truncated]");
    for (const namespace of ["bad\nnamespace", "password=private", "x".repeat(1025)]) {
      const refused = await f.execute("invalid", { context: "A", namespace });
      expect(refused.details).toMatchObject({
        status: "not-executed",
        failureCategory: "invalid-arguments",
      });
      expect(JSON.stringify(refused)).not.toContain(namespace);
    }
    expect(f.diagnostic).toHaveBeenCalledTimes(1);
    await f.controller.close();
  });

  it("charges model inventory tools through the same pipeline without inventing a context", async () => {
    const f = await fixture();
    const inventory = createRequestMcpToolBridge(
      contextsTool,
      f.controller.snapshot,
      () => f.request,
      f.policy,
    );
    const result = await inventory.execute("inventory", {}, undefined, undefined, {} as never);
    expect(result.isError).toBe(false);
    expect(f.request.counts.dispatches).toBe(1);
    expect(JSON.stringify(result.content)).toContain("configuration_contexts_list");
    expect(JSON.stringify(result.content)).toContain("dispatchedAt");
    await f.controller.close();
  });
});
