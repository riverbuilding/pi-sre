/** Exact MCP context identity with display-safe endpoint metadata only. */
export interface ClusterContext {
  readonly name: string;
  readonly server: string;
  readonly isDefault: boolean;
}
