import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ManagedMcpConnection } from "../../src/mcp/connection.js";
import { discoverClusterContexts } from "../../src/mcp/context-discovery.js";
import { discoverMcpTools } from "../../src/mcp/tool-discovery.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

async function withConnection(
  scenario: string,
  run: (connection: ManagedMcpConnection) => Promise<void>,
) {
  const connection = await ManagedMcpConnection.connect({
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", fixture, scenario],
    cwd: process.cwd(),
    startupTimeoutMs: 300_000,
    toolCallTimeoutMs: 150,
  });
  try {
    await run(connection);
  } finally {
    await connection.close();
    expect(connection.state).toBe("closed");
  }
}

describe("context discovery over managed MCP", () => {
  it("discovers and enumerates on the same connection without a model turn", async () => {
    await withConnection("contexts-success", async (connection) => {
      const report = await discoverMcpTools(connection);
      const registry = await discoverClusterContexts(connection, report);
      expect(registry.contexts.map((context) => context.name)).toEqual(["alpha", "beta"]);
      expect(registry.defaultContext?.name).toBe("alpha");
      expect(connection.state).toBe("ready");
      expect((await discoverClusterContexts(connection, report)).contexts).toEqual(
        registry.contexts,
      );
    });
  });

  it("preserves empty success", async () => {
    await withConnection("contexts-empty", async (connection) => {
      const registry = await discoverClusterContexts(
        connection,
        await discoverMcpTools(connection),
      );
      expect(registry.contexts).toEqual([]);
      expect(registry.defaultContext).toBeUndefined();
    });
  });

  it.each([
    ["contexts-malformed", { kind: "invalid-response" }],
    ["contexts-error", { kind: "tool-error", failureCategory: "authentication-failed" }],
    ["contexts-timeout", { kind: "tool-error", failureCategory: "timeout" }],
  ] as const)("classifies %s without publishing a partial registry", async (scenario, expected) => {
    await withConnection(scenario, async (connection) => {
      await expect(
        discoverClusterContexts(connection, await discoverMcpTools(connection)),
      ).rejects.toMatchObject(expected);
    });
  });

  it("propagates cancellation of an in-flight MCP enumeration", async () => {
    await withConnection("contexts-timeout", async (connection) => {
      const report = await discoverMcpTools(connection);
      const controller = new AbortController();
      const pending = discoverClusterContexts(connection, report, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(connection.state).toBe("ready");
    });
  });
});
