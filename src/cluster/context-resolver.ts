import type { ClusterContext } from "./cluster-context.js";
import { isValidContextSelection } from "./context-name.js";
import type { ClusterContextRegistry } from "./context-registry.js";

export type ClusterScopeRule =
  | { readonly kind: "exact"; readonly contexts: readonly [string, ...string[]] }
  | { readonly kind: "all" };

export interface StartupClusterIntent {
  readonly rule?: ClusterScopeRule;
}

export type StartupSelectionSource = "cli" | "config" | "default-all";
export type ClusterSelectionSource = StartupSelectionSource | "user";

export interface ClusterSelection {
  readonly rule: ClusterScopeRule;
  readonly source: ClusterSelectionSource;
  readonly selectionRevision: number;
}

export type ClusterResolution =
  | { readonly status: "blocked"; readonly reason: "inventory-unavailable" | "invalid-selection" }
  | {
      readonly status: "resolved";
      readonly available: readonly ClusterContext[];
      readonly unavailable: readonly string[];
    };

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
    if (contexts.length !== 1) throw new Error("'*' must be the sole selection value.");
    return Object.freeze({ kind: "all" });
  }
  return createExactClusterRule(contexts);
}

export function createStartupSelection(
  intent: StartupClusterIntent = {},
  configuredRule?: ClusterScopeRule,
): ClusterSelection {
  const selected = intent.rule ?? configuredRule;
  const rule =
    selected?.kind === "exact"
      ? createExactClusterRule(selected.contexts)
      : Object.freeze({ kind: "all" as const });
  return Object.freeze({
    rule,
    source: intent.rule ? "cli" : configuredRule !== undefined ? "config" : "default-all",
    selectionRevision: 1,
  });
}

/** Initial exact selection is atomic; only a previously validated rule may become partial. */
export function resolveClusterSelection(
  registry: ClusterContextRegistry,
  rule: ClusterScopeRule,
  previouslyValidated = false,
): ClusterResolution {
  const available: ClusterContext[] = [];
  const unavailable: string[] = [];
  if (rule.kind === "all") available.push(...registry.contexts);
  else {
    for (const name of rule.contexts) {
      const context = registry.get(name);
      if (context) available.push(context);
      else unavailable.push(name);
    }
    if (unavailable.length && !previouslyValidated) {
      return Object.freeze({ status: "blocked", reason: "invalid-selection" });
    }
  }
  return Object.freeze({
    status: "resolved",
    available: Object.freeze(available),
    unavailable: Object.freeze(unavailable),
  });
}

/** Resolve only complete validated inventory; MCP default metadata never selects scope. */
export function resolveStartupContext(
  registry: ClusterContextRegistry,
  intent: StartupClusterIntent = {},
  configuredRule?: ClusterScopeRule,
): { readonly selection: ClusterSelection; readonly resolution: ClusterResolution } {
  const selection = createStartupSelection(intent, configuredRule);
  return Object.freeze({
    selection,
    resolution: resolveClusterSelection(registry, selection.rule),
  });
}
