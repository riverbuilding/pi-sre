import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { InvestigationController } from "../../../src/app/investigation-controller.js";
import type {
  EffectiveInvestigationScope,
  IncidentExecutionLease,
  IncidentAdmission,
} from "../../../src/app/investigation-controller.js";
import { ClusterContextManager } from "../../../src/cluster/context-manager.js";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { createExactClusterRule } from "../../../src/cluster/context-resolver.js";
import type { ClusterScopeRule } from "../../../src/cluster/context-resolver.js";
import { InvestigationService } from "../../../src/investigation/investigation-service.js";
import { createInvestigationScopeDescription } from "../../../src/runtime/investigation-guidance.js";
import { validateMcpToolExecution } from "../../../src/runtime/tool-execution-policy.js";
import { diagnosticTools } from "../../fixtures/diagnostic-tools.js";

const now = "2026-10-23T12:00:00.000Z";
const registry = (names: readonly string[], defaultName = "beta") =>
  new ClusterContextRegistry(
    names.map((name) => ({
      name,
      server: "https://example.invalid",
      isDefault: name === defaultName,
    })),
  );
const conclusion = { explanation: "Cause remains uncertain", evidenceIds: [], hypothesisIds: [] };

function setup(rule?: ClusterScopeRule, maxToolCalls = 10) {
  let id = 0;
  const manager = new ClusterContextManager(rule ? { rule } : {});
  const service = new InvestigationService({
    maxToolCalls,
    maxExcerptChars: 1000,
    defaultTimeRange: "30m",
    clock: () => new Date(now),
    createId: (kind) => `${kind}-${++id}`,
  });
  const controller = new InvestigationController(manager, service);
  const reconnect = (names: readonly string[], tools = diagnosticTools, defaultName = "beta") => {
    const release = manager.blockDispatch();
    const generation = manager.beginConnection();
    controller.installTools(generation, tools);
    manager.acceptRegistry(generation, registry(names, defaultName));
    release();
  };
  reconnect(["alpha", "beta", "gamma"]);
  const binding = controller.bind("session-1");
  onTestFinished(() => {
    controller.dispose();
    manager.dispose();
  });
  return { manager, service, controller, binding, reconnect };
}
function scope(controller: InvestigationController): EffectiveInvestigationScope {
  const current = controller.currentScope();
  if (!current.ok) throw new Error(current.reason);
  return current.scope;
}
async function admit(
  controller: InvestigationController,
  context = "alpha",
  signal?: AbortSignal,
): Promise<IncidentExecutionLease> {
  const admission = await controller.admitExecution(
    scope(controller),
    { context, operation: "pods_list" },
    signal,
  );
  if (!admission.ok) throw new Error(admission.reason);
  return admission.lease;
}

