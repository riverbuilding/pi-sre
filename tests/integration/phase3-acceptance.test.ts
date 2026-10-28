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
function requestPods(session: AgentSession, targets: readonly (string | undefined)[]): void {
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
        ? targets.map((target, index) => ({
            type: "toolCall" as const,
            id: `pods-${index}`,
            name: "pods_get",
            arguments: {
              name: "api",
              namespace: "default",
              ...(target === undefined ? {} : { context: target }),
            },
          }))
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

describe("Phase 3 acceptance through CLI, configuration, production Pi runtime, and recording stdio", () => {
  let home: string;
  let controller: McpController | undefined;
  let runtime: SreRuntime | undefined;
  let children: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-phase3-acceptance-"));
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

  async function configure(scenario: string, configured?: readonly string[]): Promise<string> {
    const pid = join(home, `child-${children.length}.pid`);
    children.push(pid);
    await writeFile(
      join(home, "config.yaml"),
      JSON.stringify({
        kubernetes: {
          ...(configured === undefined ? {} : { contexts: configured }),
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
    await runtime.session.bindExtensions({
      uiContext: runtime.session.extensionRunner.getUIContext(),
    });
    return runtime.session;
  }

  async function calls(pid: string): Promise<unknown[]> {
    return (await readFile(`${pid}.calls`, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
  }

  it.each([
    {
      args: [],
      configured: undefined,
      targets: ["alpha", "beta"],
      rule: { kind: "all" },
      source: "default-all",
    },
    {
      args: ["--clusters", "*"],
      configured: ["beta"],
      targets: ["alpha", "beta"],
      rule: { kind: "all" },
      source: "cli",
    },
    {
      args: ["--clusters", "beta", "alpha"],
      configured: ["beta"],
      targets: ["alpha", "beta"],
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
      source: "cli",
    },
    {
      args: ["--clusters=beta"],
      configured: ["alpha"],
      targets: ["beta"],
      rule: { kind: "exact", contexts: ["beta"] },
      source: "cli",
    },
    {
      args: [],
      configured: ["beta", "alpha"],
      targets: ["alpha", "beta"],
      rule: { kind: "exact", contexts: ["alpha", "beta"] },
      source: "config",
    },
    {
      args: [],
      configured: ["*"],
      targets: ["alpha", "beta"],
      rule: { kind: "all" },
      source: "config",
    },
  ])("keeps same-named resources attributed under $source $args", async (test) => {
    const pid = await configure("diagnostic-phase3", test.configured);
    const session = await start(test.args);
    expect(controller?.clusterContext.state.selection).toMatchObject({
      rule: test.rule,
      source: test.source,
    });
    const commit = vi.spyOn(controller!.investigation, "recordObservation");
    requestPods(session, test.targets);
    await session.prompt("Inspect Pod default/api in each permitted context");
    const results = session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(test.targets.length);
    expect(commit).toHaveBeenCalledTimes(test.targets.length);
    for (const result of commit.mock.results) {
      if (result.type !== "return") throw new Error("Observation did not commit");
      const evidence = result.value;
      expect(results).toContainEqual(
        expect.objectContaining({
          details: expect.objectContaining({
            evidenceId: evidence.id,
            executionId: evidence.executionId,
          }),
          content: [{ type: "text", text: expect.stringContaining(evidence.excerpt) }],
        }),
      );
    }
    for (const [index, context] of test.targets.entries()) {
      expect(results[index]).toMatchObject({
        isError: false,
        details: {
          scope: {
            context,
            namespace: "default",
            selectionRevision: 1,
            inventoryRevision: 1,
            connectionGeneration: 1,
            readOnly: true,
          },
        },
      });
      expect(JSON.stringify(results[index])).toContain(`${context}-pods_get`);
      expect(JSON.stringify(results[index])).toContain("api");
    }
    expect(JSON.stringify(results)).not.toContain("PRIVATE_FIXTURE");
    expect(await calls(pid)).toEqual([
      { name: "configuration_contexts_list", arguments: {} },
      ...test.targets.map((context) => ({
        name: "pods_get",
        arguments: { context, name: "api", namespace: "default" },
      })),
    ]);
    for (const forbidden of ["bash", "write", "pods_delete"]) {
      expect(session.getCallableToolNames()).not.toContain(forbidden);
    }
  });

  it("refuses missing/excluded targets and atomic invalid overrides without fallback", async () => {
    const pid = await configure("diagnostic-phase3", ["alpha"]);
    const session = await start(["--clusters", "beta"]);
    requestPods(session, [undefined, "alpha", "other", "beta"]);
    await session.prompt("Attempt targets including a missing context");
    expect(
      session.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.isError),
    ).toEqual([true, true, true, false]);
    await session.prompt("/clusters missing");
    expect(controller?.clusterContext.state.selection.rule).toEqual({
      kind: "exact",
      contexts: ["beta"],
    });
    expect(await calls(pid)).toEqual([
      { name: "configuration_contexts_list", arguments: {} },
      { name: "pods_get", arguments: { context: "beta", name: "api", namespace: "default" } },
    ]);
  });

  it.each(["exact", "all"] as const)(
    "reconciles %s across removal, failure, empty discovery and recovery in one conversation",
    async (kind) => {
      await configure("diagnostic-phase3");
      const session = await start(kind === "exact" ? ["--clusters", "alpha", "beta"] : []);
      requestPods(session, ["alpha", "beta"]);
      await session.prompt("Inspect initial contexts");
      const history = structuredClone(session.messages);
      const stale = session.getToolDefinition("pods_get");
      if (!stale) throw new Error("Expected diagnostic tool");
      const revision = controller!.clusterContext.state.selection.selectionRevision;
      const replacement = await configure("diagnostic-reconciled", ["gamma"]);
      await session.prompt("/mcp_restart --force");
      expect(controller!.clusterContext.state).toMatchObject({
        selection: {
          selectionRevision: revision,
          rule: kind === "all" ? { kind: "all" } : { kind: "exact", contexts: ["alpha", "beta"] },
        },
        resolution: {
          status: "resolved",
          available: kind === "all" ? [{ name: "alpha" }, { name: "gamma" }] : [{ name: "alpha" }],
          unavailable: kind === "all" ? [] : ["beta"],
        },
      });
      expect(
        await stale.execute(
          "stale",
          { context: "alpha", name: "api" },
          undefined,
          undefined,
          {} as never,
        ),
      ).toMatchObject({ isError: true, details: { failureCategory: "stale-scope" } });
      requestPods(session, ["alpha", "beta", "gamma"]);
      await session.prompt("Inspect after inventory changed");
      expect(await calls(replacement)).toEqual([
        { name: "configuration_contexts_list", arguments: {} },
        { name: "pods_get", arguments: { context: "alpha", name: "api", namespace: "default" } },
        ...(kind === "all"
          ? [
              {
                name: "pods_get",
                arguments: { context: "gamma", name: "api", namespace: "default" },
              },
            ]
          : []),
      ]);
      const inventoryRevision = controller!.clusterContext.state.inventoryRevision;
      await configure("diagnostic-inventory-error");
      await session.prompt("/mcp_restart --force");
      expect(controller!.clusterContext.state).toMatchObject({
        status: "enumeration-failed",
        inventoryRevision,
      });
      expect(session.getCallableToolNames()).toEqual([]);
      await configure("diagnostic-empty");
      await session.prompt("/mcp_restart --force");
      expect(session.getCallableToolNames()).toEqual(["configuration_contexts_list"]);
      expect(controller!.clusterContext.state.resolution).toMatchObject({
        status: "resolved",
        available: [],
      });
      const recovered = await configure("diagnostic-beta-authorization", ["alpha"]);
      await session.prompt("/mcp_restart --force");
      requestPods(session, ["beta", "alpha"]);
      await session.prompt("Inspect independently after recovery");
      expect(
        session.messages.filter((message) => message.role === "toolResult").slice(-2),
      ).toMatchObject([
        {
          isError: true,
          details: { failureCategory: "authorization-failed", scope: { context: "beta" } },
        },
        { isError: false, details: { scope: { context: "alpha" } } },
      ]);
      expect(await calls(recovered)).toHaveLength(3);
      expect(session.messages.slice(0, history.length)).toEqual(history);
      expect(controller!.clusterContext.state.selection.selectionRevision).toBe(revision);
    },
  );

  it("overlaps four same-named reads, waits FIFO, and refuses selection during the model batch", async () => {
    const pid = await configure("diagnostic-phase3-delayed");
    const session = await start();
    const contexts = ["alpha", "beta", "alpha", "beta", "beta", "alpha"];
    requestPods(session, contexts);
    const pending = session.prompt("Inspect all six targets independently");
    try {
      await expect.poll(async () => (await calls(pid)).length).toBe(5);
      await session.prompt("/clusters beta");
      expect(controller!.clusterContext.state.selection.rule).toEqual({ kind: "all" });
    } finally {
      await pending;
    }
    expect((await calls(pid)).slice(1)).toEqual(
      contexts.map((context) => ({
        name: "pods_get",
        arguments: { context, name: "api", namespace: "default" },
      })),
    );
    expect(session.messages.filter((message) => message.role === "toolResult")).toMatchObject(
      contexts.map((context) => ({ isError: false, details: { scope: { context } } })),
    );
    expect(controller!.clusterContext.isAgentActive).toBe(false);
    await session.prompt("/clusters beta");
    expect(controller!.clusterContext.state.selection.rule).toEqual({
      kind: "exact",
      contexts: ["beta"],
    });
  });

  it("restores compacted scope and reloads tools without changing session authority", async () => {
    const pid = await configure("diagnostic-phase3");
    const session = await start(["--clusters", "alpha", "beta"]);
    const state = controller!.clusterContext.state;
    session.sessionManager.appendCompaction("Earlier observations", null, 100);
    const restored = await session.extensionRunner.emitBeforeAgentStart("Continue", undefined, {
      cwd: home,
    });
    expect(restored.messages).toMatchObject([
      { customType: "pi-sre-cluster-scope", display: false },
    ]);
    expect(JSON.stringify(restored.messages)).toContain("READ ONLY");
    await session.reload();
    expect(controller!.clusterContext.state).toBe(state);
    requestPods(session, ["beta", "alpha"]);
    await session.prompt("Inspect after reload");
    expect((await calls(pid)).slice(1)).toHaveLength(2);
    expect(session.messages.filter((message) => message.role === "toolResult")).toMatchObject([
      { isError: false, details: { scope: { context: "beta" } } },
      { isError: false, details: { scope: { context: "alpha" } } },
    ]);
  });

  it.each(["cancel", "restart"] as const)(
    "settles active and queued model calls on %s without replay",
    async (action) => {
      const pid = await configure("diagnostic-phase3-delayed");
      const session = await start();
      requestPods(session, ["alpha", "beta", "alpha", "beta", "beta", "alpha"]);
      const pending = session.prompt("Inspect six targets");
      try {
        await expect.poll(async () => (await calls(pid)).length).toBe(5);
        if (action === "cancel") await session.abort();
        else {
          const replacement = await configure("diagnostic-phase3");
          await session.prompt("/mcp_restart --force");
          expect(await calls(replacement)).toEqual([
            { name: "configuration_contexts_list", arguments: {} },
          ]);
        }
      } finally {
        await pending;
      }
      expect(await calls(pid)).toHaveLength(5);
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(6);
      expect(results.every((message) => message.isError)).toBe(true);
      expect(controller!.clusterContext.isAgentActive).toBe(false);
    },
  );
});
