import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SreApplication } from "../../../src/app/application.js";
import { createApplicationPaths, type SreConfig } from "../../../src/config/config.js";
import { PI_AGENT_DIR_ENV } from "../../../src/runtime/pi-runtime.js";

const mocks = vi.hoisted(() => ({
  abort: vi.fn<() => Promise<void>>(),
  stop: vi.fn(),
  dispose: vi.fn<() => Promise<void>>(),
  mcpClose: vi.fn<() => Promise<void>>(),
  mcpConnect: vi.fn(),
  mcpListTools: vi.fn(),
  modeInit: vi.fn<() => Promise<void>>(),
  modeRun: vi.fn<() => Promise<void>>(),
  createRuntime: vi.fn(),
  modeOptions: [] as unknown[],
}));

vi.mock("../../../src/mcp/connection.js", () => ({
  McpStartupError: class extends Error {
    diagnostic: string;
    constructor(_kind: string, diagnostic: string) {
      super(diagnostic);
      this.diagnostic = diagnostic;
    }
  },
  ManagedMcpConnection: { connect: mocks.mcpConnect },
}));

vi.mock("../../../src/runtime/pi-runtime.js", () => ({
  PI_AGENT_DIR_ENV: "PI_CODING_AGENT_DIR",
  createSreRuntime: mocks.createRuntime,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  InteractiveMode: class {
    private readonly onTerm = (): void => {
      void this.runtime.dispose().catch(() => undefined);
    };
    constructor(
      private readonly runtime: { dispose(): Promise<void> },
      options: unknown,
    ) {
      mocks.modeOptions.push(options);
    }
    init = async (): Promise<void> => {
      process.on("SIGTERM", this.onTerm);
      await mocks.modeInit();
    };
    run = mocks.modeRun;
    stop(): void {
      process.off("SIGTERM", this.onTerm);
      mocks.stop();
    }
  },
}));

