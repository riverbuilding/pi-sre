import { Buffer } from "node:buffer";
import { DomainError, requireDomain } from "../domain/errors.js";
import { positiveInteger } from "../domain/validation.js";

export const DEFAULT_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** Counts string values once per canonical record, including nested typed provenance. */
export function retainedContentBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Array.isArray(value))
    return value.reduce<number>((sum, item: unknown) => sum + retainedContentBytes(item), 0);
  if (value !== null && typeof value === "object")
    return Object.values(value).reduce<number>(
      (sum, item: unknown) => sum + retainedContentBytes(item),
      0,
    );
  return 0;
}

/** Incident EvidenceStore-owned ledger for retained evidence string content. */
export class ContentCapacity {
  readonly #limit: number;
  #retained = 0;

  constructor(limit = DEFAULT_EVIDENCE_BYTES) {
    this.#limit = positiveInteger(limit);
  }

  snapshot(): Readonly<{ limit: number; retained: number }> {
    return Object.freeze({ limit: this.#limit, retained: this.#retained });
  }

  /** Check an immediate synchronous write; this does not hold capacity for later work. */
  assertFits(bytes: number): void {
    requireDomain(Number.isSafeInteger(bytes) && bytes >= 0, "Invalid content byte count.");
    if (bytes > this.#limit - this.#retained)
      throw new DomainError(
        { kind: "capacity-refused", resource: "bytes" },
        "Incident evidence storage is full; conclude this investigation before starting another.",
      );
  }

  /** Atomically replace an owner's canonical content using its actual size. */
  replace(previous: number, next: number): void {
    requireDomain(
      Number.isSafeInteger(previous) &&
        previous >= 0 &&
        previous <= this.#retained &&
        Number.isSafeInteger(next) &&
        next >= 0,
      "Invalid retained content accounting.",
    );
    this.assertFits(Math.max(0, next - previous));
    this.#retained += next - previous;
  }
}
