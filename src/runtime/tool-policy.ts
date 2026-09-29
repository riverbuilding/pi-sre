/** Phase 1 tools that do not require an active Kubernetes cluster context. */
export const PHASE1_ALLOWED_MCP_TOOLS = ["configuration_contexts_list"] as const;

export type Phase1AllowedMcpTool = (typeof PHASE1_ALLOWED_MCP_TOOLS)[number];

export function isPhase1AllowedMcpTool(name: string): name is Phase1AllowedMcpTool {
  return PHASE1_ALLOWED_MCP_TOOLS.some((allowed) => allowed === name);
}
