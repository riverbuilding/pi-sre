import { fileURLToPath } from "node:url";

import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, import.meta.url));
}

export async function withServer<T>(
  executable: string,
  kubeconfig: string,
  action: (client: McpClient) => Promise<T>,
  options: { provider?: "kubeconfig" | "disabled"; onStderr?: (chunk: string) => void } = {},
): Promise<T> {
  const client = new McpClient({
    name: "pi-sre-contract-test",
    version: "0.1.0",
    requestTimeoutMs: 5_000,
  });
  try {
    await client.connect(
      new StdioTransport({
        command: executable,
        args: [
          "--config",
          fixturePath("server.toml"),
          "--kubeconfig",
          kubeconfig,
          "--cluster-provider",
          options.provider ?? "kubeconfig",
          "--list-output",
          "yaml",
        ],
        cwd: fixturePath("."),
        stderr: "pipe",
        ...(options.onStderr ? { onStderr: options.onStderr } : {}),
      }),
    );
    return await action(client);
  } finally {
    await client.close();
  }
}
