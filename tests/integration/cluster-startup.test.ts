import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { McpController } from "../../src/app/mcp-controller.js";
import { createApplicationPaths, type SreConfig } from "../../src/config/config.js";
import { DEFAULT_RESULT_POLICY } from "../../src/config/schema.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));

describe("scope publication on the owned MCP connection", () => {
  it.each([
    {
      scenario: "contexts-success",
      cli: "beta",
      configured: "alpha",
      status: "bound",
      context: "beta",
      source: "cli",
    },
    {
      scenario: "contexts-success",
      configured: "beta",
      status: "bound",
      context: "beta",
      source: "config",
    },
    { scenario: "contexts-success", status: "bound", context: "alpha", source: "mcp-default" },
    {
      scenario: "contexts-success",
      cli: "missing",
      configured: "alpha",
      status: "selection-error",
    },
    { scenario: "contexts-success", configured: "missing", status: "selection-error" },
    { scenario: "contexts-no-default", status: "unbound" },
    { scenario: "contexts-empty", status: "not-configured" },
    { scenario: "contexts-malformed", status: "enumeration-failed", reason: "invalid-response" },
    { scenario: "contexts-error", status: "enumeration-failed", reason: "tool-error" },
    { scenario: "contexts-timeout", status: "enumeration-failed", reason: "tool-error" },
    { scenario: "empty-tools", status: "enumeration-failed", reason: "incompatible-tool" },
  ])("publishes $status for $scenario with CLI=$cli config=$configured", async (test) => {
    const home = await mkdtemp(join(tmpdir(), "pi-sre-cluster-startup-"));
    const pid = join(home, "child.pid");
    const config: SreConfig = {
      paths: createApplicationPaths(home),
      kubernetes: {
        ...(test.configured ? { defaultCluster: test.configured } : {}),
        mcp: {
          transport: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", fixture, test.scenario, pid],
          cwd: process.cwd(),
          startupTimeoutMs: 2_000,
          toolCallTimeoutMs: 150,
        },
      },
      investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
      safety: { mode: "read-only" },
      results: DEFAULT_RESULT_POLICY,
    };
    const controller = new McpController(
      config,
      new AbortController().signal,
      undefined,
      test.cli ? { cluster: test.cli } : {},
    );
    const observed: string[] = [];
    const unsubscribe = controller.subscribe((state) => {
      if (state.status === "connecting") expect(state.tools).toEqual([]);
      if (state.status === "ready") observed.push(controller.clusterContext.state.status);
    });
    try {
      await controller.restart(false, true);
      expect(controller.snapshot.status).toBe("ready");
      expect(observed).toEqual([test.status]);
      expect(controller.clusterContext.state.status).toBe(test.status);
      if (test.context)
        expect(controller.clusterContext.captureScope()).toMatchObject({
          context: test.context,
          source: test.source,
        });
      else expect(controller.clusterContext.captureScope()).toBeUndefined();
      if (test.reason)
        expect(controller.clusterContext.state).toMatchObject({ reason: test.reason });
      if (test.scenario !== "empty-tools") {
        const calls = (await readFile(`${pid}.calls`, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        expect(calls).toEqual([{ name: "configuration_contexts_list", arguments: {} }]);
      }
      expect(controller.snapshot.tools.map((tool) => tool.name)).toEqual(
        test.status === "enumeration-failed" ? [] : ["configuration_contexts_list"],
      );
      expect(JSON.stringify(controller.clusterContext.state)).not.toContain("PRIVATE_FIXTURE");
    } finally {
      unsubscribe();
      await controller.close();
      expect(controller.clusterContext.captureScope()).toBeUndefined();
      const child = Number(await readFile(pid, "utf8"));
      expect(() => process.kill(child, 0)).toThrow();
      await rm(home, { recursive: true, force: true });
    }
  });
});
