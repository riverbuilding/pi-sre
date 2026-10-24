import { describe, expect, it } from "vitest";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { DomainError, requireRevision } from "../../../src/domain/errors.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createHypothesis } from "../../../src/domain/hypothesis.js";
import {
  beginInvestigation,
  concludeIncident,
  createIncident,
} from "../../../src/domain/incident.js";
import {
  createInvestigationScope,
  createTimeWindow,
  resolveInvestigationScope,
  resolveTimeWindow,
} from "../../../src/domain/investigation-scope.js";
import { createInvestigationState } from "../../../src/domain/investigation-state.js";
import { createTarget, targetIdentity } from "../../../src/domain/target.js";

const now = "2026-10-21T12:00:00.000Z";
const window = { start: "2026-10-21T11:30:00.000Z", end: now };
const scope = createInvestigationScope(
  { rule: { kind: "exact", contexts: ["alpha", "beta"] }, source: "user", selectionRevision: 2 },
  window,
);
const incident = createIncident({
  id: "I1",
  question: "Why is the pod failing?",
  createdAt: now,
  scope,
});
const target = createTarget({ context: "alpha", kind: "Pod", name: "app" });
const evidence = createEvidence(
  {
    id: "E1",
    incidentId: "I1",
    source: "kubernetes",
    executionId: "X1",
    operation: "pods_get",
    completedAt: now,
    context: "alpha",
    target,
    excerpt: "",
    scopeRevision: 1,
    inventoryRevision: 2,
    connectionGeneration: 3,
    truncated: false,
  },
  8000,
);
const hypothesis = createHypothesis(
  {
    id: "H1",
    incidentId: "I1",
    statement: "The image may be unavailable",
    status: "supported",
    supportingEvidence: ["E1"],
    contradictingEvidence: [],
    rationale: "The observation supports this interpretation",
    revision: 1,
    updatedAt: now,
  },
  [evidence],
);
const conclusion = {
  explanation: "The image is unavailable",
  hypothesisIds: ["H1"],
  evidenceIds: ["E1"],
  concludedAt: now,
};
const state = {
  incident: beginInvestigation(incident),
  targets: [target],
  evidence: [evidence],
  hypotheses: [hypothesis],
  outcomes: [],
  dispatchedAttempts: 1,
  startedAt: now,
  updatedAt: now,
  revision: 1,
};

function inventory(names: string[]): ClusterContextRegistry {
  return new ClusterContextRegistry(
    names.map((name) => ({ name, server: "https://example.invalid", isDefault: false })),
  );
}

