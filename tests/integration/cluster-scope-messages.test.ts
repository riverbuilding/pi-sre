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
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { registerClusterScope } from "../../src/tui/cluster-extension.js";

describe("persistent scope updates", () => {
  let home: string;
  let session: AgentSession;
  let manager: ClusterContextManager;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-scope-messages-"));
    manager = new ClusterContextManager({ cluster: "alpha" });
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
    await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
  });

  afterEach(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session?.dispose();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
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
    expect(manager.captureScope()).toBeUndefined();
    expect(manager.isAgentActive).toBe(false);
  });
});
