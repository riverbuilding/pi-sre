import { DEFAULT_RESOURCE_READ_POLICY } from "../../src/config/resource-policy.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type * as PiAgent from "@earendil-works/pi-coding-agent";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installOfflineProvider } from "../fixtures/offline-provider.js";
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
        await this.runtime.session.bindExtensions({
          uiContext: this.runtime.session.extensionRunner.getUIContext(),
        });
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

  function config(scenario = "contexts-success"): SreConfig {
    return {
      paths: createApplicationPaths(home),
      kubernetes: {
        mcp: {
          transport: "stdio",
          command: process.execPath,
          args: ["--import", import.meta.resolve("tsx"), fixture, scenario, pidPath],
          cwd: process.cwd(),
          startupTimeoutMs: 2_000,
          toolCallTimeoutMs: 10_000,
        },
      },
      execution: { maxToolCalls: 40, maxModelIterations: 80 },
      safety: { mode: "read-only", resources: DEFAULT_RESOURCE_READ_POLICY },
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
            message: expect.stringContaining("/mcp_restart"),
          }),
          expect.objectContaining({
            type: "warning",
            message: expect.stringContaining("MCP: unavailable"),
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
      await runtime.session.bindExtensions({
        uiContext: runtime.session.extensionRunner.getUIContext(),
      });
      await installOfflineProvider(runtime.session, (_context, iteration) =>
        iteration === 0
          ? [
              {
                type: "toolCall",
                id: "active-call",
                name: "configuration_contexts_list",
                arguments: {},
              },
            ]
          : [{ type: "text", text: "done" }],
      );
      const running = runtime.session.prompt("Inspect contexts");
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
      await running;
      const result = runtime.session.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true });
      expect(caller.signal.aborted).toBe(false);
      const later = await tool.execute("later-call", {}, caller.signal, undefined, context);
      expect(later).toMatchObject({ isError: true });
    });
    await new SreApplication(config("contexts-call-timeout")).run();
    await ui.run.mock.results[0]?.value;
    await expectChildExited();
  });
  it("uses the production pipeline for repeated queries, safe Pi rejections and independent request limits", async () => {
    ui.run.mockImplementation(async (runtime) => {
      const session = runtime.session;
      const originalSession = session;
      expect(session.getActiveToolNames().sort()).toEqual([
        "configuration_contexts_list",
        "events_list",
        "namespaces_list",
        "pods_get",
        "pods_list",
        "pods_log",
      ]);
      expect(
        session.extensionRunner
          .getRegisteredCommands()
          .map((command) => command.name)
          .sort(),
      ).toEqual(["clusters", "mcp_restart"]);
      let streams = 0;
      await installOfflineProvider(session, (context, iteration) => {
        streams++;
        expect(JSON.stringify(context)).toContain("Application Kubernetes environment:");
        const stage = iteration % 4;
        if (stage === 0)
          return [
            {
              type: "toolCall",
              id: `invalid-${iteration}`,
              name: "pods_get",
              arguments: { context: "alpha", password: "PRIVATE_REJECTION" },
            },
          ];
        if (stage < 3)
          return [
            {
              type: "toolCall",
              id: `query-${iteration}`,
              name: "pods_list",
              arguments: { context: "alpha" },
            },
          ];
        return [{ type: "text", text: "Report with uncertainty; further questions welcome." }];
      });
      await session.prompt("Why are pods failing?");
      await session.prompt("Recheck after my update");
      expect(streams).toBe(8);
      expect(runtime.session).toBe(originalSession);
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(6);
      for (const offset of [0, 3]) {
        expect(results[offset]).toMatchObject({
          isError: true,
          details: { status: "not-executed" },
        });
        expect(results[offset + 1]).toMatchObject({
          isError: false,
          details: { status: "success" },
        });
        expect(JSON.stringify(results[offset + 1])).toContain("dispatchedAt");
        expect(results[offset + 2]).toMatchObject({
          isError: true,
          details: { failureCategory: "budget-refused" },
        });
      }
      expect(JSON.stringify(results)).not.toMatch(
        /PRIVATE_REJECTION|PRIVATE_FIXTURE|evidenceId|incidentId/,
      );
      const persisted = session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
      expect(JSON.stringify(persisted)).not.toMatch(/PRIVATE_REJECTION|PRIVATE_FIXTURE/);
      const calls = (await readFile(`${pidPath}.calls`, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(3); // startup inventory plus one dispatch per user message
    });
    await new SreApplication({
      ...config("diagnostic-success"),
      execution: { maxToolCalls: 1, maxModelIterations: 6 },
    }).run();
    await expectChildExited();
  });

  async function writeRecoveryConfig(settings: SreConfig): Promise<void> {
    const { transport, command, args, startupTimeoutMs, toolCallTimeoutMs } =
      settings.kubernetes.mcp;
    const mcp = { transport, command, args, startupTimeoutMs, toolCallTimeoutMs };
    await writeFile(
      settings.paths.config,
      JSON.stringify({
        kubernetes: { mcp: { ...mcp, configFile: "kubernetes-mcp.toml" } },
        execution: settings.execution,
        results: settings.results,
        safety: settings.safety,
      }),
    );
    await writeFile(settings.paths.kubernetesMcpConfig, "read_only = true\n");
  }

  it("gives user steering and queued follow-ups fresh budgets through the production hooks", async () => {
    ui.run.mockImplementation(async ({ session }) => {
      let queued: Promise<void> | undefined;
      const queried = new Set<string>();
      await installOfflineProvider(session, (_context, iteration) => {
        if (iteration === 0) {
          queued = (async () => {
            await session.steer("Correction: inspect beta instead");
            await session.followUp("Report again after my update");
            await session.followUp("Continue after the report");
          })();
        }
        const user = session.messages.findLast((message) => message.role === "user");
        const text = JSON.stringify(user?.content);
        const needsQuery = !queried.has(text);
        queried.add(text);
        return needsQuery
          ? [
              {
                type: "toolCall",
                id: `query-${iteration}`,
                name: "pods_list",
                arguments: { context: iteration === 0 ? "alpha" : "beta" },
              },
            ]
          : [{ type: "text", text: "Observation recorded; revised report." }];
      });
      await session.prompt("Inspect alpha");
      await queued;
      const results = session.messages.filter((message) => message.role === "toolResult");
      // The correction is processed before the next model iteration. Each user
      // message gets a complete dispatch budget even inside the same Pi run.
      expect(results).toHaveLength(4);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(session.messages.filter((message) => message.role === "user")).toHaveLength(4);
      expect(session.isStreaming).toBe(false);
    });
    await new SreApplication({
      ...config("diagnostic-success"),
      execution: { maxToolCalls: 1, maxModelIterations: 6 },
    }).run();
    await expectChildExited();
  });

  it("keeps accepted alpha calls after live selection changes and refuses new alpha calls", async () => {
    const app = new SreApplication(config("diagnostic-gated"));
    ui.run.mockImplementation(async ({ session }) => {
      await installOfflineProvider(session, (_context, iteration) =>
        iteration === 0
          ? Array.from({ length: 6 }, (_, index) => ({
              type: "toolCall" as const,
              id: `accepted-${index}`,
              name: "pods_list",
              arguments: { context: "alpha" },
            }))
          : iteration === 1
            ? [
                {
                  type: "toolCall",
                  id: "new-alpha",
                  name: "pods_list",
                  arguments: { context: "alpha" },
                },
              ]
            : [
                {
                  type: "text",
                  text: "Historical alpha observations remain alpha; current scope is beta.",
                },
              ],
      );
      const running = session.prompt("Inspect alpha in parallel");
      await expect
        .poll(async () => (await readFile(`${pidPath}.calls`, "utf8")).trim().split("\n").length)
        .toBe(5);
      await session.prompt("/clusters beta");
      await writeFile(`${pidPath}.release`, "release");
      await running;
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(7);
      for (const result of results.slice(0, 6)) {
        expect(result).toMatchObject({ isError: false, details: { status: "success" } });
        expect(JSON.stringify(result.content)).toContain("alpha");
      }
      expect(results[6]).toMatchObject({
        isError: true,
        details: { failureCategory: "scope-unavailable" },
      });
      expect((await readFile(`${pidPath}.calls`, "utf8")).trim().split("\n")).toHaveLength(7);
      expect(app.selection?.rule).toEqual({ kind: "exact", contexts: ["beta"] });
    });
    await app.run();
    await expectChildExited();
  });

  it.each(["cancel", "force", "disconnect"] as const)(
    "settles active and queued calls once on %s and isolates the next request",
    async (action) => {
      const settings = config("diagnostic-gated");
      await writeRecoveryConfig(settings);
      ui.run.mockImplementation(async ({ session }) => {
        let phase = "old";
        await installOfflineProvider(session, (_context, iteration) => {
          if (iteration === 0) {
            return Array.from({ length: 6 }, (_, index) => ({
              type: "toolCall" as const,
              id: `old-${index}`,
              name: "pods_list",
              arguments: { context: "alpha" },
            }));
          }
          if (phase === "new") {
            phase = "reported";
            return [
              {
                type: "toolCall",
                id: "new-request",
                name: "pods_list",
                arguments: { context: "beta" },
              },
            ];
          }
          return [{ type: "text", text: "Report only settled observations." }];
        });
        const running = session.prompt("Inspect six targets");
        await expect
          .poll(async () => (await readFile(`${pidPath}.calls`, "utf8")).trim().split("\n").length)
          .toBe(5);
        if (action === "cancel") {
          await session.abort();
        } else {
          if (action === "disconnect") {
            process.kill(Number(await readFile(pidPath, "utf8")), "SIGTERM");
            await expect.poll(() => session.getActiveToolNames()).toEqual([]);
          }
          await session.prompt("/mcp_restart --force");
        }
        await running;
        const oldResults = session.messages.filter((message) => message.role === "toolResult");
        expect(oldResults).toHaveLength(6);
        expect(new Set(oldResults.map((result) => result.toolCallId)).size).toBe(6);
        expect(oldResults.every((result) => result.isError)).toBe(true);
        const historical = JSON.stringify(oldResults);
        await writeFile(`${pidPath}.release`, "release late responses");
        phase = "new";
        await session.prompt("Continue on beta with a fresh request");
        const allResults = session.messages.filter((message) => message.role === "toolResult");
        expect(allResults).toHaveLength(7);
        expect(JSON.stringify(allResults.slice(0, 6))).toBe(historical);
        expect(allResults.at(-1)).toMatchObject({ toolCallId: "new-request", isError: false });
        expect(session.isStreaming).toBe(false);
        // Cancelled queued calls never reach MCP; discovery is separately counted.
        const calls = (await readFile(`${pidPath}.calls`, "utf8")).trim().split("\n");
        expect(calls.filter((call) => call.includes('"name":"pods_list"'))).toHaveLength(5);
      });
      await new SreApplication(settings).run();
      await expectChildExited();
    },
  );

  it("retains the active request balance across recovery and does not wake an idle model", async () => {
    const settings = {
      ...config("diagnostic-gated"),
      execution: { maxToolCalls: 1, maxModelIterations: 6 },
    };
    await writeRecoveryConfig(config("diagnostic-success"));
    ui.run.mockImplementation(async ({ session }) => {
      const recovered = Promise.withResolvers<void>();
      const finishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        // Hold the deterministic next turn until publication has reopened dispatch.
        // Preserve the production finish hook and its request accounting.
        await recovered.promise;
        return (await finishTurn?.(turn, signal)) ?? undefined;
      };
      let streams = 0;
      await installOfflineProvider(session, (_context, iteration) => {
        streams++;
        return iteration < 2 || iteration === 3
          ? [
              {
                type: "toolCall",
                id: `query-${iteration}`,
                name: "pods_list",
                arguments: { context: "alpha" },
              },
            ]
          : [{ type: "text", text: "Report with the remaining request balance." }];
      });
      const running = session.prompt("Inspect alpha");
      await expect
        .poll(async () => (await readFile(`${pidPath}.calls`, "utf8")).trim().split("\n").length)
        .toBe(2);
      await session.prompt("/mcp_restart --force");
      recovered.resolve();
      await running;
      expect(session.messages.filter((message) => message.role === "toolResult")).toMatchObject([
        { isError: true, details: { failureCategory: "transport-unavailable" } },
        { isError: true, details: { failureCategory: "budget-refused" } },
      ]);
      expect(streams).toBe(3);
      await session.prompt("/mcp_restart --force");
      expect(streams).toBe(3);
      await session.prompt("Continue as a new request");
      expect(streams).toBe(5);
      expect(
        session.messages.filter((message) => message.role === "toolResult").at(-1),
      ).toMatchObject({ isError: false });
    });
    await new SreApplication(settings).run();
    await expectChildExited();
  });

  it("keeps one session and current exact intent across production MCP recovery; refuses non-read-only config", async () => {
    const settings = config("diagnostic-success");
    await writeRecoveryConfig(config("diagnostic-alpha-only"));
    ui.run.mockImplementation(async (runtime) => {
      const session = runtime.session;
      const commands = session.extensionRunner.getRegisteredCommands();
      await session.prompt("/clusters beta");
      const old = session.getToolDefinition("pods_list");
      expect(old).toBeDefined();
      await session.prompt("/mcp_restart --force");
      expect(runtime.session).toBe(session);
      expect(session.extensionRunner.getRegisteredCommands()).toEqual(commands);
      expect(JSON.stringify(session.messages)).toContain("Unavailable selected: 1");
      expect(JSON.stringify(session.messages)).toContain("Inventory removed:");
      let queries = 0;
      await installOfflineProvider(session, (_context, iteration) =>
        iteration === 0
          ? [
              {
                type: "toolCall",
                id: "unavailable",
                name: "pods_list",
                arguments: { context: "beta" },
              },
            ]
          : (queries++, [{ type: "text", text: "Selected beta is unavailable." }]),
      );
      await session.prompt("Continue checking beta");
      expect(queries).toBe(1);
      expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
        isError: true,
        details: { failureCategory: "scope-unavailable" },
      });
      await writeFile(settings.paths.kubernetesMcpConfig, "read_only = false\n");
      await session.prompt("/mcp_restart --force");
      expect(session.getActiveToolNames()).toEqual([]);
      expect(JSON.stringify(session.messages)).toContain("MCP: unavailable");
    });
    const app = new SreApplication(settings);
    await app.run();
    expect(app.selection?.rule).toEqual({ kind: "exact", contexts: ["beta"] });
    await expectChildExited();
  });

  it("enforces the production iteration ceiling for invalid tool loops", async () => {
    ui.run.mockImplementation(async (runtime) => {
      let streams = 0;
      await installOfflineProvider(runtime.session, () => {
        streams++;
        return [
          { type: "toolCall", id: `invalid-${streams}`, name: "unknown_tool", arguments: {} },
        ];
      });
      await runtime.session.prompt("Inspect pods");
      expect(streams).toBe(2);
      expect(runtime.session.isStreaming).toBe(false);
      expect(
        runtime.session.messages.filter((message) => message.role === "toolResult"),
      ).toHaveLength(2);
    });
    await new SreApplication({
      ...config(),
      execution: { maxToolCalls: 1, maxModelIterations: 2 },
    }).run();
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

  it.each(["timeout", "contexts-timeout"])(
    "cancels %s initialization when a signal arrives during startup",
    async (scenario) => {
      const running = new SreApplication(config(scenario)).run();
      await expect
        .poll(async () => {
          try {
            return scenario === "contexts-timeout"
              ? (await readFile(`${pidPath}.call`, "utf8")) === "started"
              : Number(await readFile(pidPath, "utf8")) > 0;
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
    },
  );
});
