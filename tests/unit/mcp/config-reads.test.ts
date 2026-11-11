import { describe, expect, it, vi } from "vitest";

import { RequestMcpController } from "../../../src/app/request-mcp-controller.js";
import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { RequestExecution } from "../../../src/execution/request-execution.js";
import { createRequestMcpToolBridge } from "../../../src/mcp/request-tool-bridge.js";
import { discoverMcpTools } from "../../../src/mcp/tool-discovery.js";
import { configurationView, configurationPrivateValue } from "../../fixtures/configuration-view.js";
import capture from "../../fixtures/phase5-server-0.0.67.json" with { type: "json" };

const descriptor = capture.cases.unfiltered.find((tool) => tool.name === "configuration_view")!;
const enumeration = capture.cases.unfiltered.find(
  (tool) => tool.name === "configuration_contexts_list",
)!;
const content = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

async function fixture(exact = false) {
  let names = ["alpha", "beta"];
  const query = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<unknown> => {
    void _args;
    if (_name === "configuration_contexts_list") {
      return {
        content: [],
        structuredContent: { contexts: names.map((name) => ({ name, default: false })) },
      };
    }
    return { ...content(configurationView), structuredContent: configurationView };
  });
  const published: string[][] = [];
  const controller = new RequestMcpController({
    ...(exact ? { configuredRule: { kind: "exact" as const, contexts: ["alpha"] } } : {}),
    connect: async () => ({
      state: "ready",
      listTools: async () => [enumeration, descriptor],
      callTool: query,
      close: async () => {},
    }),
    publish: (state) => {
      if (state.status === "ready") {
        published.push([...state.selection!.availability.available]);
      }
    },
  });
  await controller.restart();
  const request = new RequestExecution({ maxToolCalls: 10, maxModelIterations: 20 });
  const tool = (name = "configuration_view") =>
    createRequestMcpToolBridge(
      name === "configuration_view" ? descriptor : enumeration,
      controller.snapshot,
      () => request,
      { ...DEFAULT_RESULT_POLICY, maxTextChars: 1800 },
    );
  const execute = (args: Record<string, unknown> = {}, id = "view") =>
    tool().execute(id, args, undefined, undefined, {} as never);
  return {
    controller,
    request,
    query,
    tool,
    execute,
    published,
    setNames: (value: string[]) => {
      names = value;
    },
  };
}

