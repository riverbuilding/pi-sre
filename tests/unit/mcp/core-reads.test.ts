import { describe, expect, it, vi } from "vitest";

import { RequestMcpController } from "../../../src/app/request-mcp-controller.js";
import type { ResourceReadPolicy } from "../../../src/config/resource-policy.js";
import { RequestExecution } from "../../../src/execution/request-execution.js";
import { createRequestMcpToolBridge } from "../../../src/mcp/request-tool-bridge.js";
import { acceptMcpCall } from "../../../src/execution/accept-mcp-call.js";
import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import capture from "../../fixtures/phase5-server-0.0.67.json" with { type: "json" };

const text = (value: string) => ({ content: [{ type: "text", text: value }] });
const object = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "web", namespace: "app" },
  data: { private: "UNMARKED_PRIVATE" },
};
const cases = [
  { name: "pods_list_in_namespace", args: { namespace: "app" } },
  { name: "pods_top", args: {} },
  { name: "nodes_log", args: { name: "worker", query: "kubelet" } },
  { name: "nodes_stats_summary", args: { name: "worker" } },
  { name: "nodes_top", args: {} },
  { name: "resources_list", args: { apiVersion: "v1", kind: "ConfigMap" } },
  { name: "resources_get", args: { apiVersion: "v1", kind: "ConfigMap", name: "web" } },
  { name: "projects_list", args: {} },
];

async function fixture(name: string, resourceReadPolicy?: ResourceReadPolicy) {
  const descriptor = capture.cases.unfiltered.find((tool) => tool.name === name)!;
  const diagnostic = vi.fn(
    async (
      _name: string,
      _args: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<unknown> => {
      void _name;
      void _args;
      void _signal;
      if (name === "resources_get") return text(JSON.stringify(object));
      if (name === "resources_list")
        return { ...text(JSON.stringify([object])), structuredContent: { items: [object] } };
      return text("diagnostic result");
    },
  );
  const controller = new RequestMcpController({
    ...(resourceReadPolicy ? { resourceReadPolicy } : {}),
    connect: async () => ({
      state: "ready",
      listTools: async () => [capture.cases.unfiltered[0]!, descriptor],
      callTool: async (operation, args, signal) =>
        operation === "configuration_contexts_list"
          ? {
              content: [],
              structuredContent: {
                contexts: ["alpha", "beta"].map((name) => ({ name, default: false })),
              },
            }
          : diagnostic(operation, args, signal),
      close: async () => {},
    }),
    publish: () => {},
  });
  await controller.restart();
  const request = new RequestExecution({ maxToolCalls: 40, maxModelIterations: 80 });
  const policy = { ...DEFAULT_RESULT_POLICY, maxTextChars: 1800 };
  const tool = () =>
    createRequestMcpToolBridge(descriptor, controller.snapshot, () => request, policy);
  const handler = tool();
  const execute = (args: Record<string, unknown>, id = "call", signal?: AbortSignal) =>
    handler.execute(id, args, signal, undefined, {} as never);
  return { controller, request, diagnostic, execute, tool, descriptor };
}

describe.each(cases)("Phase 5 Slice 2 $name", ({ name, args: required }) => {
  const args = { ...required, context: "alpha" };

  it("requires explicit selected context and discovered final arguments before dispatch", async () => {
    const f = await fixture(name);
    try {
      for (const invalid of [
        { ...required },
        { ...args, context: "other" },
        { ...args, context: "*" },
        { ...args, context: 1 },
        { ...args, namespace: "bad\nnamespace" },
      ]) {
        expect((await f.execute(invalid)).isError).toBe(true);
      }
      for (const field of f.descriptor.inputSchema.required ?? []) {
        const invalid: Record<string, unknown> = { ...args };
        delete invalid[field];
        expect((await f.execute(invalid)).isError).toBe(true);
      }
      expect(f.diagnostic).not.toHaveBeenCalled();
      expect(f.request.counts.dispatches).toBe(0);
      const result = await f.execute(args);
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain("alpha");
      expect(JSON.stringify(result)).toContain("dispatchedAt");
      expect(JSON.stringify(result)).not.toContain("UNMARKED_PRIVATE");
      expect(f.diagnostic.mock.calls[0]?.[1]).toEqual({
        ...args,
        ...(name === "nodes_log" ? { tailLines: 100 } : {}),
      });
    } finally {
      await f.controller.close();
    }
  });

  it("preserves known/omitted namespace semantics and empty results", async () => {
    const f = await fixture(name);
    try {
      if (name === "resources_list")
        f.diagnostic.mockResolvedValue({ ...text("[]"), structuredContent: { items: [] } });
      else if (name !== "resources_get") f.diagnostic.mockResolvedValue({ content: [] });
      const result = await f.execute({ ...args, namespace: "app" });
      expect(result.isError).toBe(false);
      expect(f.diagnostic.mock.calls[0]?.[1].namespace).toBe("app");
      if (name === "pods_top") expect(JSON.stringify(result)).toContain("all namespaces");
      if (name === "resources_get") f.diagnostic.mockResolvedValue({ content: [] });
      if (name === "pods_list_in_namespace") {
        expect((await f.execute({ context: "alpha" }, "missing")).isError).toBe(true);
      } else {
        const omitted = await f.execute(args, "omitted");
        expect(f.diagnostic.mock.calls.at(-1)?.[1]).not.toHaveProperty("namespace");
        expect(omitted.isError).toBe(name === "resources_get");
        if (name === "resources_list" || name === "pods_top")
          expect(JSON.stringify(omitted)).toContain("all namespaces");
      }
    } finally {
      await f.controller.close();
    }
  });

  it("distinguishes malformed presentation, server failure and timeout without raw payloads", async () => {
    const f = await fixture(name);
    try {
      f.diagnostic.mockResolvedValueOnce({
        content: [{ type: "text", text: 42 }],
        private: "UNMARKED_PRIVATE",
      });
      expect((await f.execute(args, "invalid")).details).toMatchObject({
        status: "invalid-result",
      });
      f.diagnostic.mockResolvedValueOnce({
        ...text("403 forbidden UNMARKED_PRIVATE"),
        isError: true,
      });
      const error = await f.execute(args, "forbidden");
      expect(error.details).toMatchObject({
        status: "error",
        failureCategory: "authorization-failed",
      });
      expect(JSON.stringify(error)).not.toContain("UNMARKED_PRIVATE");
      f.diagnostic.mockRejectedValueOnce(new Error("timeout UNMARKED_PRIVATE"));
      expect((await f.execute(args, "timeout")).details).toMatchObject({
        status: "error",
        failureCategory: "timeout",
      });
      expect(f.request.counts.dispatches).toBe(3);
    } finally {
      await f.controller.close();
    }
  });

  it("bounds projected output", async () => {
    const f = await fixture(name);
    try {
      const large = {
        ...object,
        metadata: { ...object.metadata, name: "x".repeat(1000), resourceVersion: "9".repeat(1000) },
      };
      if (name === "resources_get") {
        f.diagnostic.mockResolvedValue(text(JSON.stringify(large)));
      } else if (name === "resources_list") {
        f.diagnostic.mockResolvedValue(
          text(JSON.stringify(Array.from({ length: 100 }, () => large))),
        );
      } else f.diagnostic.mockResolvedValue(text("diagnostic ".repeat(1000)));
      const result = await f.execute({
        ...args,
        ...(name === "resources_get" ? { name: large.metadata.name } : {}),
      });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1800);
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({ truncated: true });
      expect(JSON.stringify(result)).not.toContain("UNMARKED_PRIVATE");
    } finally {
      await f.controller.close();
    }
  });

  it.each(["cancel", "reconnect"])(
    "withholds late success on %s and preserves request budgets",
    async (action) => {
      const f = await fixture(name);
      const gate = Promise.withResolvers<unknown>();
      f.diagnostic.mockImplementation(() => gate.promise);
      try {
        const pending = f.execute(args);
        await Promise.resolve();
        if (action === "cancel") f.request.cancel();
        else await f.controller.restart(true);
        const result = await pending;
        expect(result.isError).toBe(true);
        const saved = JSON.stringify(result);
        gate.resolve(text("late UNMARKED_PRIVATE"));
        await f.request.waitForIdle();
        expect(JSON.stringify(result)).toBe(saved);
        expect(f.request.counts.dispatches).toBe(1);
        if (action === "reconnect") {
          expect((await f.execute(args, "old")).isError).toBe(true);
          f.diagnostic.mockResolvedValue(
            name.startsWith("resources_")
              ? text(JSON.stringify(name === "resources_get" ? object : []))
              : text("recovered"),
          );
          expect(
            (await f.tool().execute("new", args, undefined, undefined, {} as never)).isError,
          ).toBe(false);
          expect(f.request.counts.dispatches).toBe(2);
        }
      } finally {
        await f.controller.close();
      }
    },
  );
});

