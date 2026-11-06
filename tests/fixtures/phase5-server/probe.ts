import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

export const scenarios = [
  "unfiltered",
  "read-only",
  "kubernetes",
  "openshift-metrics",
  "singleton",
  "disabled-provider",
] as const;
export type Scenario = (typeof scenarios)[number];

/** Descriptor discovery only. No tool calls, real credentials, or external cluster access. */
export async function probePhase5Server(executable: string, scenario: Scenario) {
  const directory = await mkdtemp(join(tmpdir(), "pi-sre-phase5-"));
  const requests: string[] = [];
  const extended = scenario === "openshift-metrics";
  const groups = extended
    ? [
        { name: "project.openshift.io", version: "v1", kinds: ["Project"] },
        { name: "route.openshift.io", version: "v1", kinds: ["Route"] },
        { name: "metrics.k8s.io", version: "v1beta1", kinds: ["PodMetrics", "NodeMetrics"] },
      ]
    : [];
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "";
    requests.push(`${request.method} ${path}`);
    const group = groups.find((entry) => path === `/apis/${entry.name}/${entry.version}`);
    let body: Record<string, unknown>;
    if (path === "/api") {
      body = { kind: "APIVersions", versions: ["v1"] };
    } else if (path === "/apis") {
      body = {
        kind: "APIGroupList",
        groups: groups.map(({ name, version }) => ({
          name,
          versions: [{ groupVersion: `${name}/${version}`, version }],
          preferredVersion: { groupVersion: `${name}/${version}`, version },
        })),
      };
    } else if (path === "/api/v1" || group) {
      body = {
        kind: "APIResourceList",
        groupVersion: group ? `${group.name}/${group.version}` : "v1",
        resources: (group?.kinds ?? ["Pod", "Node", "Namespace"]).map((kind) => {
          let name: string;
          if (kind === "PodMetrics") {
            name = "pods";
          } else if (kind === "NodeMetrics") {
            name = "nodes";
          } else {
            name = `${kind.toLowerCase()}s`;
          }

          return {
            name,
            singularName: kind.toLowerCase(),
            kind,
            namespaced: kind === "Pod" || kind === "PodMetrics",
            verbs: ["get", "list"],
          };
        }),
      };
    } else {
      body = { kind: "Status", status: "Failure", reason: "NotFound", code: 404 };
    }

    response.writeHead("code" in body ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const client = new McpClient({
    name: "pi-sre-phase5-contracts",
    version: "0.1.0",
    requestTimeoutMs: 5_000,
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP address");
    }

    const names = scenario === "singleton" ? ["alpha"] : ["alpha", "beta"];
    const kubeconfig = join(directory, "kubeconfig.json");
    const config = join(directory, "server.toml");
    await writeFile(
      kubeconfig,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: names.map((name) => ({
          name,
          cluster: { server: `http://127.0.0.1:${address.port}` },
        })),
        contexts: names.map((name) => ({
          name,
          context: { cluster: name, user: "", namespace: `ns-${name}` },
        })),
        users: [],
        "current-context": "alpha",
      }),
    );
    await writeFile(
      config,
      [
        `read_only = ${scenario === "read-only"}`,
        'toolsets = ["config", "core"]',
        `experimental_enable_target_compatibility_tool_filters = ${scenario === "kubernetes" || extended}`,
      ].join("\n"),
    );
    await client.connect(
      new StdioTransport({
        command: executable,
        args: [
          "--config",
          config,
          "--kubeconfig",
          kubeconfig,
          "--cluster-provider",
          scenario === "disabled-provider" ? "disabled" : "kubeconfig",
        ],
        cwd: directory,
        stderr: "pipe",
      }),
    );
    const descriptors = (await client.listTools()).sort((a, b) => a.name.localeCompare(b.name));
    if (requests.some((request) => !request.startsWith("GET "))) {
      throw new Error("Descriptor probe attempted a non-read Kubernetes request");
    }
    return descriptors;
  } finally {
    try {
      await client.close();
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function capturePhase5Server(executable: string) {
  const cases: Partial<Record<Scenario, Awaited<ReturnType<typeof probePhase5Server>>>> = {};
  for (const scenario of scenarios) {
    cases[scenario] = await probePhase5Server(executable, scenario);
  }
  return {
    serverVersion: execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
    evidence:
      "Real MCP tools/list against synthetic loopback discovery; no tools/call or live cluster operations.",
    cases,
  };
}
