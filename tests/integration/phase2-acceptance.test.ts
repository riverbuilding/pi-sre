import { withoutInvestigationTools } from "../fixtures/investigation-tools.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "../../src/app/cli.js";
import { McpController } from "../../src/app/mcp-controller.js";
import { loadSreConfig } from "../../src/config/loader.js";
import { createSreRuntime } from "../../src/runtime/pi-runtime.js";
import type { SreRuntime } from "../../src/runtime/sre-runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));

/** Simulate only the provider stream; command dispatch, Pi loop, and MCP are real. */
function requestPods(session: AgentSession, context: string | readonly string[] | undefined): void {
  let requests = 0;
  session.agent.streamFunction = (model) => {
    const first = requests++ === 0;
    type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
    type Message = Awaited<ReturnType<Stream["result"]>>;
    const message: Message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: first
        ? (typeof context === "string" || context === undefined ? [context] : context).map(
            (target, index) => ({
              type: "toolCall" as const,
              id: `pods-${index}`,
              name: "pods_list",
              arguments: target === undefined ? {} : { context: target },
            }),
          )
        : [{ type: "text", text: "Observation complete." }],
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
}

describe("Phase 2 acceptance through CLI input, configuration, controller, Pi, and stdio", () => {
  let home: string;
  let controller: McpController | undefined;
  let runtime: SreRuntime | undefined;
  let children: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-phase2-acceptance-"));
    children = [];
    await writeFile(join(home, "kubernetes-mcp.toml"), "read_only = true\n");
  });

  afterEach(async () => {
    await runtime?.dispose();
    await controller?.close();
    vi.restoreAllMocks();
    try {
      for (const pid of children) {
        const child = Number(await readFile(pid, "utf8"));
        expect(() => process.kill(child, 0)).toThrow();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      controller = undefined;
      runtime = undefined;
    }
  });

  async function configure(scenario: string, configured?: string): Promise<string> {
    const pid = join(home, `child-${children.length}.pid`);
    children.push(pid);
    await writeFile(
      join(home, "config.yaml"),
      JSON.stringify({
        kubernetes: {
          ...(configured === undefined ? {} : { contexts: [configured] }),
          mcp: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", tsx, fixture, scenario, pid],
            configFile: "kubernetes-mcp.toml",
            startupTimeoutMs: 2000,
            toolCallTimeoutMs: 1000,
          },
        },
        investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
        safety: { mode: "read-only" },
      }),
    );
    return pid;
  }

  async function start(args: readonly string[] = []): Promise<AgentSession> {
    const options = parseCliArgs(args);
    if (options.help) throw new Error("Acceptance requires application startup");
    const config = await loadSreConfig({ env: { PI_SRE_HOME: home } });
    controller = new McpController(
      config,
      new AbortController().signal,
      () => loadSreConfig({ env: { PI_SRE_HOME: home } }),
      options,
    );
    await controller.restart(false, true);
    runtime = await createSreRuntime(config, [], undefined, controller);
    vi.spyOn(runtime.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    await runtime.session.bindExtensions({});
    return runtime.session;
  }

  async function calls(pid: string): Promise<unknown[]> {
    return (await readFile(`${pid}.calls`, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
  }

  it.each([
    { args: ["--clusters", "beta"], configured: "alpha", context: "beta", source: "cli" },
    { args: ["--clusters=beta"], configured: "alpha", context: "beta", source: "cli" },
    { args: [], configured: "beta", context: "beta", source: "config" },
  ])("routes startup $source selection with explicit model context: $args", async (test) => {
    const pid = await configure("diagnostic-success", test.configured);
    const session = await start(test.args);
    expect(controller?.clusterContext.state).toMatchObject({
      status: "resolved",
      selection: { rule: { kind: "exact", contexts: [test.context] }, source: test.source },
      resolution: { status: "resolved", available: [{ name: test.context }] },
    });
    requestPods(session, test.context);
    await session.prompt("Inspect pods in the selected cluster");
    expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: false,
      details: { scope: { context: test.context, readOnly: true } },
      content: [{ type: "text", text: expect.stringContaining(`${test.context}-pods_list`) }],
    });
    expect(await calls(pid)).toEqual([
      { name: "configuration_contexts_list", arguments: {} },
      { name: "pods_list", arguments: { context: test.context } },
    ]);
  });

  it("routes explicit A/B model calls under default all on one connection", async () => {
    const pid = await configure("diagnostic-success");
    const session = await start();
    requestPods(session, ["alpha", "beta"]);
    await session.prompt("Inspect alpha and beta");
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(2);
    for (const context of ["alpha", "beta"]) {
      expect(results).toContainEqual(
        expect.objectContaining({
          isError: false,
          details: expect.objectContaining({
            scope: expect.objectContaining({ context, readOnly: true }),
          }),
        }),
      );
      expect(JSON.stringify(results)).toContain(`${context}-pods_list`);
    }
    expect(controller?.clusterContext.state.selection.rule).toEqual({ kind: "all" });
    expect(await calls(pid)).toEqual([
      { name: "configuration_contexts_list", arguments: {} },
      { name: "pods_list", arguments: { context: "alpha" } },
      { name: "pods_list", arguments: { context: "beta" } },
    ]);
  });

  it.each([undefined, "other", "alpha"])(
    "rejects model target %j for singleton beta without MCP dispatch",
    async (context) => {
      const pid = await configure("diagnostic-success");
      const session = await start(["--clusters", "beta"]);
      requestPods(session, context);
      await session.prompt("Inspect pods");
      expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
        isError: true,
      });
      expect(await calls(pid)).toEqual([{ name: "configuration_contexts_list", arguments: {} }]);
    },
  );

  it.each([
    {
      scenario: "diagnostic-success",
      args: ["--clusters=missing"],
      configured: "alpha",
      status: "selection-error",
    },
    { scenario: "diagnostic-success", args: [], configured: "missing", status: "selection-error" },
    { scenario: "diagnostic-empty", args: [], status: "not-configured" },
  ])("sends no diagnostic request for $status with $args", async (test) => {
    const pid = await configure(test.scenario, test.configured);
    const session = await start(test.args);
    expect(controller?.clusterContext.state.status).toBe(test.status);
    expect(withoutInvestigationTools(session.getCallableToolNames())).toEqual([
      "configuration_contexts_list",
    ]);
    // Even a provider emitting an unavailable operation cannot dispatch it to MCP.
    requestPods(session, "alpha");
    await session.prompt("Inspect pods despite unavailable scope");
    expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
      toolName: "pods_list",
      isError: true,
    });
    expect(await calls(pid)).toEqual([{ name: "configuration_contexts_list", arguments: {} }]);
  });

  it("keeps incident authority across next selection and recovery", async () => {
    const initial = await configure("diagnostic-success");
    const session = await start(["--clusters=alpha"]);
    const activeController = controller!;
    requestPods(session, "alpha");
    await session.prompt("Inspect alpha");
    const history = structuredClone(session.messages);
    await session.prompt("/clusters beta");
    requestPods(session, "beta");
    await session.prompt("Inspect beta");
    expect(
      session.messages.filter((message) => message.role === "toolResult").at(-1),
    ).toMatchObject({ isError: true });
    // Pi reprojects persisted steering timestamps; message content and ordering stay intact.
    expect(session.messages.slice(0, history.length)).toMatchObject(
      history.map(({ timestamp, ...message }) => {
        void timestamp;
        return message;
      }),
    );
    expect(await calls(initial)).toEqual([
      { name: "configuration_contexts_list", arguments: {} },
      { name: "pods_list", arguments: { context: "alpha" } },
    ]);
    const stale = session.getToolDefinition("pods_list");
    if (!stale) throw new Error("Expected diagnostic tool before restart");
    const replacement = await configure("diagnostic-success", "alpha");
    await session.prompt("/mcp_restart --force");
    expect(activeController.clusterContext.state).toMatchObject({
      status: "resolved",
      selection: { rule: { kind: "exact", contexts: ["beta"] }, source: "user" },
      resolution: { status: "resolved", available: [{ name: "beta" }] },
    });
    expect(await stale.execute("stale", {}, undefined, undefined, {} as never)).toMatchObject({
      isError: true,
    });
    requestPods(session, "alpha");
    await session.prompt("Continue alpha after replacement");
    const observations = session.messages.filter((message) => message.role === "toolResult");
    expect(observations).toHaveLength(3);
    for (const index of [0, 2]) {
      const context = "alpha";
      expect(observations[index]).toMatchObject({
        isError: false,
        details: { scope: { context, readOnly: true } },
        content: [{ type: "text", text: expect.stringContaining(`${context}-pods_list`) }],
      });
    }
    expect(await calls(replacement)).toEqual([
      { name: "configuration_contexts_list", arguments: {} },
      { name: "pods_list", arguments: { context: "alpha" } },
    ]);
    const removed = await configure("diagnostic-alpha-only", "alpha");
    await session.prompt("/mcp_restart --force");
    expect(activeController.clusterContext.state.status).toBe("resolved");
    expect(withoutInvestigationTools(session.getCallableToolNames())).toContain("pods_list");
    requestPods(session, "beta");
    await session.prompt("Inspect pods after selected context disappeared");
    expect(await calls(removed)).toEqual([{ name: "configuration_contexts_list", arguments: {} }]);
    // Pi reprojects persisted steering timestamps; message content and ordering stay intact.
    expect(session.messages.slice(0, history.length)).toMatchObject(
      history.map(({ timestamp, ...message }) => {
        void timestamp;
        return message;
      }),
    );
  });
});
