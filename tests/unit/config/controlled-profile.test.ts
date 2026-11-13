import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sreConfigSchema } from "../../../src/config/schema.js";
import { loadSreConfig } from "../../../src/config/loader.js";
import { CONTROLLED_TOOLS } from "../../../src/config/controlled-operations.js";
import { captureEnvironment, environmentLines } from "../../../src/runtime/request-environment.js";
import { RequestMcpController } from "../../../src/app/request-mcp-controller.js";
import { discoverMcpTools } from "../../../src/mcp/tool-discovery.js";
import capture from "../../fixtures/phase5-server-0.0.67.json" with { type: "json" };

const base = {
  kubernetes: {
    mcp: { transport: "stdio", command: "kubernetes-mcp-server", configFile: "server.toml" },
  },
};

describe("controlled profile configuration and publication", () => {
  it("defaults to empty controlled capabilities with finite limits", () => {
    const parsed = sreConfigSchema.parse({ ...base, safety: { mode: "controlled-operations" } });
    expect(parsed.safety).toMatchObject({
      controlledOperations: {
        enabledTools: [],
        approvalTimeoutMs: 60000,
        callTimeoutMs: 30000,
        maxOperationsPerRequest: 1,
      },
    });
  });

  it.each([
    { enabledTools: ["pods_exec"] },
    { enabledTools: ["exec"] },
    { enabledTools: ["unknown"] },
    { enabledTools: ["pods_delete", "pods_delete"] },
    { approvalTimeoutMs: 60001 },
    { approvalTimeoutMs: 0 },
    { callTimeoutMs: 60001 },
    { callTimeoutMs: -1 },
    { callTimeoutMs: 0.5 },
    { maxOperationsPerRequest: 0 },
    { maxOperationsPerRequest: 11 },
    { unknown: true },
  ])("rejects unknown/unsafe controlled settings %j", (controlledOperations) => {
    expect(
      sreConfigSchema.safeParse({
        ...base,
        safety: { mode: "controlled-operations", controlledOperations },
      }).success,
    ).toBe(false);
  });

  it("rejects controlled-only settings in read-only mode", () => {
    expect(
      sreConfigSchema.safeParse({
        ...base,
        safety: { mode: "read-only", controlledOperations: {} },
      }).success,
    ).toBe(false);
  });

  it("defers the reviewed five names, never publishes controlled tools or Exec", async () => {
    const report = await discoverMcpTools(
      { listTools: async () => capture.cases.unfiltered },
      undefined,
      "controlled-operations",
      CONTROLLED_TOOLS,
    );
    expect(report.exposed).toHaveLength(15);
    expect(
      report.decisions
        .filter((decision) => decision.status === "deferred")
        .map((decision) => decision.name)
        .sort(),
    ).toEqual([...CONTROLLED_TOOLS].sort());
    expect(report.decisions.find((decision) => decision.name === "pods_exec")).toMatchObject({
      status: "rejected",
    });
  });

  it("preserves the actual profile in ready, withdrawn and closed publications", async () => {
    const config = sreConfigSchema.parse({
      ...base,
      safety: {
        mode: "controlled-operations",
        controlledOperations: { enabledTools: ["resources_scale"] },
      },
    });
    const profiles: string[] = [];
    const controller = new RequestMcpController({
      safety: config.safety,
      publish: (state) => {
        profiles.push(environmentLines(captureEnvironment(state))[0]!);
      },
      connect: async () => ({
        state: "ready",
        listTools: async () => capture.cases.unfiltered,
        callTool: async () => ({
          content: [],
          structuredContent: { contexts: [{ name: "A", default: false }] },
        }),
        close: async () => {},
      }),
    });
    await controller.restart();
    expect(controller.snapshot.tools).toHaveLength(15);
    expect(controller.snapshot.profile).toBe("controlled-operations");
    await controller.close();
    expect(profiles.length).toBeGreaterThan(2);
    expect(new Set(profiles)).toEqual(new Set(["CONTROLLED OPERATIONS — APPROVAL REQUIRED"]));
  });

  it("loads separate controlled templates and rejects MCP profile mismatch, missing read_only and CLI override", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sre-controlled-config-"));
    const configPath = join(home, "config.yaml");
    const mcpPath = join(home, "kubernetes-mcp.controlled.toml");
    try {
      const yaml = await readFile("config/pi-sre.controlled.example.yaml", "utf8");
      const toml = await readFile("config/kubernetes-mcp.controlled.example.toml", "utf8");
      await writeFile(configPath, yaml);
      await writeFile(mcpPath, toml);
      const load = () => loadSreConfig({ env: { PI_SRE_HOME: home } });
      expect((await load()).safety.mode).toBe("controlled-operations");
      for (const invalid of ["read_only = true\n", ""]) {
        await writeFile(mcpPath, invalid);
        await expect(load()).rejects.toThrow("read_only = false");
      }
      await writeFile(mcpPath, toml);
      await writeFile(configPath, yaml.replace("args: []", 'args: ["--read-only=false"]'));
      await expect(load()).rejects.toThrow("must not override read-only");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