describe("SreApplication", () => {
  let home: string;
  let previousAgentDir: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-app-"));
    previousAgentDir = process.env[PI_AGENT_DIR_ENV];
    mocks.abort.mockReset().mockResolvedValue();
    mocks.stop.mockReset();
    mocks.dispose.mockReset().mockResolvedValue();
    mocks.mcpClose.mockReset().mockResolvedValue();
    mocks.mcpListTools.mockReset().mockResolvedValue([]);
    mocks.mcpConnect
      .mockReset()
      .mockResolvedValue({ close: mocks.mcpClose, listTools: mocks.mcpListTools });
    mocks.modeInit.mockReset().mockResolvedValue();
    mocks.modeRun.mockReset().mockResolvedValue();
    mocks.createRuntime
      .mockReset()
      .mockImplementation((_config: unknown, _tools: unknown, shutdown: () => Promise<void>) => ({
        dispose: shutdown,
        disposeSession: mocks.dispose,
        session: { abort: mocks.abort },
      }));
    mocks.modeOptions.length = 0;
  });

  afterEach(async () => {
    if (previousAgentDir === undefined) delete process.env[PI_AGENT_DIR_ENV];
    else process.env[PI_AGENT_DIR_ENV] = previousAgentDir;
    await rm(home, { recursive: true, force: true });
  });

  function config(): SreConfig {
    return {
      paths: createApplicationPaths(home),
      kubernetes: {
        mcp: {
          transport: "stdio",
          command: "kubernetes-mcp-server",
          args: [],
          cwd: home,
          startupTimeoutMs: 15_000,
          toolCallTimeoutMs: 30_000,
        },
      },
      investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
      safety: { mode: "read-only" },
      results: DEFAULT_RESULT_POLICY,
    };
  }

  it("allows close before startup without disposing a runtime", async () => {
    const app = new SreApplication(config());
    await app.close();
    await app.close();
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("uses the Pi SRE home and disposes once when the mode returns", async () => {
    process.env[PI_AGENT_DIR_ENV] = "existing-pi-location";
    const app = new SreApplication(config());
    mocks.modeRun.mockImplementation(async () => {
      expect(process.env[PI_AGENT_DIR_ENV]).toBe(home);
    });

    await app.run();
    await app.close();
    await app.close();

    expect(mocks.createRuntime).toHaveBeenCalledWith(config(), [], expect.any(Function));
    expect(mocks.modeRun).toHaveBeenCalledOnce();
    expect(mocks.mcpClose).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(process.env[PI_AGENT_DIR_ENV]).toBe("existing-pi-location");
  });

  it("restores the prior Pi environment when startup fails", async () => {
    mocks.createRuntime.mockRejectedValue(new Error("runtime unavailable"));
    const app = new SreApplication(config());

    await expect(app.run()).rejects.toThrow("Pi SRE runtime startup failed.");
    expect(process.env[PI_AGENT_DIR_ENV]).toBe(previousAgentDir);
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it("opens the TUI with a startup diagnostic when MCP is unavailable", async () => {
    mocks.mcpConnect.mockRejectedValue(new Error("token=do-not-show"));
    const app = new SreApplication(config());

    await app.run();

    expect(mocks.modeRun).toHaveBeenCalledOnce();
    expect(mocks.modeOptions).toEqual([
      {
        startupDiagnostics: [
          {
            type: "warning",
            message:
              "Kubernetes MCP connection failed during startup. Kubernetes tools are unavailable. Check the MCP configuration and restart pi-sre.",
          },
        ],
      },
    ]);
    expect(mocks.mcpClose).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("registers only approved tools after discovery", async () => {
    mocks.mcpListTools.mockResolvedValue([
      {
        name: "configuration_contexts_list",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      {
        name: "configuration_view",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ]);
    const app = new SreApplication(config());

    await app.run();

    expect(app.toolDiscoveryReport?.exposed.map((tool) => tool.name)).toEqual([
      "configuration_contexts_list",
    ]);
    expect(mocks.modeOptions).toEqual([
      {
        startupDiagnostics: [
          {
            type: "info",
            message:
              "Kubernetes MCP discovery: 1 approved, 0 deferred, 1 rejected. 1 read-only tools registered.",
          },
        ],
      },
    ]);
    expect(mocks.createRuntime).toHaveBeenCalledWith(
      config(),
      [expect.objectContaining({ name: "configuration_contexts_list" })],
      expect.any(Function),
    );
  });

  it("opens without tools when an approved schema cannot be executed safely", async () => {
    mocks.mcpListTools.mockResolvedValue([
      {
        name: "configuration_contexts_list",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", format: "unsupported" } },
        },
        annotations: { readOnlyHint: true },
      },
    ]);
    await new SreApplication(config()).run();
    expect(mocks.createRuntime).toHaveBeenCalledWith(config(), [], expect.any(Function));
    expect(mocks.modeOptions).toEqual([
      {
        startupDiagnostics: [
          {
            type: "warning",
            message:
              "Kubernetes MCP tool schema cannot be adapted safely. Kubernetes tools are unavailable. Check the MCP configuration and restart pi-sre.",
          },
        ],
      },
    ]);
  });

  it("keeps the TUI available when discovery fails", async () => {
    mocks.mcpListTools.mockRejectedValue(new Error("token=private"));
    const app = new SreApplication(config());

    await app.run();

    expect(app.toolDiscoveryReport).toBeUndefined();
    expect(mocks.modeOptions).toEqual([
      {
        startupDiagnostics: [
          {
            type: "warning",
            message:
              "Kubernetes MCP tool discovery failed. Kubernetes tools are unavailable. Check the MCP configuration and restart pi-sre.",
          },
        ],
      },
    ]);
    expect(mocks.mcpClose).toHaveBeenCalledOnce();
  });
  it("disposes the runtime before closing MCP and restores the terminal last", async () => {
    await new SreApplication(config()).run();
    expect(mocks.abort.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispose.mock.invocationCallOrder[0]!,
    );
    expect(mocks.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mcpClose.mock.invocationCallOrder[0]!,
    );
    expect(mocks.mcpClose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stop.mock.invocationCallOrder[0]!,
    );
  });

  it("still closes MCP and restores state when runtime disposal fails", async () => {
    mocks.dispose.mockRejectedValue(new Error("dispose failed"));
    await expect(new SreApplication(config()).run()).rejects.toThrow("Pi SRE shutdown failed.");
    expect(mocks.mcpClose).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(process.env[PI_AGENT_DIR_ENV]).toBe(previousAgentDir);
  });

  it("waits for runtime creation during shutdown and never starts the TUI", async () => {
    const pending = Promise.withResolvers<{
      disposeSession: typeof mocks.dispose;
      session: { abort: typeof mocks.abort };
    }>();
    const creating = Promise.withResolvers<void>();
    mocks.createRuntime.mockImplementation(() => {
      creating.resolve();
      return pending.promise;
    });
    const app = new SreApplication(config());
    const running = app.run();
    await creating.promise;
    const closing = app.close();
    pending.resolve({ disposeSession: mocks.dispose, session: { abort: mocks.abort } });
    await Promise.all([running, closing]);
    expect(mocks.modeRun).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.mcpClose).toHaveBeenCalledOnce();
  });

  it("registers signals once and removes them after repeated signal shutdown", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    mocks.modeRun.mockImplementation(async () => {
      expect(process.listenerCount("SIGINT")).toBe(before[0]! + 1);
      expect(process.listenerCount("SIGTERM")).toBe(before[1]! + 1);
      process.emit("SIGINT");
      process.emit("SIGTERM");
      await new Promise<void>(() => undefined);
    });
    const app = new SreApplication(config());
    await app.run();
    await expect(app.run()).rejects.toThrow("already run");
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.mcpClose).toHaveBeenCalledOnce();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
  it("unwinds runtime and MCP when terminal initialization fails", async () => {
    const cause = new Error("terminal failed PRIVATE_FIXTURE");
    mocks.modeInit.mockRejectedValue(cause);
    await expect(new SreApplication(config()).run()).rejects.toMatchObject({
      message: "Pi SRE terminal startup failed.",
      cause,
    });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.mcpClose).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
