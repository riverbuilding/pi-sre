import { Buffer } from "node:buffer";
import { DomainError, requireDomain } from "../domain/errors.js";
import { positiveInteger } from "../domain/validation.js";

export const DEFAULT_DOMAIN_BYTES = 8 * 1024 * 1024;

export interface ContentReservation {
  readonly bytes: number;
}

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

/** Application-owned ledger shared by evidence and the later investigation service. */
export class ContentCapacity {
  readonly #limit: number;
  readonly #reservations = new Set<ContentReservation>();
  #retained = 0;
  #reserved = 0;

  constructor(limit = DEFAULT_DOMAIN_BYTES) {
    this.#limit = positiveInteger(limit);
  }

  snapshot(): Readonly<{ limit: number; retained: number; reserved: number }> {
    return Object.freeze({
      limit: this.#limit,
      retained: this.#retained,
      reserved: this.#reserved,
    });
  }

  reserve(bytes: number): ContentReservation {
    positiveInteger(bytes);
    if (bytes > this.#limit - this.#retained - this.#reserved)
      throw new DomainError(
        { kind: "capacity-refused", resource: "bytes" },
        "Domain storage is full; start a fresh application.",
      );
    const reservation = Object.freeze({ bytes });
    this.#reservations.add(reservation);
    this.#reserved += bytes;
    return reservation;
  }

  commit(reservation: ContentReservation, bytes: number): void {
    requireDomain(this.#reservations.has(reservation), "Unknown or settled content reservation.");
    requireDomain(
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= reservation.bytes,
      "Content exceeds its reserved capacity.",
    );
    this.release(reservation);
    this.#retained += bytes;
  }

  release(reservation: ContentReservation): void {
    if (this.#reservations.delete(reservation)) this.#reserved -= reservation.bytes;
  }
}
