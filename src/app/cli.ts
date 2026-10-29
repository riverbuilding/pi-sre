import {
  parseClusterRule,
  type ClusterScopeRule,
  type StartupClusterIntent,
} from "../cluster/context-resolver.js";

export type CliOptions =
  { readonly help: true } | ({ readonly help: false } & StartupClusterIntent);

export function parseCliArgs(args: readonly string[]): CliOptions {
  let help = false;
  let rule: ClusterScopeRule | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--clusters" || arg?.startsWith("--clusters=")) {
      if (rule) throw new Error("Duplicate --clusters selection. Specify it once.");
      const values: string[] = [];
      if (arg === "--clusters") {
        while (index + 1 < args.length) {
          const value = args[index + 1];
          if (value === undefined || value.startsWith("-")) break;
          values.push(value);
          index++;
        }
      } else values.push(arg.slice("--clusters=".length));
      try {
        rule = parseClusterRule(values);
      } catch (cause) {
        throw new Error(
          "--clusters requires valid, unique context names (1–1024); '*' must be the sole selection value. Run pi-sre --help for usage.",
          { cause },
        );
      }
    } else {
      throw new Error("Unknown argument. Run pi-sre --help for usage.");
    }
  }
  // Help skips configuration and MCP startup, but does not hide invalid arguments.
  return help ? { help: true } : Object.freeze({ help: false, ...(rule ? { rule } : {}) });
}

export function formatHelp(): string {
  return `Pi SRE — read-only Kubernetes incident diagnosis

Usage: pi-sre [--clusters <name> <name> ... | --clusters '*'] [--help]

Options:
  --clusters <names...>  Request an exact set of MCP contexts; specify this flag once
  --clusters '*'        Select live all-contexts (quote '*' to prevent shell expansion)
  --clusters=<name>     Single exact name, including names beginning with '-'
                        Names are opaque; patterns are not expanded.
  -h, --help           Show help without loading configuration or starting MCP
                       Other arguments are still validated when help is requested.

Startup precedence: --clusters > kubernetes.contexts > live all (*).
MCP default metadata never narrows the selection. Each diagnostic call requires an exact context.
Unknown selections never fall back to another default.

Configuration:
  PI_SRE_HOME       Application home (default: ~/.pi-sre)
  PI_SRE_CONFIG     YAML configuration file (default: <PI_SRE_HOME>/config.yaml)
  PI_SRE_MCP_COMMAND Override the Kubernetes MCP executable

The MCP TOML path is set by kubernetes.mcp.configFile in config.yaml.

Pi model credentials, settings, and sessions live under PI_SRE_HOME.
Use /mcp_restart in the TUI to retry Kubernetes MCP access.
Use /clusters to select one or more contexts in a staged picker, /clusters --all
for live all, /clusters <exact-name> for one context, and /clusters --status to
report scope, read-only mode, and MCP availability. Apply commits the picker draft.
An open incident keeps its rule; selection changes apply to the next incident.
Use /incident to inspect state or /incident new <question> to start another while idle.
Use /evidence [<id> | --cursor <cursor>] to inspect stored observations without Kubernetes calls.
Successful diagnostics return stored evidence IDs. Hypotheses and conclusions are local
interpretation, not repairs. State survives compaction/reload and same-process resume;
unarchived investigation state is lost on process exit and cannot be restored from prose.
`;
}
