import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { SreRuntime } from "../../src/runtime/sre-runtime.js";

/** Test-only creation/binding witness, not an Incident or a production controller. */
class LifecycleProbe {
  readonly events: string[] = [];
  readonly incidents = new Map<string, string>();
  readonly creations: { session: string; question: string }[] = [];
  binding: string | undefined;
  epoch = 0;
  usableScope = true;
  cancelSwitch = false;
  cancelFork = false;
  readonly toolStarted = Promise.withResolvers<void>();

  register(pi: ExtensionAPI): void {
    let candidate: string | undefined;
    pi.on("session_start", (event, ctx) => {
      this.binding = ctx.sessionManager.getSessionId();
      this.events.push(`start:${event.reason}:${this.binding}`);
    });
    pi.on("session_shutdown", (event) => {
      this.events.push(`shutdown:${event.reason}`);
      candidate = undefined;
      this.binding = undefined;
      this.epoch++;
    });
    pi.on("session_before_switch", (event) => {
      this.events.push(`switch:${event.reason}`);
      if (this.cancelSwitch) return { cancel: true };
    });
    pi.on("session_before_fork", () => {
      this.events.push("fork");
      if (this.cancelFork) return { cancel: true };
    });
    pi.on("input", (event) => {
      this.events.push(`input:${event.source}:${event.streamingBehavior ?? "idle"}`);
      candidate =
        event.source !== "extension" && event.streamingBehavior === undefined
          ? event.text
          : undefined;
      if (event.text === "handled input") {
        candidate = undefined;
        return { action: "handled" };
      }
    });
    pi.on("before_agent_start", (_event, ctx) => {
      this.events.push("before-agent");
      const question = candidate;
      candidate = undefined;
      const session = ctx.sessionManager.getSessionId();
      if (question && this.usableScope && !this.incidents.has(session)) {
        this.incidents.set(session, question);
        this.creations.push({ session, question });
      }
    });
    pi.on("agent_start", () => {
      this.events.push("agent-start");
    });
    pi.on("agent_end", () => {
      this.events.push("agent-end");
    });
    pi.on("session_before_compact", (event) => {
      this.events.push(`before-compact:${event.reason}:${event.willRetry}`);
      return {
        compaction: {
          summary: "Synthetic context summary; not operational state.",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    });
    pi.on("session_compact", (event) => {
      this.events.push(`compact:${event.reason}:${event.willRetry}`);
    });
    pi.on("session_tree", () => {
      this.events.push("tree");
    });
    pi.registerCommand("probe", {
      description: "Local lifecycle fixture",
      handler: async () => {
        this.events.push("command");
      },
    });
    pi.registerTool({
      name: "lifecycle_wait",
      label: "Lifecycle wait",
      description: "Local cancellation fixture",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        if (!signal) throw new Error("Expected Pi tool cancellation signal");
        signal.throwIfAborted();
        this.toolStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              this.events.push("tool-aborted");
              reject(new Error("Fixture operation aborted"));
            },
            { once: true },
          );
        });
        return { content: [{ type: "text", text: "Unreachable success" }], details: {} };
      },
    });
  }
}

/** Only provider I/O is simulated; Pi's loop, queues and lifecycle stay real. */
function simulateProvider(
  session: AgentSession,
  beforeResponse?: (request: number) => Promise<void>,
  overflowAt?: number,
  callTool = false,
): void {
  let requests = 0;
  vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
  session.settingsManager.setRetryEnabled(false);
  session.agent.streamFunction = (model) => {
    const request = requests++;
    type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
    type Message = Awaited<ReturnType<Stream["result"]>>;
    const overflow = request === overflowAt;
    const message: Message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content:
        callTool && request === 0
          ? [{ type: "toolCall", id: "wait-1", name: "lifecycle_wait", arguments: {} }]
          : [{ type: "text", text: "Synthetic observation discussion." }],
      stopReason: overflow ? "error" : callTool && request === 0 ? "toolUse" : "stop",
      ...(overflow ? { errorMessage: "prompt is too long: context window exceeded" } : {}),
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    // Pi's provider stream class has private fields. This synthetic implementation
    // supplies the iterator/result boundary consumed by the real agent loop.
    return {
      async *[Symbol.asyncIterator]() {
        await beforeResponse?.(request);
        if (overflow) yield { type: "error", reason: "error", error: message };
        else yield { type: "done", reason: message.stopReason, message };
      },
      async result() {
        return message;
      },
    } as unknown as Stream;
  };
}