describe("inactive Phase 4 investigation controller", () => {
  it("captures exact A, publishes distinct next B, continues A and explicitly replaces with B", async () => {
    const { controller, binding, manager } = setup(createExactClusterRule(["alpha"]));
    const first = controller.start(binding, "Why unavailable?");
    const expected = scope(controller);
    manager.select("beta");
    expect(scope(controller)).toBe(expected);
    expect(controller.continueOrStart(binding, "Check more").incident.id).toBe(first.incident.id);
    expect(controller.clusterState().selection.rule).toEqual(createExactClusterRule(["alpha"]));
    expect(createInvestigationScopeDescription(controller)).toContain(
      'Next investigation selection: ["beta"]',
    );
    const lease = await admit(controller);
    expect(controller.isCurrent(lease)).toBe(true);
    expect(
      await controller.admitExecution(expected, { context: "beta", operation: "pods_list" }),
    ).toEqual({ ok: false, reason: "invalid-arguments" });
    controller.release(lease);
    const second = controller.start(binding, "Different incident");
    expect(second.incident.scope.rule).toEqual(createExactClusterRule(["beta"]));
    expect(second.dispatchedAttempts).toBe(0);
    expect(controller.isCurrent(lease)).toBe(false);
  });

  it("routes parallel exact targets independently and refuses missing/foreign contexts", async () => {
    const { controller, binding, service } = setup(createExactClusterRule(["alpha", "beta"]));
    const incident = controller.start(binding, "Compare");
    for (const context of ["", "gamma", "unknown"])
      expect(
        await controller.admitExecution(scope(controller), { context, operation: "pods_list" }),
      ).toMatchObject({ ok: false });
    const [a, b] = await Promise.all([admit(controller), admit(controller, "beta")]);
    const ta = controller.dispatchExecution(a);
    const tb = controller.dispatchExecution(b);
    service.recordObservation(tb, { excerpt: "beta", truncated: false, completedAt: now });
    expect(controller.isCurrent(a)).toBe(true);
    service.recordObservation(ta, { excerpt: "alpha", truncated: false, completedAt: now });
    expect(service.inspect(incident.incident.id).evidence.map((item) => item.context)).toEqual([
      "beta",
      "alpha",
    ]);
    controller.release(a);
    controller.release(b);
  });

  it("reconciles exact scope independently of missing next selection and never admits additions", async () => {
    const { controller, binding, manager, reconnect } = setup(
      createExactClusterRule(["alpha", "beta"]),
    );
    controller.start(binding, "Compare");
    manager.select("gamma");
    reconnect(["alpha", "delta"]);
    expect(manager.state.resolution).toMatchObject({ status: "resolved", available: [] });
    expect(scope(controller).resolution).toMatchObject({
      status: "resolved",
      available: [{ name: "alpha" }],
      unavailable: ["beta"],
    });
    const a = await admit(controller);
    expect(controller.isCurrent(a)).toBe(true);
    expect(
      await controller.admitExecution(scope(controller), {
        context: "delta",
        operation: "pods_list",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await controller.admitExecution(scope(controller), {
        context: "beta",
        operation: "pods_list",
      }),
    ).toEqual({ ok: false, reason: "scope-unavailable" });
    expect(controller.availableTools().map((tool) => tool.name)).toContain("pods_list");
    expect(
      validateMcpToolExecution(
        { name: "pods_list", clusterDependent: true },
        { context: "alpha" },
        controller.clusterState(),
      ),
    ).toEqual({ ok: true, context: "alpha" });
    controller.release(a);
  });

  it("live * ignores default changes and admits new inventory with not-checked notice", async () => {
    const { controller, binding, reconnect } = setup();
    const incident = controller.start(binding, "Explore");
    expect(incident.incident.scope.rule).toEqual({ kind: "all" });
    reconnect(["alpha", "delta"], diagnosticTools, "delta");
    expect(scope(controller).rule).toEqual({ kind: "all" });
    expect(createInvestigationScopeDescription(controller)).toContain(
      "Added contexts are not checked",
    );
    expect(createInvestigationScopeDescription(controller)).toContain(
      'removed: 2 ["beta", "gamma"]',
    );
    const lease = await admit(controller, "delta");
    controller.release(lease);
    expect(controller.inspect(binding)?.outcomes).toEqual([]);
  });

  it("requires usable current inventory and diagnostics before automatic/explicit creation", () => {
    const { controller, binding, manager, reconnect } = setup();
    reconnect([], []);
    expect(() => controller.start(binding, "Question")).toThrow(/usable/);
    reconnect(["alpha"], []);
    expect(() => controller.start(binding, "Question")).toThrow(/usable/);
    manager.beginConnection();
    expect(() => controller.start(binding, "Question")).toThrow(/usable/);
    manager.failEnumeration(
      manager.state.connectionGeneration,
      "invalid-response",
      "Invalid inventory",
    );
    expect(() => controller.start(binding, "Question")).toThrow(/usable/);
    expect(controller.inspect(binding)).toBeUndefined();
  });

  it("uses tool compatibility for both visibility and target admission", async () => {
    const { controller, binding, reconnect } = setup();
    const tools = diagnosticTools
      .filter((tool) => tool.name === "pods_list")
      .map((tool) => ({
        ...tool,
        inputSchema: { ...tool.inputSchema, properties: { context: { const: "alpha" } } },
      }));
    reconnect(["alpha", "beta"], tools);
    controller.start(binding, "Question");
    expect(controller.availableTools()).toHaveLength(1);
    expect(
      await controller.admitExecution(scope(controller), {
        context: "beta",
        operation: "pods_list",
      }),
    ).toEqual({ ok: false, reason: "invalid-arguments" });
    expect(
      await controller.admitExecution(scope(controller), {
        context: "alpha",
        operation: "pods_delete",
      }),
    ).toEqual({ ok: false, reason: "invalid-arguments" });
  });

  it("spends synchronously at dispatch only; release and cancellation never reset budgets", async () => {
    const { controller, binding } = setup(undefined, 1);
    controller.start(binding, "Question");
    const first = await admit(controller);
    expect(controller.inspect(binding)?.dispatchedAttempts).toBe(0);
    controller.dispatchExecution(first);
    expect(controller.inspect(binding)?.dispatchedAttempts).toBe(1);
    expect(() => controller.dispatchExecution(first)).toThrow(/already dispatched/);
    controller.release(first, "transport");
    const second = await admit(controller);
    expect(() => controller.dispatchExecution(second)).toThrow(/budget exhausted/);
    controller.release(second);
    expect(controller.inspect(binding)?.outcomes).toHaveLength(1);
  });

  it("invalidates and settles old-generation work before publishing replacement inventory", async () => {
    const { controller, binding, service, manager, reconnect } = setup();
    const first = controller.start(binding, "Question");
    const lease = await admit(controller);
    const token = controller.dispatchExecution(lease);
    const release = manager.blockDispatch();
    expect(controller.isCurrent(lease)).toBe(false);
    manager.beginConnection();
    expect(service.inspect(first.incident.id).outcomes[0]?.status).toBe("interrupted");
    release();
    reconnect(["alpha", "delta"]);
    expect(() =>
      service.recordObservation(token, { excerpt: "Late", truncated: false, completedAt: now }),
    ).toThrow();
    expect(controller.inspect(binding)?.dispatchedAttempts).toBe(1);
    expect(controller.inspect(binding)?.evidence).toEqual([]);
    expect(manager.isAgentActive).toBe(false);
  });

  it("keeps the publication gate closed through scope listeners", async () => {
    const { controller, binding, reconnect } = setup();
    controller.start(binding, "Question");
    const attempts: Promise<IncidentAdmission>[] = [];
    const stop = controller.subscribe((snapshot) => {
      if (snapshot.effective.ok)
        attempts.push(
          controller.admitExecution(snapshot.effective.scope, {
            context: "alpha",
            operation: "pods_list",
          }),
        );
    });
    // Ignore the initial ready publication, which legitimately admits work.
    const initial = await attempts.shift();
    if (initial?.ok) controller.release(initial.lease);
    reconnect(["alpha", "delta"]);
    stop();
    expect(await Promise.all(attempts)).toSatisfy(
      (results: IncidentAdmission[]) => results.length > 0 && results.every((result) => !result.ok),
    );
    expect(controller.inspect(binding)?.dispatchedAttempts).toBe(0);
  });

  it("shares FIFO capacity and settles queued work on binding replacement without spending", async () => {
    const { controller, binding } = setup();
    controller.start(binding, "Question");
    const active = await Promise.all(Array.from({ length: 4 }, () => admit(controller)));
    const queued = controller.admitExecution(scope(controller), {
      context: "alpha",
      operation: "pods_list",
    });
    expect(() => controller.start(binding, "Replace")).toThrow(/active work/);
    controller.bind("session-2");
    expect(await queued).toEqual({ ok: false, reason: "stale-scope" });
    expect(active.every((lease) => !controller.isCurrent(lease))).toBe(true);
    const rebound = controller.bind("session-1");
    expect(controller.inspect(rebound)?.dispatchedAttempts).toBe(0);
  });

  it("isolates new/fork sessions, preserves resume/reload and rejects stale extension cleanup", async () => {
    const { controller, binding } = setup();
    const first = controller.start(binding, "Original");
    const lease = await admit(controller);
    controller.dispatchExecution(lease);
    const fork = controller.bind("fork");
    expect(controller.inspect(fork)).toBeUndefined();
    expect(controller.currentScope()).toEqual({ ok: false, reason: "no-open-incident" });
    controller.start(fork, "Fork question");
    const resumed = controller.bind(binding.sessionId);
    controller.unbind(binding);
    expect(controller.isBound(resumed)).toBe(true);
    expect(controller.inspect(resumed)?.incident.id).toBe(first.incident.id);
    expect(controller.inspect(resumed)?.outcomes[0]?.status).toBe("interrupted");
    expect(controller.isCurrent(lease)).toBe(false);
  });

  it("rejects copied/released leases; cancellation settles work while leaving incident open", async () => {
    const { controller, binding } = setup();
    controller.start(binding, "Question");
    const signal = new AbortController();
    const lease = await admit(controller, "alpha", signal.signal);
    controller.dispatchExecution(lease);
    expect(controller.isCurrent({ ...lease })).toBe(false);
    signal.abort();
    expect(controller.isCurrent(lease)).toBe(false);
    controller.release(lease);
    expect(controller.inspect(binding)?.incident.status).toBe("investigating");
    expect(controller.inspect(binding)?.outcomes).toHaveLength(1);
    const fresh = await admit(controller);
    controller.cancel(binding);
    expect(controller.isCurrent(fresh)).toBe(false);
  });

  it("preserves authority on failed replacement and blocks diagnostics after conclusion", async () => {
    const { controller, binding } = setup();
    const first = controller.start(binding, "Question");
    const expected = scope(controller);
    expect(() => controller.start(binding, " ")).toThrow();
    expect(scope(controller)).toBe(expected);
    controller.conclude(binding, first.revision, "inconclusive", conclusion);
    expect(controller.availableTools()).toEqual([]);
    expect(
      await controller.admitExecution(expected, { context: "alpha", operation: "pods_list" }),
    ).toEqual({ ok: false, reason: "stale-scope" });
    expect(controller.inspect(binding)?.incident.status).toBe("inconclusive");
  });
  it("flush releases concluded session references while preserving another session's open incident", async () => {
    const { controller, binding } = setup();
    const first = controller.start(binding, "First");
    controller.conclude(binding, first.revision, "inconclusive", conclusion);
    const other = controller.bind("session-2");
    const second = controller.start(other, "Second");
    const directory = await mkdtemp(join(tmpdir(), "pi-sre-controller-archive-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await controller.flush(first.incident.id, join(directory, "first.jsonl"));
    expect(controller.inspect(other)?.incident.id).toBe(second.incident.id);
    const resumed = controller.bind(binding.sessionId);
    expect(controller.inspect(resumed)).toBeUndefined();
    expect(controller.currentScope()).toEqual({ ok: false, reason: "no-open-incident" });
  });

  it.each(["empty", "malformed", "unavailable"])(
    "blocks active authority after %s inventory and preserves its immutable rule",
    async (failure) => {
      const { controller, binding, manager, service, reconnect } = setup(
        createExactClusterRule(["alpha"]),
      );
      const incident = controller.start(binding, "Question");
      const lease = await admit(controller);
      const token = controller.dispatchExecution(lease);
      if (failure === "empty") reconnect([]);
      else if (failure === "unavailable") manager.markUnavailable("Fixture MCP loss");
      else {
        const generation = manager.beginConnection();
        manager.failEnumeration(generation, "invalid-response", "Malformed inventory");
      }
      expect(controller.availableTools()).toEqual([]);
      expect(scope(controller).rule).toEqual(incident.incident.scope.rule);
      expect(controller.isCurrent(lease)).toBe(false);
      expect(() =>
        service.recordObservation(token, { excerpt: "Late", truncated: false, completedAt: now }),
      ).toThrow();
      expect(controller.inspect(binding)?.dispatchedAttempts).toBe(1);
      expect(controller.inspect(binding)?.evidence).toEqual([]);
    },
  );

  it("does not spend for queued cancellation or cancellation between admission and transport", async () => {
    const { controller, binding } = setup();
    controller.start(binding, "Question");
    const active = await Promise.all(Array.from({ length: 4 }, () => admit(controller)));
    const cancellation = new AbortController();
    const waiting = controller.admitExecution(
      scope(controller),
      { context: "alpha", operation: "pods_list" },
      cancellation.signal,
    );
    cancellation.abort(new Error("Fixture cancellation"));
    await expect(waiting).rejects.toThrow("Fixture cancellation");
    for (const lease of active) controller.release(lease);
    const abort = new AbortController();
    const lease = await admit(controller, "alpha", abort.signal);
    abort.abort();
    expect(() => controller.dispatchExecution(lease)).toThrow(/stale/);
    expect(controller.inspect(binding)?.dispatchedAttempts).toBe(0);
  });
});
