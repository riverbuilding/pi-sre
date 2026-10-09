import { isValidContextSelection } from "../cluster/context-name.js";
import type { StartupClusterIntent } from "../cluster/context-resolver.js";

export type CliOptions =
  { readonly help: true } | ({ readonly help: false } & StartupClusterIntent);

export function parseCliArgs(args: readonly string[]): CliOptions {
  let help = false;
  let cluster: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--cluster" || arg?.startsWith("--cluster=")) {
      if (cluster !== undefined) throw new Error("Duplicate --cluster selection. Specify it once.");
      const value = arg === "--cluster" ? args[++index] : arg.slice("--cluster=".length);
      if (
        value === undefined ||
        (arg === "--cluster" && value.startsWith("-")) ||
        !isValidContextSelection(value)
      ) {
        throw new Error("--cluster requires a nonblank context name. Run pi-sre --help for usage.");
      }
      cluster = value;
    } else {
      throw new Error("Unknown argument. Run pi-sre --help for usage.");
    }
  }
  // Help skips configuration and MCP startup, but does not hide invalid arguments.
  return help ? { help: true } : { help: false, ...(cluster === undefined ? {} : { cluster }) };
}

export function formatHelp(): string {
  return `Pi SRE — read-only Kubernetes incident diagnosis

Usage: pi-sre [--cluster <name>] [--help]

Options:
  --cluster <name>  Request an exact MCP context (--cluster=<name> also works)
  -h, --help       Show help without loading configuration or starting MCP
                   Other arguments are still validated when help is requested.

Startup precedence: --cluster > kubernetes.defaultCluster > MCP default > unbound.
Unknown selections never fall back to another default.

Configuration:
  PI_SRE_HOME       Application home (default: ~/.pi-sre)
  PI_SRE_CONFIG     YAML configuration file (default: <PI_SRE_HOME>/config.yaml)
  PI_SRE_MCP_COMMAND Override the Kubernetes MCP executable

The MCP TOML path is set by kubernetes.mcp.configFile in config.yaml.

Pi model credentials, settings, and sessions live under PI_SRE_HOME.
Use /mcp_restart in the TUI to retry Kubernetes MCP access.
Cluster intent is retained; startup binding and TUI selection arrive in Phase 2 Slice 3 onward.
`;
}
