import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type * as PiAgent from "@earendil-works/pi-coding-agent";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SreApplication } from "../../src/app/application.js";
import { createApplicationPaths, type SreConfig } from "../../src/config/config.js";
import * as runtimeFactory from "../../src/runtime/pi-runtime.js";
import { DEFAULT_RESULT_POLICY } from "../../src/config/schema.js";

const ui = vi.hoisted(() => ({
  run: vi.fn<(runtime: AgentSessionRuntime) => Promise<void>>(),
  stop: vi.fn(),
  diagnostics: [] as unknown[],
}));

// Only the terminal is replaced: application, Pi session, tool bridge and MCP are real.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original = await importOriginal<typeof PiAgent>();
  return {
    ...original,
    InteractiveMode: class {
      constructor(
        private readonly runtime: AgentSessionRuntime,
        options: unknown,
      ) {
        ui.diagnostics.push(options);
      }
      private readonly onTerm = (): void => {
        void this.runtime.dispose().catch(() => undefined);
      };
      async init(): Promise<void> {
        process.on("SIGTERM", this.onTerm);
      }
      run(): Promise<void> {
        return ui.run(this.runtime);
      }
      stop(): void {
        process.off("SIGTERM", this.onTerm);
        ui.stop();
      }
    },
  };
});

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

describe("application lifecycle with real Pi and managed MCP", () => {
  let home: string;
  let pidPath: string;
  const handlers = (): number[] => [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  let baseline: number[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-lifecycle-"));
    pidPath = join(home, "child.pid");
    baseline = handlers();
    ui.run.mockReset().mockResolvedValue();
    ui.stop.mockReset();
    ui.diagnostics.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    expect(handlers()).toEqual(baseline);
    await rm(home, { recursive: true, force: true });
  });

  function config(scenario = "success"): SreConfig {
    return {
      paths: createApplicationPaths(home),
      kubernetes: {
        mcp: {
          transport: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", fixture, scenario, pidPath],
          cwd: process.cwd(),
          startupTimeoutMs: 2_000,
          toolCallTimeoutMs: 10_000,
        },
      },
      investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
      safety: { mode: "read-only" },
      results: DEFAULT_RESULT_POLICY,
    };
  }

  async function expectChildExited(): Promise<void> {
    const pid = Number(await readFile(pidPath, "utf8"));
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
          throw error;
        }
      })
      .toBe(true);
  }

  it("starts approved tools and exits without a managed child", async () => {
    ui.run.mockImplementation(async (runtime) => {
      expect(runtime.session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
      expect(runtime.session.systemPrompt).toContain("read-only");
    });
    await new SreApplication(config()).run();
    expect(ui.stop).toHaveBeenCalledOnce();
    await expectChildExited();
  });

  it("opens a usable session without tools when the MCP executable is missing", async () => {
    const settings = config();
    ui.run.mockImplementation(async (runtime) => {
      expect(runtime.session.getActiveToolNames()).toEqual([]);
    });
    await new SreApplication({
      ...settings,
      kubernetes: {
        mcp: { ...settings.kubernetes.mcp, command: "/no/such/pi-sre-mcp" },
      },
    }).run();
    expect(ui.diagnostics).toEqual([
      expect.objectContaining({
        startupDiagnostics: [
          expect.objectContaining({
            type: "warning",
            message: expect.stringContaining("tools are unavailable"),
          }),
        ],
      }),
    ]);
  });

  it("routes Pi's direct quit disposal through MCP cleanup exactly once", async () => {
    ui.run.mockImplementation(async (runtime) => {
      await runtime.dispose();
      await runtime.dispose();
    });
    await new SreApplication(config()).run();
    expect(ui.stop).toHaveBeenCalledOnce();
    await expectChildExited();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "closes on %s without waiting for input",
    async (signal) => {
      ui.run.mockImplementation(async () => {
        process.emit(signal);
        await new Promise<void>(() => undefined);
      });
      await new SreApplication(config()).run();
      await expectChildExited();
    },
  );
  it("aborts an active MCP request during shutdown and blocks later calls", async () => {
    ui.run.mockImplementation(async (runtime) => {
      const tool = runtime.session.getToolDefinition("configuration_contexts_list");
      if (!tool) throw new Error("Expected approved MCP tool");
      const caller = new AbortController();
      const context = {
        ...runtime.session.extensionRunner.createContext(),
        tools: [],
        executeTool: async () => {
          throw new Error("Nested tool execution is unused in this test.");
        },
      };
      const call = tool.execute("active-call", {}, caller.signal, undefined, context);
      await expect
        .poll(async () => {
          try {
            return await readFile(`${pidPath}.call`, "utf8");
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
            throw error;
          }
        })
        .toBe("started");
      process.emit("SIGINT");
      const result = await call;
      expect(result).toMatchObject({ isError: true });
      expect(caller.signal.aborted).toBe(false);
      const later = await tool.execute("later-call", {}, caller.signal, undefined, context);
      expect(later).toMatchObject({ isError: true });
    });
    await new SreApplication(config("call-timeout")).run();
    await ui.run.mock.results[0]?.value;
    await expectChildExited();
  });
  it("closes the child when Pi runtime creation fails without exposing the cause", async () => {
    const cause = new Error("unexpected credential PRIVATE_FIXTURE");
    vi.spyOn(runtimeFactory, "createSreRuntime").mockRejectedValueOnce(cause);
    await expect(new SreApplication(config()).run()).rejects.toMatchObject({
      message: "Pi SRE runtime startup failed.",
      cause,
    });
    expect(ui.run).not.toHaveBeenCalled();
    await expectChildExited();
  });

  it("cancels connection initialization when a signal arrives during startup", async () => {
    const running = new SreApplication(config("timeout")).run();
    await expect
      .poll(async () => {
        try {
          return Number(await readFile(pidPath, "utf8")) > 0;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        }
      })
      .toBe(true);
    process.emit("SIGTERM");
    await running;
    expect(ui.run).not.toHaveBeenCalled();
    await expectChildExited();
  });
});
