import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { ZodError } from "zod";

import { createApplicationPaths, resolveConfiguredPath, type SreConfig } from "./config.js";
import { sreConfigSchema } from "./schema.js";

export interface LoadSreConfigOptions {
  readonly cwd?: string;
  readonly userHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class SreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SreConfigError";
  }
}

function nonEmptyOverride(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function formatValidationError(error: ZodError): string {
  const fields = [
    ...new Set(
      error.issues.flatMap((issue) => {
        const path = issue.path.join(".");
        if (issue.code !== "unrecognized_keys") return [path || "root"];
        return issue.keys.map((key) =>
          /^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(key)
            ? [path, key].filter(Boolean).join(".")
            : path || "root",
        );
      }),
    ),
  ];
  return `Invalid Pi SRE configuration at ${fields.join(", ")}. Check field names and required values.`;
}

export async function loadSreConfig(options: LoadSreConfigOptions = {}): Promise<SreConfig> {
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  const env = options.env ?? process.env;
  const appHome = resolveConfiguredPath(
    nonEmptyOverride(env.PI_SRE_HOME) ?? "~/.pi-sre",
    cwd,
    userHome,
  );
  const paths = createApplicationPaths(appHome);
  const configPath = resolveConfiguredPath(
    nonEmptyOverride(env.PI_SRE_CONFIG) ?? paths.config,
    cwd,
    userHome,
  );

  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    throw new SreConfigError(`Cannot read Pi SRE configuration at ${configPath}.`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(contents, { uniqueKeys: true });
  } catch {
    throw new SreConfigError(`Cannot parse Pi SRE YAML configuration at ${configPath}.`);
  }

  const parsed = sreConfigSchema.safeParse(raw);
  if (!parsed.success) throw new SreConfigError(formatValidationError(parsed.error));

  const mcp = parsed.data.kubernetes.mcp;
  const command = nonEmptyOverride(env.PI_SRE_MCP_COMMAND) ?? mcp.command;
  if (!command.includes("/") && /\s/.test(command)) {
    throw new SreConfigError(
      "Kubernetes MCP command must be one executable; put arguments in args.",
    );
  }
  if (mcp.args.some((arg) => arg === "--config" || arg.startsWith("--config="))) {
    throw new SreConfigError("kubernetes.mcp.args must not set --config; use configFile instead.");
  }
  if (mcp.args.some((arg) => arg === "--config-dir" || arg.startsWith("--config-dir="))) {
    throw new SreConfigError("kubernetes.mcp.args must not set --config-dir in Phase 1.");
  }

  const configFile = resolveConfiguredPath(mcp.configFile, dirname(configPath), userHome);
  let mcpContents: string;
  try {
    mcpContents = await readFile(configFile, "utf8");
  } catch {
    throw new SreConfigError(`Cannot read Kubernetes MCP configuration at ${configFile}.`);
  }

  let mcpSettings: Record<string, unknown>;
  try {
    mcpSettings = parseToml(mcpContents);
  } catch {
    throw new SreConfigError(`Cannot parse Kubernetes MCP TOML configuration at ${configFile}.`);
  }
  if (mcpSettings.read_only !== true) {
    throw new SreConfigError("Kubernetes MCP configuration must set read_only = true.");
  }
  if (mcpSettings.port !== undefined && mcpSettings.port !== "") {
    throw new SreConfigError("Kubernetes MCP configuration must use stdio transport (empty port).");
  }

  const normalizedCommand = command.includes("/")
    ? resolveConfiguredPath(command, dirname(configPath), userHome)
    : command;

  return {
    paths: { ...paths, config: configPath, kubernetesMcpConfig: configFile },
    kubernetes: {
      ...(parsed.data.kubernetes.defaultCluster === undefined
        ? {}
        : { defaultCluster: parsed.data.kubernetes.defaultCluster }),
      mcp: {
        transport: "stdio",
        command: normalizedCommand,
        args: [...mcp.args, "--config", configFile],
        cwd: appHome,
        startupTimeoutMs: mcp.startupTimeoutMs,
        toolCallTimeoutMs: mcp.toolCallTimeoutMs,
      },
    },
    investigation: parsed.data.investigation,
    safety: parsed.data.safety,
  };
}
