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
    incidentId?: string;
    maxBytes?: number;
    createId?: () => string;
  } = {},
): EvidenceStore {
  let id = 0;
  return new EvidenceStore({
    incidentId: "I1",
    maxExcerptChars: 8000,
    createId: () => `E${++id}`,
    ...options,
  });
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

  it("binds one incident and isolates records, IDs and capacity between stores", () => {
    const first = store({ maxEvidence: 1 });
    const other = store({ incidentId: "I2", maxEvidence: 1 });
    const record = first.append(observation()).evidence;
    expect(other.list().items).toEqual([]);
    expect(() => other.get(record.id)).toThrowError(
      expect.objectContaining({ failure: { kind: "missing-reference" } }),
    );
    expect(() => first.append(observation("X2", "I2"))).toThrow(DomainError);
    expect(() => first.get("unknown")).toThrow(DomainError);
    expect(() => first.append(observation("X2"))).toThrowError(capacityFailure("evidence"));
    other.append(observation("X2", "I2"));
    expect(first.list().items).toEqual([record]);
    expect(other.list().items).toHaveLength(1);
    expect(() => store({ incidentId: "" })).toThrow(DomainError);
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
    const page = evidence.list();
    expect(Reflect.set(page.items, "0", {})).toBe(false);
    expect(Reflect.set(page, "cursor", "changed")).toBe(false);
    expect(evidence.get(first.id)).toBe(first);
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
    const first = evidence.list({ size: 2 });
    expect(first.items.map((item) => item.executionId)).toEqual(["X1", "X2"]);
    evidence.append(observation("X6"));
    store({ incidentId: "I2" }).append(observation("X7", "I2"));
    const second = evidence.list({ size: 2, cursor: first.cursor! });
    const third = evidence.list({ size: 2, cursor: second.cursor! });
    expect(second.items.map((item) => item.executionId)).toEqual(["X3", "X4"]);
    expect(third.items.map((item) => item.executionId)).toEqual(["X5"]);
    expect(third.cursor).toBeUndefined();
    expect(evidence.list().items).toHaveLength(6);
    expect(evidence.list({ size: 2, cursor: first.cursor! })).toEqual(second);
  });

  it("rejects unknown, altered, cross-incident and cross-store cursors and invalid sizes", () => {
    const evidence = store();
    for (let i = 0; i < 3; i++) evidence.append(observation(`X${i}`));
    const cursor = evidence.list({ size: 1 }).cursor!;
    for (const action of [
      () => store({ incidentId: "I2" }).list({ cursor }),
      () => store().list({ cursor }),
      () => evidence.list({ cursor: `${cursor}x` }),
      () => evidence.list({ cursor: "unknown" }),
    ])
      expect(action).toThrow(DomainError);
    for (const size of [0, -1, 51, 1.5, Infinity, NaN])
      expect(() => evidence.list({ size })).toThrow(DomainError);
  });

  it("bounds full serialized pages with whole records and usable continuation", () => {
    const evidence = store();
    for (let i = 0; i < 4; i++) evidence.append(observation(`X${i}`));
    const one = evidence.list({ size: 1 });
    const maxBytes = Buffer.byteLength(JSON.stringify(one), "utf8");
    const reduced = evidence.list({ size: 4, maxBytes });
    expect(reduced).toEqual(one);
    expect(evidence.list({ cursor: reduced.cursor!, maxBytes }).items[0]?.executionId).toBe("X1");
    expect(() => evidence.list({ maxBytes: 10 })).toThrowError(capacityFailure("bytes"));
    expect(() => store().list({ maxBytes: 1 })).toThrowError(capacityFailure("bytes"));
  });

  it("uses default 20 and maximum 50 record pages", () => {
    const evidence = store();
    for (let i = 0; i < 55; i++) evidence.append(observation(`X${i}`));
    expect(evidence.list().items).toHaveLength(20);
    expect(evidence.list({ size: 50 }).items).toHaveLength(50);
  });

  it("charges UTF-8 string content exactly once and accepts the exact byte boundary", () => {
    const input = { ...observation(), excerpt: "é🙂", namespace: "ns", container: "app" };
    const measured = store().append(input).evidence;
    const bytes = retainedContentBytes(measured);
    expect(retainedContentBytes({ nested: ["é", "🙂"], count: 3 })).toBe(6);
    const evidence = store({ maxBytes: bytes });
    evidence.append(input);
    expect(evidence.capacity().bytes).toEqual({ limit: bytes, retained: bytes });
    const before = evidence.capacity();
    expect(evidence.append(input).status).toBe("already-committed");
    expect(() => evidence.append(observation("X2"))).toThrowError(capacityFailure("bytes"));
    expect(evidence.capacity()).toEqual(before);
    const tooSmall = store({ maxBytes: bytes - 1 });
    expect(() => tooSmall.append(input)).toThrowError(capacityFailure("bytes"));
    expect(tooSmall.list().items).toEqual([]);
  });

  it("refuses concurrent appends after capacity is consumed", async () => {
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
    });
    expect(evidence.list().items.map((item) => item.executionId)).toEqual(["X0", "X1"]);
  });

  it("refuses duplicate IDs and malformed writes without changing records or capacity", () => {
    const evidence = store({ createId: () => "E1" });
    evidence.append(observation());
    const before = evidence.capacity();
    expect(() => evidence.append(observation("X2"))).toThrow(DomainError);
    expect(() => evidence.append({ ...observation("X3"), context: "beta" })).toThrow(DomainError);
    expect(evidence.capacity()).toEqual(before);
    expect(evidence.list().items).toHaveLength(1);
  });

  it("isolates evidence capacity across applications", () => {
    const evidence = store();
    const first = evidence.append(observation()).evidence;
    const independent = store();
    expect(independent.capacity().evidence).toBe(0);
    expect(() => independent.get(first.id)).toThrow(DomainError);
    expect(independent.append(observation()).status).toBe("committed");
  });
});

describe("ContentCapacity", () => {
  it("atomically checks actual replacements, including shrinking at full capacity", () => {
    const capacity = new ContentCapacity(20);
    capacity.replace(0, 20);
    const before = capacity.snapshot();
    expect(() => capacity.replace(10, 11)).toThrowError(capacityFailure("bytes"));
    expect(capacity.snapshot()).toEqual(before);
    capacity.replace(20, 4);
    expect(capacity.snapshot()).toEqual({ limit: 20, retained: 4 });
    capacity.replace(0, 16);
    expect(capacity.snapshot().retained).toBe(20);
  });

  it("rejects invalid byte counts without changing accounting", () => {
    const capacity = new ContentCapacity(10);
    for (const bytes of [-1, 1.5, Infinity, NaN]) {
      expect(() => capacity.assertFits(bytes)).toThrow(DomainError);
      expect(() => capacity.replace(0, bytes)).toThrow(DomainError);
    }
    expect(() => capacity.replace(1, 0)).toThrow(DomainError);
    expect(() => capacity.replace(0, 11)).toThrowError(capacityFailure("bytes"));
    expect(capacity.snapshot()).toEqual({ limit: 10, retained: 0 });
  });
});
