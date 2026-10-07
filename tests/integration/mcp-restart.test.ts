import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  async function configure(scenario = "bridge", command = process.execPath): Promise<void> {
    const pid = join(home, `child-${generation++}.pid`);
    pids.push(pid);
    await writeFile(
      join(home, "config.yaml"),
      stringify({
        kubernetes: {
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
  async function start(): Promise<void> {
    const load = () =>
      loadSreConfig({
        env: { PI_SRE_HOME: reloadHome ?? home, PI_SRE_CONFIG: join(home, "config.yaml") },
      });
    const config = await load();
    controller = new McpController(config, new AbortController().signal, load);
    await controller.restart(false, true);
    runtime = await createSreRuntime(config, [], undefined, controller);
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

  it("recovers from startup and repeated retry failures without replacing the session", async () => {
    await configure("bridge", "/no/such/mcp");
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
    expect(session.sessionManager.getEntries()).toEqual(entries);
    expect(session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    expect(await invoke()).toMatchObject({ isError: false });
    expect(JSON.stringify(await invoke())).toContain("prod");
    let turns = 0;
    session.agent.streamFunction = (model, context) => {
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
    const messages = [...session.agent.state.messages];
    await command("--force");
    expect(session.agent.state.messages).toEqual(messages);

    session.setActiveToolsByName(["bash", "read", "pods_list", "configuration_contexts_list"]);
    expect(session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
    await runtime.newSession();
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

  it("cancels an active call before forced replacement and blocks captured stale tools", async () => {
    await configure("call-timeout");
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
