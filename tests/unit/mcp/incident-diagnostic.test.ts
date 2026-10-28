import { describe, expect, it, onTestFinished, vi } from "vitest";
import { InvestigationController } from "../../../src/app/investigation-controller.js";
import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { DEFAULT_RESULT_POLICY } from "../../../src/config/schema.js";
import { InvestigationService } from "../../../src/investigation/investigation-service.js";
import { createMcpToolBridge } from "../../../src/mcp/tool-bridge.js";
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";

function setup(
  options: {
    maxToolCalls?: number;
    maxEvidence?: number;
    maxBytes?: number;
    maxTextChars?: number;
  } = {},
) {
  const policy = { ...DEFAULT_RESULT_POLICY, maxTextChars: options.maxTextChars ?? 1800 };
  const manager = new ClusterContextManager();
  const service = new InvestigationService({
    maxToolCalls: options.maxToolCalls ?? 20,
    maxExcerptChars: policy.maxTextChars,
    defaultTimeRange: "30m",
    ...(options.maxEvidence ? { maxEvidence: options.maxEvidence } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
  const controller = new InvestigationController(manager, service);
  const generation = manager.beginConnection();
  controller.installTools(generation, diagnosticTools);
  manager.acceptRegistry(
    generation,
    new ClusterContextRegistry(
      ["alpha", "beta"].map((name) => ({
        name,
        server: "https://example.invalid",
        isDefault: false,
      })),
    ),
  );
  const binding = controller.bind("session");
  controller.start(binding, "Why unavailable?");
  const callTool = vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({ content: [{ type: "text", text: "Observed" }] });
  const descriptor = diagnosticTools.find((tool) => tool.name === "pods_get");
  if (!descriptor) throw new Error("Missing fixture");
  const tool = createMcpToolBridge(descriptor, { callTool }, policy, {
    manager,
    investigation: controller,
    connectionGeneration: generation,
  });
  const invoke = (context = "alpha", signal?: AbortSignal) =>
    tool.execute(
      "request",
      { context, name: "api", namespace: "payments" },
      signal,
      undefined,
      {} as never,
    );
  const state = () => controller.inspect(binding)!;
  onTestFinished(() => {
    controller.dispose();
    manager.dispose();
  });
  return { tool, invoke, state, controller, manager, binding, callTool, policy, service };
}

describe("incident MCP observation capture", () => {
  it.each([
    { content: [{ type: "text", text: "token=PRIVATE_FIXTURE\nObserved" }], extra: "accepted" },
    { content: [] },
    { content: [], structuredContent: { items: [], additional: "accepted" } },
    { content: [{ type: "text", text: '𐀀\\"'.repeat(4000) }] },
  ])("commits exactly the returned safe excerpt and provenance before resolving", async (raw) => {
    const { invoke, state, callTool, policy } = setup();
    callTool.mockResolvedValue(raw);
    const result = await invoke();
    expect(result.isError).toBe(false);
    const evidence = state().evidence[0]!;
    expect(state().evidence).toHaveLength(1);
    expect(result.details).toMatchObject({
      evidenceId: evidence.id,
      executionId: evidence.executionId,
      incidentId: evidence.incidentId,
      completedAt: evidence.completedAt,
      truncated: evidence.truncated,
      scope: {
        context: evidence.context,
        namespace: evidence.namespace,
        scopeRevision: evidence.scopeRevision,
        inventoryRevision: evidence.inventoryRevision,
        connectionGeneration: evidence.connectionGeneration,
      },
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(new RegExp(`READ ONLY\\n`)),
    });
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Expected text");
    expect(block.text.split("READ ONLY\n")[1]).toBe(evidence.excerpt);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(policy.maxTextChars);
    expect(state().outcomes[0]?.status).toBe(evidence.truncated ? "partial" : "successful");
    expect(state().dispatchedAttempts).toBe(1);
  });

  it.each([
    [{ content: [null] }, "invalid-result", "could not be presented"],
    [
      { content: [{ type: "text", text: "401 PRIVATE_FIXTURE" }], isError: true },
      "authentication-failed",
      "authentication",
    ],
    [
      { content: [{ type: "text", text: "403 PRIVATE_FIXTURE" }], isError: true },
      "authorization-failed",
      "authorization",
    ],
    [{ content: [], isError: true }, "tool-execution-failed", "tool failed"],
  ])("records a safe failure without evidence for %j", async (raw, category, explanation) => {
    const { invoke, state, callTool } = setup();
    callTool.mockResolvedValue(raw);
    const result = await invoke();
    expect(result).toMatchObject({ isError: true, details: { failureCategory: category } });
    expect(result.details).not.toHaveProperty("evidenceId");
    expect(state().evidence).toEqual([]);
    expect(state().outcomes[0]).toMatchObject({
      status: "failed",
      explanation: expect.stringContaining(explanation),
    });
    expect(JSON.stringify(state())).not.toContain("PRIVATE_FIXTURE");
  });

  it.each([
    ["401 PRIVATE_FIXTURE", "authentication-failed"],
    ["403 PRIVATE_FIXTURE", "authorization-failed"],
    ["timeout PRIVATE_FIXTURE", "timeout"],
    ["transport closed PRIVATE_FIXTURE", "transport-unavailable"],
    ["PRIVATE_FIXTURE", "tool-execution-failed"],
  ])("classifies transport rejection %s privately", async (message, category) => {
    const { invoke, state, callTool } = setup();
    callTool.mockRejectedValue(new Error(message));
    expect(await invoke()).toMatchObject({ isError: true, details: { failureCategory: category } });
    expect(state().evidence).toEqual([]);
    expect(state().dispatchedAttempts).toBe(1);
    expect(JSON.stringify(state())).not.toContain("PRIVATE_FIXTURE");
  });

  it.each(["cancel", "restart", "session", "shutdown"])(
    "withholds late success on %s and settles pending work",
    async (change) => {
      const { invoke, callTool, state, controller, manager, service } = setup();
      const response = Promise.withResolvers<unknown>();
      callTool.mockReturnValue(response.promise);
      const cancel = new AbortController();
      const pending = invoke("alpha", cancel.signal);
      await vi.waitFor(() => expect(callTool).toHaveBeenCalledOnce());
      const incident = state().incident.id;
      if (change === "cancel") cancel.abort();
      else if (change === "restart") manager.beginConnection();
      else if (change === "session") controller.bind("other");
      else controller.dispose();
      response.resolve({ content: [{ type: "text", text: "LATE_PAYLOAD" }] });
      if (change === "cancel") await expect(pending).rejects.toThrow();
      else
        expect(await pending).toMatchObject({
          isError: true,
          details: { failureCategory: "stale-scope" },
        });
      // Read by explicit incident identity even when the outgoing binding is invalid.
      expect(service.inspect(incident).evidence).toEqual([]);
      expect(service.inspect(incident).outcomes[0]?.status).toBe("interrupted");
      expect(manager.isAgentActive).toBe(false);
    },
  );

  it("keeps out-of-order observations distinct and next selection cannot retarget an incident", async () => {
    const { invoke, callTool, state, manager, controller } = setup();
    const response = Promise.withResolvers<unknown>();
    callTool.mockReturnValueOnce(response.promise);
    const pending = invoke("alpha");
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledOnce());
    await invoke("beta");
    response.resolve({ content: [{ type: "text", text: "alpha" }] });
    await pending;
    expect(state().evidence.map((item) => item.context)).toEqual(["beta", "alpha"]);
    expect(new Set(state().evidence.map((item) => item.id)).size).toBe(2);
    manager.select("beta");
    expect(controller.clusterState().selection.rule).toEqual({ kind: "all" });
    expect((await invoke("alpha")).isError).toBe(false);
  });

  it.each([{ maxEvidence: 1 }, { maxBytes: 1 }])(
    "refuses actual completion storage atomically: %j",
    async (options) => {
      const { invoke, state, callTool, manager } = setup(options);
      if (options.maxEvidence) expect((await invoke()).isError).toBe(false);
      const before = state();
      expect(await invoke()).toMatchObject({
        isError: true,
        details: { failureCategory: "storage-refused" },
      });
      expect(state().evidence).toEqual(before.evidence);
      expect(state().dispatchedAttempts).toBe(before.dispatchedAttempts + 1);
      expect(state().outcomes.at(-1)?.status).toBe("failed");
      expect(callTool).toHaveBeenCalledTimes(state().dispatchedAttempts);
      expect(manager.isAgentActive).toBe(false);
    },
  );

  it("refuses budget, malformed identity and oversized envelopes before transport", async () => {
    const { invoke, state, callTool } = setup({ maxToolCalls: 1 });
    await invoke();
    expect(await invoke()).toMatchObject({ details: { failureCategory: "budget-refused" } });
    expect(state().dispatchedAttempts).toBe(1);
    expect(callTool).toHaveBeenCalledOnce();
    const small = setup({ maxTextChars: 256 });
    const refused = await small.invoke();
    expect(JSON.stringify(refused).length).toBeLessThanOrEqual(256);
    expect(refused).toMatchObject({
      details: { failureCategory: "presentation-refused" },
    });
    expect(small.state().dispatchedAttempts).toBe(0);
    expect(small.callTool).not.toHaveBeenCalled();
    const fresh = setup();
    expect(
      await fresh.tool.execute(
        "bad",
        { context: "alpha", name: "api", namespace: "bad\u001b" },
        undefined,
        undefined,
        {} as never,
      ),
    ).toMatchObject({ isError: true });
    expect(fresh.callTool).not.toHaveBeenCalled();
  });

  it("checks cancellation after normalization and before synchronous commit", async () => {
    const { invoke, callTool, state } = setup();
    const cancellation = new AbortController();
    callTool.mockResolvedValue({
      get content() {
        cancellation.abort();
        return [{ type: "text", text: "Observed too late" }];
      },
    });
    await expect(invoke("alpha", cancellation.signal)).rejects.toThrow();
    expect(state().evidence).toEqual([]);
    expect(state().outcomes[0]?.status).toBe("interrupted");
  });

  it("serializes concurrent completion capacity checks without preallocating storage", async () => {
    const { invoke, callTool, state } = setup({ maxEvidence: 1 });
    const response = Promise.withResolvers<unknown>();
    callTool.mockReturnValue(response.promise);
    const pending = [invoke("alpha"), invoke("beta")];
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    response.resolve({ content: [] });
    expect((await Promise.all(pending)).map((result) => result.isError)).toEqual([false, true]);
    expect(state().dispatchedAttempts).toBe(2);
    expect(state().evidence).toHaveLength(1);
    expect(state().outcomes.map((outcome) => outcome.status)).toEqual(["successful", "failed"]);
  });

  it("cannot create an incident from a captured diagnostic handler", async () => {
    const { controller, binding, invoke, state, callTool } = setup();
    controller.conclude(binding, state().revision, "inconclusive", {
      explanation: "Unknown",
      evidenceIds: [],
      hypothesisIds: [],
    });
    expect(await invoke()).toMatchObject({ isError: true });
    expect(callTool).not.toHaveBeenCalled();
  });
});
