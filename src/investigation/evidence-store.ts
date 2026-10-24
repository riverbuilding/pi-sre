import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DomainError, requireDomain } from "../domain/errors.js";
import { createEvidence } from "../domain/evidence.js";
import type { Evidence } from "../domain/evidence.js";
import { identity, positiveInteger } from "../domain/validation.js";
import { ContentCapacity, retainedContentBytes } from "./content-capacity.js";

export const DEFAULT_EVIDENCE_LIMIT = 1_000;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_EVIDENCE_PAGE_BYTES = 64 * 1024;

export type Observation = Omit<Evidence, "id"> & { readonly id?: string };

export interface EvidencePage {
  readonly items: readonly Evidence[];
  readonly cursor?: string;
}

export interface EvidenceStoreOptions {
  readonly incidentId: string;
  readonly maxExcerptChars: number;
  readonly maxEvidence?: number;
  readonly maxBytes?: number;
  readonly createId?: () => string;
}

export type AppendResult = {
  readonly status: "committed" | "already-committed";
  readonly evidence: Evidence;
};

interface StoredEvidence {
  readonly evidence: Evidence;
  readonly sequence: number;
}

/** One incident owns this in-memory collection and its independent capacity. Authority and incident lifecycle belong to the service. */
export class EvidenceStore {
  readonly #capacity: ContentCapacity;
  readonly #maxEvidence: number;
  readonly #incidentId: string;
  readonly #maxExcerptChars: number;
  readonly #createId: () => string;
  readonly #records = new Map<string, StoredEvidence>();
  readonly #evidence: Evidence[] = [];
  readonly #executions = new Map<string, Evidence>();
  readonly #cursorKey = randomBytes(32);
  #sequence = 0;

  constructor(options: EvidenceStoreOptions) {
    this.#capacity = new ContentCapacity(options.maxBytes);
    this.#maxEvidence = positiveInteger(options.maxEvidence ?? DEFAULT_EVIDENCE_LIMIT);
    this.#incidentId = identity(options.incidentId, 128);
    this.#maxExcerptChars = positiveInteger(options.maxExcerptChars);
    this.#createId = options.createId ?? randomUUID;
  }

  capacity(): Readonly<{
    evidence: number;
    maxEvidence: number;
    bytes: ReturnType<ContentCapacity["snapshot"]>;
  }> {
    return Object.freeze({
      evidence: this.#records.size,
      maxEvidence: this.#maxEvidence,
      bytes: this.#capacity.snapshot(),
    });
  }

  /** Validate and commit immediately; failed writes leave records and capacity unchanged. */
  append(input: Observation): AppendResult {
    requireDomain(
      input.incidentId === this.#incidentId,
      "Observation belongs to another incident.",
    );
    const previous = this.#executions.get(input.executionId);
    const evidence = createEvidence(
      { ...input, id: previous?.id ?? input.id ?? this.#createId() },
      this.#maxExcerptChars,
    );
    if (previous) {
      requireDomain(
        previous.incidentId === input.incidentId &&
          (input.id === undefined || input.id === previous.id) &&
          JSON.stringify(previous) === JSON.stringify(evidence),
        "Execution was already committed with a different observation.",
      );
      return Object.freeze({ status: "already-committed", evidence: previous });
    }
    if (this.#records.size >= this.#maxEvidence)
      throw new DomainError(
        { kind: "capacity-refused", resource: "evidence" },
        "Incident evidence storage is full; conclude this investigation before starting another.",
      );
    requireDomain(!this.#records.has(evidence.id), "Evidence ID must be unique.");
    this.#capacity.replace(0, retainedContentBytes(evidence));
    this.#records.set(evidence.id, { evidence, sequence: ++this.#sequence });
    this.#evidence.push(evidence);
    this.#executions.set(evidence.executionId, evidence);
    return Object.freeze({ status: "committed", evidence });
  }

  get(evidenceId: string): Evidence {
    identity(evidenceId, 128);
    const record = this.#records.get(evidenceId);
    if (!record)
      throw new DomainError(
        { kind: "missing-reference" },
        "Evidence must exist in the requested incident.",
      );
    return record.evidence;
  }

  /** Live read-only aggregate for internal validation; model-facing reads must use get/list. */
  get evidence(): readonly Evidence[] {
    return this.#evidence;
  }

  /** Detached collection; evidence records themselves are immutable. */
  snapshot(): readonly Evidence[] {
    return Object.freeze([...this.#evidence]);
  }

  /** Cursors are authenticated, collection/incident/store-bound high-water snapshots. */
  list(
    options: { readonly size?: number; readonly cursor?: string; readonly maxBytes?: number } = {},
  ): EvidencePage {
    const size = positiveInteger(options.size ?? DEFAULT_PAGE_SIZE);
    requireDomain(size <= MAX_PAGE_SIZE, "Evidence page size exceeds its limit.");
    const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_EVIDENCE_PAGE_BYTES);
    let after = 0;
    let highWater = this.#sequence;
    if (options.cursor !== undefined) {
      requireDomain(
        typeof options.cursor === "string" && options.cursor.length <= 2048,
        "Invalid evidence cursor.",
      );
      const [payload, signature, extra] = options.cursor.split(".");
      requireDomain(
        payload && signature && extra === undefined && this.#sign(payload) === signature,
        "Unknown or foreign evidence cursor.",
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        throw new DomainError({ kind: "invalid-state" }, "Invalid evidence cursor.");
      }
      requireDomain(
        Array.isArray(parsed) &&
          parsed.length === 3 &&
          parsed[0] === this.#incidentId &&
          Number.isSafeInteger(parsed[1]) &&
          Number.isSafeInteger(parsed[2]) &&
          parsed[1] >= 0 &&
          parsed[1] <= parsed[2] &&
          parsed[2] <= this.#sequence,
        "Cursor does not belong to this incident traversal.",
      );
      after = parsed[1];
      highWater = parsed[2];
    }
    const records = [...this.#records.values()].filter(
      (item) => item.sequence > after && item.sequence <= highWater,
    );
    const items: Evidence[] = [];
    let page: EvidencePage = Object.freeze({ items: Object.freeze([]) });
    for (const record of records.slice(0, size)) {
      const next = [...items, record.evidence];
      const cursor =
        next.length < records.length ? this.#cursor(record.sequence, highWater) : undefined;
      const candidate = Object.freeze({
        items: Object.freeze(next),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) break;
      items.push(record.evidence);
      page = candidate;
    }
    if (
      (records.length > 0 && items.length === 0) ||
      Buffer.byteLength(JSON.stringify(page), "utf8") > maxBytes
    )
      throw new DomainError(
        { kind: "capacity-refused", resource: "bytes" },
        "Evidence page cannot fit one complete record; increase its presentation budget.",
      );
    return page;
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#cursorKey).update(payload).digest("base64url");
  }

  #cursor(after: number, highWater: number): string {
    const payload = Buffer.from(JSON.stringify([this.#incidentId, after, highWater])).toString(
      "base64url",
    );
    return `${payload}.${this.#sign(payload)}`;
  }
}
