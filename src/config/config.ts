import { isAbsolute, join, resolve } from "node:path";

import type { ParsedSreConfig } from "./schema.js";

export interface ApplicationPaths {
  readonly home: string;
  readonly config: string;
  readonly kubernetesMcpConfig: string;
  readonly auth: string;
  readonly models: string;
  readonly settings: string;
  readonly sessions: string;
  readonly logs: string;
}

export interface McpServerConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly startupTimeoutMs: number;
  readonly toolCallTimeoutMs: number;
}

export interface SreConfig {
  readonly results: ParsedSreConfig["results"];
  readonly paths: ApplicationPaths;
  readonly kubernetes: {
    readonly defaultCluster?: string;
    readonly mcp: McpServerConfig;
  };
  readonly investigation: ParsedSreConfig["investigation"];
  readonly safety: ParsedSreConfig["safety"];
}

export function resolveConfiguredPath(value: string, baseDir: string, userHome: string): string {
  if (value === "~") return userHome;
  if (value.startsWith("~/")) return resolve(userHome, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

export function createApplicationPaths(appHome: string): ApplicationPaths {
  return {
    home: appHome,
    config: join(appHome, "config.yaml"),
    kubernetesMcpConfig: join(appHome, "kubernetes-mcp.toml"),
    auth: join(appHome, "auth.json"),
    models: join(appHome, "models.json"),
    settings: join(appHome, "settings.json"),
    sessions: join(appHome, "sessions"),
    logs: join(appHome, "logs"),
  };
}
