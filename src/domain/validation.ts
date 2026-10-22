import { Buffer } from "node:buffer";
import { isValidContextSelection } from "../cluster/context-name.js";
import { redactDiagnosticText } from "../shared/redaction.js";
import { requireDomain } from "./errors.js";

export function identity(value: string, maxBytes = 1_024): string {
  requireDomain(
    typeof value === "string" &&
      isValidContextSelection(value) &&
      Buffer.byteLength(value, "utf8") <= maxBytes,
    "Identity must be nonblank, display-safe and within its UTF-8 byte limit.",
  );
  return value;
}

export function prose(value: string, maxChars: number, allowEmpty = false): string {
  requireDomain(
    typeof value === "string" &&
      value.length <= maxChars &&
      (allowEmpty || value.trim().length > 0),
    "Text must be within its character limit and nonblank where required.",
  );
  const safe = redactDiagnosticText(value);
  requireDomain(safe.length <= maxChars, "Redacted text exceeds its character limit.");
  return safe;
}

export function timestamp(value: string): string {
  requireDomain(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "Timestamp must be a valid canonical UTC ISO string.",
  );
  return value;
}

export function positiveInteger(value: number): number {
  requireDomain(Number.isSafeInteger(value) && value > 0, "Expected a positive safe integer.");
  return value;
}

export function uniqueIds(values: readonly string[]): readonly string[] {
  const ids = values.map((value) => identity(value, 128));
  requireDomain(new Set(ids).size === ids.length, "Duplicate references are not allowed.");
  return Object.freeze(ids);
}
