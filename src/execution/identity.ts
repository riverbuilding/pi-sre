import { isValidContextSelection } from "../cluster/context-name.js";
import { redactDiagnosticText } from "../shared/redaction.js";

/** Preserve whole display-safe identities; never redact or shorten them into another target. */
export function isPresentableIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isValidContextSelection(value) &&
    redactDiagnosticText(value) === value
  );
}