it("enforces narrowed resource policy below direct admission and retained handlers", async () => {
  const f = await fixture("resources_get", { allowedReadKinds: [] });
  const args = { apiVersion: "v1", kind: "ConfigMap", name: "web", context: "alpha" };
  try {
    for (const kind of ["ConfigMap", "Secret", "Pod/status", "List", "*", "pods"]) {
      expect((await f.execute({ ...args, kind })).details).toMatchObject({
        status: "not-executed",
        failureCategory: "resource-policy-denied",
      });
      await expect(async () =>
        f.controller.snapshot.accept!(f.request, "direct", "resources_get", { ...args, kind }),
      ).rejects.toThrow("resource policy");
      expect(() =>
        acceptMcpCall(
          f.request,
          f.controller.selection!,
          {
            ready: true,
            resourceReadPolicy: { allowedReadKinds: [] },
            getTool: () => f.descriptor,
            callTool: f.diagnostic,
          },
          "bypass",
          "resources_get",
          { ...args, kind },
        ),
      ).toThrow("resource policy");
    }
    expect(f.diagnostic).not.toHaveBeenCalled();
    expect(f.request.counts.dispatches).toBe(0);
  } finally {
    await f.controller.close();
  }
});

it("limits node service logs before transport, including direct handlers", async () => {
  const f = await fixture("nodes_log");
  try {
    for (const tailLines of [0, -1, 1.5, 1001, "100", null]) {
      expect(
        (await f.execute({ context: "alpha", name: "worker", query: "kubelet", tailLines }))
          .isError,
      ).toBe(true);
    }
    for (const query of [
      "/var/log/kubelet.log",
      "../credentials",
      "kubelet&tailLines=0",
      "",
      "kubelet\n",
    ]) {
      expect((await f.execute({ context: "alpha", name: "worker", query })).isError).toBe(true);
    }
    expect(f.diagnostic).not.toHaveBeenCalled();
    for (const tailLines of [1, 1000])
      expect(
        (
          await f.execute(
            { context: "alpha", name: "worker", query: "kubelet", tailLines },
            String(tailLines),
          )
        ).isError,
      ).toBe(false);
  } finally {
    await f.controller.close();
  }
});
