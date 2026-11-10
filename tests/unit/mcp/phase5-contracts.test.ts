import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { normalizeSensitiveReadResult } from "../../../src/mcp/read-projection.js";
import { discoverMcpTools } from "../../../src/mcp/tool-discovery.js";
import { MCP_TOOL_POLICIES, prepareMcpToolSchema } from "../../../src/runtime/tool-policy.js";
import capture from "../../fixtures/phase5-server-0.0.67.json" with { type: "json" };
import facts from "../../fixtures/phase5-server/source-facts.json" with { type: "json" };
import { probePhase5Server, scenarios } from "../../fixtures/phase5-server/probe.js";

// Historical target names, independent of the selected server's filtered inventory.
const targets = [
  "configuration_contexts_list",
  "targets_list",
  "configuration_view",
  "events_list",
  "namespaces_list",
  "projects_list",
  "nodes_log",
  "nodes_stats_summary",
  "nodes_top",
  "pods_list",
  "pods_list_in_namespace",
  "pods_get",
  "pods_delete",
  "pods_top",
  "pods_exec",
  "pods_log",
  "pods_run",
  "resources_list",
  "resources_get",
  "resources_create_or_update",
  "resources_delete",
  "resources_scale",
];
const controlled = [
  "pods_delete",
  "pods_exec",
  "pods_run",
  "resources_create_or_update",
  "resources_delete",
  "resources_scale",
];

describe("Phase 5 Slice 0 frozen server evidence (not runtime schema admission)", () => {
  it("covers all 22 historical targets with descriptors or explicit provider conditions", () => {
    expect(capture.serverVersion).toBe("0.0.67");
    expect(new Set(targets).size).toBe(22);
    expect(
      [...capture.cases.unfiltered.map((tool) => tool.name), facts.targetDiscovery.baseName].sort(),
    ).toEqual(targets.toSorted());
    expect(facts.targetDiscovery.nonKubeconfigLiveProbe).toBe(false);
    expect(facts.targetDiscovery.example.advertisedName).toBe("cluster_list");
    expect(facts.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
  });

  it("server read-only filtering removes all six controlled definitions, including scale", () => {
    const names = capture.cases["read-only"].map((tool) => tool.name);
    expect(
      capture.cases.unfiltered
        .filter((tool) => !names.includes(tool.name))
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(controlled.toSorted());
    expect(names).toContain("configuration_view");
  });

  it("records platform and metrics absence separately from optimistic advertisement", () => {
    for (const name of ["projects_list", "pods_top", "nodes_top"]) {
      expect(capture.cases.kubernetes.some((tool) => tool.name === name)).toBe(false);
      expect(capture.cases["openshift-metrics"].some((tool) => tool.name === name)).toBe(true);
      expect(capture.cases.unfiltered.some((tool) => tool.name === name)).toBe(true);
    }
    for (const tools of Object.values(capture.cases)) {
      expect(
        tools.some((tool) => ["targets_list", "context_list", "cluster_list"].includes(tool.name)),
      ).toBe(false);
    }
  });

  it.each(["singleton", "disabled-provider"] as const)(
    "%s cannot satisfy explicit-context routing",
    (scenario) => {
      expect(
        capture.cases[scenario].some((tool) => tool.name === "configuration_contexts_list"),
      ).toBe(false);
      const pod = capture.cases[scenario].find((tool) => tool.name === "pods_get");
      expect(pod).toBeDefined();
      expect(pod?.inputSchema.properties).not.toHaveProperty("context");
      expect(() => prepareMcpToolSchema(pod!)).toThrow("context parameter");
    },
  );

  it("retains distinct namespaces, log limits, and unbounded exec schema facts", () => {
    const schema = (name: string) =>
      capture.cases.unfiltered.find((tool) => tool.name === name)?.inputSchema;
    expect(schema("pods_list_in_namespace")?.required).toEqual(["namespace"]);
    expect(schema("pods_list")?.properties).not.toHaveProperty("namespace");
    expect(schema("nodes_log")?.properties).toHaveProperty(
      "tailLines",
      expect.objectContaining({ default: 100, minimum: 0 }),
    );
    expect(schema("pods_log")?.properties).toHaveProperty(
      "tail",
      expect.objectContaining({ default: 100, minimum: 0 }),
    );
    expect(Object.keys(schema("pods_exec")?.properties ?? {}).sort()).toEqual([
      "command",
      "container",
      "context",
      "name",
      "namespace",
    ]);
    expect(facts.limits.pods_exec.outputLimitArgument).toBeNull();
  });

  it("exposes the 14 reviewed reads while excluding config inspection, writes and Exec", async () => {
    const report = await discoverMcpTools({ listTools: async () => capture.cases.unfiltered });
    expect(report.exposed.map((tool) => tool.name).sort()).toEqual(
      MCP_TOOL_POLICIES.map((policy) => policy.name).sort(),
    );
    expect(report.exposed).toHaveLength(14);
    const ordinary = await discoverMcpTools({ listTools: async () => capture.cases.kubernetes });
    for (const name of ["projects_list", "pods_top", "nodes_top"]) {
      expect(ordinary.exposed.some((tool) => tool.name === name)).toBe(false);
    }
    for (const name of targets.filter(
      (name) => !MCP_TOOL_POLICIES.some((policy) => policy.name === name),
    )) {
      expect(() => prepareMcpToolSchema({ name, inputSchema: { type: "object" } })).toThrow(
        "not approved",
      );
    }
  });
});

const executable = process.env.PI_SRE_CONTRACT_SERVER;
describe.skipIf(!executable)(
  "Phase 5 real-server descriptor probe (synthetic Kubernetes only)",
  () => {
    it("projects real resource response channels and verifies server Secret denial", async () => {
      await probePhase5Server(executable!, "read-only", async (client, requests) => {
        const args = { context: "alpha", apiVersion: "v1", kind: "Pod" };
        const get = await client.callTool("resources_get", { ...args, name: "web" });
        const projected = normalizeSensitiveReadResult(
          "resources_get",
          { ...args, name: "web" },
          get,
        );
        expect(projected.status).toBe("success");
        expect(projected.text).toContain("web");
        expect(JSON.stringify(projected)).not.toContain("UNMARKED_PRIVATE");
        const list = await client.callTool("resources_list", args);
        expect(list).not.toHaveProperty("isError", true);
        const projectedList = normalizeSensitiveReadResult("resources_list", args, list);
        expect(projectedList.status).toBe("success");
        expect(projectedList.text).toContain("web");
        expect(projectedList.text).not.toContain("UNMARKED_PRIVATE");
        const empty = await client.callTool("resources_list", {
          ...args,
          labelSelector: "app=empty",
        });
        expect(normalizeSensitiveReadResult("resources_list", args, empty)).toMatchObject({
          status: "success",
          text: '{"items":[]}',
        });
        const denied = await client.callTool("resources_get", {
          ...args,
          kind: "Secret",
          name: "private",
        });
        expect(denied.isError).toBe(true);
        expect(requests.some((path) => path.includes("/secrets"))).toBe(false);
        expect(requests).toContain("GET /api/v1/namespaces/ns-alpha/pods/web");
        expect(requests).toContain("GET /api/v1/namespaces/ns-alpha/pods");
      });
    });

    it.each(scenarios)("%s matches the frozen discovery fixture", async (scenario) => {
      expect(execFileSync(executable!, ["--version"], { encoding: "utf8" }).trim()).toBe(
        capture.serverVersion,
      );
      expect(await probePhase5Server(executable!, scenario)).toEqual(capture.cases[scenario]);
    });
  },
);
