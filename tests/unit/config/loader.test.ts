import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationPaths } from "../../../src/config/config.js";
import { loadSreConfig, SreConfigError } from "../../../src/config/loader.js";
import {
  isPhase1AllowedMcpTool,
  PHASE1_ALLOWED_MCP_TOOLS,
} from "../../../src/runtime/tool-policy.js";

const validYaml = `
kubernetes:
  defaultCluster: staging
  mcp:
    transport: stdio
    command: kubernetes-mcp-server
    args: []
    configFile: kubernetes-mcp.toml
investigation:
  defaultTimeRange: 30m
  maxToolCalls: 40
safety:
  mode: read-only
`;

describe("loadSreConfig", () => {
  let temporaryHome: string;
  let applicationHome: string;
  let configPath: string;
  let mcpConfigPath: string;

  beforeEach(async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), "pi-sre-config-"));
    applicationHome = join(temporaryHome, ".pi-sre");
    await mkdir(applicationHome);
    configPath = join(applicationHome, "config.yaml");
    mcpConfigPath = join(applicationHome, "kubernetes-mcp.toml");
    await writeFile(configPath, validYaml);
    await writeFile(mcpConfigPath, 'read_only = true\ntoolsets = ["core", "config"]\n');
  });

  afterEach(async () => {
    await rm(temporaryHome, { recursive: true, force: true });
  });

  function load(env: Readonly<Record<string, string | undefined>> = {}) {
    return loadSreConfig({ cwd: temporaryHome, userHome: temporaryHome, env });
  }

  it("loads the default application root and constructs a single-root runtime layout", async () => {
    const config = await load();

    expect(config.paths).toEqual(createApplicationPaths(applicationHome));
    expect(config.paths.auth).toBe(join(applicationHome, "auth.json"));
    expect(config.paths.models).toBe(join(applicationHome, "models.json"));
    expect(config.paths.settings).toBe(join(applicationHome, "settings.json"));
    expect(config.paths.sessions).toBe(join(applicationHome, "sessions"));
    expect(config.kubernetes.defaultCluster).toBe("staging");
    expect(config.results).toEqual({ maxTextChars: 8_000, maxItems: 50, rawRetention: "disabled" });
    expect(config.kubernetes.mcp).toEqual({
      transport: "stdio",
      command: "kubernetes-mcp-server",
      args: ["--config", mcpConfigPath],
      cwd: applicationHome,
      startupTimeoutMs: 15_000,
      toolCallTimeoutMs: 30_000,
    });
  });

  it("accepts the versioned YAML and TOML templates", async () => {
    const exampleYaml = await readFile("config/pi-sre.example.yaml", "utf8");
    const exampleToml = await readFile("config/kubernetes-mcp.example.toml", "utf8");
    await writeFile(configPath, exampleYaml);
    await writeFile(mcpConfigPath, exampleToml);

    const config = await load();
    expect(config.kubernetes.mcp.args).toEqual(["--config", mcpConfigPath]);
  });

  it("loads explicit model-facing result budgets", async () => {
    await writeFile(
      configPath,
      `${validYaml}results:
  maxTextChars: 512
  maxItems: 5
  rawRetention: disabled
`,
    );
    expect((await load()).results).toEqual({
      maxTextChars: 512,
      maxItems: 5,
      rawRetention: "disabled",
    });
  });

  it.each([
    "maxTextChars: 0",
    "maxTextChars: 255",
    "maxTextChars: 64001",
    "maxItems: 0",
    "maxItems: 1.5",
    "maxItems: 1001",
    "rawRetention: enabled",
  ])("rejects unsafe result policy %s", async (field) => {
    await writeFile(
      configPath,
      `${validYaml}results:
  ${field}
`,
    );
    await expect(load()).rejects.toThrow("results.");
  });

  it("resolves paths and executable arguments relative to the selected config file", async () => {
    const alternate = join(temporaryHome, "alternate");
    await mkdir(join(alternate, "mcp"), { recursive: true });
    await writeFile(
      join(alternate, "config.yaml"),
      validYaml
        .replace("command: kubernetes-mcp-server", "command: ./bin/kubernetes-mcp-server")
        .replace("args: []", 'args: ["  --verbose  " ]')
        .replace("configFile: kubernetes-mcp.toml", "configFile: mcp/kubernetes-mcp.toml"),
    );
    await writeFile(join(alternate, "mcp", "kubernetes-mcp.toml"), "read_only = true\n");

    const config = await load({ PI_SRE_CONFIG: "./alternate/config.yaml" });
    expect(config.paths.config).toBe(join(alternate, "config.yaml"));
    expect(config.paths.kubernetesMcpConfig).toBe(join(alternate, "mcp", "kubernetes-mcp.toml"));
    expect(config.kubernetes.mcp.command).toBe(join(alternate, "bin", "kubernetes-mcp-server"));
    expect(config.kubernetes.mcp.args).toEqual([
      "--verbose",
      "--config",
      join(alternate, "mcp", "kubernetes-mcp.toml"),
    ]);
  });

  it("applies application-root and command environment overrides", async () => {
    const alternateHome = join(temporaryHome, "alternate-home");
    await mkdir(alternateHome);
    await writeFile(join(alternateHome, "config.yaml"), validYaml);
    await writeFile(join(alternateHome, "kubernetes-mcp.toml"), "read_only = true\n");

    const config = await load({
      PI_SRE_HOME: "alternate-home",
      PI_SRE_MCP_COMMAND: "other-kubernetes-mcp-server",
    });
    expect(config.paths.home).toBe(alternateHome);
    expect(config.paths.auth).toBe(join(alternateHome, "auth.json"));
    expect(config.kubernetes.mcp.command).toBe("other-kubernetes-mcp-server");
  });

  it.each([
    ["unknown field", `${validYaml}unexpected: true\n`, "unexpected"],
    [
      "missing command",
      validYaml.replace("    command: kubernetes-mcp-server\n", ""),
      "kubernetes.mcp.command",
    ],
    [
      "missing MCP config path",
      validYaml.replace("    configFile: kubernetes-mcp.toml\n", ""),
      "kubernetes.mcp.configFile",
    ],
    [
      "invalid transport",
      validYaml.replace("transport: stdio", "transport: http"),
      "kubernetes.mcp.transport",
    ],
    [
      "invalid safety mode",
      validYaml.replace("mode: read-only", "mode: write-enabled"),
      "safety.mode",
    ],
    [
      "invalid timeout",
      validYaml.replace("args: []", "args: []\n    startupTimeoutMs: 0"),
      "kubernetes.mcp.startupTimeoutMs",
    ],
  ])("rejects %s", async (_name, contents, field) => {
    await writeFile(configPath, contents);
    await expect(load()).rejects.toThrow(field);
  });

  it("rejects a missing MCP config and conflicting MCP config arguments", async () => {
    await writeFile(configPath, validYaml.replace("kubernetes-mcp.toml", "missing.toml"));
    await expect(load()).rejects.toThrow("Cannot read Kubernetes MCP configuration");

    await writeFile(configPath, validYaml.replace("args: []", 'args: ["--config"]'));
    await expect(load()).rejects.toThrow("must not set --config");

    await writeFile(configPath, validYaml.replace("args: []", 'args: ["--config-dir=other"]'));
    await expect(load()).rejects.toThrow("must not set --config-dir");
  });

  it("keeps executable and arguments separate", async () => {
    await writeFile(
      configPath,
      validYaml.replace("command: kubernetes-mcp-server", "command: npx -y kubernetes-mcp-server"),
    );
    await expect(load()).rejects.toThrow("put arguments in args");
  });

  it("reports missing or malformed configuration without echoing its contents", async () => {
    await expect(load({ PI_SRE_CONFIG: "missing.yaml" })).rejects.toThrow(
      "Cannot read Pi SRE configuration",
    );

    const privateValue = "MCP_SECRET_VALUE_4721";
    await writeFile(mcpConfigPath, `read_only = ${privateValue}\n`);
    await expect(load()).rejects.toThrow("Cannot parse Kubernetes MCP TOML");
    await expect(load()).rejects.not.toThrow(privateValue);
  });

  it("requires read-only stdio MCP configuration", async () => {
    await writeFile(mcpConfigPath, "read_only = false\n");
    await expect(load()).rejects.toThrow("read_only = true");

    await writeFile(mcpConfigPath, 'read_only = true\nport = "8080"\n');
    await expect(load()).rejects.toThrow("stdio transport");
  });

  it("keeps secret values out of validation and parse diagnostics", async () => {
    const privateValue = "TOP_SECRET_VALUE_8392";
    await writeFile(configPath, validYaml.replace("mode: read-only", `mode: ${privateValue}`));
    await expect(load()).rejects.toThrow(SreConfigError);
    await expect(load()).rejects.not.toThrow(privateValue);

    await writeFile(configPath, `${validYaml}invalid: [${privateValue}\n`);
    await expect(load()).rejects.toThrow("Cannot parse Pi SRE YAML");
    await expect(load()).rejects.not.toThrow(privateValue);
  });
});

describe("Phase 1 MCP allowlist", () => {
  it("exposes only context enumeration", () => {
    expect(PHASE1_ALLOWED_MCP_TOOLS).toEqual(["configuration_contexts_list"]);
    expect(isPhase1AllowedMcpTool("configuration_contexts_list")).toBe(true);
    expect(isPhase1AllowedMcpTool("configuration_view")).toBe(false);
    expect(isPhase1AllowedMcpTool("targets_list")).toBe(false);
    expect(isPhase1AllowedMcpTool("pods_list")).toBe(false);
  });
});
