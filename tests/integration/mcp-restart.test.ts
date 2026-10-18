import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { McpController } from "../../src/app/mcp-controller.js";
import { loadSreConfig } from "../../src/config/loader.js";
import { createSreRuntime } from "../../src/runtime/pi-runtime.js";
import type { SreRuntime } from "../../src/runtime/sre-runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

describe("in-session MCP recovery with real Pi and stdio", () => {
  let home: string;
  let controller: McpController;
  let runtime: SreRuntime;
  let generation: number;
  const pids: string[] = [];
  let reloadHome: string | undefined;

  async function configure(
    scenario = "contexts-runtime",
    command = process.execPath,
    defaultCluster?: string,
  ): Promise<void> {
    const pid = join(home, `child-${generation++}.pid`);
    pids.push(pid);
    await writeFile(
      join(home, "config.yaml"),
      stringify({
        kubernetes: {
          ...(defaultCluster === undefined ? {} : { defaultCluster }),
          mcp: {
            transport: "stdio",
            command,
            args: ["--import", import.meta.resolve("tsx"), fixture, scenario, pid],
            configFile: "kubernetes-mcp.toml",
            startupTimeoutMs: 2000,
            toolCallTimeoutMs: 10000,
          },
        },
        investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
        safety: { mode: "read-only" },
      }),
    );
  }
  async function start(cluster?: string): Promise<void> {
    const load = () =>
      loadSreConfig({
        env: { PI_SRE_HOME: reloadHome ?? home, PI_SRE_CONFIG: join(home, "config.yaml") },
      });
    const config = await load();
    controller = new McpController(
      config,
      new AbortController().signal,
      load,
      cluster === undefined ? {} : { cluster },
    );
    await controller.restart(false, true);
    runtime = await createSreRuntime(config, [], undefined, controller);
    await runtime.session.bindExtensions({});
  }
  async function command(args = ""): Promise<void> {
    // This is the same extension command dispatch used by Pi's terminal.
    await runtime.session.prompt(`/mcp_restart${args ? ` ${args}` : ""}`);
  }
  async function invoke(tool?: ToolDefinition) {
    const definition = tool ?? runtime.session.getToolDefinition("configuration_contexts_list");
    if (!definition) throw new Error("Expected approved tool");
    return definition.execute("contexts", {}, new AbortController().signal, undefined, {} as never);
  }
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-restart-"));
    generation = 0;
    pids.length = 0;
    reloadHome = undefined;
    await writeFile(join(home, "kubernetes-mcp.toml"), "read_only = true\n");
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await runtime?.disposeSession();
    await controller?.close();
    for (const path of pids) {
      let pid: number;
      try {
        pid = Number(await readFile(path, "utf8"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
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
    await rm(home, { recursive: true, force: true });
  });

  async function observeFeedback() {
    const notify = vi.fn();
    await runtime.session.bindExtensions({
      uiContext: { ...runtime.session.extensionRunner.getUIContext(), notify },
    });
    return notify;
  }

  it("numbers repeated no-ops and status across commands/reload, and isolates new sessions", async () => {
    await configure("diagnostic-success");
    await start();
    const notify = await observeFeedback();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 17, 12, 34, 1));
    const messages = [...runtime.session.messages];
    const calls = await readFile(`${pids[0]}.calls`, "utf8");
    const state = controller.snapshot;
    await command();
    await command();
    await runtime.session.prompt("/cluster --status");
    await runtime.session.prompt("/cluster --status");
    await runtime.session.prompt("/cluster alpha");
    await runtime.session.prompt("/cluster alpha");
    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining(
        "[12:34:01 #1] /mcp_restart: MCP already healthy; existing connection retained.",
      ),
      expect.stringContaining(
        "[12:34:01 #2] /mcp_restart: MCP already healthy; existing connection retained.",
      ),
      expect.stringContaining("[12:34:01 #3] /cluster --status:"),
      expect.stringContaining("[12:34:01 #4] /cluster --status:"),
      expect.stringContaining("[12:34:01 #5] /cluster: Already selected."),
      expect.stringContaining("[12:34:01 #6] /cluster: Already selected."),
    ]);
    expect(controller.snapshot).toBe(state);
    expect(runtime.session.messages).toEqual(messages);
    expect(await readFile(`${pids[0]}.calls`, "utf8")).toBe(calls);
    await runtime.session.reload();
    await command();
    expect(notify.mock.lastCall?.[0]).toContain("#7]");
    await runtime.newSession();
    const next = await observeFeedback();
    await command();
    expect(next.mock.lastCall?.[0]).toContain("#1]");
  });

  it("acknowledges picker receipt/cancellation, invalid choices, and active-work refusal", async () => {
    await configure();
    await start();
    const notify = vi.fn();
    const choice = Promise.withResolvers<string | undefined>();
    const select = vi.fn(() => choice.promise);
    await runtime.session.bindExtensions({
      uiContext: { ...runtime.session.extensionRunner.getUIContext(), notify, select },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 17, 12, 34, 1));
    const state = controller.clusterContext.state;
    const picking = runtime.session.prompt("/cluster");
    expect(notify.mock.lastCall?.[0]).toBe("[12:34:01 #1] /cluster: Opening cluster picker…");
    vi.setSystemTime(new Date(2026, 9, 17, 12, 34, 2));
    choice.resolve(undefined);
    await picking;
    expect(notify.mock.lastCall?.[0]).toBe(
      "[12:34:02 #1] /cluster: Selection cancelled; cluster unchanged.",
    );
    await runtime.session.prompt("/cluster missing");
    expect(notify.mock.lastCall).toEqual([
      expect.stringContaining("#2] /cluster: Selection refused: Unknown MCP context"),
      "warning",
    ]);
    const release = controller.clusterContext.beginAgentWork();
    try {
      await runtime.session.prompt("/cluster prod");
      expect(notify.mock.lastCall).toEqual([
        expect.stringContaining("#3] /cluster: Wait for or cancel the active agent turn"),
        "warning",
      ]);
      await runtime.session.prompt("/cluster --status");
      expect(notify.mock.lastCall?.[0]).toContain("#4] /cluster --status:");
    } finally {
      release();
    }
    expect(controller.clusterContext.state).toBe(state);
  });

  it("acknowledges unexpected restart rejection without exposing its raw error", async () => {
    await configure();
    await start();
    const notify = await observeFeedback();
    vi.spyOn(controller, "restart").mockRejectedValueOnce(new Error("PRIVATE_FIXTURE"));
    await command("--force");
    expect(notify.mock.lastCall).toEqual([
      expect.stringContaining("#1] /mcp_restart --force: Restart failed unexpectedly"),
      "error",
    ]);
    expect(JSON.stringify(notify.mock.calls)).not.toContain("PRIVATE_FIXTURE");
  });

  it("associates concurrent forced/shared completion with invocation numbers and one replacement PID", async () => {
    await configure("diagnostic-success");
    await start();
    const notify = await observeFeedback();
    await runtime.session.prompt("/cluster beta");
    const oldPid = await readFile(pids[0]!, "utf8");
    await configure("diagnostic-success");
    const first = command("--force");
    const second = command();
    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("#1] /cluster: Selection changed."),
      expect.stringContaining("#2] /mcp_restart --force: Replacing MCP connection"),
      expect.stringContaining("#3] /mcp_restart: Joining MCP restart"),
    ]);
    await Promise.all([first, second]);
    expect(notify.mock.calls.slice(-2).map(([message]) => message)).toEqual([
      expect.stringContaining("#2] /mcp_restart --force: Restart completed; MCP transport ready."),
      expect.stringContaining("#3] /mcp_restart: Restart completed; MCP transport ready."),
    ]);
    expect(controller.clusterContext.state.connectionGeneration).toBe(2);
    expect(await readFile(pids[1]!, "utf8")).not.toBe(oldPid);
    expect(controller.clusterContext.captureScope()).toMatchObject({
      context: "beta",
      source: "user",
    });
    expect(await invoke(runtime.session.getToolDefinition("pods_list"))).toMatchObject({
      details: { scope: { context: "beta" } },
      isError: false,
    });
  });

  it("reports failed recovery, ready transport with enumeration failure, and unavailable selection honestly", async () => {
    await configure("contexts-runtime", "/no/such/mcp");
    await start();
    const notify = await observeFeedback();
    await command();
    expect(notify.mock.calls[0]?.[0]).toContain("#1] /mcp_restart: Attempting MCP recovery");
    expect(notify.mock.lastCall).toEqual([
      expect.stringContaining("#1] /mcp_restart: Restart failed"),
      "warning",
    ]);
    await configure("contexts-malformed");
    await command();
    expect(notify.mock.lastCall).toEqual([
      expect.stringContaining("Registry: failed (invalid-response)"),
      "warning",
    ]);
    expect(notify.mock.lastCall?.[0]).toContain(
      "#2] /mcp_restart: Restart completed; MCP transport ready.",
    );
    await configure("diagnostic-success");
    await command();
    await runtime.session.prompt("/cluster beta");
    await configure("diagnostic-alpha-only");
    await command("--force");
    expect(notify.mock.lastCall).toEqual([
      expect.stringContaining('Requested context: "beta"; selection source: user'),
      "warning",
    ]);
    expect(notify.mock.lastCall?.[0]).toContain("Cluster-dependent calls are blocked");
    await controller.close();
    await command();
    expect(notify.mock.lastCall?.[0]).toContain("Restart refused");
  });

  it("recovers from startup and repeated retry failures without replacing the session", async () => {
    await configure("contexts-runtime", "/no/such/mcp");
    await start();
    const session = runtime.session;
    session.sessionManager.appendCustomEntry("preserved", { value: 42 });
    const entries = session.sessionManager.getEntries();
    expect(session.getActiveToolNames()).toEqual([]);
    expect(session.extensionRunner.getCommand("mcp_restart")).toBeDefined();
    await command();
    await command();
    expect(controller.snapshot.status).toBe("unavailable");
    await configure();
    await command();
    expect(runtime.session).toBe(session);
    expect(session.sessionManager.getEntries().slice(0, entries.length)).toEqual(entries);
    expect(session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    expect(await invoke()).toMatchObject({ isError: false });
    expect(JSON.stringify(await invoke())).toContain("prod");
    let turns = 0;
    session.agent.streamFunction = (model, context) => {
      expect(controller.clusterContext.isAgentActive).toBe(true);
      expect(() => controller.clusterContext.select("prod")).toThrow("active agent");
      const first = turns++ === 0;
      if (!first) {
        expect(context.messages.find((message) => message.role === "toolResult")).toMatchObject({
          toolName: "configuration_contexts_list",
          isError: false,
        });
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
                id: "recovered-contexts",
                name: "configuration_contexts_list",
                arguments: {},
              },
            ]
          : [{ type: "text", text: "Contexts: dev, prod." }],
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
      // Only the model stream is simulated; Pi's tool loop and stdio are real.
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: message.stopReason, message };
        },
        async result() {
          return message;
        },
      } as unknown as Stream;
    };
    await session.agent.prompt("List configured contexts");
    expect(turns).toBe(2);
    expect(controller.clusterContext.isAgentActive).toBe(false);
    const messages = [...session.agent.state.messages];
    await command("--force");
    expect(session.agent.state.messages.slice(0, messages.length)).toEqual(messages);

    session.setActiveToolsByName(["bash", "read", "pods_list", "configuration_contexts_list"]);
    expect(session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    controller.clusterContext.select("prod");
    const scope = controller.clusterContext.captureScope();
    await runtime.newSession();
    expect(controller.clusterContext.captureScope()).toBe(scope);
    await runtime.session.bindExtensions({
      uiContext: runtime.session.extensionRunner.getUIContext(),
    });
    expect(runtime.session.messages).toMatchObject([
      {
        role: "custom",
        content: expect.stringContaining('Cluster: "prod"; selection source: user'),
      },
    ]);
    const newSessionMessages = [...runtime.session.messages];
    await runtime.session.reload();
    expect(runtime.session.messages).toEqual(newSessionMessages);
    expect(controller.clusterContext.captureScope()).toBe(scope);
    expect(runtime.session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    await configure("empty-tools");
    await command("--force");
    expect(runtime.session.getActiveToolNames()).toEqual([]);
  });

  it("keeps healthy connections and rejects unknown command arguments", async () => {
    await configure();
    await start();
    const state = controller.snapshot;
    await command();
    await command("--force extra");
    expect(controller.snapshot).toBe(state);
    expect(await invoke()).toMatchObject({ isError: false });
  });

  it.each([undefined, "alpha"])(
    "resolves pending startup with refreshed defaults and CLI=%s",
    async (cluster) => {
      await configure("diagnostic-success", "/no/such/mcp", "alpha");
      await start(cluster);
      await configure("diagnostic-success", process.execPath, "beta");
      await command();
      expect(controller.clusterContext.captureScope()).toMatchObject({
        context: cluster ?? "beta",
        source: cluster ? "cli" : "config",
      });
      expect(runtime.session.getActiveToolNames()).toContain("pods_list");
    },
  );

  it("retains a user choice through failed enumeration, removal, and reappearance", async () => {
    await configure("diagnostic-success");
    await start();
    await runtime.session.prompt("/cluster beta");
    const old = runtime.session.getToolDefinition("pods_list");
    await configure("contexts-malformed", process.execPath, "alpha");
    await command("--force");
    expect(controller.clusterContext.state.status).toBe("enumeration-failed");
    expect(runtime.session.getActiveToolNames()).toEqual([]);
    await configure("diagnostic-alpha-only", process.execPath, "alpha");
    await command();
    expect(controller.clusterContext.state).toMatchObject({
      status: "selection-error",
      requestedName: "beta",
      source: "user",
    });
    expect(runtime.session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    expect(await invoke(old)).toMatchObject({
      isError: true,
      details: { failureCategory: "stale-scope" },
    });
    await configure("diagnostic-success", process.execPath, "alpha");
    await command("--force");
    expect(controller.clusterContext.captureScope()).toMatchObject({
      context: "beta",
      source: "user",
    });
    expect(await invoke(runtime.session.getToolDefinition("pods_list"))).toMatchObject({
      isError: false,
      details: { scope: { context: "beta" } },
    });
    const calls = await readFile(`${pids.at(-1)}.calls`, "utf8");
    expect(
      calls
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line)),
    ).toEqual([
      { name: "configuration_contexts_list", arguments: {} },
      { name: "pods_list", arguments: { context: "beta" } },
    ]);
  });

  it("keeps resolved unbound scope when replacement adds configured and MCP defaults", async () => {
    await configure("diagnostic-unbound");
    await start();
    await configure("diagnostic-success", process.execPath, "beta");
    await command("--force");
    expect(controller.clusterContext.state.status).toBe("unbound");
    expect(runtime.session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
  });

  it("publishes coherent recovery state, coalesces listener retries, and validates new schemas", async () => {
    await configure("diagnostic-success");
    await start();
    const old = runtime.session.getToolDefinition("pods_get");
    const transitions: string[] = [];
    let listenerRetry: Promise<unknown> | undefined;
    const unsubscribeScope = controller.clusterContext.subscribe((scope) => {
      if (scope.status === "connecting") {
        expect(controller.snapshot).toMatchObject({ status: "connecting", tools: [] });
        expect(controller.discoveryReport).toBeUndefined();
        expect(() => controller.clusterContext.select("beta")).toThrow(
          "current MCP context registry",
        );
        listenerRetry = controller.restart(true);
      }
    });
    const unsubscribe = controller.subscribe((state) => transitions.push(state.status));
    await configure("diagnostic-evolved");
    const replacement = controller.restart(true);
    expect(listenerRetry).toBe(replacement);
    await replacement;
    unsubscribeScope();
    unsubscribe();
    expect(transitions).toEqual(["ready", "connecting", "ready"]);
    expect(await invoke(old)).toMatchObject({
      isError: true,
      details: { failureCategory: "stale-scope" },
    });
    const tool = runtime.session.getToolDefinition("pods_get");
    if (!tool) throw new Error("Expected replacement diagnostic tool");
    expect(
      await tool.execute("missing-view", { name: "api" }, undefined, undefined, {} as never),
    ).toMatchObject({
      isError: true,
      details: { failureCategory: "invalid-arguments" },
    });
    expect(
      await tool.execute(
        "new-schema",
        { name: "api", view: "summary" },
        undefined,
        undefined,
        {} as never,
      ),
    ).toMatchObject({
      isError: false,
      details: { scope: { context: "alpha" } },
    });
  });

  it.each([
    ["diagnostic-authentication", "authentication-failed"],
    ["diagnostic-authorization", "authorization-failed"],
    ["diagnostic-operation", "tool-execution-failed"],
  ])(
    "keeps %s separate from healthy MCP transport and selected scope",
    async (scenario, category) => {
      await configure(scenario);
      await start("beta");
      expect(await invoke(runtime.session.getToolDefinition("pods_list"))).toMatchObject({
        isError: true,
        details: { failureCategory: category, scope: { context: "beta" } },
      });
      const state = controller.snapshot;
      await command();
      expect(controller.snapshot).toBe(state);
      expect(controller.snapshot.status).toBe("ready");
      expect(controller.clusterContext.captureScope()?.context).toBe("beta");
    },
  );

  it("withdraws diagnostics immediately on drop and withholds a late cancelled response", async () => {
    await configure("diagnostic-delayed");
    await start("beta");
    const old = runtime.session.getToolDefinition("pods_list");
    const active = invoke(old);
    await expect
      .poll(async () => {
        try {
          return await readFile(`${pids[0]}.call`, "utf8");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
          throw error;
        }
      })
      .toBe("started");
    await configure("diagnostic-success");
    await command("--force");
    const result = await active;
    expect(result).toMatchObject({
      isError: true,
      details: { failureCategory: "stale-scope", scope: { context: "beta" } },
    });
    expect(JSON.stringify(result)).not.toContain("beta-pods_list");
    const observed: string[] = [];
    const unsubscribe = controller.subscribe((state) => observed.push(state.status));
    const unsubscribeScope = controller.clusterContext.subscribe((scope) => {
      if (scope.status === "unavailable")
        expect(controller.snapshot).toMatchObject({ status: "unavailable", tools: [] });
    });
    process.kill(Number(await readFile(pids.at(-1)!, "utf8")), "SIGTERM");
    await expect.poll(() => controller.snapshot.status).toBe("unavailable");
    expect(observed).toEqual(["ready", "unavailable"]);
    expect(runtime.session.getActiveToolNames()).toEqual([]);
    expect(runtime.session.messages.at(-1)).toMatchObject({
      content: expect.stringContaining("Cluster-dependent calls are blocked"),
    });
    unsubscribeScope();
    unsubscribe();
  });

  it("selects exact names and picker choices without replacing the conversation or MCP", async () => {
    await configure();
    await start();
    const session = runtime.session;
    session.sessionManager.appendCustomEntry("preserved", { value: 42 });
    const entries = session.sessionManager.getEntries();
    const connection = controller.snapshot;
    const yaml = await readFile(join(home, "config.yaml"), "utf8");
    const toml = await readFile(join(home, "kubernetes-mcp.toml"), "utf8");
    const select = vi.fn().mockResolvedValueOnce("dev").mockResolvedValueOnce(undefined);
    const notify = vi.fn();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), select, notify },
    });
    await session.prompt("/cluster prod");
    expect(controller.clusterContext.captureScope()).toMatchObject({
      context: "prod",
      source: "user",
    });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('"prod" (user)'), "info");
    const selected = controller.clusterContext.state;
    await session.prompt("/cluster prod");
    await session.prompt("/cluster missing");
    expect(controller.clusterContext.state).toBe(selected);
    await session.prompt("/cluster");
    expect(select).toHaveBeenLastCalledWith(
      'Cluster (current: "prod")',
      ["dev", "prod"],
      undefined,
    );
    expect(controller.clusterContext.captureScope()?.context).toBe("dev");
    const picked = controller.clusterContext.state;
    await session.prompt("/cluster");
    expect(controller.clusterContext.state).toBe(picked);
    expect(notify.mock.lastCall?.[0]).toContain("Selection cancelled; cluster unchanged.");
    expect(await session.extensionRunner.emitContext([])).toEqual([]);
    expect(session.messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "pi-sre-cluster-scope",
      content: expect.stringContaining('Cluster: "dev"; selection source: user'),
    });
    expect(runtime.session).toBe(session);
    expect(controller.snapshot).toBe(connection);
    expect(session.sessionManager.getEntries().slice(0, entries.length)).toEqual(entries);
    expect(session.messages).toHaveLength(3);
    expect(session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(yaml);
    expect(await readFile(join(home, "kubernetes-mcp.toml"), "utf8")).toBe(toml);
  });

  it("rejects stale picker choices and rechecks active work after the picker returns", async () => {
    await configure();
    await start();
    const session = runtime.session;
    const notify = vi.fn();
    const choice = Promise.withResolvers<string | undefined>();
    const select = vi.fn(() => choice.promise);
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), select, notify },
    });
    const selecting = session.prompt("/cluster");
    await expect.poll(() => select.mock.calls.length).toBe(1);
    await command("--force");
    const replaced = controller.clusterContext.state;
    choice.resolve("prod");
    await selecting;
    expect(controller.clusterContext.state).toBe(replaced);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("state changed"), "warning");

    const activeChoice = Promise.withResolvers<string | undefined>();
    select.mockImplementation(() => activeChoice.promise);
    const pending = session.prompt("/cluster");
    await expect.poll(() => select.mock.calls.length).toBe(2);
    const release = controller.clusterContext.beginAgentWork();
    try {
      activeChoice.resolve("prod");
      await pending;
      await session.prompt("/cluster prod");
      expect(controller.clusterContext.state).toBe(replaced);
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringContaining("active agent turn"),
        "warning",
      );
    } finally {
      release();
    }
  });

  it("keeps cluster selection available after degraded startup and extension reload", async () => {
    await configure("contexts-runtime", "/no/such/mcp");
    await start();
    const select = vi.fn();
    const notify = vi.fn();
    await runtime.session.bindExtensions({
      uiContext: { ...runtime.session.extensionRunner.getUIContext(), select, notify },
    });
    const unavailable = controller.clusterContext.state;
    await runtime.session.prompt("/cluster prod");
    await runtime.session.prompt("/cluster");
    expect(controller.clusterContext.state).toBe(unavailable);
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining("current MCP context registry"),
      "warning",
    );
    expect(await runtime.session.extensionRunner.emitContext([])).toEqual([]);
    expect(runtime.session.messages.at(-1)).toMatchObject({
      role: "custom",
      content: expect.stringContaining("Cluster-dependent calls are blocked"),
    });
    await configure();
    await command();
    await runtime.session.prompt("/cluster prod");
    await runtime.session.reload();
    await runtime.session.prompt("/cluster dev");
    expect(controller.clusterContext.captureScope()).toMatchObject({
      context: "dev",
      source: "user",
    });
    expect(runtime.session.extensionRunner.getCommandDiagnostics()).toEqual([]);
  });

  it("recovers from a startup selection error with an exact user selection", async () => {
    await configure();
    await start("absent");
    expect(controller.clusterContext.state.status).toBe("selection-error");
    await runtime.session.prompt("/cluster prod");
    expect(controller.clusterContext.captureScope()).toMatchObject({
      context: "prod",
      source: "user",
    });
  });

  it.each(["contexts-empty", "contexts-malformed", "contexts-error"])(
    "does not offer a picker or change scope after %s enumeration",
    async (scenario) => {
      await configure(scenario);
      await start();
      const select = vi.fn();
      const notify = vi.fn();
      await runtime.session.bindExtensions({
        uiContext: { ...runtime.session.extensionRunner.getUIContext(), select, notify },
      });
      const state = controller.clusterContext.state;
      await runtime.session.prompt("/cluster");
      await runtime.session.prompt("/cluster alpha");
      expect(controller.clusterContext.state).toBe(state);
      expect(select).not.toHaveBeenCalled();
      expect(notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    },
  );

  it("cancels an active call before forced replacement and blocks captured stale tools", async () => {
    await configure("contexts-call-timeout");
    await start();
    const old = runtime.session.getToolDefinition("configuration_contexts_list");
    const active = invoke(old);
    await expect
      .poll(async () => {
        try {
          return await readFile(`${pids[0]}.call`, "utf8");
        } catch {
          return "";
        }
      })
      .toBe("started");
    await configure();
    await command("--force");
    expect(await active).toMatchObject({ isError: true });
    expect(await invoke(old)).toMatchObject({ isError: true });
    expect(await invoke()).toMatchObject({ isError: false });
  });

  it("coalesces concurrent restarts and hides removed tools", async () => {
    await configure();
    await start();
    await configure("empty-tools");
    const first = controller.restart(true);
    expect(controller.restart(true)).toBe(first);
    await first;
    expect(controller.snapshot).toMatchObject({ status: "ready", tools: [] });
    expect(runtime.session.getActiveToolNames()).toEqual([]);
    runtime.session.setActiveToolsByName(["configuration_contexts_list", "bash"]);
    expect(runtime.session.getActiveToolNames()).toEqual([]);
  });

  it.each(["yaml", "toml", "unsafe", "home"])(
    "fails closed on changed %s configuration and permits repair",
    async (kind) => {
      await configure();
      await start();
      if (kind === "yaml") await writeFile(join(home, "config.yaml"), "{bad yaml");
      if (kind === "toml") await writeFile(join(home, "kubernetes-mcp.toml"), "bad toml");
      if (kind === "unsafe")
        await writeFile(join(home, "kubernetes-mcp.toml"), "read_only = false\n");
      if (kind === "home") reloadHome = join(home, "different");
      await command("--force");
      expect(controller.snapshot.status).toBe("unavailable");
      expect(runtime.session.getActiveToolNames()).toEqual([]);
      expect(controller.snapshot.message).toContain("configuration");
      reloadHome = undefined;
      await writeFile(join(home, "kubernetes-mcp.toml"), "read_only = true\n");
      await configure();
      await command();
      expect(await invoke()).toMatchObject({ isError: false });
    },
  );

  it("removes tools as soon as the MCP child drops, then recovers", async () => {
    await configure();
    await start();
    process.kill(Number(await readFile(pids[0]!, "utf8")), "SIGTERM");
    await expect.poll(() => runtime.session.getActiveToolNames()).toEqual([]);
    expect(controller.snapshot.status).toBe("unavailable");
    await configure();
    await command();
    expect(await invoke()).toMatchObject({ isError: false });
  });
});
