import type { McpToolDescriptor } from "../mcp/tool-discovery.js";

/** Phase 1 tools that do not require an active Kubernetes cluster context. */
export const PHASE1_ALLOWED_MCP_TOOLS = ["configuration_contexts_list"] as const;

export type Phase1AllowedMcpTool = (typeof PHASE1_ALLOWED_MCP_TOOLS)[number];

const CLUSTER_DEPENDENT_TOOLS = new Set(["pods_list", "pods_log", "events_list"]);

export type ToolPolicyDecision =
  | { readonly status: "exposed" }
  | {
      readonly status: "rejected";
      readonly reason: "not-allowlisted" | "not-read-only" | "destructive";
    }
  | { readonly status: "deferred"; readonly reason: "cluster-context-required" };

export function isPhase1AllowedMcpTool(name: string): name is Phase1AllowedMcpTool {
  return PHASE1_ALLOWED_MCP_TOOLS.some((allowed) => allowed === name);
}

export function evaluateToolPolicy(tool: McpToolDescriptor): ToolPolicyDecision {
  if (!isPhase1AllowedMcpTool(tool.name) && !CLUSTER_DEPENDENT_TOOLS.has(tool.name)) {
    return { status: "rejected", reason: "not-allowlisted" };
  }
  if (tool.annotations?.readOnlyHint !== true) {
    return { status: "rejected", reason: "not-read-only" };
  }
  if (tool.annotations.destructiveHint === true) {
    return { status: "rejected", reason: "destructive" };
  }
  if (CLUSTER_DEPENDENT_TOOLS.has(tool.name)) {
    return { status: "deferred", reason: "cluster-context-required" };
  }
  return { status: "exposed" };
}
