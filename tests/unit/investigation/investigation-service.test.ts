import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ClusterContextRegistry } from "../../../src/cluster/context-registry.js";
import { DomainError } from "../../../src/domain/errors.js";
import type { Target } from "../../../src/domain/target.js";
import { retainedContentBytes } from "../../../src/investigation/content-capacity.js";
import { InvestigationService } from "../../../src/investigation/investigation-service.js";
import type {
  ExecutionOrigin,
  InvestigationServiceOptions,
  SuccessfulObservation,
} from "../../../src/investigation/investigation-service.js";

const now = "2026-10-23T12:00:00.000Z";
const inventory = new ClusterContextRegistry(
  ["alpha", "beta"].map((name) => ({ name, server: "https://example.invalid", isDefault: false })),
);
const start = {
  question: "Why is the pod failing?",
  selection: {
    rule: { kind: "exact" as const, contexts: ["alpha", "beta"] as const },
    source: "user" as const,
    selectionRevision: 1,
  },
  inventory,
};
const target: Target = { context: "alpha", kind: "Pod", name: "app" };
const origin: ExecutionOrigin = {
  context: "alpha",
  operation: "pods_get",
  inventoryRevision: 2,
  connectionGeneration: 3,
};
const observation: SuccessfulObservation = {
  excerpt: "The image could not be pulled",
  truncated: false,
  completedAt: now,
};
const hypothesis = {
  statement: "The image is unavailable",
  rationale: "The observation supports this interpretation",
  status: "candidate" as const,
  supportingEvidence: [],
  contradictingEvidence: [],
};
const conclusion = {
  explanation: "The cause remains uncertain",
  hypothesisIds: [],
  evidenceIds: [],
};

function service(options: Partial<InvestigationServiceOptions> = {}): InvestigationService {
  const ids = { incident: 0, hypothesis: 0, evidence: 0, execution: 0 };
  return new InvestigationService({
    maxExcerptChars: 1000,
    maxToolCalls: 3,
    defaultTimeRange: "30m",
    clock: () => new Date(now),
    createId: (kind) => `${kind}-${++ids[kind]}`,
    ...options,
  });
}

function capture(
  s: InvestigationService,
  id: string,
  input = observation,
  executionOrigin = origin,
) {
  const token = s.dispatchDiagnostic(id, executionOrigin);

  return { token, evidence: s.recordObservation(token, input) };
}

const failure = (kind: string, resource?: string) =>
  expect.objectContaining({
    failure: { kind, ...(resource ? { resource } : {}) },
  });

