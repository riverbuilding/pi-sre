import type { McpToolPolicy } from "./tool-policy.js";

/** Prepare a private call copy; validation and execution policy do not rewrite arguments. */
export function prepareMcpToolArguments(
  policy: Pick<McpToolPolicy, "name" | "clusterDependent">,
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const args: Record<string, unknown> = { ...value };
  if (policy.name === "pods_log" && args.tail === undefined) args.tail = 100;
  return structuredClone(args);
}
