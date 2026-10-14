import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ClusterContextManager } from "../../src/cluster/context-manager.js";
import { createApplicationPaths, type SreConfig } from "../../src/config/config.js";
import { DEFAULT_RESULT_POLICY } from "../../src/config/schema.js";
import { ManagedMcpConnection } from "../../src/mcp/connection.js";
import { discoverClusterContexts } from "../../src/mcp/context-discovery.js";
import { createMcpToolBridge } from "../../src/mcp/tool-bridge.js";
import { discoverMcpTools } from "../../src/mcp/tool-discovery.js";
import { createSreRuntime } from "../../src/runtime/pi-runtime.js";
import { scopedPodTool } from "../fixtures/scoped-tool.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

describe("Slice 4 scoped bridge over Pi and stdio MCP", () => {
  it.each([{}, { context: "alpha", labelSelector: "app=api" }])(
    "injects the exact selected context in an agent-loop call with arguments %j",
    async (args) => {
      const home = await mkdtemp(join(tmpdir(), "pi-sre-scoped-"));
      const pid = join(home, "mcp.pid");
      const config: SreConfig = {
        paths: createApplicationPaths(home),
        kubernetes: {
          mcp: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", "tsx", fixture, "scoped-success", pid],
            cwd: process.cwd(),
            startupTimeoutMs: 2_000,
            toolCallTimeoutMs: 500,
          },
        },
        investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
        safety: { mode: "read-only" },
        results: DEFAULT_RESULT_POLICY,
      };
      let connection: ManagedMcpConnection | undefined;
      let runtime: AgentSessionRuntime | undefined;
      try {
        connection = await ManagedMcpConnection.connect(config.kubernetes.mcp);
        const report = await discoverMcpTools(connection);
        expect(report.exposed.map((tool) => tool.name)).toEqual(["configuration_contexts_list"]);
        expect(report.decisions).toContainEqual({
          name: "pods_list",
          status: "deferred",
          reason: "cluster-context-required",
        });
        const manager = new ClusterContextManager({ cluster: "beta" });
        const generation = manager.beginConnection();
        manager.acceptRegistry(generation, await discoverClusterContexts(connection, report));
        const tool = createMcpToolBridge(scopedPodTool, connection, config.results, {
          manager,
          connectionGeneration: generation,
        });
        runtime = await createSreRuntime(config, [tool]);
        const session = runtime.session;
        let turns = 0;
        session.agent.streamFunction = (model, context) => {
          const first = turns++ === 0;
          if (!first) {
            const result = context.messages.find((message) => message.role === "toolResult");
            expect(result).toMatchObject({ toolName: "pods_list", isError: false });
            expect(JSON.stringify(result)).toContain("beta-pod");
            expect(JSON.stringify(result)).toContain('context=\\"beta\\"');
            expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
          }
          type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
          type Message = Awaited<ReturnType<Stream["result"]>>;
          const message: Message = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: first
              ? [{ type: "toolCall", id: "pods", name: "pods_list", arguments: args }]
              : [{ type: "text", text: "Observed beta-pod in the selected context." }],
            stopReason: first ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "done", reason: message.stopReason, message };
            },
            async result() {
              return message;
            },
          } as unknown as Stream;
        };
        await session.agent.prompt("Inspect pods in the selected cluster");
        expect(turns).toBe(2);
        expect(
          session.agent.state.messages.find((message) => message.role === "toolResult"),
        ).toMatchObject({
          details: { scope: { context: "beta", connectionGeneration: generation, readOnly: true } },
        });
        const calls = (await readFile(`${pid}.calls`, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        expect(calls).toEqual([
          { name: "configuration_contexts_list", arguments: {} },
          {
            name: "pods_list",
            arguments: {
              context: "beta",
              ...("labelSelector" in args ? { labelSelector: args.labelSelector } : {}),
            },
          },
        ]);
      } finally {
        await runtime?.dispose();
        await connection?.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["scoped-empty", undefined],
    ["scoped-malformed", undefined],
    ["scoped-error", "authentication-failed"],
    ["scoped-timeout", "timeout"],
  ] as const)("preserves %s outcomes on the selected connection", async (scenario, category) => {
    const connection = await ManagedMcpConnection.connect({
      transport: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixture, scenario],
      cwd: process.cwd(),
      startupTimeoutMs: 2_000,
      toolCallTimeoutMs: 150,
    });
    try {
      const manager = new ClusterContextManager({ cluster: "beta" });
      const generation = manager.beginConnection();
      manager.acceptRegistry(
        generation,
        await discoverClusterContexts(connection, await discoverMcpTools(connection)),
      );
      const tool = createMcpToolBridge(scopedPodTool, connection, DEFAULT_RESULT_POLICY, {
        manager,
        connectionGeneration: generation,
      });
      const result = await tool.execute("pods", {}, undefined, undefined, {} as never);
      expect(result).toMatchObject({
        isError: scenario !== "scoped-empty",
        details: {
          scope: { context: "beta" },
          ...(category ? { failureCategory: category } : {}),
          status:
            scenario === "scoped-empty"
              ? "success"
              : scenario === "scoped-malformed"
                ? "invalid-result"
                : "tool-error",
        },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
      expect(manager.isAgentActive).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it("forwards cancellation through scoped stdio execution and releases the call guard", async () => {
    const connection = await ManagedMcpConnection.connect({
      transport: "stdio",
      command: process.execPath,
      args: ["--import", "tsx", fixture, "scoped-timeout"],
      cwd: process.cwd(),
      startupTimeoutMs: 2_000,
      toolCallTimeoutMs: 2_000,
    });
    try {
      const manager = new ClusterContextManager({ cluster: "alpha" });
      const generation = manager.beginConnection();
      manager.acceptRegistry(
        generation,
        await discoverClusterContexts(connection, await discoverMcpTools(connection)),
      );
      const tool = createMcpToolBridge(scopedPodTool, connection, DEFAULT_RESULT_POLICY, {
        manager,
        connectionGeneration: generation,
      });
      const cancellation = new AbortController();
      const pending = tool.execute("pods", {}, cancellation.signal, undefined, {} as never);
      cancellation.abort();
      await expect(pending).rejects.toThrow(/abort/i);
      expect(manager.isAgentActive).toBe(false);
      expect(connection.state).toBe("ready");
    } finally {
      await connection.close();
    }
  });
});
