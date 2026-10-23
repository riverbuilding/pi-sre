import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DomainError } from "../../../src/domain/errors.js";
import {
  ContentCapacity,
  retainedContentBytes,
} from "../../../src/investigation/content-capacity.js";
import { EvidenceStore } from "../../../src/investigation/evidence-store.js";
import type { Observation } from "../../../src/investigation/evidence-store.js";

function observation(executionId = "X1", incidentId = "I1"): Observation {
  return {
    incidentId,
    executionId,
    source: "kubernetes",
    operation: "pods_get",
    completedAt: "2026-10-22T12:00:00.000Z",
    context: "alpha",
    excerpt: "same observation",
    scopeRevision: 1,
    inventoryRevision: 2,
    connectionGeneration: 3,
    truncated: false,
    target: { context: "alpha", kind: "Pod", name: "app" },
  };
}

function store(
  options: {
    maxEvidence?: number;
    maxIncidents?: number;
    capacity?: ContentCapacity;
    createId?: () => string;
  } = {},
): EvidenceStore {
  let id = 0;
  const result = new EvidenceStore({
    maxExcerptChars: 8000,
    createId: () => `E${++id}`,
    ...options,
  });
  result.registerIncident("I1");
  result.registerIncident("I2");
  return result;
}

const capacityFailure = (resource: string) =>
  expect.objectContaining({ failure: { kind: "capacity-refused", resource } });

