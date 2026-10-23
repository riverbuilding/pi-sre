import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DomainError, requireDomain } from "../domain/errors.js";
import { createEvidence } from "../domain/evidence.js";
import type { Evidence } from "../domain/evidence.js";
import { identity, positiveInteger } from "../domain/validation.js";
import { ContentCapacity, retainedContentBytes } from "./content-capacity.js";
import type { ContentReservation } from "./content-capacity.js";

export const DEFAULT_EVIDENCE_LIMIT = 1_000;
export const DEFAULT_INCIDENT_LIMIT = 20;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_EVIDENCE_PAGE_BYTES = 64 * 1024;

export type Observation = Omit<Evidence, "id">;

export interface EvidenceReservation {
  readonly evidenceId: string;
  readonly incidentId: string;
  readonly executionId: string;
  readonly bytes: number;
}

export interface EvidencePage {
  readonly items: readonly Evidence[];
  readonly cursor?: string;
}

export interface EvidenceStoreOptions {
  readonly maxExcerptChars: number;
  readonly maxEvidence?: number;
  readonly maxIncidents?: number;
  readonly capacity?: ContentCapacity;
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

/** In-memory safe excerpts only. Authority and incident lifecycle belong to the service. */
export class EvidenceStore {
  readonly #capacity: ContentCapacity;
  readonly #maxEvidence: number;
  readonly #maxIncidents: number;
  readonly #maxExcerptChars: number;
  readonly #createId: () => string;
  readonly #incidents = new Set<string>();
  readonly #records = new Map<string, StoredEvidence>();
  readonly #executions = new Map<string, Evidence>();
  readonly #reservations = new Map<EvidenceReservation, ContentReservation>();
  readonly #committedReservations = new WeakSet<EvidenceReservation>();
  readonly #cursorKey = randomBytes(32);
  #sequence = 0;

  constructor(options: EvidenceStoreOptions) {
    this.#capacity = options.capacity ?? new ContentCapacity();
    this.#maxEvidence = positiveInteger(options.maxEvidence ?? DEFAULT_EVIDENCE_LIMIT);
    this.#maxIncidents = positiveInteger(options.maxIncidents ?? DEFAULT_INCIDENT_LIMIT);
    this.#maxExcerptChars = positiveInteger(options.maxExcerptChars);
    this.#createId = options.createId ?? randomUUID;
  }