async function archiveDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sre-archive-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("InvestigationService", () => {
  it("validates per-incident evidence limits when constructing the service", () => {
    for (const limit of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => service({ maxEvidence: limit })).toThrow(DomainError);
      expect(() => service({ maxBytes: limit })).toThrow(DomainError);
    }
  });

  it("captures deterministic immutable incident scope/window without session or transcript state", () => {
    const s = service();
    const input = {
      ...start,
      selection: {
        ...start.selection,
        rule: { kind: "exact" as const, contexts: ["alpha"] as [string, ...string[]] },
      },
    };
    const state = s.start(input);
    input.selection.rule.contexts.push("beta");
    expect(state.incident).toMatchObject({
      id: "incident-1",
      createdAt: now,
      status: "new",
      scope: {
        rule: { kind: "exact", contexts: ["alpha"] },
        timeWindow: { start: "2026-10-23T11:30:00.000Z", end: now },
      },
    });

    expect(s.inspect(state.incident.id)).toEqual(state);
    expect(Reflect.set(state.incident.scope.rule, "contexts", ["beta"])).toBe(true);
    expect(Reflect.set(state, "revision", 9)).toBe(true);
    expect(s.inspect(state.incident.id).revision).toBe(1);
    expect(s.inspect(state.incident.id).incident.scope.rule).toEqual({
      kind: "exact",
      contexts: ["alpha"],
    });
    expect(service().start(start).incident.id).toBe(state.incident.id);
    expect(() => service().inspect(state.incident.id)).toThrowError(failure("missing-reference"));
    // Only explicit mutations transition the domain; there is no agent-answer/completion transition.
    expect(s.inspect(state.incident.id).incident.status).toBe("new");
  });

  it.each(["inspect", "setFocus", "setTargets", "conclude"] as const)(
    "returns an equal but distinct snapshot from %s",
    (method) => {
      const s = service();
      const id = s.start(start).incident.id;
      const { evidence } = capture(s, id, observation, { ...origin, target });
      const h = s.upsertHypothesis(id, {
        ...hypothesis,
        status: "supported",
        supportingEvidence: [evidence.id],
      });
      const revision = s.inspect(id).revision;
      const snapshot =
        method === "inspect"
          ? s.inspect(id)
          : method === "setFocus"
            ? s.setFocus(id, revision, "Inspect image")
            : method === "setTargets"
              ? s.setTargets(id, revision, [target])
              : s.conclude(id, revision, "resolved", {
                  ...conclusion,
                  hypothesisIds: [h.id],
                  evidenceIds: [evidence.id],
                });
      const expected = s.inspect(id);
      expect(snapshot).toEqual(expected);
      expect(snapshot).not.toBe(expected);
    },
  );

  it("keeps earlier snapshots stable through updates, replacement and conclusion", () => {
    const s = service();
    const initial = s.start(start);
    const id = initial.incident.id;
    const focused = s.setFocus(id, 1, "Inspect image");
    const targeted = s.setTargets(id, 2, [target]);
    const inspected = s.inspect(id);
    const snapshots = [initial, focused, targeted, inspected];
    const expected = structuredClone(snapshots);
    capture(s, id, observation, { ...origin, target });
    s.upsertHypothesis(id, hypothesis);
    const replacement = s.replace(id, s.inspect(id).revision, start);
    const nextId = replacement.incident.id;
    const terminal = s.conclude(nextId, 1, "inconclusive", conclusion);
    expect(snapshots).toEqual(expected);
    expect(replacement.incident.status).toBe("new");
    Reflect.set(replacement.incident.scope.rule, "contexts", ["outside"]);
    Reflect.set(terminal.incident.conclusion!, "explanation", "changed");
    expect(s.inspect(nextId).incident.scope.rule).toEqual(start.selection.rule);
    expect(s.inspect(nextId).incident.conclusion?.explanation).toBe(conclusion.explanation);
  });

  it("requires usable scope and valid time/question/identities before retaining an incident", () => {
    const s = service({ maxIncidents: 1 });
    for (const input of [
      { ...start, question: " " },
      { ...start, question: "x".repeat(4001) },
      { ...start, inventory: new ClusterContextRegistry([]) },
      {
        ...start,
        selection: {
          ...start.selection,
          rule: { kind: "exact" as const, contexts: ["missing"] as const },
        },
      },
    ])
      expect(() => s.start(input)).toThrow(DomainError);
    const id = s.start(start).incident.id;
    expect(s.capacity(id).bytes.retained).toBe(0);
    for (const range of ["0m", "bogus", "99999999999999999999d"]) {
      const invalid = service({ defaultTimeRange: range });
      expect(() => invalid.start(start)).toThrow(DomainError);
      expect(() => invalid.inspect("incident-1")).toThrowError(failure("missing-reference"));
    }
    for (const id of ["", "x".repeat(129), "bad\u001b"]) {
      const invalid = service({ createId: () => id });
      expect(() => invalid.start(start)).toThrow(DomainError);
      expect(() => invalid.inspect("incident-1")).toThrowError(failure("missing-reference"));
    }
  });

  it("redacts bounded human text, updates focus/targets, and refuses stale or invalid mutations atomically", () => {
    const s = service();
    const first = s.start({ ...start, question: "token=private" });
    const id = first.incident.id;
    expect(first.incident.question).toBe("token=[REDACTED]");
    const focused = s.setFocus(id, 1, "password=private");
    expect(focused.focus).toBe("password=[REDACTED]");
    const targets = [{ ...target }];
    const updated = s.setTargets(id, 2, targets);
    targets[0]!.name = "changed";
    expect(updated.targets).toEqual([target]);
    const before = s.capacity(id);
    for (const mutate of [
      () => s.setFocus(id, 2, "stale"),
      () => s.setFocus(id, 3, "x".repeat(1001)),
      () => s.setTargets(id, 3, [target, target]),
      () => s.setTargets(id, 3, [{ ...target, context: "outside" }]),
    ])
      expect(mutate).toThrow(DomainError);
    expect(s.inspect(id)).toEqual(updated);
    expect(s.capacity(id)).toEqual(before);
    expect(s.setFocus(id, 3).focus).toBeUndefined();
  });

  it("validates interpretation links, stable hypothesis revisions, support and contradiction", () => {
    const s = service();
    const id = s.start(start).incident.id;
    const e1 = capture(s, id).evidence;
    const e2 = capture(s, id, { ...observation, excerpt: "A second observation" }).evidence;
    const h = s.upsertHypothesis(id, {
      ...hypothesis,
      status: "supported",
      supportingEvidence: [e1.id],
      contradictingEvidence: [e2.id],
    });
    expect(h).toMatchObject({ id: "hypothesis-1", revision: 1, updatedAt: now });
    expect(s.inspect(id).incident.status).toBe("investigating");
    const updated = s.upsertHypothesis(id, {
      ...hypothesis,
      id: h.id,
      expectedRevision: 1,
      status: "rejected",
      supportingEvidence: [e1.id],
      contradictingEvidence: [e2.id],
    });
    expect(updated).toMatchObject({ id: h.id, revision: 2, status: "rejected" });
    expect(updated.supportingEvidence).toEqual([e1.id]);
    const before = s.inspect(id);
    const bytes = s.capacity(id);
    for (const input of [
      { ...hypothesis, status: "supported" as const },
      { ...hypothesis, status: "rejected" as const },
      { ...hypothesis, supportingEvidence: [e1.id, e1.id] },
      { ...hypothesis, supportingEvidence: [e1.id], contradictingEvidence: [e1.id] },
      { ...hypothesis, supportingEvidence: ["unknown"] },
      { ...hypothesis, statement: "x".repeat(2001) },
      { ...hypothesis, id: h.id, expectedRevision: 1 },
      { ...hypothesis, id: "unknown", expectedRevision: 1 },
    ])
      expect(() => s.upsertHypothesis(id, input)).toThrow(DomainError);
    expect(s.inspect(id)).toEqual(before);
    expect(s.capacity(id)).toEqual(bytes);
    const other = s.start(start).incident.id;
    expect(() =>
      s.upsertHypothesis(other, { ...hypothesis, supportingEvidence: [e1.id] }),
    ).toThrowError(failure("missing-reference"));
    expect(() =>
      s.upsertHypothesis(other, { ...hypothesis, id: h.id, expectedRevision: 2 }),
    ).toThrowError(failure("missing-reference"));
    expect(s.upsertHypothesis(other, hypothesis).revision).toBe(1);
  });

  it("requires evidence-backed resolved conclusions and preserves immutable terminal records", () => {
    const s = service();
    const id = s.start(start).incident.id;
    expect(() => s.conclude(id, 1, "resolved", conclusion)).toThrow(DomainError);
    expect(() => s.conclude(id, 1, "inconclusive", { ...conclusion, explanation: " " })).toThrow(
      DomainError,
    );
    const e = capture(s, id).evidence;
    const h = s.upsertHypothesis(id, {
      ...hypothesis,
      status: "supported",
      supportingEvidence: [e.id],
    });
    const before = s.inspect(id);
    expect(() =>
      s.conclude(id, before.revision, "resolved", { ...conclusion, hypothesisIds: ["unknown"] }),
    ).toThrow(DomainError);
    const terminal = s.conclude(id, before.revision, "resolved", {
      explanation: "The image is unavailable",
      hypothesisIds: [h.id],
      evidenceIds: [e.id],
    });
    const bytes = s.capacity(id);
    for (const mutate of [
      () => s.setFocus(id, terminal.revision, "changed"),
      () => s.setTargets(id, terminal.revision, []),
      () => s.upsertHypothesis(id, hypothesis),
      () => s.dispatchDiagnostic(id, origin),
      () => s.conclude(id, terminal.revision, "inconclusive", conclusion),
      () => s.replace(id, terminal.revision, start),
    ])
      expect(mutate).toThrow(DomainError);
    expect(s.inspect(id)).toEqual(terminal);
    expect(s.evidenceGet(id, e.id)).toBe(e);
    expect(s.capacity(id)).toEqual(bytes);
    const next = s.start(start);
    expect(s.conclude(next.incident.id, 1, "inconclusive", conclusion).incident.status).toBe(
      "inconclusive",
    );
  });

  it("replaces only after all validation succeeds and retains the previous investigation", () => {
    const s = service();
    const id = s.start(start).incident.id;
    const e = capture(s, id).evidence;
    const before = s.inspect(id);
    const capacity = s.capacity(id);
    expect(() => s.replace(id, before.revision, { ...start, question: " " })).toThrow(DomainError);
    expect(() => s.replace(id, 1, start)).toThrowError(failure("stale-revision"));
    expect(s.inspect(id)).toEqual(before);
    expect(s.capacity(id)).toEqual(capacity);
    const next = s.replace(id, before.revision, { ...start, question: "A different question" });
    expect(next.incident.id).not.toBe(id);
    expect(next.incident.status).toBe("new");
    expect(s.inspect(id).incident).toMatchObject({
      status: "inconclusive",
      conclusion: { explanation: expect.stringContaining("replaced") },
    });
    expect(s.inspect(id).evidence).toEqual([e]);
    expect(next.evidence).toEqual([]);
  });

  it("enforces incident count across concluded records", () => {
    const limited = service({ maxIncidents: 1 });
    const id = limited.start(start).incident.id;
    const before = limited.capacity(id);
    expect(() => limited.replace(id, 1, start)).toThrowError(
      failure("capacity-refused", "incidents"),
    );
    expect(limited.inspect(id).incident.status).toBe("new");
    expect(limited.capacity(id)).toEqual(before);
    limited.conclude(id, 1, "inconclusive", conclusion);
    expect(() => limited.start(start)).toThrowError(failure("capacity-refused", "incidents"));
  });

  it("counts dispatched attempts atomically, including failed and cancelled calls", async () => {
    const s = service({ maxToolCalls: 2 });
    const id = s.start(start).incident.id;
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => s.dispatchDiagnostic(id, origin)),
      ),
    );
    const tokens = attempts
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    expect(tokens).toHaveLength(2);
    for (const result of attempts)
      if (result.status === "rejected") expect(result.reason).toEqual(failure("budget-refused"));
    expect(s.inspect(id).dispatchedAttempts).toBe(2);
    s.releaseDiagnostic(tokens[0]!, "transport"); // includes a synchronous transport throw
    s.releaseDiagnostic(tokens[0]!);
    s.recordObservation(tokens[1]!, observation);
    expect(s.inspect(id).outcomes.map((outcome) => outcome.status)).toEqual([
      "failed",
      "successful",
    ]);
    expect(() => s.dispatchDiagnostic(id, origin)).toThrowError(failure("budget-refused"));
    const next = s.replace(id, s.inspect(id).revision, start);
    expect(next.dispatchedAttempts).toBe(0);
    expect(s.inspect(id).dispatchedAttempts).toBe(2);
    const cancelled = s.dispatchDiagnostic(next.incident.id, origin);
    s.releaseDiagnostic(cancelled);
    expect(s.inspect(next.incident.id).dispatchedAttempts).toBe(1);
  });

  it("rejects forged execution tokens and lifecycle changes while work is active", () => {
    const s = service();
    const id = s.start(start).incident.id;
    const token = s.dispatchDiagnostic(id, origin);
    const before = s.inspect(id);
    for (const mutate of [
      () => s.recordObservation({ ...token }, observation),
      () => service().recordObservation(token, observation),
      () => s.conclude(id, before.revision, "inconclusive", conclusion),
      () => s.replace(id, before.revision, start),
    ])
      expect(mutate).toThrow(DomainError);
    s.releaseDiagnostic({ ...token });
    expect(s.inspect(id)).toEqual(before);
    s.releaseDiagnostic(token, "stale");
    expect(() => s.recordObservation(token, observation)).toThrow(DomainError);
    expect(s.inspect(id).outcomes[0]).toMatchObject({
      status: "interrupted",
      explanation: "The diagnostic operation was invalidated.",
    });
    s.conclude(id, s.inspect(id).revision, "inconclusive", conclusion);
    s.releaseDiagnostic(token);
  });

  it("commits out-of-order observations with exact provenance and matching aggregate targets", () => {
    let clock = now;
    const s = service({ clock: () => new Date(clock) });
    const id = s.start(start).incident.id;
    const a = s.dispatchDiagnostic(id, { ...origin, target });
    const b = s.dispatchDiagnostic(id, {
      ...origin,
      context: "beta",
      namespace: "ns",
      container: "app",
      target: { ...target, context: "beta", namespace: "ns" },
    });

    s.setFocus(id, s.inspect(id).revision, "Concurrent ordinary change");
    s.upsertHypothesis(id, hypothesis);
    clock = "2026-10-23T12:00:02.000Z";
    const eb = s.recordObservation(b, {
      ...observation,
      excerpt: "",
      truncated: true,
      completedAt: clock,
    });
    const ea = s.recordObservation(a, { ...observation, completedAt: "2026-10-23T12:00:01.000Z" });
    const state = s.inspect(id);
    expect(state.updatedAt).toBe(clock);
    expect(state.evidence).toEqual([eb, ea]);
    expect(state.targets).toEqual([eb.target, target]);
    expect(state.outcomes[0]).toMatchObject({
      context: "beta",
      namespace: "ns",
      status: "partial",
      inventoryRevision: 2,
      connectionGeneration: 3,
      scopeRevision: 1,
    });
    expect(ea).not.toHaveProperty("namespace");
    expect(s.evidenceList(id, { size: 1 }).items).toEqual([eb]);
    expect(s.evidenceGet(id, ea.id)).toBe(ea);
    const before = s.capacity(id);
    expect(s.recordObservation(a, { ...observation, completedAt: ea.completedAt })).toBe(ea);
    expect(() => s.recordObservation(a, observation)).toThrow(DomainError);
    expect(s.capacity(id)).toEqual(before);

    // Only evidence content is counted; aggregate state and read snapshots cost nothing.
    expect(s.capacity(id).bytes.retained).toBe(retainedContentBytes(state.evidence));
    expect(Reflect.set(state.outcomes[0]!, "status", "failed")).toBe(true);
    expect(s.inspect(id).outcomes[0]?.status).toBe("partial");
  });

  it("preserves state on malformed completion and settles explicit failure", () => {
    const s = service();
    const id = s.start(start).incident.id;
    const token = s.dispatchDiagnostic(id, origin);

    const before = s.inspect(id);
    const bytes = s.capacity(id);
    for (const input of [
      { ...observation, excerpt: "x".repeat(1001) },
      { ...observation, completedAt: "2026-10-23T12:00:01.000Z" },
      { ...observation, completedAt: "2026-10-23T11:59:59.000Z" },
    ])
      expect(() => s.recordObservation(token, input)).toThrow(DomainError);
    expect(s.inspect(id)).toEqual(before);
    expect(s.capacity(id)).toEqual(bytes);
    s.releaseDiagnostic(token, "malformed");
    expect(s.inspect(id).evidence).toEqual([]);
    expect(s.inspect(id).outcomes[0]).toMatchObject({
      status: "failed",
      explanation: "The diagnostic response could not be presented.",
    });
  });

  it.each([
    "authentication",
    "authorization",
    "timeout",
    "transport",
    "tool",
    "malformed",
    "cancelled",
    "stale",
  ] as const)("retains safe distinct %s outcomes without successful evidence", (category) => {
    const s = service();
    const id = s.start(start).incident.id;
    const token = s.dispatchDiagnostic(id, origin);

    s.releaseDiagnostic(token, category);
    const state = s.inspect(id);
    expect(state.dispatchedAttempts).toBe(1);
    expect(state.evidence).toEqual([]);
    expect(state.outcomes).toHaveLength(1);
    expect(state.outcomes[0]?.explanation).toBeTruthy();
    expect(s.capacity(id).bytes.retained).toBe(retainedContentBytes(state.evidence));
    s.releaseDiagnostic(token, category);
    expect(s.inspect(id)).toEqual(state);
  });

  it("isolates incident count and byte capacity and keeps failed writes atomic", () => {
    const probe = service();
    const probeId = probe.start(start).incident.id;
    const bytes = retainedContentBytes(capture(probe, probeId).evidence);
    const s = service({ maxEvidence: 1, maxBytes: bytes });
    const a = s.start(start).incident.id;
    const first = capture(s, a);
    const b = s.start(start).incident.id;
    expect(s.capacity(b).bytes.retained).toBe(0);
    expect(s.capacity(a).evidence).toBe(1);
    const second = capture(s, b);
    expect(s.capacity(b)).toEqual(s.capacity(a));
    s.conclude(a, s.inspect(a).revision, "inconclusive", conclusion);
    const c = s.start(start).incident.id;
    expect(capture(s, c).evidence.incidentId).toBe(c);
    expect(s.capacity(c)).toEqual(s.capacity(a));
    expect(s.evidenceGet(a, first.evidence.id)).toBe(first.evidence);
    expect(() => s.evidenceGet(b, first.evidence.id)).toThrowError(failure("missing-reference"));
    const third = s.dispatchDiagnostic(b, origin);
    const before = s.inspect(b);
    const capacity = s.capacity(b);
    expect(() => s.recordObservation(third, observation)).toThrowError(
      failure("capacity-refused", "evidence"),
    );
    expect(s.inspect(b)).toEqual(before);
    expect(s.capacity(b)).toEqual(capacity);
    expect(s.evidenceGet(b, second.evidence.id)).toBe(second.evidence);
    s.releaseDiagnostic(third, "tool");
  });

  it("rejects scope/origin mismatch and duplicate generated IDs atomically", () => {
    const s = service({ createId: (kind) => kind });
    const id = s.start(start).incident.id;
    const before = s.capacity(id);
    expect(() => s.start(start)).toThrow(DomainError);
    expect(() => s.dispatchDiagnostic(id, { ...origin, context: "outside" })).toThrowError(
      failure("scope-mismatch"),
    );
    expect(() =>
      s.dispatchDiagnostic(id, { ...origin, target: { ...target, context: "beta" } }),
    ).toThrow(DomainError);
    expect(s.capacity(id)).toEqual(before);
    const token = s.dispatchDiagnostic(id, origin);
    expect(() => s.dispatchDiagnostic(id, origin)).toThrow(DomainError);

    s.recordObservation(token, observation);
    expect(() => s.dispatchDiagnostic(id, origin)).toThrow(DomainError);
    s.upsertHypothesis(id, hypothesis);
    expect(() => s.upsertHypothesis(id, hypothesis)).toThrow(DomainError);
  });

  it("uses actual UTF-8 bytes and refuses one-byte overflow without partial commits", () => {
    const input = { ...observation, excerpt: "🙂".repeat(500) };
    const probe = service();
    const id = probe.start(start).incident.id;
    capture(probe, id, input);
    const bytes = probe.capacity(id).bytes.retained;
    const exact = service({ maxBytes: bytes });
    const exactId = exact.start(start).incident.id;
    capture(exact, exactId, input);
    expect(exact.capacity(exactId).bytes.retained).toBe(bytes);
    expect(bytes).toBe(retainedContentBytes(exact.inspect(exactId).evidence));

    const short = service({ maxBytes: bytes - 1 });
    const shortId = short.start(start).incident.id;
    const token = short.dispatchDiagnostic(shortId, origin);
    const before = short.inspect(shortId);
    const capacity = short.capacity(shortId);
    expect(() => short.recordObservation(token, input)).toThrowError(
      failure("capacity-refused", "bytes"),
    );
    expect(short.inspect(shortId)).toEqual(before);
    expect(short.capacity(shortId)).toEqual(capacity);
    expect(short.evidenceList(shortId).items).toEqual([]);
    short.releaseDiagnostic(token, "malformed");
  });

  it("allows metadata updates and failure settlement when the evidence byte budget is full", () => {
    const probe = service();
    const id = probe.start(start).incident.id;
    const bytes = retainedContentBytes(capture(probe, id).evidence);
    const s = service({ maxBytes: bytes });
    const initial = s.start(start);
    expect(s.capacity(initial.incident.id).bytes.retained).toBe(0);
    const limitedId = initial.incident.id;
    capture(s, limitedId);
    const capacity = s.capacity(initial.incident.id);
    s.setFocus(limitedId, s.inspect(limitedId).revision, "Additional focus");
    s.setTargets(limitedId, s.inspect(limitedId).revision, [target]);
    s.upsertHypothesis(limitedId, hypothesis);
    const token = s.dispatchDiagnostic(limitedId, origin);
    expect(() => s.recordObservation(token, observation)).toThrowError(
      failure("capacity-refused", "bytes"),
    );
    s.releaseDiagnostic(token, "tool");
    expect(s.inspect(limitedId).outcomes.at(-1)?.status).toBe("failed");
    const next = s.replace(limitedId, s.inspect(limitedId).revision, start);
    s.conclude(next.incident.id, next.revision, "inconclusive", conclusion);
    expect(s.capacity(initial.incident.id)).toEqual(capacity);
    expect(() => s.recordObservation(token, observation)).toThrow(DomainError);
  });

  it("keeps only safe bounded observation content and cannot overwrite execution provenance", () => {
    const s = service();
    const id = s.start(start).incident.id;
    const input = {
      ...observation,
      excerpt: "token=private",
      context: "beta",
      raw: "private",
      target,
    };
    const { evidence } = capture(s, id, input);
    expect(evidence).toMatchObject({ context: "alpha", excerpt: "token=[REDACTED]" });
    expect(evidence).not.toHaveProperty("raw");
    expect(evidence).not.toHaveProperty("target");
    expect(s.inspect(id).targets).toEqual([]);
    const before = s.inspect(id);
    expect(() => s.evidenceGet("missing", evidence.id)).toThrowError(failure("missing-reference"));
    const next = s.start(start).incident.id;
    expect(() => s.evidenceGet(next, evidence.id)).toThrowError(failure("missing-reference"));
    expect(s.inspect(id)).toEqual(before);
  });

  it("rejects a backwards clock without changing state or accounting", () => {
    let clock = now;
    const s = service({ clock: () => new Date(clock) });
    const id = s.start(start).incident.id;
    const initial = s.inspect(id);
    const bytes = s.capacity(id);
    clock = "2026-10-23T11:59:59.000Z";
    expect(() => s.setFocus(id, 1, "focus")).toThrow(DomainError);
    expect(() => s.replace(id, 1, start)).toThrow(DomainError);
    expect(s.inspect(id)).toEqual(initial);
    expect(s.capacity(id)).toEqual(bytes);
  });

  it("flushes a complete redacted JSONL investigation before releasing its memory slot", async () => {
    const directory = await archiveDirectory();
    const path = join(directory, "incident.jsonl");
    const s = service({ maxIncidents: 1 });
    const id = s.start({ ...start, question: "token=private" }).incident.id;
    s.setFocus(id, s.inspect(id).revision, "Inspect image pull");
    const first = capture(
      s,
      id,
      { ...observation, excerpt: "token=private\né🙂" },
      { ...origin, target },
    );
    const second = capture(s, id);
    const failed = s.dispatchDiagnostic(id, origin);
    s.releaseDiagnostic(failed, "authentication");
    const h = s.upsertHypothesis(id, {
      ...hypothesis,
      status: "supported",
      supportingEvidence: [first.evidence.id],
    });
    const terminal = s.conclude(id, s.inspect(id).revision, "resolved", {
      ...conclusion,
      hypothesisIds: [h.id],
      evidenceIds: [first.evidence.id],
    });
    expect(() => s.start(start)).toThrowError(failure("capacity-refused", "incidents"));
    const flushing = s.flush(id, path);
    expect(s.inspect(id)).toEqual(terminal);
    const receipt = await flushing;
    expect(receipt).toEqual({ incidentId: id, path, evidenceCount: 2 });
    expect(Object.isFrozen(receipt)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("private");
    expect(text.endsWith("\n")).toBe(true);
    const records: unknown[] = text
      .trimEnd()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    const { evidence, ...metadata } = terminal;
    expect(records).toEqual([
      { type: "investigation", version: 1, state: metadata, evidenceCount: 2 },
      ...evidence.map((item) => ({ type: "evidence", evidence: item })),
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["incident.jsonl"]);
    for (const read of [
      () => s.inspect(id),
      () => s.capacity(id),
      () => s.evidenceGet(id, second.evidence.id),
      () => s.evidenceList(id),
      () => s.recordObservation(first.token, { ...observation, excerpt: first.evidence.excerpt }),
    ])
      expect(read).toThrowError(failure("missing-reference"));
    const next = s.start(start).incident.id;
    expect(s.capacity(next).bytes.retained).toBe(0);
    expect(capture(s, next).evidence.incidentId).toBe(next);
  });

  it("refuses unknown/open investigations and relative paths without flushing state", async () => {
    const directory = await archiveDirectory();
    const path = join(directory, "incident.jsonl");
    const s = service();
    await expect(s.flush("unknown", path)).rejects.toEqual(failure("missing-reference"));
    const id = s.start(start).incident.id;
    await expect(s.flush(id, path)).rejects.toEqual(failure("invalid-state"));
    const token = s.dispatchDiagnostic(id, origin);
    await expect(s.flush(id, path)).rejects.toEqual(failure("invalid-state"));
    expect(s.inspect(id).dispatchedAttempts).toBe(1);
    s.releaseDiagnostic(token);
    const terminal = s.conclude(id, s.inspect(id).revision, "inconclusive", conclusion);
    await expect(s.flush(id, "relative.jsonl")).rejects.toEqual(failure("invalid-state"));
    expect(s.inspect(id)).toEqual(terminal);
    expect(await readdir(directory)).toEqual([]);
    await s.flush(id, path);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "investigation", evidenceCount: 0 });
  });

  it("retains state on archive failures, refuses existing destinations and allows retry", async () => {
    const directory = await archiveDirectory();
    const path = join(directory, "existing.jsonl");
    const alias = join(directory, "alias.jsonl");
    const s = service({ maxIncidents: 1 });
    const id = s.start(start).incident.id;
    capture(s, id);
    const terminal = s.conclude(id, s.inspect(id).revision, "inconclusive", conclusion);
    const capacity = s.capacity(id);
    await writeFile(path, "existing content");
    await symlink(path, alias);
    for (const destination of [join(directory, "missing", "incident.jsonl"), path, alias]) {
      await expect(s.flush(id, destination)).rejects.toMatchObject({
        message: expect.stringContaining(id),
        cause: expect.any(Error),
      });
      expect(s.inspect(id)).toEqual(terminal);
      expect(s.capacity(id)).toEqual(capacity);
      expect(() => s.start(start)).toThrowError(failure("capacity-refused", "incidents"));
      expect((await readdir(directory)).sort()).toEqual(["alias.jsonl", "existing.jsonl"]);
    }
    expect(await readFile(path, "utf8")).toBe("existing content");
    await s.flush(id, join(directory, "retry.jsonl"));
    expect(s.start(start).evidence).toEqual([]);
  });

  it("rejects concurrent flushes for one incident while another investigation continues", async () => {
    const directory = await archiveDirectory();
    const s = service();
    const a = s.start(start).incident.id;
    capture(s, a);
    s.conclude(a, s.inspect(a).revision, "inconclusive", conclusion);
    const b = s.start(start).incident.id;
    const first = s.flush(a, join(directory, "first.jsonl"));
    const duplicate = s.flush(a, join(directory, "duplicate.jsonl"));
    capture(s, b);
    expect(s.capacity(b).evidence).toBe(1);
    const results = await Promise.allSettled([first, duplicate]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: failure("invalid-state") });
    expect(await readdir(directory)).toEqual(["first.jsonl"]);
    expect(s.inspect(b).incident.status).toBe("investigating");
  });
});
