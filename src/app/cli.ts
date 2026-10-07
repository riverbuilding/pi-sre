export type CliOptions = { readonly help: true } | { readonly help: false };

export function parseCliArgs(args: readonly string[]): CliOptions {
  if (args.length === 0) return { help: false };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  throw new Error(`Unknown argument: ${args[0] ?? ""}. Run pi-sre --help for usage.`);
}

export function formatHelp(): string {
  return `Pi SRE — read-only Kubernetes incident diagnosis

Usage: pi-sre [--help]

Configuration:
  PI_SRE_HOME       Application home (default: ~/.pi-sre)
  PI_SRE_CONFIG     YAML configuration file (default: <PI_SRE_HOME>/config.yaml)
  PI_SRE_MCP_COMMAND Override the Kubernetes MCP executable

The MCP TOML path is set by kubernetes.mcp.configFile in config.yaml.

Pi model credentials, settings, and sessions live under PI_SRE_HOME.
Use /mcp_restart in the TUI to retry Kubernetes MCP access.
Cluster selection is planned for Phase 2.
`;
}
