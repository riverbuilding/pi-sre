import { isValidContextSelection } from "./context-name.js";

export type ClusterScopeRule =
  | { readonly kind: "exact"; readonly contexts: readonly [string, ...string[]] }
  | { readonly kind: "all" };

export interface StartupClusterIntent {
  readonly rule?: ClusterScopeRule;
}

export type StartupSelectionSource = "cli" | "config" | "default-all";

/** Validate and privately copy authority; exact names are opaque, never patterns. */
export function createExactClusterRule(contexts: readonly string[]): ClusterScopeRule {
  const [first, ...rest] = [...contexts].sort();
  if (
    first === undefined ||
    contexts.length > 1_024 ||
    contexts.some((name) => !isValidContextSelection(name))
  ) {
    throw new Error("An exact selection requires 1–1024 valid nonblank context names.");
  }
  if (new Set(contexts).size !== contexts.length) {
    throw new Error("Duplicate context names are not allowed.");
  }
  return Object.freeze({ kind: "exact", contexts: Object.freeze([first, ...rest] as const) });
}

/** CLI/config values share wildcard semantics; the picker can still select literal '*' exactly. */
export function parseClusterRule(contexts: readonly string[]): ClusterScopeRule {
  if (contexts.includes("*")) {
    if (contexts.length !== 1) {
      throw new Error("'*' must be the sole selection value.");
    }
    return Object.freeze({ kind: "all" });
  }
  return createExactClusterRule(contexts);
}

export function createStartupSelection(
  intent: StartupClusterIntent = {},
  configuredRule?: ClusterScopeRule,
): { readonly rule: ClusterScopeRule; readonly source: StartupSelectionSource } {
  const selected = intent.rule ?? configuredRule;
  const rule =
    selected?.kind === "exact"
      ? createExactClusterRule(selected.contexts)
      : Object.freeze({ kind: "all" as const });
  return Object.freeze({
    rule,
    source: intent.rule ? "cli" : configuredRule !== undefined ? "config" : "default-all",
  });
}