  /** The owning service registers retained incidents; reads never create them. */
  registerIncident(incidentId: string): void {
    identity(incidentId, 128);
    if (this.#incidents.has(incidentId)) return;
    if (this.#incidents.size >= this.#maxIncidents)
      throw new DomainError(
        { kind: "capacity-refused", resource: "incidents" },
        "Incident storage is full; start a fresh application.",
      );
    // The incident ID is retained by the service's canonical incident, not this index.
    this.#incidents.add(incidentId);
  }

  capacity(): Readonly<{
    evidence: number;
    reservedEvidence: number;
    maxEvidence: number;
    bytes: ReturnType<ContentCapacity["snapshot"]>;
  }> {
    return Object.freeze({
      evidence: this.#records.size,
      reservedEvidence: this.#reservations.size,
      maxEvidence: this.#maxEvidence,
      bytes: this.#capacity.snapshot(),
    });
  }

  reserve(incidentId: string, executionId: string, bytes: number): EvidenceReservation {
    return this.#reserve(incidentId, executionId, bytes, this.#createId());
  }

  #reserve(
    incidentId: string,
    executionId: string,
    bytes: number,
    proposedId: string,
  ): EvidenceReservation {
    this.#requireIncident(incidentId);
    identity(executionId, 128);
    positiveInteger(bytes);
    requireDomain(
      !this.#executions.has(executionId) &&
        ![...this.#reservations.keys()].some((item) => item.executionId === executionId),
      "Execution already has evidence or a reservation.",
    );
    if (this.#records.size + this.#reservations.size >= this.#maxEvidence)
      throw new DomainError(
        { kind: "capacity-refused", resource: "evidence" },
        "Evidence storage is full; start a fresh application.",
      );
    const evidenceId = identity(proposedId, 128);
    requireDomain(
      !this.#records.has(evidenceId) &&
        ![...this.#reservations.keys()].some((item) => item.evidenceId === evidenceId),
      "Evidence ID must be unique.",
    );
    const content = this.#capacity.reserve(bytes);
    const reservation = Object.freeze({ evidenceId, incidentId, executionId, bytes });
    this.#reservations.set(reservation, content);
    return reservation;
  }

  /** Idempotent cleanup on failure, cancellation or invalidation; copied tokens own nothing. */
  release(reservation: EvidenceReservation): void {
    const content = this.#reservations.get(reservation);
    if (content) {
      this.#capacity.release(content);
      this.#reservations.delete(reservation);
    }
  }

  /** Synchronous atomic commit. A failed append releases its supplied reservation. */
  append(input: Observation, reservation?: EvidenceReservation): AppendResult {
    try {
      this.#requireIncident(input.incidentId);
      const previous = this.#executions.get(input.executionId);
      const evidence = createEvidence(
        { ...input, id: previous?.id ?? reservation?.evidenceId ?? this.#createId() },
        this.#maxExcerptChars,
      );
      if (previous) {
        requireDomain(
          previous.incidentId === input.incidentId &&
            JSON.stringify(previous) === JSON.stringify(evidence),
          "Execution was already committed with a different observation.",
        );
        // Only the exact original delivery is idempotent; it spends no capacity.
        requireDomain(
          reservation === undefined ||
            (this.#committedReservations.has(reservation) &&
              reservation.evidenceId === previous.id &&
              reservation.incidentId === previous.incidentId &&
              reservation.executionId === previous.executionId),
          "Reservation does not match the committed observation.",
        );
        return Object.freeze({ status: "already-committed", evidence: previous });
      }
      const owned =
        reservation ??
        this.#reserve(
          input.incidentId,
          input.executionId,
          retainedContentBytes(evidence),
          evidence.id,
        );
      try {
        const content = this.#reservations.get(owned);
        requireDomain(
          content !== undefined &&
            owned.incidentId === evidence.incidentId &&
            owned.executionId === evidence.executionId,
          "Unknown, settled or mismatched evidence reservation.",
        );
        const committed = createEvidence(
          { ...evidence, id: owned.evidenceId },
          this.#maxExcerptChars,
        );
        const bytes = retainedContentBytes(committed);
        this.#capacity.commit(content, bytes);
        this.#reservations.delete(owned);
        this.#committedReservations.add(owned);
        this.#records.set(committed.id, { evidence: committed, sequence: ++this.#sequence });
        this.#executions.set(committed.executionId, committed);
        return Object.freeze({ status: "committed", evidence: committed });
      } catch (error) {
        this.release(owned);
        throw error;
      }
    } catch (error) {
      if (reservation) this.release(reservation);
      throw error;
    }
  }

  get(incidentId: string, evidenceId: string): Evidence {
    this.#requireIncident(incidentId);
    identity(evidenceId, 128);
    const record = this.#records.get(evidenceId);
    if (!record || record.evidence.incidentId !== incidentId)
      throw new DomainError(
        { kind: "missing-reference" },
        "Evidence must exist in the requested incident.",
      );
    return record.evidence;
  }

  /** Cursors are authenticated, collection/incident/store-bound high-water snapshots. */
  list(
    incidentId: string,
    options: { readonly size?: number; readonly cursor?: string; readonly maxBytes?: number } = {},
  ): EvidencePage {
    this.#requireIncident(incidentId);
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
          parsed[0] === incidentId &&
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
      (item) =>
        item.evidence.incidentId === incidentId &&
        item.sequence > after &&
        item.sequence <= highWater,
    );
    const items: Evidence[] = [];
    let page: EvidencePage = Object.freeze({ items: Object.freeze([]) });
    for (const record of records.slice(0, size)) {
      const next = [...items, record.evidence];
      const cursor =
        next.length < records.length
          ? this.#cursor(incidentId, record.sequence, highWater)
          : undefined;
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

  #requireIncident(incidentId: string): void {
    identity(incidentId, 128);
    if (!this.#incidents.has(incidentId))
      throw new DomainError(
        { kind: "missing-reference" },
        "Unknown incident; no evidence collection exists.",
      );
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#cursorKey).update(payload).digest("base64url");
  }

  #cursor(incidentId: string, after: number, highWater: number): string {
    const payload = Buffer.from(JSON.stringify([incidentId, after, highWater])).toString(
      "base64url",
    );
    return `${payload}.${this.#sign(payload)}`;
  }
}
