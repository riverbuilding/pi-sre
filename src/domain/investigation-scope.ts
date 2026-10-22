import { createExactClusterRule, resolveClusterSelection } from "../cluster/context-resolver.js";
import type {
  ClusterScopeRule,
  ClusterSelection,
  ClusterResolution,
} from "../cluster/context-resolver.js";
import type { ClusterContextRegistry } from "../cluster/context-registry.js";
import { requireDomain } from "./errors.js";
import { positiveInteger, timestamp } from "./validation.js";

export interface TimeWindow {
  readonly start: string;
  readonly end: string;
}

export interface InvestigationScope {
  readonly rule: ClusterScopeRule;
  readonly revision: 1;
  readonly selectionSource: ClusterSelection["source"];
  readonly selectionRevision: number;
  readonly namespacePolicy: "unrestricted";
  readonly timeWindow: TimeWindow;
}

export function createTimeWindow(input: TimeWindow): TimeWindow {
  const start = timestamp(input.start);
  const end = timestamp(input.end);
  requireDomain(start < end, "Time window start must precede its end.");
  return Object.freeze({ start, end });
}

/** Resolve once at incident creation; neither clock nor mutable Date is retained. */
export function resolveTimeWindow(duration: string, clock: () => Date): TimeWindow {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration);
  requireDomain(match !== null, "Time range requires a positive duration and known unit.");
  const factors: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const milliseconds = positiveInteger(Number(match[1]) * (factors[match[2] ?? ""] ?? NaN));
  const end = clock().getTime();
  const start = end - milliseconds;
  requireDomain(
    Number.isSafeInteger(end) &&
      Number.isSafeInteger(start) &&
      start >= -62_167_219_200_000 &&
      end <= 253402300799999,
    "Time range exceeds supported UTC timestamps.",
  );
  return createTimeWindow({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  });
}

export function createInvestigationScope(
  selection: ClusterSelection,
  timeWindow: TimeWindow,
): InvestigationScope {
  requireDomain(
    ["cli", "config", "default-all", "user"].includes(selection.source),
    "Unknown selection source.",
  );
  requireDomain(
    selection.rule.kind === "all" || selection.rule.kind === "exact",
    "Unknown scope rule.",
  );
  let rule: ClusterScopeRule;
  try {
    rule =
      selection.rule.kind === "exact"
        ? createExactClusterRule(selection.rule.contexts)
        : Object.freeze({ kind: "all" });
  } catch {
    requireDomain(false, "Invalid exact scope membership.");
  }
  return Object.freeze({
    rule,
    revision: 1,
    selectionSource: selection.source,
    selectionRevision: positiveInteger(selection.selectionRevision),
    namespacePolicy: "unrestricted",
    timeWindow: createTimeWindow(timeWindow),
  });
}

export function copyInvestigationScope(scope: InvestigationScope): InvestigationScope {
  requireDomain(
    scope.revision === 1 && scope.namespacePolicy === "unrestricted",
    "Unsupported scope revision or namespace policy.",
  );
  return createInvestigationScope(
    { rule: scope.rule, source: scope.selectionSource, selectionRevision: scope.selectionRevision },
    scope.timeWindow,
  );
}

/** Resolution is replaceable application state and grants no transport authority. */
export function resolveInvestigationScope(
  scope: InvestigationScope,
  inventory?: ClusterContextRegistry,
): ClusterResolution {
  return inventory
    ? resolveClusterSelection(inventory, scope.rule, true)
    : Object.freeze({ status: "blocked", reason: "inventory-unavailable" });
}

export function permitsContext(scope: InvestigationScope, context: string): boolean {
  return scope.rule.kind === "all" || scope.rule.contexts.includes(context);
}
