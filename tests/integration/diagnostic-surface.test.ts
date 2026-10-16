import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpController } from "../../src/app/mcp-controller.js";
import { createApplicationPaths, type SreConfig } from "../../src/config/config.js";
import { DEFAULT_RESULT_POLICY } from "../../src/config/schema.js";
import { createSreRuntime } from "../../src/runtime/pi-runtime.js";
import type { SreRuntime } from "../../src/runtime/sre-runtime.js";
import { diagnosticTools } from "../fixtures/diagnostic-tools.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));
const names = diagnosticTools.map((tool) => tool.name);

describe("reviewed diagnostics through controller, Pi, and managed stdio", () => {
  it.each(["diagnostic-success", "diagnostic-unbound"])(
    "publishes and scopes the reviewed tools with %s",
    async (scenario) => {
      const home = await mkdtemp(join(tmpdir(), "pi-sre-diagnostics-"));
      const pid = join(home, "child.pid");
      const config: SreConfig = {
        paths: createApplicationPaths(home),
        kubernetes: {
          mcp: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", "tsx", fixture, scenario, pid],
            cwd: process.cwd(),
            startupTimeoutMs: 2000,
            toolCallTimeoutMs: 1000,
          },
        },
        investigation: { defaultTimeRange: "30m", maxToolCalls: 40 },
        safety: { mode: "read-only" },
        results: DEFAULT_RESULT_POLICY,
      };
      const controller = new McpController(config, new AbortController().signal);
      let runtime: SreRuntime | undefined;
      const calls = async (): Promise<unknown[]> =>
        (await readFile(`${pid}.calls`, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
      try {
        await controller.restart(false, true);
        runtime = await createSreRuntime(config, [], undefined, controller);
        await runtime.session.bindExtensions({});
        if (scenario === "diagnostic-unbound") {
          expect(controller.snapshot.tools.map((tool) => tool.name)).toEqual([
            "configuration_contexts_list",
          ]);
          runtime.session.setActiveToolsByName([...names, "bash", "resources_get"]);
          expect(runtime.session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
        }
        await runtime.session.prompt("/cluster beta");
        expect(runtime.session.getActiveToolNames()).toEqual(names);
        expect(controller.snapshot.tools.map((tool) => tool.name)).toEqual(names);
        const requests: readonly [string, Record<string, unknown>][] = [
          ["pods_list", { labelSelector: "app=api", fieldSelector: "status.phase=Running" }],
          ["pods_get", { name: "api", namespace: "payments" }],
          ["pods_log", { name: "api", namespace: "payments", container: "app", previous: true }],
          ["events_list", { namespace: "payments", fieldSelector: "involvedObject.name=api" }],
          ["namespaces_list", { fieldSelector: "metadata.name=payments" }],
        ];
        for (const [name, args] of requests) {
          const tool = runtime.session.getToolDefinition(name);
          if (!tool) throw new Error("Expected diagnostic tool");
          expect(JSON.stringify(tool.parameters)).not.toContain('"context"');
          const result = await tool.execute(
            name,
            { ...args, context: "alpha" },
            undefined,
            undefined,
            {} as never,
          );
          expect(result).toMatchObject({
            isError: false,
            details: {
              scope: {
                context: "beta",
                readOnly: true,
                ...(args.namespace ? { namespace: args.namespace } : {}),
              },
            },
          });
          expect(JSON.stringify(result)).toContain(`beta-${name}`);
          expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
        }
        expect(await calls()).toEqual([
          { name: "configuration_contexts_list", arguments: {} },
          ...requests.map(([name, args]) => ({
            name,
            arguments: { ...args, context: "beta", ...(name === "pods_log" ? { tail: 100 } : {}) },
          })),
        ]);

        await runtime.session.reload();
        expect(runtime.session.getActiveToolNames()).toEqual(names);
        const captured = runtime.session.getToolDefinition("pods_list");
        if (!captured) throw new Error("Expected captured tool");
        const before = await calls();
        controller.clusterContext.markUnavailable("Test scope unavailable");
        expect(controller.snapshot.tools.map((tool) => tool.name)).toEqual([
          "configuration_contexts_list",
        ]);
        runtime.session.setActiveToolsByName(names);
        expect(runtime.session.getActiveToolNames()).toEqual(["configuration_contexts_list"]);
        expect(
          runtime.session
            .getAllTools()
            .filter((tool) => tool.exposure !== "hidden")
            .map((tool) => tool.name),
        ).toEqual(["configuration_contexts_list"]);
        expect(
          await captured.execute("blocked", {}, undefined, undefined, {} as never),
        ).toMatchObject({ isError: true, details: { failureCategory: "scope-unavailable" } });
        expect(runtime.session.getCallableToolNames()).toEqual(["configuration_contexts_list"]);
        expect(await calls()).toEqual(before);
        process.kill(Number(await readFile(pid, "utf8")), "SIGTERM");
        await expect.poll(() => controller.snapshot.status).toBe("unavailable");
        expect(runtime.session.getActiveToolNames()).toEqual([]);
        expect(runtime.session.getCallableToolNames()).toEqual([]);
        expect(await captured.execute("lost", {}, undefined, undefined, {} as never)).toMatchObject(
          { isError: true },
        );
        expect(await calls()).toEqual(before);
      } finally {
        await runtime?.dispose();
        await controller.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
