export type DomainFailure =
  | { readonly kind: "invalid-state" }
  | { readonly kind: "scope-mismatch" }
  | { readonly kind: "missing-reference" }
  | { readonly kind: "stale-revision" }
  | {
      readonly kind: "capacity-refused";
      readonly resource: "incidents" | "evidence" | "bytes" | "targets" | "hypotheses";
    }
  | { readonly kind: "budget-refused" };

/** Messages are application constants, never untrusted input or transport errors. */
export class DomainError extends Error {
  readonly failure: DomainFailure;

  constructor(failure: DomainFailure, message: string) {
    super(message);
    this.name = "DomainError";
    this.failure = Object.freeze({ ...failure });
  }
}

export function requireDomain(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError({ kind: "invalid-state" }, message);
}

export function requireRevision(actual: number, expected: number): void {
  if (actual !== expected)
    throw new DomainError(
      { kind: "stale-revision" },
      "Revision has changed; inspect current state before retrying.",
    );
}
