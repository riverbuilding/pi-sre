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
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigationController } from "../../src/app/investigation-controller.js";
import { ClusterContextManager } from "../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../src/cluster/context-registry.js";
import { InvestigationService } from "../../src/investigation/investigation-service.js";
import { registerInvestigationLifecycle } from "../../src/runtime/investigation-lifecycle.js";
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { SreRuntime } from "../../src/runtime/sre-runtime.js";
import { diagnosticTools } from "../fixtures/diagnostic-tools.js";

function provider(session: AgentSession, wait?: () => Promise<void>): void {
  vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
  session.agent.streamFunction = (model) => {
    type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
    type Message = Awaited<ReturnType<Stream["result"]>>;
    const message: Message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "Fixture discussion" }],
      stopReason: "stop",
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
    // Implements the agent loop's public iterator/result boundary; the installed class has private members.
    return {
      async *[Symbol.asyncIterator]() {
        await wait?.();
        yield { type: "done", reason: "stop", message };
      },
      async result() {
        return message;
      },
    } as unknown as Stream;
  };
}

describe("Slice 4 controller with real Pi lifecycle (inactive in production)", () => {
  let home: string;
  let manager: ClusterContextManager;
  let controller: InvestigationController;
  let runtime: SreRuntime;
  let veto = false;
  const current = () => controller.currentScope();
  const id = () => {
    const value = current();
    return value.ok ? value.scope.incidentId : undefined;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sre-phase4-controller-"));
    manager = new ClusterContextManager();
    controller = new InvestigationController(
      manager,
      new InvestigationService({
        maxToolCalls: 10,
        maxExcerptChars: 1000,
        defaultTimeRange: "30m",
      }),
    );
    const generation = manager.beginConnection();
    controller.installTools(generation, diagnosticTools);
    manager.acceptRegistry(
      generation,
      new ClusterContextRegistry([
        { name: "alpha", server: "https://example.invalid", isDefault: true },
      ]),
    );
    veto = false;
    const factory: CreateAgentSessionRuntimeFactory = async (options) => {
      const services = await createAgentSessionServices({
        cwd: home,
        agentDir: home,
        resourceLoaderOptions: {
          ...createSreResourceLoaderOptions(),
          extensionFactories: [
            {
              name: "investigation",
              factory: (pi) => {
                pi.registerCommand("local", { description: "Fixture", handler: async () => {} });
                pi.on("input", (event) =>
                  event.text === "handled" ? { action: "handled" } : undefined,
                );
                pi.on("session_before_switch", () => (veto ? { cancel: true } : undefined));
                registerInvestigationLifecycle(pi, controller);
              },
            },
          ],
        },
      });
      const model = new ModelRegistry(services.modelRuntime).getAll()[0];
      if (!model) throw new Error("Missing installed model descriptor");
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
    provider(runtime.session);
  });
  afterEach(async () => {
    await runtime?.session.abort();
    await runtime?.disposeSession();
    controller?.dispose();
    manager?.dispose();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it("creates once after preflight, excluding commands, handled, custom and extension input", async () => {
    const session = runtime.session;
    await session.prompt("/local");
    await session.prompt("handled");
    await session.sendCustomMessage({
      customType: "scope",
      content: "Application state",
      display: false,
    });
    await session.prompt("Application", { source: "extension" });
    expect(id()).toBeUndefined();
    await session.prompt("Why unavailable?", { source: "rpc" });
    const first = id();
    expect(first).toBeDefined();
    await session.prompt("More detail");
    expect(id()).toBe(first);
    expect(current()).toMatchObject({
      ok: true,
      scope: { sessionId: session.sessionId, rule: { kind: "all" } },
    });
  });

  it("does not create through failed credentials, recovery or queued delivery", async () => {
    const session = runtime.session;
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
    vi.spyOn(session.modelRuntime, "checkAuth").mockResolvedValue(undefined);
    await expect(session.prompt("No credential preflight")).rejects.toThrow();
    expect(id()).toBeUndefined();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    provider(session, async () => {
      entered.resolve();
      await release.promise;
    });
    const run = session.prompt("Application", { source: "extension" });
    await entered.promise;
    try {
      await session.steer("Queued user question");
    } finally {
      release.resolve();
      await run;
    }
    expect(id()).toBeUndefined();
    manager.markUnavailable("Fixture unavailable");
    provider(session);
    await session.prompt("No scope");
    expect(id()).toBeUndefined();
    const generation = manager.beginConnection();
    controller.installTools(generation, diagnosticTools);
    manager.acceptRegistry(
      generation,
      new ClusterContextRegistry([
        { name: "alpha", server: "https://example.invalid", isDefault: false },
      ]),
    );
    expect(id()).toBeUndefined();
    await session.prompt("New idle question");
    expect(id()).toBeDefined();
  });

  it("preserves reload/navigation/resume, isolates fork/new, and keeps binding on veto", async () => {
    await runtime.session.prompt("Original");
    const first = id();
    const originalFile = runtime.session.sessionFile;
    const originalSession = runtime.session.sessionId;
    const entry = runtime.session.sessionManager
      .getEntries()
      .find((item) => item.type === "message");
    if (!originalFile || !entry) throw new Error("Missing session history");
    await runtime.session.navigateTree(entry.id);
    expect(id()).toBe(first);
    const before = current();
    await runtime.session.reload();
    expect(id()).toBe(first);
    expect(current()).not.toEqual(before);
    const reloaded = current();
    veto = true;
    expect(await runtime.newSession()).toEqual({ cancelled: true });
    expect(current()).toEqual(reloaded);
    veto = false;
    await runtime.fork(entry.id, { position: "at" });
    expect(id()).toBeUndefined();
    provider(runtime.session);
    await runtime.session.prompt("Fork");
    expect(id()).not.toBe(first);
    await runtime.newSession();
    expect(id()).toBeUndefined();
    await runtime.switchSession(originalFile);
    expect(runtime.session.sessionId).toBe(originalSession);
    expect(id()).toBe(first);
  });
});
