import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createApplicationPaths, type SreConfig } from "../../src/config/config.js";
import { ManagedMcpConnection } from "../../src/mcp/connection.js";
import { createMcpToolBridge } from "../../src/mcp/tool-bridge.js";
import { discoverMcpTools } from "../../src/mcp/tool-discovery.js";
import { createSreRuntime } from "../../src/runtime/pi-runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

function config(home: string, scenario = "bridge"): SreConfig {
  return {
    paths: createApplicationPaths(home),
    kubernetes: {
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["--import", "tsx", fixture, scenario],
        cwd: process.cwd(),
        startupTimeoutMs: 2_000,
        toolCallTimeoutMs: 150,
      },
    },
    investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
    safety: { mode: "read-only" },
  };
}

describe("Pi runtime MCP tools", () => {
  it("executes a model tool call through stdio and delivers the result to the transcript and TUI events", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sre-bridge-"));
    const sreConfig = config(home);
    const connection = await ManagedMcpConnection.connect(sreConfig.kubernetes.mcp);
    let runtime: AgentSessionRuntime | undefined;
    try {
      const report = await discoverMcpTools(connection);
      runtime = await createSreRuntime(
        sreConfig,
        report.exposed.map((tool) => createMcpToolBridge(tool, connection)),
      );
      const session = runtime.session;
      expect(session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
      expect(session.getAllTools().map((tool) => tool.name)).toEqual([
        "configuration_contexts_list",
      ]);
      session.setActiveToolsByName(["bash", "read", "configuration_contexts_list"]);
      expect(session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);

      let turns = 0;
      session.agent.streamFunction = (model, context) => {
        const first = turns++ === 0;
        if (!first) {
          const result = context.messages.find((message) => message.role === "toolResult");
          expect(result).toMatchObject({ toolName: "configuration_contexts_list", isError: false });
          expect(JSON.stringify(result)).toContain("dev");
        }
        type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
        type Message = Awaited<ReturnType<Stream["result"]>>;
        const message: Message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: first
            ? [
                {
                  type: "toolCall",
                  id: "contexts-1",
                  name: "configuration_contexts_list",
                  arguments: {},
                },
              ]
            : [{ type: "text", text: "Configured contexts: dev, prod." }],
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
        // Test double implements the public stream methods used by the agent;
        // EventStream's private queue state is deliberately absent.
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() {
            return message;
          },
        } as unknown as Stream;
      };
      const tuiResults: unknown[] = [];
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_end") tuiResults.push(event);
      });
      try {
        await session.agent.prompt("List configured contexts");
      } finally {
        unsubscribe();
      }
      expect(turns).toBe(2);
      expect(tuiResults).toMatchObject([
        {
          toolName: "configuration_contexts_list",
          isError: false,
          result: {
            details: { status: "success", tool: { mcpName: "configuration_contexts_list" } },
          },
        },
      ]);
      const result = session.agent.state.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: "configuration_contexts_list",
              arguments: {},
              contexts: ["dev", "prod"],
            }),
          },
        ],
      });
      await runtime.newSession();
      expect(runtime.session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    } finally {
      await runtime?.dispose();
      await connection.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["timeout", "abort"])("interrupts a pending stdio tool call on %s", async (kind) => {
    const connection = await ManagedMcpConnection.connect(
      config(tmpdir(), "call-timeout").kubernetes.mcp,
    );
    try {
      const report = await discoverMcpTools(connection);
      const descriptor = report.exposed[0];
      if (!descriptor) throw new Error("Expected approved fixture tool");
      const tool = createMcpToolBridge(descriptor, connection);
      const controller = new AbortController();
      const pending = tool.execute("pending", {}, controller.signal, undefined, {} as never);
      const rejection = expect(pending).rejects.toThrow(
        kind === "timeout" ? "operation configuration_contexts_list failed" : /abort/i,
      );
      if (kind === "abort") controller.abort();
      await rejection;
      expect(connection.state).toBe("ready");
    } finally {
      await connection.close();
    }
  });
});
