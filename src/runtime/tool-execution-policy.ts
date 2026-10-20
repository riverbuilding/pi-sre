import type { ClusterContextState } from "../cluster/context-manager.js";
import type { McpToolPolicy } from "./tool-policy.js";

export type McpToolExecutionValidation =
  | { readonly ok: true; readonly context?: string }
  | { readonly ok: false; readonly category: "invalid-arguments" | "scope-unavailable" };

/** Validate argument values against live permission and limits, independently of schemas. */
export function validateMcpToolExecution(
  policy: McpToolPolicy,
  args: Readonly<Record<string, unknown>>,
  state?: ClusterContextState,
): McpToolExecutionValidation {
  if (!allowsMcpToolExecution(policy.name, args))
    return { ok: false, category: "invalid-arguments" };
  if (!policy.clusterDependent) return { ok: true };
  const context = args.context;
  if (typeof context !== "string" || context.length === 0)
    return { ok: false, category: "invalid-arguments" };
  if (!state || state.resolution.status !== "resolved")
    return { ok: false, category: "scope-unavailable" };
  const rule = state.selection.rule;
  if (rule.kind === "exact" && !rule.contexts.includes(context))
    return { ok: false, category: "invalid-arguments" };
  if (state.resolution.unavailable.includes(context))
    return { ok: false, category: "scope-unavailable" };
  if (!state.resolution.available.some((entry) => entry.name === context))
    return { ok: false, category: "invalid-arguments" };
  return { ok: true, context };
}

/** Application retrieval limits, independent of discovered MCP argument constraints. */
export function allowsMcpToolExecution(
  name: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (name !== "pods_log") return true;
  return (
    typeof args.tail === "number" &&
    Number.isInteger(args.tail) &&
    args.tail >= 1 &&
    args.follow !== true &&
    args.stream !== true &&
    args.tail <= 1000
  );
}
