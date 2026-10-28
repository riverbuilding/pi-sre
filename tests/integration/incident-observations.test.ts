import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { InvestigationController } from "../../src/app/investigation-controller.js";
import { ClusterContextManager } from "../../src/cluster/context-manager.js";
import { DEFAULT_RESULT_POLICY } from "../../src/config/schema.js";
import { InvestigationService } from "../../src/investigation/investigation-service.js";
import { ManagedMcpConnection } from "../../src/mcp/connection.js";
import { discoverClusterContexts } from "../../src/mcp/context-discovery.js";
import { createMcpToolBridge } from "../../src/mcp/tool-bridge.js";
import { discoverMcpTools } from "../../src/mcp/tool-discovery.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

describe("incident evidence across managed recording stdio", () => {
  it.each([
    ["scoped-success", undefined],
    ["scoped-empty", undefined],
    ["scoped-malformed", "invalid-result"],
    ["scoped-error", "authentication-failed"],
    ["scoped-timeout", "timeout"],
    ["diagnostic-authorization", "authorization-failed"],
    ["diagnostic-operation", "tool-execution-failed"],
    ["diagnostic-observation-large", undefined],
    ["diagnostic-observation-empty", undefined],
  ])("captures only successful observations for %s", async (scenario, failure) => {
    const connection = await ManagedMcpConnection.connect({
      transport: "stdio",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), fixture, scenario],
      startupTimeoutMs: 2000,
      toolCallTimeoutMs: 150,
    });
    const manager = new ClusterContextManager();
    const service = new InvestigationService({
      maxToolCalls: 2,
      maxExcerptChars: 1800,
      defaultTimeRange: "30m",
    });
    const controller = new InvestigationController(manager, service);
    onTestFinished(async () => {
      controller.dispose();
      manager.dispose();
      await connection.close();
    });
    const report = await discoverMcpTools(connection);
    const generation = manager.beginConnection();
    controller.installTools(generation, report.exposed);
    manager.acceptRegistry(generation, await discoverClusterContexts(connection, report));
    const binding = controller.bind("stdio-session");
    controller.start(binding, "Inspect fixture pods");
    const descriptor = report.exposed.find((tool) => tool.name === "pods_list");
    if (!descriptor) throw new Error("Expected fixture diagnostic");
    const bridge = createMcpToolBridge(
      descriptor,
      connection,
      { ...DEFAULT_RESULT_POLICY, maxTextChars: 1800 },
      { manager, investigation: controller, connectionGeneration: generation },
    );
    const result = await bridge.execute(
      "pods",
      { context: "alpha" },
      undefined,
      undefined,
      {} as never,
    );
    const state = controller.inspect(binding)!;
    expect(state.dispatchedAttempts).toBe(1);
    if (failure) {
      expect(result).toMatchObject({ isError: true, details: { failureCategory: failure } });
      expect(result.details).not.toHaveProperty("evidenceId");
      expect(state.evidence).toEqual([]);
      expect(state.outcomes[0]?.status).toBe("failed");
    } else {
      const evidence = state.evidence[0]!;
      expect(state.evidence).toHaveLength(1);
      expect(service.evidenceGet(state.incident.id, evidence.id)).toEqual(evidence);
      expect(result).toMatchObject({
        isError: false,
        details: {
          evidenceId: evidence.id,
          incidentId: evidence.incidentId,
          executionId: evidence.executionId,
          truncated: evidence.truncated,
          scope: {
            context: "alpha",
            scopeRevision: evidence.scopeRevision,
            inventoryRevision: evidence.inventoryRevision,
            connectionGeneration: evidence.connectionGeneration,
          },
        },
      });
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Expected observation text");
      expect(block.text.split("READ ONLY\n")[1]).toBe(evidence.excerpt);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1800);
      if (scenario.endsWith("large")) expect(evidence.truncated).toBe(true);
    }
    expect(JSON.stringify(state)).not.toContain("PRIVATE_FIXTURE");
    expect(manager.isAgentActive).toBe(false);
  });
});
