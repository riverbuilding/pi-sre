import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { McpServerConfig } from "../../src/config/config.js";
import { ManagedMcpConnection, McpStartupError } from "../../src/mcp/connection.js";
import { discoverMcpTools } from "../../src/mcp/tool-discovery.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

function config(scenario = "success", startupTimeoutMs = 2_000): McpServerConfig {
  return {
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", fixture, scenario],
    cwd: process.cwd(),
    startupTimeoutMs,
    toolCallTimeoutMs: 2_000,
  };
}

async function failureKind(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    throw new Error("Expected startup to fail");
  } catch (error) {
    if (!(error instanceof McpStartupError)) throw error;
    return error.kind;
  }
}

describe("managed MCP lifecycle", () => {
  it("initializes, pings, calls through Pi MCP, and closes idempotently", async () => {
    const connection = await ManagedMcpConnection.connect(config());
    expect(connection.state).toBe("ready");
    expect(connection.diagnosticStderr).not.toContain("fixture-secret");
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual([
      "configuration_contexts_list",
    ]);
    expect(await connection.callTool("configuration_contexts_list", {})).toMatchObject({
      content: [{ text: "ok" }],
    });
    await connection.close();
    await connection.close();
    expect(connection.state).toBe("closed");
    await expect(connection.listTools()).rejects.toThrow("unavailable");
  });

  it("classifies missing executable", async () => {
    expect(
      await failureKind(
        ManagedMcpConnection.connect({ ...config(), command: "/no/such/pi-sre-mcp" }),
      ),
    ).toBe("command-not-found");
  });

  it("classifies startup timeout", async () => {
    expect(await failureKind(ManagedMcpConnection.connect(config("timeout", 500)))).toBe("timeout");
  });

  it("classifies early process exit", async () => {
    expect(await failureKind(ManagedMcpConnection.connect(config("exit")))).toBe("process-exited");
  });

  it("classifies malformed JSON-RPC", async () => {
    expect(await failureKind(ManagedMcpConnection.connect(config("malformed")))).toBe(
      "invalid-protocol",
    );
  });

  it("cancels startup", async () => {
    const controller = new AbortController();
    const pending = ManagedMcpConnection.connect(config("timeout"), controller.signal);
    controller.abort();
    expect(await failureKind(pending)).toBe("aborted");
  });

  it("discovers every page through the MCP client and filters the result", async () => {
    const connection = await ManagedMcpConnection.connect(config("paginated"));
    try {
      const report = await discoverMcpTools(connection);
      expect(report.exposed.map((tool) => tool.name)).toEqual(["configuration_contexts_list"]);
      expect(report.decisions).toEqual([
        { name: "configuration_contexts_list", status: "exposed" },
        { name: "configuration_view", status: "rejected", reason: "not-allowlisted" },
      ]);
    } finally {
      await connection.close();
    }
  });
});