describe("EvidenceStore", () => {
  it("assigns stable IDs per execution rather than deduplicating identical text", () => {
    const evidence = store();
    const first = evidence.append(observation());
    const second = evidence.append(observation("X2"));
    expect(first.status).toBe("committed");
    expect(second.evidence.id).not.toBe(first.evidence.id);
    expect(evidence.append(observation())).toEqual({
      status: "already-committed",
      evidence: first.evidence,
    });
    expect(() => evidence.append({ ...observation(), excerpt: "different" })).toThrow(DomainError);
    expect(() => evidence.append(observation("X1", "I2"))).toThrow(DomainError);
    expect(evidence.capacity().evidence).toBe(2);
  });

  it("isolates incidents and never manufactures a collection or falls back on unknown IDs", () => {
    const evidence = store();
    const first = evidence.append(observation()).evidence;
    evidence.append(observation("X2", "I2"));
    expect(evidence.list("I1").items).toEqual([first]);
    for (const action of [
      () => evidence.get("I2", first.id),
      () => evidence.get("I1", "unknown"),
      () => evidence.list("unknown"),
      () => evidence.reserve("unknown", "X3", 100),
      () => evidence.append(observation("X3", "unknown")),
    ])
      expect(action).toThrowError(
        expect.objectContaining({ failure: { kind: "missing-reference" } }),
      );
    expect(evidence.list("I2").items).toHaveLength(1);
    const empty = new EvidenceStore({ maxExcerptChars: 10, maxIncidents: 1 });
    empty.registerIncident("I1");
    empty.registerIncident("I1");
    expect(empty.list("I1").items).toEqual([]);
    expect(() => empty.registerIncident("I2")).toThrowError(capacityFailure("incidents"));
  });

  it("retains only redacted, bounded domain fields and freezes every read", () => {
    const evidence = store();
    const input = {
      ...observation(),
      excerpt: "token=private",
      target: { context: "alpha", kind: "Pod", name: "app" },
      raw: { credential: "never retain" },
      artifactRef: "never retain",
    };
    const first = evidence.append(input).evidence;
    input.target!.name = "changed";
    expect(first.excerpt).toBe("token=[REDACTED]");
    expect(first).not.toHaveProperty("raw");
    expect(first).not.toHaveProperty("artifactRef");
    expect(first.target?.name).toBe("app");
    expect(Reflect.set(first, "excerpt", "changed")).toBe(false);
    expect(Reflect.set(first.target!, "name", "changed")).toBe(false);
    const page = evidence.list("I1");
    expect(Reflect.set(page.items, "0", {})).toBe(false);
    expect(Reflect.set(page, "cursor", "changed")).toBe(false);
    expect(evidence.get("I1", first.id)).toBe(first);
    expect(Object.isFrozen(evidence.capacity().bytes)).toBe(true);
    expect(() => evidence.append({ ...observation("X2"), excerpt: "x".repeat(8001) })).toThrow(
      DomainError,
    );
  });

  it("records empty and partial observations without inventing missing namespace", () => {
    const evidence = store();
    const first = evidence.append({ ...observation(), excerpt: "", truncated: true }).evidence;
    expect(first).toMatchObject({ excerpt: "", truncated: true });
    expect(first).not.toHaveProperty("namespace");
    expect(first.target).not.toHaveProperty("namespace");
  });

  it("keeps insertion order and captures a high-water mark across interleaved appends", () => {
    const evidence = store();
    for (let i = 1; i <= 5; i++) evidence.append(observation(`X${i}`));
    const first = evidence.list("I1", { size: 2 });
    expect(first.items.map((item) => item.executionId)).toEqual(["X1", "X2"]);
    evidence.append(observation("X6"));
    evidence.append(observation("X7", "I2"));
    const second = evidence.list("I1", { size: 2, cursor: first.cursor! });
    const third = evidence.list("I1", { size: 2, cursor: second.cursor! });
    expect(second.items.map((item) => item.executionId)).toEqual(["X3", "X4"]);
    expect(third.items.map((item) => item.executionId)).toEqual(["X5"]);
    expect(third.cursor).toBeUndefined();
    expect(evidence.list("I1").items).toHaveLength(6);
    expect(evidence.list("I1", { size: 2, cursor: first.cursor! })).toEqual(second);
  });

  it("rejects unknown, altered, cross-incident and cross-store cursors and invalid sizes", () => {
    const evidence = store();
    for (let i = 0; i < 3; i++) evidence.append(observation(`X${i}`));
    const cursor = evidence.list("I1", { size: 1 }).cursor!;
    for (const action of [
      () => evidence.list("I2", { cursor }),
      () => store().list("I1", { cursor }),
      () => evidence.list("I1", { cursor: `${cursor}x` }),
      () => evidence.list("I1", { cursor: "unknown" }),
    ])
      expect(action).toThrow(DomainError);
    for (const size of [0, -1, 51, 1.5, Infinity, NaN])
      expect(() => evidence.list("I1", { size })).toThrow(DomainError);
  });

  it("bounds full serialized pages with whole records and usable continuation", () => {
    const evidence = store();
    for (let i = 0; i < 4; i++) evidence.append(observation(`X${i}`));
    const one = evidence.list("I1", { size: 1 });
    const maxBytes = Buffer.byteLength(JSON.stringify(one), "utf8");
    const reduced = evidence.list("I1", { size: 4, maxBytes });
    expect(reduced).toEqual(one);
    expect(evidence.list("I1", { cursor: reduced.cursor!, maxBytes }).items[0]?.executionId).toBe(
      "X1",
    );
    expect(() => evidence.list("I1", { maxBytes: 10 })).toThrowError(capacityFailure("bytes"));
    expect(() => store().list("I1", { maxBytes: 1 })).toThrowError(capacityFailure("bytes"));
  });

  it("uses default 20 and maximum 50 record pages", () => {
    const evidence = store();
    for (let i = 0; i < 55; i++) evidence.append(observation(`X${i}`));
    expect(evidence.list("I1").items).toHaveLength(20);
    expect(evidence.list("I1", { size: 50 }).items).toHaveLength(50);
  });

  it("charges UTF-8 string content exactly once and accepts the exact byte boundary", () => {
    const input = { ...observation(), excerpt: "é🙂", namespace: "ns", container: "app" };
    const measured = store().append(input).evidence;
    const bytes = retainedContentBytes(measured);
    expect(retainedContentBytes({ nested: ["é", "🙂"], count: 3 })).toBe(6);
    const evidence = store({ capacity: new ContentCapacity(bytes) });
    evidence.append(input);
    expect(evidence.capacity().bytes).toEqual({ limit: bytes, retained: bytes, reserved: 0 });
    const before = evidence.capacity();
    expect(evidence.append(input).status).toBe("already-committed");
    expect(() => evidence.append(observation("X2"))).toThrowError(capacityFailure("bytes"));
    expect(evidence.capacity()).toEqual(before);
    const tooSmall = store({ capacity: new ContentCapacity(bytes - 1) });
    expect(() => tooSmall.append(input)).toThrowError(capacityFailure("bytes"));
    expect(tooSmall.list("I1").items).toEqual([]);
  });

  it("holds count and byte reservations across concurrent completions", async () => {
    const evidence = store({ maxEvidence: 2, capacity: new ContentCapacity(1000) });
    const a = evidence.reserve("I1", "X1", 500);
    const b = evidence.reserve("I2", "X2", 500);
    expect(evidence.capacity()).toMatchObject({
      evidence: 0,
      reservedEvidence: 2,
      bytes: { reserved: 1000 },
    });
    expect(evidence.list("I1").items).toEqual([]);
    expect(() => evidence.reserve("I1", "X3", 1)).toThrowError(capacityFailure("evidence"));
    const result = await Promise.all([
      Promise.resolve().then(() => evidence.append(observation("X2", "I2"), b)),
      Promise.resolve().then(() => evidence.append(observation(), a)),
    ]);
    expect(result.map((item) => item.evidence.id)).toEqual([b.evidenceId, a.evidenceId]);
    expect(evidence.capacity()).toMatchObject({
      evidence: 2,
      reservedEvidence: 0,
      bytes: {
        reserved: 0,
        retained: result.reduce((total, item) => total + retainedContentBytes(item.evidence), 0),
      },
    });
    expect(evidence.append(observation(), a).status).toBe("already-committed");
    expect(() => evidence.append(observation(), { ...a })).toThrow(DomainError);
  });

  it("refuses concurrent unreserved appends after capacity is consumed", async () => {
    const evidence = store({ maxEvidence: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() => evidence.append(observation(`X${i}`))),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(6);
    for (const failure of failures) expect(failure.reason).toEqual(capacityFailure("evidence"));
    expect(evidence.capacity()).toMatchObject({
      evidence: 2,
      reservedEvidence: 0,
      bytes: { reserved: 0 },
    });
    expect(evidence.list("I1").items.map((item) => item.executionId)).toEqual(["X0", "X1"]);
  });

  it("refuses byte oversubscription while count capacity remains available", () => {
    const evidence = store({ maxEvidence: 10, capacity: new ContentCapacity(1000) });
    const first = evidence.reserve("I1", "X1", 700);
    expect(() => evidence.reserve("I2", "X2", 301)).toThrowError(capacityFailure("bytes"));
    expect(evidence.capacity()).toMatchObject({ reservedEvidence: 1, bytes: { reserved: 700 } });
    const second = evidence.reserve("I2", "X2", 300);
    evidence.release(first);
    evidence.release(second);
    expect(evidence.capacity()).toMatchObject({ reservedEvidence: 0, bytes: { reserved: 0 } });
  });

  it("settles failures and cancellation exactly once without leaking capacity", () => {
    const evidence = store({ maxEvidence: 1, capacity: new ContentCapacity(1000) });
    const a = evidence.reserve("I1", "X1", 1000);
    evidence.release(a);
    evidence.release(a);
    expect(() => evidence.append(observation(), a)).toThrow(DomainError);
    const tooSmall = evidence.reserve("I1", "X2", 1);
    expect(() => evidence.append(observation("X2"), tooSmall)).toThrow(DomainError);
    const malformed = evidence.reserve("I1", "X3", 1000);
    expect(() => evidence.append({ ...observation("X3"), context: "beta" }, malformed)).toThrow(
      DomainError,
    );
    const mismatched = evidence.reserve("I1", "X4", 1000);
    expect(() => evidence.append(observation("X4", "I2"), mismatched)).toThrow(DomainError);
    expect(evidence.capacity()).toMatchObject({
      evidence: 0,
      reservedEvidence: 0,
      bytes: { retained: 0, reserved: 0 },
    });
    expect(evidence.append(observation("X5")).status).toBe("committed");
  });

  it("refuses copied and foreign reservations and duplicate IDs atomically", () => {
    const evidence = store({ createId: () => "E1" });
    const a = evidence.reserve("I1", "X1", 1000);
    expect(() => evidence.append(observation(), { ...a })).toThrow(DomainError);
    expect(() => store().append(observation(), a)).toThrow(DomainError);
    expect(() => evidence.reserve("I1", "X1", 1000)).toThrow(DomainError);
    expect(() => evidence.reserve("I1", "X2", 1000)).toThrow(DomainError);
    expect(evidence.capacity().reservedEvidence).toBe(1);
    evidence.append(observation(), a);
    const before = evidence.capacity();
    expect(() => evidence.append(observation("X2"))).toThrow(DomainError);
    expect(evidence.capacity()).toEqual(before);
  });

  it("coordinates with other domain content and shares no state across applications", () => {
    const capacity = new ContentCapacity(1000);
    const otherDomainContent = capacity.reserve(800);
    const evidence = store({ capacity });
    expect(() => evidence.reserve("I1", "X1", 201)).toThrowError(capacityFailure("bytes"));
    capacity.release(otherDomainContent);
    const attempt = evidence.reserve("I1", "X1", 1000);
    evidence.append(observation(), attempt);
    const independent = store();
    expect(independent.capacity().evidence).toBe(0);
    expect(() => independent.get("I1", attempt.evidenceId)).toThrow(DomainError);
    expect(independent.append(observation()).status).toBe("committed");
  });
});

describe("ContentCapacity", () => {
  it("rejects invalid and foreign reservations and preserves accounting on failed commit", () => {
    const capacity = new ContentCapacity(10);
    for (const bytes of [0, -1, 1.5, NaN, Infinity])
      expect(() => capacity.reserve(bytes)).toThrow(DomainError);
    const token = capacity.reserve(10);
    expect(() => capacity.commit({ ...token }, 10)).toThrow(DomainError);
    expect(() => capacity.commit(token, 11)).toThrow(DomainError);
    expect(capacity.snapshot()).toEqual({ limit: 10, retained: 0, reserved: 10 });
    capacity.commit(token, 6);
    capacity.release(token);
    expect(() => capacity.commit(token, 6)).toThrow(DomainError);
    expect(capacity.snapshot()).toEqual({ limit: 10, retained: 6, reserved: 0 });
    const released = capacity.reserve(4);
    capacity.release(released);
    expect(() => capacity.commit(released, 1)).toThrow(DomainError);
  });
});