describe("Phase 5 Slice 3 configuration inspection", () => {
  it.each([{}, { minified: false }, { minified: true }])(
    "projects selected configuration data without interpreting minified as selection: %j",
    async (args) => {
      const f = await fixture(true);
      try {
        const result = await f.execute(args);
        expect(result.isError).toBe(false);
        expect(result.content).toHaveLength(1);
        const block = result.content[0];
        if (block?.type !== "text") {
          throw new Error("Missing text");
        }
        const projected: unknown = JSON.parse(block.text.slice(block.text.indexOf("\n") + 1));
        expect(projected).toStrictEqual({
          contexts: [
            { name: "alpha", context: { cluster: "alpha", namespace: "app" } },
            { name: "outside-selection", context: { cluster: "other" } },
          ],
          clusters: [{ name: "alpha", endpointOrigin: "https://api.example:6443" }],
        });
        expect(JSON.stringify(result)).not.toMatch(
          /UNMARKED_CONFIG_PRIVATE|users|certificate|auth-provider|proxy-url|current-context/,
        );
        expect(f.query.mock.calls.at(-1)).toEqual([
          "configuration_view",
          args,
          expect.any(AbortSignal),
        ]);
        expect(f.controller.selection!.rule).toEqual({ kind: "exact", contexts: ["alpha"] });
        expect(f.request.counts.dispatches).toBe(1);
        expect(f.tool().description).toContain("server default");
      } finally {
        await f.controller.close();
      }
    },
  );

  it("does not attribute configuration metadata to an extra model-supplied context or namespace", async () => {
    const f = await fixture(true);
    try {
      const result = await f.execute({ context: "outside-selection", namespace: "other" });
      expect(result.isError).toBe(false);
      const block = result.content.find((item) => item.type === "text");
      expect(block?.type).toBe("text");
      if (block?.type === "text") {
        const source: unknown = JSON.parse(block.text.split("\n")[0]!.slice("Source: ".length));
        expect(source).not.toHaveProperty("context");
        expect(source).not.toHaveProperty("namespace");
      }
    } finally {
      await f.controller.close();
    }
  });

  it("validates final arguments below direct handlers and direct admission", async () => {
    const f = await fixture();
    try {
      expect((await f.execute({ minified: "true" })).details).toMatchObject({
        status: "not-executed",
        failureCategory: "invalid-arguments",
      });
      expect(() =>
        f.controller.snapshot.accept!(f.request, "direct", "configuration_view", { minified: 1 }),
      ).toThrow("Invalid");
      expect(f.request.counts.dispatches).toBe(0);
      expect(f.query).toHaveBeenCalledTimes(1); // lifecycle enumeration only
    } finally {
      await f.controller.close();
    }
  });

  it("prefers structured configuration and withholds unused text content", async () => {
    const f = await fixture();
    try {
      f.query.mockResolvedValueOnce({
        ...content(configurationPrivateValue),
        structuredContent: configurationView,
      });
      const result = await f.execute();
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain("https://api.example:6443");
      expect(JSON.stringify(result)).not.toContain(configurationPrivateValue);
    } finally {
      await f.controller.close();
    }
  });

  it("refuses invalid selected configuration without fallback and categorizes server/transport errors", async () => {
    const f = await fixture();
    try {
      for (const raw of [
        content(configurationPrivateValue),
        {
          ...content(configurationView),
          structuredContent: { contexts: configurationPrivateValue },
        },
        content({ contexts: [{ name: "bad\nname", context: { cluster: "alpha" } }], clusters: [] }),
      ]) {
        f.query.mockResolvedValueOnce(raw);
        const result = await f.execute({}, String(f.request.counts.dispatches));
        expect(result.details).toMatchObject({ status: "invalid-result" });
        expect(JSON.stringify(result)).not.toContain(configurationPrivateValue);
      }
      f.query.mockResolvedValueOnce({
        ...content(`403 forbidden ${configurationPrivateValue}`),
        isError: true,
      });
      expect((await f.execute({}, "denied")).details).toMatchObject({
        failureCategory: "authorization-failed",
      });
      f.query.mockRejectedValueOnce(new Error(`timeout ${configurationPrivateValue}`));
      const timeout = await f.execute({}, "timeout");
      expect(timeout.details).toMatchObject({ failureCategory: "timeout" });
      expect(JSON.stringify(timeout)).not.toContain(configurationPrivateValue);
    } finally {
      await f.controller.close();
    }
  });

  it("bounds projected metadata and presents empty configuration safely", async () => {
    const f = await fixture();
    try {
      f.query.mockResolvedValueOnce(content({ contexts: [], clusters: [] }));
      expect((await f.execute()).isError).toBe(false);
      f.query.mockResolvedValueOnce(
        content({
          ...configurationView,
          contexts: Array.from({ length: 100 }, (_, i) => ({
            name: `ctx-${i}`,
            context: { cluster: "alpha" },
          })),
        }),
      );
      const result = await f.execute({}, "large");
      expect(result.details).toMatchObject({ truncated: true });
      const block = result.content[0];
      if (block?.type !== "text") {
        throw new Error("Missing text");
      }
      expect(block.text.slice(block.text.indexOf("\n") + 1).length).toBeLessThanOrEqual(1800);
      expect(JSON.stringify(result)).not.toContain(configurationPrivateValue);
    } finally {
      await f.controller.close();
    }
  });

  it.each(["cancel", "reconnect"])(
    "withholds late configuration success after %s",
    async (action) => {
      const f = await fixture();
      const gate = Promise.withResolvers<unknown>();
      f.query.mockImplementationOnce(() => gate.promise);
      try {
        const pending = f.execute();
        await Promise.resolve();
        if (action === "cancel") {
          f.request.cancel();
        } else {
          await f.controller.restart(true);
        }
        const result = await pending;
        expect(result.isError).toBe(true);
        gate.resolve(content(configurationView));
        await f.request.waitForIdle();
        expect(JSON.stringify(result)).not.toContain("api.example");
        expect(f.request.counts.dispatches).toBe(1);
      } finally {
        await f.controller.close();
      }
    },
  );

  it.each([false, true])(
    "enumeration never installs inventory or amends intent; reconnect publishes resolved scope (exact=%s)",
    async (exact) => {
      const f = await fixture(exact);
      try {
        const selection = f.controller.selection!;
        const inventory = selection.inventory;
        const rule = selection.rule;
        f.setNames(["alpha", "new"]);
        const result = await f
          .tool("configuration_contexts_list")
          .execute("list", {}, undefined, undefined, {} as never);
        expect(result.isError).toBe(false);
        expect(JSON.stringify(result)).toContain("new");
        await f.execute();
        expect(selection.inventory).toBe(inventory);
        expect(selection.rule).toBe(rule);
        expect(selection.target("new")).toBeUndefined();
        expect(f.request.counts.dispatches).toBe(2);
        await f.controller.restart(true);
        expect(f.controller.selection).toBe(selection);
        expect(selection.rule).toBe(rule);
        expect(f.published.at(-1)).toEqual(exact ? ["alpha"] : ["alpha", "new"]);
        expect(f.request.counts.dispatches).toBe(2);
      } finally {
        await f.controller.close();
      }
    },
  );

  it.each(["singleton", "disabled-provider"] as const)(
    "fails closed for %s instead of using configuration_view as discovery",
    async (scenario) => {
      const callTool = vi.fn();
      const controller = new RequestMcpController({
        connect: async () => ({
          state: "ready",
          listTools: async () => capture.cases[scenario],
          callTool,
          close: async () => {},
        }),
        publish: () => {},
      });
      try {
        await controller.restart();
        expect(controller.snapshot.status).toBe("unavailable");
        expect(controller.snapshot.tools).toEqual([]);
        expect(callTool).not.toHaveBeenCalled();
      } finally {
        await controller.close();
      }
    },
  );

  it("rejects unsupported provider listings and fabricated aliases at discovery and direct admission", async () => {
    const f = await fixture();
    try {
      for (const name of [
        "targets_list",
        "cluster_list",
        "context_list",
        "configuration_targets_list",
      ]) {
        const report = await discoverMcpTools({
          listTools: async () => [{ ...enumeration, name }],
        });
        expect(report.exposed).toEqual([]);
        expect(report.decisions).toContainEqual({
          name,
          status: "rejected",
          reason: "not-allowlisted",
        });
        expect(() => f.controller.snapshot.accept!(f.request, name, name, {})).toThrow(
          "unavailable",
        );
      }
      expect(f.request.counts.dispatches).toBe(0);
    } finally {
      await f.controller.close();
    }
  });
});