describe("investigation domain", () => {
  it("privately captures selection, timestamps and nested arrays", () => {
    const contexts: [string, ...string[]] = ["beta", "alpha"];
    const time = { ...window };
    const captured = createIncident({
      ...incident,
      scope: createInvestigationScope(
        { rule: { kind: "exact", contexts }, source: "cli", selectionRevision: 1 },
        time,
      ),
    });
    contexts[0] = "gamma";
    time.start = now;
    expect(captured.scope.rule).toEqual(scope.rule);
    expect(captured.scope.timeWindow).toEqual(window);
    expect(Reflect.set(captured.scope.timeWindow, "start", now)).toBe(false);
    expect(Reflect.set(captured.scope, "revision", 2)).toBe(false);
    const input = {
      ...state,
      targets: [{ ...target }],
      hypotheses: [{ ...hypothesis, supportingEvidence: ["E1"] }],
    };
    const snapshot = createInvestigationState(input, 8000);
    input.targets[0]!.name = "changed";
    input.targets.push({ ...target });
    input.hypotheses[0]!.supportingEvidence.push("E2");
    expect(snapshot.targets).toEqual([target]);
    expect(snapshot.hypotheses[0]?.supportingEvidence).toEqual(["E1"]);
    expect(Reflect.set(snapshot.targets[0]!, "name", "changed")).toBe(false);
    expect(Reflect.set(snapshot.evidence[0]!.target!, "name", "changed")).toBe(false);
    expect(Reflect.set(snapshot.hypotheses[0]!.supportingEvidence, "0", "E2")).toBe(false);
  });

  it("separates immutable exact rules and replaceable live resolutions", () => {
    expect(resolveInvestigationScope(scope, inventory(["alpha", "gamma"]))).toMatchObject({
      available: [{ name: "alpha" }],
      unavailable: ["beta"],
    });
    const all = createInvestigationScope(
      { rule: { kind: "all" }, source: "default-all", selectionRevision: 1 },
      window,
    );
    expect(resolveInvestigationScope(all, inventory(["alpha", "beta"]))).toMatchObject({
      available: [{ name: "alpha" }, { name: "beta" }],
    });
    expect(resolveInvestigationScope(all, inventory(["alpha", "gamma"]))).toMatchObject({
      available: [{ name: "alpha" }, { name: "gamma" }],
    });
    expect(resolveInvestigationScope(all)).toEqual({
      status: "blocked",
      reason: "inventory-unavailable",
    });
    expect(resolveInvestigationScope(all, inventory([]))).toMatchObject({
      available: [],
      unavailable: [],
    });
    for (const contexts of [[], ["alpha", "alpha"], [""], ["\u001b"], ["é".repeat(513)]]) {
      expect(() =>
        createInvestigationScope(
          {
            rule: { kind: "exact", contexts: [contexts[0] ?? "", ...contexts.slice(1)] },
            source: "user",
            selectionRevision: 1,
          },
          window,
        ),
      ).toThrow(DomainError);
    }
  });

  it("preserves full target identity and never supplies a namespace", () => {
    expect(target.namespace).toBeUndefined();
    const variants = [
      target,
      { ...target, context: "Alpha" },
      { ...target, context: " alpha " },
      { ...target, namespace: "default" },
      { ...target, kind: "Deployment" },
      { ...target, uid: "new" },
      { ...target, apiVersion: "v1" },
    ];
    expect(new Set(variants.map(targetIdentity)).size).toBe(variants.length);
    expect(() => createTarget({ ...target, name: "\n" })).toThrow(DomainError);
    expect(() => createTarget({ ...target, namespace: "" })).toThrow(DomainError);
  });

  it("resolves time once and rejects invalid durations and windows", () => {
    expect(() => createTimeWindow({ start: now, end: now })).toThrow(DomainError);
    const date = new Date(now);
    const resolved = resolveTimeWindow("30m", () => date);
    date.setTime(0);
    expect(resolved).toEqual(window);
    for (const duration of ["0ms", "-1m", "1w", "1.5h", "999999999999999999d"])
      expect(() => resolveTimeWindow(duration, () => new Date(now))).toThrow(DomainError);
    expect(() => resolveTimeWindow("1m", () => new Date(NaN))).toThrow(DomainError);
    for (const start of [
      "bad",
      "2026-02-30T00:00:00.000Z",
      "2026-10-21T13:00:00.000Z",
      "2026-10-21T12:00:00+00:00",
    ])
      expect(() => createTimeWindow({ start, end: now })).toThrow(DomainError);
  });

  it("validates and redacts observations including successful empty content", () => {
    expect(evidence.excerpt).toBe("");
    expect(
      createEvidence({ ...evidence, excerpt: "token=private", truncated: true }, 8000),
    ).toMatchObject({ excerpt: "token=[REDACTED]", truncated: true });
    expect(() => createEvidence({ ...evidence, context: "beta" }, 8000)).toThrow(DomainError);
    expect(() => createEvidence({ ...evidence, scopeRevision: 0 }, 8000)).toThrow(DomainError);
    expect(() => createEvidence({ ...evidence, excerpt: "too long" }, 1)).toThrow(DomainError);
    expect(() => createIncident({ ...incident, id: "é".repeat(65) })).toThrow(DomainError);
    expect(() => createIncident({ ...incident, question: " " })).toThrow(DomainError);
    expect(() => createIncident({ ...incident, question: "x".repeat(4001) })).toThrow(DomainError);
  });

  it("requires same-incident evidence and consistent hypothesis status", () => {
    for (const change of [
      { supportingEvidence: [] },
      { supportingEvidence: ["missing"] },
      { supportingEvidence: ["E1", "E1"] },
      { contradictingEvidence: ["E1"] },
      { incidentId: "other" },
      { status: "rejected" as const },
    ])
      expect(() => createHypothesis({ ...hypothesis, ...change }, [evidence])).toThrow(DomainError);
    expect(
      createHypothesis({ ...hypothesis, status: "candidate", supportingEvidence: [] }, []),
    ).toMatchObject({ status: "candidate" });
    expect(() => requireRevision(2, 1)).toThrowError(
      expect.objectContaining({ failure: { kind: "stale-revision" } }),
    );
    const other = createEvidence({ ...evidence, id: "E2", executionId: "X2" }, 8000);
    expect(
      createHypothesis({ ...hypothesis, contradictingEvidence: ["E2"] }, [evidence, other])
        .contradictingEvidence,
    ).toEqual(["E2"]);
  });

  it("permits explicit conclusions and rejects all terminal transitions", () => {
    expect(beginInvestigation(incident).status).toBe("investigating");
    expect(() => concludeIncident(incident, "resolved", conclusion, [], [])).toThrow(DomainError);
    expect(() =>
      concludeIncident(
        incident,
        "inconclusive",
        { ...conclusion, explanation: " " },
        [hypothesis],
        [evidence],
      ),
    ).toThrow(DomainError);
    for (const status of ["resolved", "inconclusive"] as const) {
      const terminal = concludeIncident(incident, status, conclusion, [hypothesis], [evidence]);
      expect(() => beginInvestigation(terminal)).toThrow(DomainError);
      expect(() =>
        concludeIncident(terminal, status, conclusion, [hypothesis], [evidence]),
      ).toThrow(DomainError);
      expect(Reflect.set(terminal.conclusion!.evidenceIds, "0", "E2")).toBe(false);
      expect(createInvestigationState({ ...state, incident: terminal }, 8000).incident).toEqual(
        terminal,
      );
    }
    expect(
      concludeIncident(
        incident,
        "inconclusive",
        { ...conclusion, hypothesisIds: [], evidenceIds: [] },
        [],
        [],
      ).status,
    ).toBe("inconclusive");
  });

  it("bounds outcomes by dispatched attempts", () => {
    const outcome = {
      executionId: "X1",
      context: "alpha",
      operation: "pods_get",
      scopeRevision: 1,
      inventoryRevision: 2,
      connectionGeneration: 3,
      completedAt: now,
      status: "successful" as const,
    };
    const snapshot = createInvestigationState({ ...state, outcomes: [outcome] }, 8000);
    expect(Object.isFrozen(snapshot.outcomes[0])).toBe(true);
    expect(() =>
      createInvestigationState({ ...state, outcomes: [outcome, outcome] }, 8000),
    ).toThrow(DomainError);
  });

  it("rejects mismatched aggregate scope, chronology and duplicate records", () => {
    for (const change of [
      { targets: [{ ...target, context: "gamma" }] },
      { evidence: [{ ...evidence, incidentId: "other" }] },
      { evidence: [evidence, evidence] },
      { hypotheses: [hypothesis, hypothesis] },
      { updatedAt: window.start },
      { incident },
      { dispatchedAttempts: -1 },
      { evidence: [{ ...evidence, scopeRevision: 2 }] },
    ])
      expect(() => createInvestigationState({ ...state, ...change }, 8000)).toThrow(DomainError);
    expect(() =>
      createInvestigationState({ ...state, targets: [{ ...target, context: "gamma" }] }, 8000),
    ).toThrowError(expect.objectContaining({ failure: { kind: "scope-mismatch" } }));
  });
});
