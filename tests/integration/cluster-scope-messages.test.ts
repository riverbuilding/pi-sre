import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClusterContextManager } from "../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../src/cluster/context-registry.js";
import { createClusterStatusLines } from "../../src/runtime/cluster-guidance.js";
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { registerClusterScope } from "../../src/tui/cluster-extension.js";

describe("persistent scope updates", () => {
  let home: string;
  let session: AgentSession;
  let manager: ClusterContextManager;
  const setWidget = vi.fn();
  const notify = vi.fn();
  const select = vi.fn();

  beforeEach(async () => {
    setWidget.mockClear();
    notify.mockClear();
    select.mockReset().mockResolvedValue(undefined);
    home = await mkdtemp(join(tmpdir(), "pi-sre-scope-messages-"));
    manager = new ClusterContextManager({ rule: { kind: "exact", contexts: ["alpha"] } });
    manager.acceptRegistry(
      manager.beginConnection(),
      new ClusterContextRegistry(
        ["alpha", "beta"].map((name) => ({
          name,
          server: "https://example.invalid",
          isDefault: name === "alpha",
        })),
      ),
    );
    const services = await createAgentSessionServices({
      cwd: home,
      agentDir: home,
      resourceLoaderOptions: {
        ...createSreResourceLoaderOptions(),
        extensionFactories: [{ name: "scope", factory: (pi) => registerClusterScope(pi, manager) }],
      },
    });
    ({ session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(home),
      noTools: "builtin",
    }));
    // Model streaming is simulated below; bypass only the credential preflight.
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setWidget, notify, select },
    });
  });

  it("keeps status, widget, and persistent scope aligned without changing selection or history", async () => {
    const checkStatus = async (cluster: string, mcp: string, registry: string) => {
      const state = manager.state;
      const messages = [...session.messages];
      // Status remains usable during active work; selection still has its guard.
      const release = manager.beginAgentWork();
      try {
        await session.prompt("/clusters --status");
      } finally {
        release();
      }
      expect(manager.state).toBe(state);
      expect(session.messages).toEqual(messages);
      expect(setWidget).toHaveBeenLastCalledWith("pi-sre-scope", createClusterStatusLines(state), {
        placement: "belowEditor",
      });
      const status: unknown = notify.mock.lastCall?.[0];
      expect(status).toEqual(expect.stringContaining(`Cluster: ${cluster}`));
      expect(status).toEqual(expect.stringContaining(`MCP: ${mcp} | Registry: ${registry}`));
      const snapshot = session.messages.at(-1);
      expect(snapshot).toMatchObject({
        role: "custom",
        content: expect.stringContaining(`MCP: ${mcp} | Registry: ${registry}`),
      });
    };
    await checkStatus('"alpha"', "ready", "validated (2 contexts)");
    manager.select("beta");
    await checkStatus('"beta"', "ready", "validated (2 contexts)");
    const generation = manager.beginConnection();
    await checkStatus("UNAVAILABLE", "connecting", "unavailable");
    manager.failEnumeration(generation, "invalid-response", "Invalid registry");
    await checkStatus("UNAVAILABLE", "ready", "failed (invalid-response)");
    manager.markUnavailable("Connection lost");
    await checkStatus("UNAVAILABLE", "unavailable", "unavailable");
    manager.acceptRegistry(manager.beginConnection(), new ClusterContextRegistry([]));
    // A validated exact selection retains unavailable members without fallback.
    await checkStatus("NOT CONFIGURED", "ready", "validated (0 contexts)");
    expect(notify.mock.lastCall?.[0]).toContain(
      'Requested context: "beta"; selection source: user',
    );
    await session.reload();
    await checkStatus("NOT CONFIGURED", "ready", "validated (0 contexts)");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(setWidget).toHaveBeenLastCalledWith("pi-sre-scope", undefined);
    const calls = setWidget.mock.calls.length;
    manager.beginConnection();
    expect(setWidget).toHaveBeenCalledTimes(calls);
  });

  afterEach(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session?.dispose();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it("opens status inspection during direct work and reports UI failures without exposing their contents", async () => {
    const state = manager.state;
    const messages = [...session.messages];
    const release = manager.beginAgentWork();
    try {
      await session.prompt("/clusters --status");
      expect(select).toHaveBeenLastCalledWith(
        expect.stringContaining("2 names"),
        [
          '1. "alpha" — permitted, available; health not checked',
          '2. "beta" — outside exact selection',
          "Close status",
        ],
        undefined,
      );
      select.mockRejectedValueOnce(new Error("PRIVATE_UI_FAILURE"));
      await session.prompt("/clusters --status");
      expect(notify.mock.lastCall?.[0]).toContain("status dialog unavailable");
      expect(notify.mock.calls.flat().join(" ")).not.toContain("PRIVATE_UI_FAILURE");
    } finally {
      release();
    }
    expect(manager.state).toBe(state);
    expect(session.messages).toEqual(messages);
  });

  it("deduplicates unchanged state and reloads, and disposes the subscription", async () => {
    expect(session.messages).toHaveLength(1);
    const initial = [...session.messages];
    const prompt = session.systemPrompt;
    await session.reload();
    expect(session.messages).toEqual(initial);
    manager.select("alpha");
    expect(session.messages).toEqual(initial);
    manager.select("beta");
    expect(session.messages).toHaveLength(2);
    expect(session.messages.slice(0, initial.length)).toEqual(initial);
    expect(session.messages.at(-1)).toMatchObject({
      role: "custom",
      content: expect.stringContaining('Cluster: "beta"; selection source: user'),
    });
    expect(session.systemPrompt).toBe(prompt);
    expect(prompt).toContain("owned and enforced by the application and tool bridge");
    expect(prompt).not.toContain('Cluster: "alpha"');
    manager.markUnavailable("Connection lost");
    const disconnected = [...session.messages];
    manager.markUnavailable("Connection lost");
    expect(session.messages).toEqual(disconnected);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    manager.beginConnection();
    expect(session.messages).toEqual(disconnected);
  });

  it("restores a snapshot removed by compaction only once through the turn-start hook", async () => {
    session.sessionManager.appendCompaction("Prior investigation summary", null, 100);
    expect(session.sessionManager.buildSessionProjection().messages).not.toContainEqual(
      expect.objectContaining({ customType: "pi-sre-cluster-scope" }),
    );
    const result = await session.extensionRunner.emitBeforeAgentStart("Continue", undefined, {
      cwd: home,
    });
    expect(result.messages).toEqual([
      {
        customType: "pi-sre-cluster-scope",
        content: expect.stringContaining('Cluster: "alpha"'),
        display: false,
      },
    ]);
    // Pi's prompt path persists these returned messages before running the agent.
    for (const message of result.messages) {
      session.sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
    }
    const next = await session.extensionRunner.emitBeforeAgentStart("Continue again", undefined, {
      cwd: home,
    });
    expect(next.messages).toEqual([]);
    expect(await session.extensionRunner.emitContext([])).toEqual([]);
  });

  it("appends a connection-loss update during active work without rewriting the request prefix", async () => {
    const requests: { role: string; content: unknown }[][] = [];
    session.agent.streamFunction = (model, context) => {
      const request = context.messages.map((message) => ({
        role: message.role,
        content: structuredClone(message.content),
      }));
      const previous = requests.at(-1);
      if (previous) {
        expect(request.slice(0, previous.length)).toEqual(previous);
        expect(JSON.stringify(request)).toContain("Cluster scope unavailable (unavailable)");
      } else {
        manager.markUnavailable("Connection lost during work");
      }
      requests.push(request);
      type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
      type Message = Awaited<ReturnType<Stream["result"]>>;
      const message: Message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "Access requires a successful tool result." }],
        stopReason: "stop",
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
    await session.prompt("Inspect current scope");
    expect(requests).toHaveLength(2);
    const scopeMessages = session.messages.filter((message) => message.role === "custom");
    expect(scopeMessages).toHaveLength(2);
    expect(scopeMessages[0]).toMatchObject({
      customType: "pi-sre-cluster-scope",
      content: expect.stringContaining('Cluster: "alpha"'),
      display: false,
    });
    expect(scopeMessages[1]).toMatchObject({
      customType: "pi-sre-cluster-scope",
      content: expect.stringContaining(
        "Cluster scope unavailable (unavailable). Cluster-dependent calls are blocked. Connection lost during work",
      ),
      display: false,
    });
    expect(manager.state.resolution.status).toBe("blocked");
    expect(manager.isAgentActive).toBe(false);
  });
});
