import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "success";
process.stderr.write("token=fixture-secret\n");

if (scenario === "exit") process.exit(7);
if (scenario === "malformed") process.stdout.write("this is not json\n");

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (scenario === "timeout" || scenario === "malformed") return;
  const request: unknown = JSON.parse(line);
  if (!request || typeof request !== "object" || !("method" in request) || !("id" in request))
    return;
  const { method, id } = request as { method: string; id: number };
  const result =
    method === "initialize"
      ? {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-kubernetes-mcp", version: "0.0.1" },
        }
      : method === "tools/list"
        ? { tools: [{ name: "configuration_contexts_list", inputSchema: { type: "object" } }] }
        : method === "tools/call"
          ? { content: [{ type: "text", text: "ok" }] }
          : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
});
