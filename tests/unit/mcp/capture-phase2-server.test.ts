import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import expected from "../../fixtures/phase2-server-0.0.67.json" with { type: "json" };
import { fixturePath, withServer } from "../../fixtures/phase2-server/mcp-client.js";
import { withMockKubernetes } from "../../fixtures/phase2-server/mock-kubernetes.js";

// Explicit opt-in keeps ordinary unit tests independent of a locally installed executable.
const configuredExecutable = process.env.PI_SRE_CONTRACT_SERVER;
const executable = configuredExecutable || "kubernetes-mcp-server";
const candidates = new Set([
  "configuration_contexts_list",
  "pods_list",
  "pods_get",
  "pods_log",
  "events_list",
  "namespaces_list",
]);

describe.skipIf(!configuredExecutable)("Kubernetes MCP Server frozen contracts", () => {
  beforeAll(() => {
    expect(execFileSync(executable, ["--version"], { encoding: "utf8" }).trim()).toBe(
      expected.serverVersion,
    );
  });

  it.each(["multiple-default", "single-default", "single-no-default", "disabled"] as const)(
    "%s matches the captured descriptors and response",
    async (scenario) => {
      const actual = await withServer(
        executable,
        fixturePath(`kubeconfigs/${scenario}.json`),
        async (client) => {
          const descriptors = (await client.listTools()).filter((tool) =>
            candidates.has(tool.name),
          );
          const response = descriptors.some((tool) => tool.name === "configuration_contexts_list")
            ? await client.callTool("configuration_contexts_list", {})
            : null;
          return { descriptors, response };
        },
        { provider: scenario === "disabled" ? "disabled" : "kubeconfig" },
      );
      expect(actual).toEqual(expected.cases[scenario]);
    },
  );

  it.each(["multiple-no-default", "empty"] as const)(
    "%s matches the captured startup failure",
    async (scenario) => {
      let diagnostic = "";
      await expect(
        withServer(
          executable,
          fixturePath(`kubeconfigs/${scenario}.json`),
          async () => {
            throw new Error("Unexpected successful initialization");
          },
          {
            onStderr: (chunk) => {
              diagnostic += chunk;
            },
          },
        ),
      ).rejects.toThrow(expected.cases[scenario].startupFailure);
      expect(diagnostic.split("\n")[0]).toBe(expected.cases[scenario].diagnostic);
    },
  );

  it("explicit contexts match the captured routing and return distinct markers", async () => {
    await withMockKubernetes(async (kubeconfig, requests) => {
      await withServer(executable, kubeconfig, async (client) => {
        for (const args of expected.cases.routing.arguments) {
          const result = await client.callTool("pods_list", args);
          expect(result.isError).not.toBe(true);
          expect(JSON.stringify(result)).toContain(`${args.context}-marker`);
        }
      });
      expect({
        tool: "pods_list",
        arguments: [{ context: "alpha" }, { context: "beta" }],
        requests,
        distinctMarkersVerified: true,
      }).toEqual(expected.cases.routing);
    });
  });
});