describe("Phase 4 Slice 0 installed Pi lifecycle contracts (no production incidents)", () => {
  let home: string;
  let runtime: SreRuntime;
  let probe: LifecycleProbe;
  let factory: CreateAgentSessionRuntimeFactory;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-phase4-contract-"));
    probe = new LifecycleProbe();
    factory = async (options) => {
      const services = await createAgentSessionServices({
        cwd: home,
        agentDir: home,
        resourceLoaderOptions: {
          ...createSreResourceLoaderOptions(),
          extensionFactories: [{ name: "lifecycle-probe", factory: (pi) => probe.register(pi) }],
        },
      });
      const model = new ModelRegistry(services.modelRuntime).getAll()[0];
      if (!model) throw new Error("Expected an installed model descriptor");
      const result = await createAgentSessionFromServices({
        services,
        model,
        sessionManager: options.sessionManager,
        noTools: "builtin",
        ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const result = await factory({
      cwd: home,
      agentDir: home,
      sessionManager: SessionManager.create(home, join(home, "sessions")),
    });
    runtime = new SreRuntime(result, factory);
    runtime.setRebindSession(async (session) => {
      await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
    });
    await runtime.session.bindExtensions({
      uiContext: runtime.session.extensionRunner.getUIContext(),
    });
    simulateProvider(runtime.session);
  });

  afterEach(async () => {
    await runtime?.session.abort();
    await runtime?.disposeSession();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it("creates once for an eligible prompt after preflight, excluding commands, handled and extension input", async () => {
    const session = runtime.session;
    await session.prompt("/probe");
    await session.prompt("handled input");
    await session.sendCustomMessage(
      { customType: "scope", content: "Scope: alpha", display: false },
      { triggerTurn: true },
    );
    await session.prompt("Application instruction", { source: "extension" });
    expect(probe.creations).toEqual([]);
    probe.events.length = 0;
    await session.prompt("Why is api unavailable?", { source: "rpc" });
    expect(probe.events).toEqual(["input:rpc:idle", "before-agent", "agent-start", "agent-end"]);
    await session.prompt("Inspect events too");
    expect(probe.creations).toEqual([
      { session: session.sessionId, question: "Why is api unavailable?" },
    ]);
    expect(probe.binding).toBe(session.sessionId);
  });

  it("does not create on credential refusal or unavailable scope and never creates when access later recovers by itself", async () => {
    const session = runtime.session;
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
    vi.spyOn(session.modelRuntime, "checkAuth").mockResolvedValue(undefined);
    await expect(session.prompt("No credentials")).rejects.toThrow();
    expect(probe.events).not.toContain("before-agent");
    expect(probe.creations).toEqual([]);
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    probe.usableScope = false;
    await session.prompt("No scope");
    probe.usableScope = true;
    await session.sendCustomMessage({ customType: "scope", content: "Recovered", display: false });
    expect(probe.creations).toEqual([]);
    await session.prompt("Inspect after recovery");
    expect(probe.creations.map((item) => item.question)).toEqual(["Inspect after recovery"]);
  });

  it("drains steering, follow-up and application messages without another prompt-creation hook", async () => {
    const session = runtime.session;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    simulateProvider(session, async (request) => {
      if (request === 0) {
        entered.resolve();
        await release.promise;
      }
    });
    const running = session.prompt("Initial question");
    await entered.promise;
    try {
      await session.prompt("Queued steering", { streamingBehavior: "steer" });
      await session.followUp("Queued follow-up", undefined, { source: "rpc" });
      await session.sendCustomMessage(
        { customType: "scope", content: "Scope changed", display: false },
        { deliverAs: "steer" },
      );
      await session.prompt("/probe");
    } finally {
      release.resolve();
      await running;
    }
    expect(probe.events).toContain("input:interactive:steer");
    expect(probe.events).toContain("input:rpc:followUp");
    expect(probe.events.filter((event) => event === "before-agent")).toHaveLength(1);
    expect(probe.creations).toHaveLength(1);
    expect(JSON.stringify(session.messages)).toContain("Queued follow-up");
    expect(JSON.stringify(session.messages)).toContain("Queued steering");
  });

  it("keeps identity and operational state through real overflow compaction/retry, reload and tree navigation", async () => {
    const session = runtime.session;
    await session.prompt("Initial question");
    const id = session.sessionId;
    let requests = 0;
    simulateProvider(
      session,
      async () => {
        requests++;
      },
      0,
    );
    session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
    await session.prompt("Follow-up that overflows");
    expect(probe.events).toContain("before-compact:overflow:true");
    expect(probe.events).toContain("compact:overflow:true");
    expect(requests).toBe(2);
    expect(probe.events.filter((event) => event === "before-agent")).toHaveLength(2);
    const entry = session.sessionManager.getEntries().find((item) => item.type === "message");
    if (!entry) throw new Error("Expected persisted message");
    await session.navigateTree(entry.id);
    expect(probe.events).toContain("tree");
    const epoch = probe.epoch;
    await session.reload();
    expect(probe.epoch).toBe(epoch + 1);
    expect(probe.binding).toBe(id);
    expect(probe.events).toContain(`start:reload:${id}`);
    expect(session.sessionId).toBe(id);
    await session.prompt("Continue after reload");
    expect(probe.creations).toEqual([{ session: id, question: "Initial question" }]);
  });

  it("isolates new/forked identities, restores same-process resume, and does not restore state from transcript in a fresh owner", async () => {
    await runtime.session.prompt("Original question");
    const originalId = runtime.session.sessionId;
    const originalFile = runtime.session.sessionFile;
    const entry = runtime.session.sessionManager
      .getEntries()
      .find((item) => item.type === "message");
    if (!originalFile || !entry) throw new Error("Expected persisted session");
    await runtime.fork(entry.id, { position: "at" });
    const forkId = runtime.session.sessionId;
    expect(forkId).not.toBe(originalId);
    expect(probe.incidents.has(forkId)).toBe(false);
    expect(probe.binding).toBe(forkId);
    expect(probe.events).toContain("shutdown:fork");
    simulateProvider(runtime.session);
    await runtime.session.prompt("Fork question");
    await runtime.newSession();
    expect(probe.incidents.has(runtime.session.sessionId)).toBe(false);
    expect(probe.events).toContain("shutdown:new");
    await runtime.switchSession(originalFile);
    expect(probe.binding).toBe(originalId);
    expect(probe.incidents.get(originalId)).toBe("Original question");
    const creations = probe.creations.length;
    simulateProvider(runtime.session);
    await runtime.session.prompt("Resume follow-up");
    expect(probe.creations).toHaveLength(creations);
    // A new application owner opens identical transcript history with no authority.
    probe = new LifecycleProbe();
    await runtime.switchSession(originalFile);
    expect(probe.binding).toBe(originalId);
    expect(probe.incidents.size).toBe(0);
    expect(JSON.stringify(runtime.session.messages)).toContain("Original question");
    simulateProvider(runtime.session);
    await runtime.session.prompt("New investigation after process restart");
    expect(probe.creations).toEqual([
      { session: originalId, question: "New investigation after process restart" },
    ]);
  });

  it("keeps binding and epoch when switch/fork is vetoed", async () => {
    await runtime.session.prompt("Original question");
    const session = runtime.session;
    const epoch = probe.epoch;
    const entry = session.sessionManager.getEntries().find((item) => item.type === "message");
    if (!entry) throw new Error("Expected message");
    probe.cancelSwitch = true;
    probe.cancelFork = true;
    expect(await runtime.newSession()).toEqual({ cancelled: true });
    expect(await runtime.fork(entry.id)).toEqual({ cancelled: true });
    expect(runtime.session).toBe(session);
    expect(probe.binding).toBe(session.sessionId);
    expect(probe.epoch).toBe(epoch);
  });

  it("does not create an incident from queued user delivery after an extension-origin run", async () => {
    const session = runtime.session;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    simulateProvider(session, async (request) => {
      if (request === 0) {
        entered.resolve();
        await release.promise;
      }
    });
    const running = session.prompt("Application run", { source: "extension" });
    await entered.promise;
    try {
      await session.steer("Queued user input");
    } finally {
      release.resolve();
      await running;
    }
    expect(probe.creations).toEqual([]);
    await session.prompt("Next explicit idle question");
    expect(probe.creations.map((item) => item.question)).toEqual(["Next explicit idle question"]);
  });

  it("aborts and settles an executing Pi tool before session replacement shuts down the binding", async () => {
    const outgoing = runtime.session;
    simulateProvider(outgoing, undefined, undefined, true);
    const running = outgoing.prompt("Question with a pending tool");
    await probe.toolStarted.promise;
    await runtime.newSession();
    await running;
    expect(probe.events).toContain("tool-aborted");
    expect(probe.events.indexOf("tool-aborted")).toBeLessThan(probe.events.indexOf("shutdown:new"));
    expect(probe.events).toContain("agent-end");
    expect(probe.events.indexOf("agent-end")).toBeLessThan(probe.events.indexOf("shutdown:new"));
    expect(runtime.session.sessionId).not.toBe(outgoing.sessionId);
    expect(probe.binding).toBe(runtime.session.sessionId);
    expect(probe.incidents.has(runtime.session.sessionId)).toBe(false);
    expect(JSON.stringify(outgoing.messages)).not.toContain("Unreachable success");
  });
});
