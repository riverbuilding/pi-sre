import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import discovery from "./discovery-responses.json" with { type: "json" };
import alphaPods from "./alpha-pods.json" with { type: "json" };
import betaPods from "./beta-pods.json" with { type: "json" };
import { fixturePath } from "./mcp-client.js";

export interface RecordedRequest {
  readonly target: string;
  readonly method: string;
  readonly path: string;
}

/** The template is static; only ephemeral loopback ports are filled at runtime. */
export async function withMockKubernetes<T>(
  action: (kubeconfig: string, requests: readonly RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "pi-sre-routing-"));
  const requests: RecordedRequest[] = [];
  const servers = ["alpha", "beta"].map((target) =>
    createServer((request, response) => {
      requests.push({ target, method: request.method ?? "", path: request.url ?? "" });
      const path = request.url?.split("?")[0];
      const body =
        path === "/api" || path === "/apis" || path === "/api/v1"
          ? discovery[path]
          : path === "/api/v1/pods" || path === "/api/v1/namespaces/default/pods"
            ? target === "alpha"
              ? alphaPods
              : betaPods
            : discovery.notFound;
      response.writeHead(body === discovery.notFound ? 404 : 200, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(body));
    }),
  );
  try {
    let template = await readFile(fixturePath("kubeconfigs/routing.template.json"), "utf8");
    for (const [index, server] of servers.entries()) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback TCP address");
      template = template.replace(
        index === 0 ? "{{ALPHA_PORT}}" : "{{BETA_PORT}}",
        String(address.port),
      );
    }
    const kubeconfig = join(home, "routing.json");
    await writeFile(kubeconfig, template);
    return await action(kubeconfig, requests);
  } finally {
    try {
      await Promise.all(
        servers
          .filter((server) => server.listening)
          .map(
            (server) =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
