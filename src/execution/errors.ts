export type ExecutionFailureCategory =
  | "invalid-arguments"
  | "scope-unavailable"
  | "transport-unavailable"
  | "capacity-exceeded"
  | "timeout"
  | "budget-refused"
  | "request-closed";

/** Execution failures carry a public category, never an untrusted diagnostic payload. */
export class ExecutionError extends Error {
  readonly category: ExecutionFailureCategory;

  constructor(category: ExecutionFailureCategory, message: string) {
    super(message);
    this.name = "ExecutionError";
    this.category = category;
  }
}
