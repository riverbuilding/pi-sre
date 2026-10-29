import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvestigationController } from "../../src/app/investigation-controller.js";
import { ClusterContextManager } from "../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../src/cluster/context-registry.js";
import { InvestigationService } from "../../src/investigation/investigation-service.js";
import { registerInvestigationLifecycle } from "../../src/runtime/investigation-lifecycle.js";
import { registerInvestigationTools } from "../../src/runtime/investigation-tools.js";
import { createInvestigationScopeDescription } from "../../src/runtime/investigation-guidance.js";
import { createSreResourceLoaderOptions } from "../../src/runtime/resource-loader.js";
import { registerClusterScope } from "../../src/tui/cluster-extension.js";
import { diagnosticTools } from "../fixtures/diagnostic-tools.js";

describe("Slice 6 public investigation surface through real Pi", () => {
  let home: string;
  let session: AgentSession;
  let manager: ClusterContextManager;
  let controller: InvestigationController;
  const notify = vi.fn();
  const hypothesis = {
    statement: "Pod cannot start",
    status: "candidate",
    supportingEvidence: [],
    contradictingEvidence: [],
    rationale: "Investigate",
  };
  const current = () => {
    const state = controller.currentInvestigation();
    if (!state) throw new Error("Missing fixture investigation");
    return state;
  };
  async function run(
    name: string,
    args: Record<string, string | number | string[]>,
    afterProposal?: () => void,
    finalStop: "stop" | "aborted" = "stop",
  ) {
    let called = false;
    session.agent.streamFunction = (model) => {
      const first = !called;
      called = true;
      if (!first && afterProposal) {
        const callback = afterProposal;
        afterProposal = undefined;
        callback();
      }
      type Stream = Awaited<ReturnType<typeof session.agent.streamFunction>>;
      type Message = Awaited<ReturnType<Stream["result"]>>;
      const message: Message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: first
          ? [{ type: "toolCall", id: `call-${Date.now()}`, name, arguments: args }]
          : [{ type: "text", text: "Done" }],
        stopReason: first ? "toolUse" : finalStop,
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
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: message.stopReason, message };
        },
        async result() {
          return message;
        },
      } as unknown as Stream;
    };
    await session.prompt("Continue investigation", { source: "extension" });
    const message = session.messages.findLast((item) => item.role === "toolResult");
    if (!message || message.role !== "toolResult") throw new Error("Missing tool result");
    return message;
  }
  beforeEach(async () => {
    notify.mockClear();
    home = await mkdtemp(join(tmpdir(), "pi-sre-local-tools-"));
    manager = new ClusterContextManager();
    controller = new InvestigationController(
      manager,
      new InvestigationService({
        maxToolCalls: 10,
        maxExcerptChars: 64_000,
        defaultTimeRange: "30m",
      }),
    );
    const generation = manager.beginConnection();
    controller.installTools(generation, diagnosticTools);
    manager.acceptRegistry(
      generation,
      new ClusterContextRegistry([{ name: "alpha", server: "https://invalid", isDefault: false }]),
    );
    const services = await createAgentSessionServices({
      cwd: home,
      agentDir: home,
      resourceLoaderOptions: {
        ...createSreResourceLoaderOptions(),
        extensionFactories: [
          {
            name: "investigation",
            factory: (pi) => {
              registerInvestigationLifecycle(pi, controller);
              registerClusterScope(pi, manager, undefined, controller);
              registerInvestigationTools(pi, controller);
            },
          },
        ],
      },
    });
    const model = new ModelRegistry(services.modelRuntime).getAll()[0];
    if (!model) throw new Error("Missing installed model descriptor");
    ({ session } = await createAgentSessionFromServices({
      services,
      model,
      sessionManager: SessionManager.inMemory(home),
      noTools: "builtin",
    }));
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("/incident new Why unavailable?");
  });
  afterEach(async () => {
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await session?.dispose();
    controller?.dispose();
    manager?.dispose();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });
  it("validates model arguments and revisions and never borrows references", async () => {
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining([
        "investigation_get",
        "evidence_list",
        "evidence_get",
        "hypothesis_upsert",
        "investigation_conclude",
      ]),
    );
    expect(await run("evidence_list", { size: 0 })).toMatchObject({ isError: true });
    expect(await run("evidence_get", { id: "foreign" })).toMatchObject({ isError: true });
    expect(await run("investigation_get", { incidentId: "foreign" })).toMatchObject({
      isError: true,
    });
    expect(
      await run("hypothesis_upsert", {
        ...hypothesis,
        supportingEvidence: ["foreign"],
        status: "supported",
      }),
    ).toMatchObject({ isError: true });
    expect(current().hypotheses).toHaveLength(0);
    expect(await run("hypothesis_upsert", hypothesis)).toMatchObject({ isError: false });
    const item = current().hypotheses[0];
    if (!item) throw new Error("Missing hypothesis");
    expect(
      await run("hypothesis_upsert", { ...hypothesis, id: item.id, expectedRevision: 9 }),
    ).toMatchObject({ isError: true });
    expect(await run("hypothesis_upsert", { ...hypothesis, id: item.id })).toMatchObject({
      isError: true,
    });
    expect(
      await run("hypothesis_upsert", { ...hypothesis, id: item.id, expectedRevision: 1 }),
    ).toMatchObject({ isError: false });
    expect(await run("investigation_get", { hypothesisId: item.id })).toMatchObject({
      isError: false,
      content: [{ text: expect.stringContaining('"revision":2') }],
    });
    expect(current().dispatchedAttempts).toBe(0);
  });
  it("captures evidence references, refuses unsupported resolution, and commits a valid proposal only after idle", async () => {
    const scope = controller.currentScope();
    if (!scope.ok) throw new Error("Missing scope");
    const admission = await controller.admitExecution(scope.scope, {
      context: "alpha",
      operation: "pods_get",
    });
    if (!admission.ok) throw new Error("Missing admission");
    controller.dispatchExecution(admission.lease);
    const evidence = controller.recordObservation(admission.lease, {
      excerpt: "CrashLoopBackOff",
      truncated: false,
      completedAt: new Date().toISOString(),
    });
    controller.release(admission.lease);
    expect(await run("evidence_get", { id: evidence.id })).toMatchObject({
      isError: false,
      content: [{ text: expect.stringContaining("CrashLoopBackOff") }],
    });
    expect(
      await run("investigation_conclude", {
        expectedRevision: current().revision,
        status: "resolved",
        explanation: "Explained",
        hypothesisIds: [],
        evidenceIds: [evidence.id],
      }),
    ).toMatchObject({ isError: true });
    await run("hypothesis_upsert", {
      ...hypothesis,
      status: "supported",
      supportingEvidence: [evidence.id],
    });
    const result = await run("investigation_conclude", {
      expectedRevision: current().revision,
      status: "resolved",
      explanation: "Explained, not repaired",
      hypothesisIds: current().hypotheses.map((item) => item.id),
      evidenceIds: [evidence.id],
    });
    expect(result).toMatchObject({
      isError: false,
      content: [{ text: expect.stringContaining('"pending"') }],
    });
    expect(current().incident.status).toBe("resolved");
    expect(manager.isAgentActive).toBe(false);
    expect(controller.currentScope().ok).toBe(false);
    expect(await run("investigation_get", {})).toMatchObject({ isError: false });
    expect(current().incident.status).toBe("resolved");
    await session.prompt("/evidence");
    expect(notify.mock.lastCall?.[0]).toContain(evidence.id);
  });
  it("inspects during MCP loss and active work, acknowledges repeats, and guards replacement", async () => {
    const before = current();
    manager.markUnavailable("Fixture outage");
    const release = manager.beginAgentWork();
    try {
      await session.prompt("/incident");
      const first = notify.mock.lastCall?.[0];
      await session.prompt("/incident");
      expect(notify.mock.lastCall?.[0]).not.toEqual(first);
      await session.prompt("/evidence");
      expect(notify.mock.lastCall?.[0]).toContain('"items":[]');
      await session.prompt("/incident new Replacement");
      expect(notify.mock.lastCall?.[0]).toContain("Wait for active work");
    } finally {
      release();
    }
    expect(current()).toEqual(before);
    expect(await run("investigation_get", {})).toMatchObject({ isError: false });
    expect(await run("evidence_list", {})).toMatchObject({ isError: false });
    expect(current().dispatchedAttempts).toBe(0);
  });
  it("deduplicates snapshots and restores state after reload and compaction", async () => {
    const before = current();
    const messages = [...session.messages];
    await session.prompt("/incident");
    await session.prompt("/evidence");
    expect(session.messages).toEqual(messages);
    await session.reload();
    expect(current()).toEqual(before);
    expect(session.messages).toEqual(messages);
    session.sessionManager.appendCompaction("Transcript cannot replace domain state", null, 100);
    const restored = await session.extensionRunner.emitBeforeAgentStart("Continue", undefined, {
      cwd: home,
    });
    expect(restored.messages).toContainEqual(
      expect.objectContaining({
        customType: "pi-sre-cluster-scope",
        content: createInvestigationScopeDescription(controller),
      }),
    );
    expect(createInvestigationScopeDescription(controller).length).toBeLessThanOrEqual(8000);
  });
  it("refuses changed and aborted conclusion proposals without resetting investigation state", async () => {
    const proposal = () => ({
      expectedRevision: current().revision,
      status: "inconclusive",
      explanation: "Insufficient observations",
      hypothesisIds: [],
      evidenceIds: [],
    });
    const owner = controller.bindingFor(session.sessionId);
    expect(
      await run("investigation_conclude", proposal(), () => {
        controller.upsertHypothesis(owner, { ...hypothesis, status: "candidate" });
      }),
    ).toMatchObject({ isError: false });
    expect(current().incident.status).toBe("investigating");
    expect(notify.mock.calls.flat().join(" ")).toContain("Revision has changed");
    expect(await run("investigation_conclude", proposal(), undefined, "aborted")).toMatchObject({
      isError: false,
    });
    expect(current().incident.status).toBe("investigating");
    expect(notify.mock.calls.flat().join(" ")).toContain("agent work was interrupted");
    expect(current().dispatchedAttempts).toBe(0);
  });

  it("rejects prior-incident evidence and cursors after explicit replacement", async () => {
    const previous = current().incident.id;
    const scope = controller.currentScope();
    if (!scope.ok) throw new Error("Missing scope");
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const admission = await controller.admitExecution(scope.scope, {
        context: "alpha",
        operation: "pods_get",
      });
      if (!admission.ok) throw new Error("Missing admission");
      controller.dispatchExecution(admission.lease);
      ids.push(
        controller.recordObservation(admission.lease, {
          excerpt: "observed",
          truncated: false,
          completedAt: new Date().toISOString(),
        }).id,
      );
      controller.release(admission.lease);
    }
    const cursor = controller.evidenceList(controller.bindingFor(session.sessionId), {
      size: 1,
    }).cursor;
    if (!cursor) throw new Error("Missing cursor");
    await session.prompt("/incident new A different question");
    expect(current().incident.id).not.toBe(previous);
    expect(await run("evidence_list", { cursor })).toMatchObject({ isError: true });
    expect(await run("evidence_get", { id: ids[0]! })).toMatchObject({ isError: true });
    expect(
      await run("hypothesis_upsert", {
        ...hypothesis,
        status: "supported",
        supportingEvidence: ids,
      }),
    ).toMatchObject({ isError: true });
    expect(current().evidence).toHaveLength(0);
  });

  it("bounds large evidence inspection and summary without changing retained observations", async () => {
    const scope = controller.currentScope();
    if (!scope.ok) throw new Error("Missing scope");
    const admission = await controller.admitExecution(scope.scope, {
      context: "alpha",
      operation: "pods_get",
    });
    if (!admission.ok) throw new Error("Missing admission");
    controller.dispatchExecution(admission.lease);
    const evidence = controller.recordObservation(admission.lease, {
      excerpt: "\t".repeat(64_000),
      truncated: false,
      completedAt: new Date().toISOString(),
    });
    controller.release(admission.lease);
    const result = await run("evidence_get", { id: evidence.id });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result).length).toBeLessThan(64 * 1024);
    expect(result.content).toMatchObject([{ text: expect.stringContaining('"truncated":true') }]);
    expect(current().evidence[0]).toEqual(evidence);
    expect(createInvestigationScopeDescription(controller).length).toBeLessThanOrEqual(8000);
  });
  it("omits whole long identities with accurate reference counts inside the summary budget", async () => {
    const contexts = Array.from({ length: 45 }, (_, index) => `${index}-${"x".repeat(900)}`);
    const generation = manager.beginConnection();
    controller.installTools(generation, diagnosticTools);
    manager.acceptRegistry(
      generation,
      new ClusterContextRegistry(
        contexts.map((name) => ({ name, server: "https://invalid", isDefault: false })),
      ),
    );
    const scope = controller.currentScope();
    if (!scope.ok) throw new Error("Missing scope");
    for (const context of contexts.slice(0, 8)) {
      const admission = await controller.admitExecution(scope.scope, {
        context,
        operation: "pods_get",
      });
      if (!admission.ok) throw new Error("Missing admission");
      controller.dispatchExecution(admission.lease);
      controller.recordObservation(admission.lease, {
        excerpt: "observed",
        truncated: false,
        completedAt: new Date().toISOString(),
      });
      controller.release(admission.lease);
    }
    const summary = createInvestigationScopeDescription(controller);
    expect(summary.length).toBeLessThanOrEqual(8000);
    expect(summary).toContain("READ ONLY");
    expect(summary).toContain("Not checked: 37");
    const shown = summary
      .split("\n")
      .filter((line) => line.startsWith("Evidence ") && !line.startsWith("Evidence references"));
    expect(shown.length).toBeLessThan(8);
    expect(summary).toContain(`Evidence references omitted: ${8 - shown.length}.`);
    for (const line of shown)
      expect(contexts.some((context) => line.includes(JSON.stringify(context)))).toBe(true);
  });
});
